import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostEntry, HostInput } from '../src/types.ts';
import { HostStore, normalizeInput, assertJumpTarget } from '../src/server/store.ts';
import { createApiRouter } from '../src/server/router.ts';
import type { MetricStore } from '../src/server/metric-store.ts';
import type { MetricRecorder } from '../src/server/recorder.ts';
import type { HostPool } from '../src/server/pool.ts';
import { fixture, flush, host, outcome } from './pool-fixture.ts';

/** Route tests use an in-memory store; no user ledger, config or secret is opened. */
function storeFor(hosts: HostEntry[]): HostStore {
  const store = new HostStore();
  store.list = () => hosts;
  store.get = (id) => hosts.find((h) => h.id === id);
  store.update = async (id, input) => {
    const before = store.get(id);
    if (before === undefined) throw Object.assign(new Error('主机不存在'), { status: 404 });
    const next = { ...before, ...normalizeInput(input).fields };
    assertJumpTarget(id, next.jumpHostId, hosts);
    hosts[hosts.indexOf(before)] = next;
    return next;
  };
  store.remove = async (id) => {
    const index = hosts.findIndex((h) => h.id === id);
    if (index < 0) return false;
    hosts.splice(index, 1);
    for (const h of hosts) if (h.jumpHostId === id) h.jumpHostId = undefined;
    return true;
  };
  return store;
}

async function request(store: HostStore, pool: HostPool, id: string, method: string, body: HostInput = {}): Promise<number> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.url = `/server-deck/api/hosts/${id}`;
  req.method = method;
  Object.assign(req, { socket: { remoteAddress: '127.0.0.1' } });
  let status = 0;
  const res = { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse;
  await createApiRouter(store, pool, { removeHost: async () => {} } as unknown as MetricStore, { forget() {} } as unknown as MetricRecorder)(req, res);
  return status;
}

for (const [field, value] of Object.entries({ host: 'new.invalid', port: 2222, username: 'new-user', auth: 'agent', keyPath: '/fixture-key', password: 'new-password', passphrase: 'new-passphrase', jumpHostId: null }).concat([['password', null], ['passphrase', null]])) {
  test(`PATCH ${field} invalidates target and transitive dependents only`, async (t) => {
    const f = fixture(t, [host('gateway'), host('jump', 'gateway'), host('target', 'jump'), host('unrelated')]);
    const store = storeFor(f.hosts);
    const target = await f.pool.connect('target');
    const jump = await f.pool.connect('jump');
    const unrelated = await f.pool.connect('unrelated');
    assert.equal(await request(store, f.pool, 'jump', 'PATCH', { [field]: value }), 200);
    assert.ok(f.clients.find((c) => c.conn === target)?.ended);
    assert.ok(f.clients.find((c) => c.conn === jump)?.ended);
    assert.equal(await f.pool.connect('unrelated'), unrelated);
    assert.notEqual(await f.pool.connect('target'), target);
  });
}

test('PATCH metadata and rejected updates preserve established connections', async (t) => {
  const f = fixture(t);
  const store = storeFor(f.hosts);
  const target = await f.pool.connect('target');
  assert.equal(await request(store, f.pool, 'target', 'PATCH', { name: 'new name', tags: ['new'], notes: 'new' }), 200);
  assert.equal(await f.pool.connect('target'), target);
  assert.equal(await request(store, f.pool, 'target', 'PATCH', { jumpHostId: 'missing' }), 500);
  assert.equal(await f.pool.connect('target'), target);
});

test('PATCH direct target endpoint invalidates its own cache', async (t) => {
  const f = fixture(t, [host('target')]);
  const store = storeFor(f.hosts);
  const target = await f.pool.connect('target');
  assert.equal(await request(store, f.pool, 'target', 'PATCH', { host: 'new.invalid' }), 200);
  assert.notEqual(await f.pool.connect('target'), target);
});

test('DELETE an ancestor captures dependents before the store clears direct references', async (t) => {
  const f = fixture(t, [host('gateway'), host('jump', 'gateway'), host('target', 'jump'), host('unrelated')]);
  const store = storeFor(f.hosts);
  const target = await f.pool.connect('target');
  const jump = await f.pool.connect('jump');
  const unrelated = await f.pool.connect('unrelated');
  assert.equal(await request(store, f.pool, 'gateway', 'DELETE'), 200);
  assert.equal(store.get('jump')?.jumpHostId, undefined);
  assert.ok(f.clients.find((c) => c.conn === target)?.ended);
  assert.ok(f.clients.find((c) => c.conn === jump)?.ended);
  assert.equal(await f.pool.connect('unrelated'), unrelated);
  assert.notEqual(await f.pool.connect('target'), target);
});

for (const method of ['PATCH', 'DELETE']) {
  test(`${method} an ancestor also cancels pending target connections`, async (t) => {
    const f = fixture(t);
    const store = storeFor(f.hosts);
    f.onConnect((client) => {
      if (client.cfg.host !== 'target.invalid') queueMicrotask(() => client.conn.emit('ready'));
    });
    const result = outcome(f.pool.connect('target'));
    await flush();
    const pending = f.clients.at(-1)!;
    assert.equal(await request(store, f.pool, 'gateway', method, { host: 'changed.invalid' }), 200);
    pending.conn.emit('ready');
    assert.match(await result, /关闭|断开|取消|closed/i);
    assert.ok(f.clients.every((c) => c.ended));
  });
}
