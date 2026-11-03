import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect as netConnect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2, { type Connection } from 'ssh2';
import { HostPool } from '../src/server/pool.ts';
import type { HostEntry } from '../src/types.ts';

const { Server, utils } = ssh2;

// Only synthetic credentials and an in-memory host key are used.
const hostKey = utils.generateKeyPairSync('ed25519').private;

async function server(t: TestContext, mode: 'normal' | 'close-ready' | 'deny-auth' | 'deny-forward' = 'normal') {
  const clients = new Set<Connection>();
  const sockets = new Set<Socket>();
  const destinations: number[] = [];
  const ssh = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => { if (mode === 'deny-auth') ctx.reject(); else ctx.accept(); });
    client.on('ready', () => { if (mode === 'close-ready') client.end(); });
    client.on('tcpip', (accept, reject, info) => {
      destinations.push(info.destPort);
      if (mode === 'deny-forward') { reject(); return; }
      const socket = netConnect(info.destPort, info.destIP);
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => reject());
      socket.once('connect', () => {
        const channel = accept();
        channel.on('error', () => {});
        channel.on('close', () => socket.destroy());
        socket.pipe(channel).pipe(socket);
      });
    });
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (acceptPty) => acceptPty?.());
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.write(`exec:${info.command}\n`);
        stream.stderr.write('fixture stderr\n');
        stream.exit(0);
        stream.end();
      });
      session.on('shell', (acceptShell) => {
        const stream = acceptShell();
        stream.write('fixture shell ready\n');
        stream.on('data', (chunk: Buffer) => stream.write(chunk));
      });
    });
  });
  ssh.listen(0, '127.0.0.1');
  await once(ssh, 'listening');
  const address = ssh.address();
  assert.ok(typeof address === 'object' && address !== null);
  t.after(async () => {
    for (const client of clients) client.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => ssh.close((error?: Error) => error ? reject(error) : resolve()));
  });
  return { port: address.port, clients, sockets, destinations };
}

function entry(id: string, port: number, jumpHostId?: string): HostEntry {
  return { id, name: id, host: '127.0.0.1', port, username: 'fixture', auth: 'password', jumpHostId, createdAt: '' };
}

function poolFor(t: TestContext, hosts: HostEntry[]) {
  const pool = new HostPool((id) => hosts.find((h) => h.id === id), () => ({ password: 'fixture-password' }));
  t.after(() => pool.closeAll());
  return pool;
}

async function drained(servers: Awaited<ReturnType<typeof server>>[]): Promise<void> {
  const deadline = Date.now() + 1500;
  while (servers.some((s) => s.clients.size > 0 || s.sockets.size > 0) && Date.now() < deadline) await delay(10);
  assert.deepEqual(servers.map((s) => [s.clients.size, s.sockets.size]), servers.map(() => [0, 0]));
}

test('real ssh2 multi-hop exec and PTY share a chain; test is independent and releases all resources', { timeout: 10_000 }, async (t) => {
  const gateway = await server(t);
  const jump = await server(t);
  const target = await server(t);
  const hosts = [entry('gateway', gateway.port), entry('jump', jump.port, 'gateway'), entry('target', target.port, 'jump')];
  const pool = poolFor(t, hosts);
  const conn = await pool.connect('target');
  assert.deepEqual(await pool.exec('target', 'fixture-command'), { code: 0, stdout: 'exec:fixture-command\n', stderr: 'fixture stderr\n' });
  const shell = await pool.shell('target', 80, 24);
  const [data] = await once(shell, 'data');
  assert.match(String(data), /fixture shell ready/);
  shell.close();
  assert.equal(await pool.connect('target'), conn);
  assert.deepEqual(gateway.destinations, [jump.port]);
  assert.deepEqual(jump.destinations, [target.port]);
  assert.equal((await pool.test(hosts[2])).ok, true);
  assert.equal(await pool.connect('target'), conn);
  assert.equal(gateway.destinations.length, 2);
  assert.equal(jump.destinations.length, 2);
  pool.closeAll();
  await drained([gateway, jump, target]);
});

test('real ssh2 ready followed by immediate close never caches a dead forwarded client or leaks jumps', { timeout: 10_000 }, async (t) => {
  const gateway = await server(t);
  const target = await server(t, 'close-ready');
  const pool = poolFor(t, [entry('gateway', gateway.port), entry('target', target.port, 'gateway')]);
  const first = await pool.connect('target').catch(() => undefined);
  await drained([gateway, target]);
  const second = await pool.connect('target').catch(() => undefined);
  if (first !== undefined && second !== undefined) assert.notEqual(second, first);
  await drained([gateway, target]);
  assert.equal(gateway.destinations.length, 2);
});

for (const mode of ['deny-auth', 'deny-forward'] as const) {
  test(`real ssh2 ${mode} cleans the entire multi-hop chain`, { timeout: 10_000 }, async (t) => {
    const gateway = await server(t);
    const jump = await server(t, mode === 'deny-forward' ? mode : 'normal');
    const target = await server(t, mode === 'deny-auth' ? mode : 'normal');
    const pool = poolFor(t, [entry('gateway', gateway.port), entry('jump', jump.port, 'gateway'), entry('target', target.port, 'jump')]);
    await assert.rejects(pool.connect('target'), mode === 'deny-auth' ? /authentication/i : /转发/);
    await drained([gateway, jump, target]);
  });
}
