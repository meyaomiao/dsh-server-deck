import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MetricRecorder } from '../src/server/recorder.ts';
import type { HostStore } from '../src/server/store.ts';
import type { HostPool } from '../src/server/pool.ts';
import type { MetricStore } from '../src/server/metric-store.ts';
import type { HostEntry, MetricSample, MetricsSettings, NetMonthState } from '../src/types.ts';

type ExecResult = { code: number | null; stdout: string; stderr: string };
const output = (cpu = 20, os = 'fixture'): ExecResult => ({
  code: 0, stderr: '', stdout: `@@OS@@\nLinux\nPRETTY_NAME="${os}"\n@@CPU@@\nwinload=${cpu}\n`,
});
const month: NetMonthState = { ym: '2026-11', rxBytes: 10, txBytes: 20 };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

interface Hooks {
  connect?: (id: string) => Promise<unknown>;
  posix?: (id: string) => Promise<ExecResult>;
  windows?: (id: string) => Promise<ExecResult>;
  net?: (id: string) => Promise<NetMonthState>;
  append?: (id: string, sample: MetricSample) => Promise<void>;
}

function fixture(t: TestContext, count = 1, hooks: Hooks = {}) {
  const hosts = Array.from({ length: count }, (_, i) => ({ id: `fixture-${i + 1}` } as HostEntry));
  const calls = {
    connect: [] as string[], posix: [] as string[], windows: [] as string[], net: [] as string[],
    append: [] as { id: string; sample: MetricSample }[],
  };
  const settings: MetricsSettings = { recording: true, collectIntervalSec: 10, pausedHostIds: [] };
  const ssh = {
    async connect(id: string) { calls.connect.push(id); return hooks.connect?.(id); },
    async execSh(id: string) { calls.posix.push(id); return hooks.posix?.(id) ?? output(); },
    async exec(id: string) { calls.windows.push(id); return hooks.windows?.(id) ?? output(); },
  };
  const metrics = {
    getSettings: () => settings,
    getNetMonth: () => undefined,
    async applyNetSample(id: string) { calls.net.push(id); return hooks.net?.(id) ?? month; },
    async append(id: string, sample: MetricSample) {
      calls.append.push({ id, sample });
      await hooks.append?.(id, sample);
    },
  };
  const recorder = new MetricRecorder({ list: () => hosts } as unknown as HostStore, ssh as unknown as HostPool, metrics as unknown as MetricStore);
  t.after(() => recorder.stop());
  return { recorder, calls, settings };
}

for (const result of ['resolve', 'reject'] as const) {
  test(`stop during four pending connects prevents fifth host and later requests (${result})`, async (t) => {
    const gates = Array.from({ length: 4 }, () => deferred<unknown>());
    const f = fixture(t, 5, { connect: (id) => gates[Number(id.slice(-1)) - 1]?.promise ?? Promise.resolve() });
    const tick = f.recorder.tick(false);
    assert.equal(f.calls.connect.length, 4);
    f.recorder.stop();
    for (const gate of gates) {
      if (result === 'resolve') gate.resolve(undefined);
      else gate.reject(new Error('fixture unload'));
    }
    assert.ok((await tick).every((status) => status.state === 'unknown'));
    assert.equal(f.calls.connect.length, 4);
    assert.deepEqual(f.calls.posix, []);
    assert.deepEqual(f.calls.windows, []);
    assert.deepEqual(f.calls.append, []);
  });
}

for (const useful of [true, false]) {
  test(`stop during POSIX exec prevents ${useful ? 'metric writes' : 'PowerShell fallback'}`, async (t) => {
    const gate = deferred<ExecResult>();
    const f = fixture(t, 1, { posix: () => gate.promise });
    const tick = f.recorder.tick(false);
    await flush();
    assert.equal(f.calls.posix.length, 1);
    f.recorder.stop();
    gate.resolve(useful ? output() : { code: 127, stdout: '', stderr: 'no sh' });
    assert.deepEqual(await tick, [{ id: 'fixture-1', state: 'unknown' }]);
    assert.deepEqual(f.calls.windows, []);
    assert.deepEqual(f.calls.net, []);
    assert.deepEqual(f.calls.append, []);
  });
}

for (const result of ['resolve', 'reject'] as const) {
  test(`stop during PowerShell exec discards result without offline write (${result})`, async (t) => {
    const gate = deferred<ExecResult>();
    const f = fixture(t, 1, { posix: async () => ({ code: 127, stdout: '', stderr: '' }), windows: () => gate.promise });
    const tick = f.recorder.tick(false);
    await flush();
    assert.equal(f.calls.windows.length, 1);
    f.recorder.stop();
    if (result === 'resolve') gate.resolve(output());
    else gate.reject(new Error('fixture shutdown'));
    assert.deepEqual(await tick, [{ id: 'fixture-1', state: 'unknown' }]);
    assert.deepEqual(f.calls.net, []);
    assert.deepEqual(f.calls.append, []);
  });
}

test('stop during network sample persistence prevents later append and snapshot', async (t) => {
  const gate = deferred<NetMonthState>();
  const f = fixture(t, 1, { net: () => gate.promise });
  const tick = f.recorder.tick(false);
  await flush();
  assert.equal(f.calls.net.length, 1);
  f.recorder.stop();
  gate.resolve(month);
  assert.deepEqual(await tick, [{ id: 'fixture-1', state: 'unknown' }]);
  assert.deepEqual(f.calls.append, []);
});

for (const offline of [false, true]) {
  test(`stop during ${offline ? 'offline' : 'online'} append prevents old snapshot publication`, async (t) => {
    const gate = deferred<void>();
    const f = fixture(t, 1, {
      ...(offline ? { connect: async () => { throw new Error('fixture failure'); } } : {}),
      append: () => gate.promise,
    });
    const tick = f.recorder.tick(false);
    await flush();
    assert.equal(f.calls.append.length, 1);
    f.recorder.stop();
    gate.resolve();
    assert.deepEqual(await tick, [{ id: 'fixture-1', state: 'unknown' }]);
    assert.equal(f.recorder.latestOf('fixture-1').state, 'unknown');
  });
}

test('arm and forced ticks cannot revive a stopped recorder; start restores collection', async (t) => {
  let timers = 0;
  const setInterval = t.mock.method(globalThis, 'setInterval', () => { timers += 1; return {} as ReturnType<typeof globalThis.setInterval>; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const f = fixture(t);
  f.recorder.stop();
  f.recorder.arm();
  await f.recorder.tick(true);
  assert.equal(timers, 0);
  assert.deepEqual(f.calls.connect, []);
  f.recorder.start();
  await flush();
  assert.equal(timers, 1);
  assert.equal(f.calls.connect.length, 1);
  assert.equal(f.recorder.latestOf('fixture-1').state, 'online');
  assert.equal(setInterval.mock.callCount(), 1);
});

test('restart admits a new batch while an old connect is pending and ignores the old result', async (t) => {
  const stale = deferred<unknown>();
  let connections = 0;
  const f = fixture(t, 1, { connect: () => ++connections === 1 ? stale.promise : Promise.resolve() });
  const oldTick = f.recorder.tick(false);
  f.recorder.stop();
  f.recorder.start();
  await flush();
  assert.equal(f.calls.connect.length, 2);
  assert.equal(f.recorder.latestOf('fixture-1').state, 'online');
  const current = f.recorder.latestOf('fixture-1');
  stale.reject(new Error('stale connection'));
  await oldTick;
  assert.deepEqual(f.recorder.latestOf('fixture-1'), current);
  assert.equal(f.calls.posix.length, 1);
  assert.equal(f.calls.append.length, 1);
});

test('old batch completion cannot unlock another tick while the restarted batch is busy', async (t) => {
  const old = deferred<unknown>();
  const current = deferred<unknown>();
  let connections = 0;
  const f = fixture(t, 1, { connect: () => ++connections === 1 ? old.promise : current.promise });
  const oldTick = f.recorder.tick(false);
  f.recorder.stop();
  f.recorder.start();
  assert.equal(f.calls.connect.length, 2);
  old.resolve(undefined);
  await oldTick;
  await f.recorder.tick(true);
  assert.equal(f.calls.connect.length, 2);
  current.resolve(undefined);
  await flush();
  assert.equal(f.recorder.latestOf('fixture-1').state, 'online');
});

test('manual ticks before start and force while running preserve recording and pause behavior', async (t) => {
  const f = fixture(t, 2);
  f.settings.recording = false;
  f.settings.pausedHostIds = ['fixture-2'];
  assert.ok((await f.recorder.tick(false)).every((status) => status.state === 'unknown'));
  assert.deepEqual(f.calls.connect, []);
  assert.ok((await f.recorder.tick(true)).every((status) => status.state === 'online'));
  assert.equal(f.calls.connect.length, 2);
  f.recorder.start();
  await flush();
  await f.recorder.tick(true);
  assert.equal(f.calls.connect.length, 4);
  f.settings.recording = true;
  await f.recorder.tick(false);
  assert.equal(f.calls.connect.length, 5);
  assert.equal(f.calls.windows.length, 0);
});

test('normal collection still records Windows fallback and genuine offline results', async (t) => {
  const f = fixture(t, 2, {
    connect: async (id) => { if (id === 'fixture-2') throw new Error('fixture offline'); },
    posix: async () => ({ code: 127, stdout: '', stderr: '' }),
  });
  const statuses = await f.recorder.tick(false);
  assert.deepEqual(statuses.map((status) => status.state), ['online', 'offline']);
  assert.equal(statuses[0].cpuPercent, 20);
  assert.match(statuses[1].error ?? '', /fixture offline/);
  assert.deepEqual(f.calls.windows, ['fixture-1']);
  assert.deepEqual(f.calls.append.map((call) => call.sample.online).sort(), [false, true]);
});
