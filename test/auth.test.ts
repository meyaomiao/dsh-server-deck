import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import type { HostPool } from '../src/server/pool.ts';
import type { HostStore } from '../src/server/store.ts';
import type { MetricStore } from '../src/server/metric-store.ts';
import type { MetricRecorder } from '../src/server/recorder.ts';
import { createApiRouter } from '../src/server/router.ts';
import { createPtyRoute } from '../src/server/pty.ts';
import { requestRejection } from '../src/server/auth.ts';

// Simulates host Connection: trust checks precede cookie authentication.
interface TestConnection { requestRejection(req: IncomingMessage): 401 | 403 | undefined }
function verifier(): TestConnection {
  return { requestRejection(req) {
    if (!req.headers.host?.startsWith('127.0.0.1:')) return 403;
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403;
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) return 403;
    return req.headers.cookie === 'test-session=valid' ? undefined : 401;
  } };
}

class TestChannel extends Duplex {
  ended = 0;
  closeCalls = 0;
  input: Buffer[] = [];
  windows: number[][] = [];
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.input.push(Buffer.from(chunk));
    done();
  }
  override end(): this { this.ended += 1; return super.end(); }
  close(): void { this.closeCalls += 1; this.emit('close'); }
  setWindow(rows: number, cols: number): void { this.windows.push([rows, cols]); }
}

async function fixture(t: TestContext, connection: TestConnection | undefined, shell?: () => Promise<TestChannel>) {
  let shellCalls = 0;
  let hostReads = 0;
  const channel = new TestChannel();
  const pool = { async shell() {
    shellCalls += 1;
    return shell === undefined ? channel : shell();
  } } as unknown as HostPool;
  const store = { list() { hostReads += 1; return []; } } as unknown as HostStore;
  const api = createApiRouter(store, pool, {} as MetricStore, {} as MetricRecorder, undefined, connection);
  const pty = createPtyRoute(pool, (id) => id === 'test-host', connection);
  const server = createServer((req, res) => { void api(req, res); });
  const sockets = new Set<Duplex>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', pty.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const authority = `127.0.0.1:${address.port}`;
  t.after(async () => {
    pty.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    authority, channel, pty,
    shellCalls: () => shellCalls,
    hostReads: () => hostReads,
    http(headers: Record<string, string> = {}, query = '') {
      return new Promise<number>((resolve, reject) => {
        const req = request(`http://${authority}/server-deck/api/hosts${query}`, { headers }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
    },
    ws(headers: Record<string, string> = {}, query = '') {
      return new Promise<{ status: number; socket: WebSocket }>((resolve) => {
        const socket = new WebSocket(`ws://${authority}/server-deck/ws/pty?host=test-host&cols=100&rows=30${query}`, { headers });
        t.after(() => socket.terminate());
        socket.on('open', () => resolve({ status: 101, socket }));
        socket.on('unexpected-response', (_req, res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, socket });
          socket.terminate();
        });
        socket.on('error', () => {});
      });
    },
  };
}

test('authenticated loopback still requires host admission; non-loopback never reaches the verifier', () => {
  let calls = 0;
  const connection = { requestRejection() {
    assert.equal(this, connection);
    calls += 1;
    return undefined;
  } };
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const req = { socket: { remoteAddress } } as IncomingMessage;
    assert.equal(requestRejection(req, connection), undefined);
  }
  assert.equal(calls, 3);
  const remote = { socket: { remoteAddress: '192.0.2.1' } } as IncomingMessage;
  assert.equal(requestRejection(remote, connection)?.status, 403);
  assert.equal(calls, 3);
});

const rejected: { name: string; headers: Record<string, string>; status: number }[] = [
  { name: 'anonymous loopback', headers: {}, status: 401 },
  { name: 'invalid cookie', headers: { cookie: 'test-session=invalid' }, status: 401 },
  { name: 'untrusted Origin with authenticated cookie', headers: { cookie: 'test-session=valid', origin: 'https://untrusted.example' }, status: 403 },
  { name: 'arbitrary desktop Origin', headers: { cookie: 'test-session=valid', origin: 'dsh-app://app' }, status: 403 },
  { name: 'untrusted Host with authenticated cookie', headers: { cookie: 'test-session=valid', host: 'untrusted.example' }, status: 403 },
  { name: 'cross-site request', headers: { cookie: 'test-session=valid', 'sec-fetch-site': 'cross-site' }, status: 403 },
];
for (const { name, headers, status } of rejected) {
  test(`REST rejects ${name} before reading hosts`, { timeout: 3000 }, async (t) => {
    const f = await fixture(t, verifier());
    assert.equal(await f.http(headers), status);
    assert.equal(f.hostReads(), 0);
    assert.equal(f.shellCalls(), 0);
  });
  test(`PTY rejects ${name} before opening SSH shell`, { timeout: 3000 }, async (t) => {
    const f = await fixture(t, verifier());
    assert.equal((await f.ws(headers)).status, status);
    assert.equal(f.shellCalls(), 0);
  });
}

test('launch token query cannot replace host request authentication', { timeout: 3000 }, async (t) => {
  const f = await fixture(t, verifier());
  assert.equal(await f.http({}, '?token=test-launch-token'), 401);
  assert.equal((await f.ws({}, '&token=test-launch-token')).status, 401);
  assert.equal(f.shellCalls(), 0);
});

test('authenticated browser and desktop carrier list hosts and bridge terminal', { timeout: 3000 }, async (t) => {
  const f = await fixture(t, verifier());
  // Desktop carrier forwards its cookie and rewrites Origin to the target host.
  const headers = { cookie: 'test-session=valid', origin: `http://${f.authority}`, 'sec-fetch-site': 'same-origin' };
  assert.equal(await f.http(headers), 200);
  assert.equal(f.hostReads(), 1);
  const { status, socket } = await f.ws(headers);
  assert.equal(status, 101);
  assert.equal(f.shellCalls(), 1);
  const output = once(socket, 'message');
  f.channel.push(Buffer.from('shell-output'));
  assert.equal((await output)[0].toString(), 'shell-output');
  const input = once(f.channel, 'finish');
  socket.send('shell-input');
  socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  socket.close();
  await input;
  assert.equal(Buffer.concat(f.channel.input).toString(), 'shell-input');
  assert.deepEqual(f.channel.windows, [[40, 120]]);
  assert.equal(f.channel.closeCalls, 1);
});

test('missing Connection admission API fails closed on REST and PTY', { timeout: 3000 }, async (t) => {
  for (const connection of [undefined, {} as TestConnection]) {
    const f = await fixture(t, connection);
    assert.equal(await f.http({ cookie: 'test-session=valid' }), 503);
    assert.equal((await f.ws({ cookie: 'test-session=valid' })).status, 503);
    assert.equal(f.hostReads(), 0);
    assert.equal(f.shellCalls(), 0);
  }
});

test('Connection verifier failure fails closed on REST and PTY', { timeout: 3000 }, async (t) => {
  const f = await fixture(t, { requestRejection() { throw new Error('test verifier failure'); } });
  assert.equal(await f.http({ cookie: 'test-session=valid' }), 503);
  assert.equal((await f.ws({ cookie: 'test-session=valid' })).status, 503);
  assert.equal(f.shellCalls(), 0);
});

test('PTY closes a shell arriving after WebSocket disconnected', { timeout: 3000 }, async (t) => {
  let ready!: (channel: TestChannel) => void;
  const pending = new Promise<TestChannel>((resolve) => { ready = resolve; });
  const f = await fixture(t, verifier(), () => pending);
  const { socket } = await f.ws({ cookie: 'test-session=valid' });
  const closeCalls = once(socket, 'close');
  socket.close();
  await closeCalls;
  ready(f.channel);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.channel.ended, 1);
  assert.equal(f.channel.closeCalls, 1);
});

test('PTY disposal closes active shells and refuses new upgrades', { timeout: 3000 }, async (t) => {
  const f = await fixture(t, verifier());
  const { socket } = await f.ws({ cookie: 'test-session=valid' });
  const closed = once(socket, 'close');
  f.pty.dispose();
  f.pty.dispose();
  await closed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.channel.ended, 1);
  assert.equal(f.channel.closeCalls, 1);
  assert.equal((await f.ws({ cookie: 'test-session=valid' })).status, 503);
  assert.equal(f.shellCalls(), 1);
});

test('PTY disposal closes a shell that is still being created', { timeout: 3000 }, async (t) => {
  let ready!: (channel: TestChannel) => void;
  const pending = new Promise<TestChannel>((resolve) => { ready = resolve; });
  const f = await fixture(t, verifier(), () => pending);
  const { socket } = await f.ws({ cookie: 'test-session=valid' });
  const closed = once(socket, 'close');
  f.pty.dispose();
  await closed;
  ready(f.channel);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.channel.ended, 1);
  assert.equal(f.channel.closeCalls, 1);
});
