import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, flush, host, outcome } from './pool-fixture.ts';

const rejection = /关闭|断开|取消|closed/i;

test('HostPool reuses a chain and deduplicates concurrent connections', async (t) => {
  const f = fixture(t);
  const [first, concurrent] = await Promise.all([f.pool.connect('target'), f.pool.connect('target')]);
  assert.equal(first, concurrent);
  assert.equal(f.clients.length, 3);
  assert.equal(await f.pool.connect('target'), first);
  f.pool.close('target');
  assert.ok(f.clients.every((c) => c.ended));
  assert.ok(f.channels.every((c) => c.destroyed));
});

test('HostPool rejects ready followed immediately by close and releases the parents', async (t) => {
  const f = fixture(t);
  f.onConnect((client) => queueMicrotask(() => {
    client.conn.emit('ready');
    if (client.cfg.host === 'target.invalid') client.conn.emit('close');
  }));
  assert.match(await outcome(f.pool.connect('target')), rejection);
  assert.ok(f.clients.every((c) => c.ended));
  f.onConnect((client) => queueMicrotask(() => client.conn.emit('ready')));
  const next = await f.pool.connect('target');
  assert.notEqual(next, f.clients[2].conn);
});

for (const event of ['end', 'close', 'error'] as const) {
  test(`HostPool settles a ${event} before ready and closes the whole chain`, async (t) => {
    const f = fixture(t);
    f.onConnect((client) => queueMicrotask(() => {
      if (client.cfg.host !== 'target.invalid') client.conn.emit('ready');
      else if (event === 'error') client.conn.emit('error', new Error('fixture authentication failure'));
      else client.conn.emit(event);
    }));
    const result = await outcome(f.pool.connect('target'));
    assert.match(result, event === 'error' ? /fixture authentication failure/ : rejection);
    assert.ok(f.clients.every((c) => c.ended));
  });
}

for (const failure of ['error', 'throw'] as const) {
  test(`HostPool cleans parents and forward timers after forward ${failure}`, async (t) => {
    const f = fixture(t);
    f.onForward((target) => target === 'target.invalid' ? failure : undefined);
    await assert.rejects(f.pool.connect('target'), /fixture.*forward/);
    assert.ok(f.clients.every((c) => c.ended));
    assert.ok(f.channels.every((c) => c.destroyed));
  });
}

test('HostPool cleans the complete chain after a synchronous connect throw', async (t) => {
  const f = fixture(t);
  f.onConnect((client) => {
    if (client.cfg.host === 'target.invalid') throw new Error('fixture synchronous connect failure');
    queueMicrotask(() => client.conn.emit('ready'));
  });
  await assert.rejects(f.pool.connect('target'), /fixture synchronous connect failure/);
  assert.ok(f.clients.every((c) => c.ended));
  assert.ok(f.channels.every((c) => c.destroyed));
});

test('HostPool evicts a target when an intermediate jump disconnects', async (t) => {
  const f = fixture(t);
  const first = await f.pool.connect('target');
  f.clients[1].conn.emit('end');
  assert.ok(f.clients.every((c) => c.ended));
  const next = await f.pool.connect('target');
  assert.notEqual(next, first);
});

for (const closeAll of [false, true]) {
  test(`HostPool ${closeAll ? 'closeAll' : 'close'} cancels pending ready without resurrection`, async (t) => {
    const f = fixture(t);
    f.onConnect((client) => {
      if (client.cfg.host !== 'target.invalid') queueMicrotask(() => client.conn.emit('ready'));
    });
    const pending = f.pool.connect('target');
    const result = outcome(pending);
    await flush();
    assert.equal(f.clients.length, 3);
    if (closeAll) f.pool.closeAll(); else f.pool.close('target');
    f.clients[2].conn.emit('ready');
    assert.match(await result, rejection);
    assert.ok(f.clients.every((c) => c.ended));
    f.onConnect((client) => queueMicrotask(() => client.conn.emit('ready')));
    assert.notEqual(await f.pool.connect('target'), f.clients[2].conn);
  });
}

test('HostPool close before connection startup prevents any clients from opening', async (t) => {
  const f = fixture(t);
  const result = outcome(f.pool.connect('target'));
  f.pool.close('target');
  assert.match(await result, rejection);
  assert.equal(f.clients.length, 0);
});

test('HostPool closes late forward callbacks and does not delete a replacement entry', async (t) => {
  const f = fixture(t);
  f.onForward((target) => target === 'target.invalid' ? 'hold' : undefined);
  const oldResult = outcome(f.pool.connect('target'));
  await flush();
  f.pool.close('target');
  const oldJump = f.clients[1].conn;
  f.onForward(() => undefined);
  const next = await f.pool.connect('target');
  oldJump.emit('close');
  oldJump.emit('error', new Error('fixture delayed old error'));
  const late = f.forwards[1].finish();
  assert.match(await oldResult, rejection);
  assert.ok(late.destroyed);
  assert.equal(await f.pool.connect('target'), next);
  assert.equal(f.clients.length, 5);
});

test('HostPool cancellation between a successful forward callback and its continuation closes the channel', async (t) => {
  const f = fixture(t);
  f.onForward((target) => target === 'target.invalid' ? 'hold' : undefined);
  const result = outcome(f.pool.connect('target'));
  await flush();
  const channel = f.forwards[1].finish();
  f.pool.close('target');
  assert.match(await result, rejection);
  assert.ok(channel.destroyed);
  assert.equal(f.clients.length, 2);
  assert.ok(f.clients.every((c) => c.ended));
});

test('HostPool intermediate disconnect cancels a pending forward and closes a late channel', async (t) => {
  const f = fixture(t);
  f.onForward((target) => target === 'target.invalid' ? 'hold' : undefined);
  const result = outcome(f.pool.connect('target'));
  await flush();
  f.clients[1].conn.emit('end');
  assert.match(await result, rejection);
  const channel = f.forwards[1].finish();
  assert.ok(channel.destroyed);
  assert.ok(f.clients.every((c) => c.ended));
});

test('HostPool closes dependent pending chains without disturbing unrelated hosts', async (t) => {
  const f = fixture(t, [host('gateway'), host('jump', 'gateway'), host('target', 'jump'), host('unrelated')]);
  const unrelated = await f.pool.connect('unrelated');
  f.onConnect((client) => {
    if (client.cfg.host !== 'target.invalid') queueMicrotask(() => client.conn.emit('ready'));
  });
  const result = outcome(f.pool.connect('target'));
  await flush();
  f.pool.close('gateway');
  f.clients.at(-1)!.conn.emit('ready');
  assert.match(await result, rejection);
  assert.ok(f.clients.filter((c) => c.conn !== unrelated).every((c) => c.ended));
  assert.equal(await f.pool.connect('unrelated'), unrelated);
});

test('HostPool test uses an independent chain and closeAll also cancels pending tests', async (t) => {
  const f = fixture(t);
  const cached = await f.pool.connect('target');
  assert.equal((await f.pool.test(f.hosts[2])).ok, true);
  assert.equal(f.clients.length, 6);
  assert.ok(f.clients.slice(3).every((c) => c.ended));
  assert.ok(f.clients.slice(0, 3).every((c) => !c.ended));
  assert.equal(await f.pool.connect('target'), cached);
  f.onConnect(() => {});
  const pending = f.pool.test(f.hosts[2]);
  await flush();
  f.pool.closeAll();
  f.clients.at(-1)!.conn.emit('ready');
  const result = await Promise.race([pending, flush().then(() => undefined)]);
  assert.equal(result?.ok, false);
  assert.ok(f.clients.every((c) => c.ended));
});
