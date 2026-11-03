import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/index.ts';
import { HostStore } from '../src/server/store.ts';
import { MetricStore } from '../src/server/metric-store.ts';
import { MetricRecorder } from '../src/server/recorder.ts';
import { HostPool } from '../src/server/pool.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(t: TestContext) {
  const hostLoad = deferred();
  const metricsLoad = deferred();
  const hostMock = t.mock.method(HostStore.prototype, 'load', () => hostLoad.promise);
  const metricsMock = t.mock.method(MetricStore.prototype, 'load', () => metricsLoad.promise);
  const start = t.mock.method(MetricRecorder.prototype, 'start', () => {});
  const stop = t.mock.method(MetricRecorder.prototype, 'stop', () => {});
  const close = t.mock.method(HostPool.prototype, 'closeAll', () => {});
  const cleanups: (() => void)[] = [];
  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer: { register: () => () => {}, registerUpgrade: () => () => {} },
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    effect(install: () => () => void) { cleanups.push(install()); },
  };
  apply(ctx as unknown as Context);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of [...cleanups].reverse()) cleanup();
  };
  t.after(dispose);
  return { hostLoad, metricsLoad, hostMock, metricsMock, start, stop, close, dispose };
}

for (const stage of ['host', 'metrics']) {
  test(`unloading during ${stage} load cannot restart the recorder`, async (t) => {
    const f = setup(t);
    assert.equal(f.hostMock.mock.callCount(), 1);
    if (stage === 'metrics') {
      f.hostLoad.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.metricsMock.mock.callCount(), 1);
    }
    f.dispose();
    assert.equal(f.stop.mock.callCount(), 1);
    assert.equal(f.close.mock.callCount(), 1);
    f.hostLoad.resolve();
    f.metricsLoad.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.start.mock.callCount(), 0);
  });
}

test('loaded plugin starts the recorder once and stops it on unload', async (t) => {
  const f = setup(t);
  f.hostLoad.resolve();
  f.metricsLoad.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.start.mock.callCount(), 1);
  f.dispose();
  assert.equal(f.stop.mock.callCount(), 1);
  assert.equal(f.close.mock.callCount(), 1);
});
