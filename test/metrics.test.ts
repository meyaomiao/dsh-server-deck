process.env.TZ = 'Asia/Shanghai';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowedBuckets,
  autoBucket,
  buildSeries,
  resolveBucket,
  resolveRange,
  rollup,
  summarizeField,
} from '../src/metrics.ts';
import { MetricStore } from '../src/server/metric-store.ts';
import { parseSarRows, sarRowsToSamples } from '../src/server/backfill.ts';
import type { MetricSample } from '../src/types.ts';

test('resolveRange:1h/24h 滚动 / 自然日对齐 / 自定义上限', () => {
  const now = Date.parse('2026-09-15T15:00:00+08:00');
  const one = resolveRange('1h', now);
  assert.equal(one.to - one.from, 3600_000);

  // 24 小时 = 滚动窗口,不按 0 点对齐
  const day = resolveRange('24h', now);
  assert.equal(day.to - day.from, 24 * 3600_000);
  assert.equal(day.to, now);
  assert.equal(day.from, Date.parse('2026-09-14T15:00:00+08:00'));

  // 一周/一个月按自然日对齐(含今天)
  const seven = resolveRange('7d', now);
  assert.equal(seven.from, Date.parse('2026-09-09T00:00:00+08:00'));
  assert.equal(seven.to, now);
  const thirty = resolveRange('30d', now);
  assert.equal(thirty.from, Date.parse('2026-08-17T00:00:00+08:00'));

  assert.throws(() => resolveRange('custom', now), /自定义周期无效/);
  assert.throws(
    () => resolveRange('custom', now, { from: now, to: now + 40 * 86400_000 }),
    /31 天/,
  );
  const custom = resolveRange('custom', now, { from: now - 2 * 3600_000, to: now });
  assert.equal(custom.to - custom.from, 2 * 3600_000);
});

test('粒度:1h 默认 10s,超 1200 点自动升档', () => {
  assert.equal(autoBucket(3600_000), '10s');
  assert.equal(autoBucket(3 * 3600_000), '1m');
  assert.equal(autoBucket(8 * 86400_000), '1h');

  // 10s 探针:3h 窗口 = 1080 点 ≤ 1200,允许
  const ok = resolveBucket(3 * 3600_000, '10s');
  assert.equal(ok.bucketUsed, '10s');

  // 24h 窗口 10s = 8640 点,升档到 1m
  const lifted = resolveBucket(24 * 3600_000, '10s');
  assert.equal(lifted.requested, '10s');
  assert.equal(lifted.bucketUsed, '1m');

  assert.ok(allowedBuckets(3 * 3600_000).includes('10s'));
  assert.ok(!allowedBuckets(24 * 3600_000).includes('10s'));
});

test('rollup 空桶省略;离线点 online=false 且不计入均值', () => {
  const from = 1_000_000;
  const samples: MetricSample[] = [
    { t: from + 1_000, cpu: 10, mem: 20, disk: 30, online: true },
    { t: from + 2_000, cpu: 30, mem: 40, disk: 50, online: true },
    { t: from + 12_000, online: false },
    { t: from + 22_000, cpu: 90, mem: 80, disk: 70, online: true },
  ];
  const points = rollup(samples, from, from + 30_000, 10_000);
  assert.equal(points.length, 3);
  assert.equal(points[0].cpu, 20);
  assert.equal(points[0].online, true);
  assert.equal(points[1].online, false);
  assert.equal(points[1].cpu, undefined);
  assert.equal(points[2].cpu, 90);

  const sum = summarizeField(samples, 'cpu');
  assert.equal(sum.samples, 3);
  assert.equal(sum.latest, 90);
  assert.equal(sum.avg, 43.3);
  assert.equal(sum.max, 90);
  assert.equal(sum.min, 10);
});

test('buildSeries 三指标独立摘要', () => {
  const samples: MetricSample[] = [
    { t: 10, cpu: 10, mem: 50, disk: 70, online: true },
    { t: 20, cpu: 20, mem: 60, disk: 70, online: true },
  ];
  const s = buildSeries('h1', samples, 0, 30_000, '10s');
  assert.equal(s.hostId, 'h1');
  assert.equal(s.cpu.avg, 15);
  assert.equal(s.mem.avg, 55);
  assert.equal(s.disk.avg, 70);
});

test('MetricStore append / query / 删主机', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sd-metrics-'));
  const store = new MetricStore(dir);
  await store.load();
  const t0 = Date.now() - 60_000;
  await store.append('srv_a', { t: t0, cpu: 11, mem: 22, disk: 33, online: true });
  await store.append('srv_a', { t: t0 + 30_000, cpu: 21, mem: 32, disk: 43, online: true });
  const rows = await store.query('srv_a', t0 - 1_000, t0 + 40_000);
  assert.equal(rows.length, 2);
  assert.equal(store.getLatest('srv_a')?.cpu, 21);

  const raw = await readFile(join(dir, 'srv_a', 'raw.jsonl'), 'utf8');
  assert.ok(raw.includes('"cpu":11'));

  await store.removeHost('srv_a');
  const after = await store.query('srv_a', t0, t0 + 40_000);
  assert.equal(after.length, 0);
});

test('MetricStore settings 规范化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sd-metrics-set-'));
  const store = new MetricStore(dir);
  await store.load();
  const saved = await store.saveSettings({
    collectIntervalSec: 10,
    recording: true,
    pausedHostIds: ['srv_x'],
  });
  assert.equal(saved.collectIntervalSec, 10);
  const again = new MetricStore(dir);
  await again.load();
  assert.equal(again.getSettings().collectIntervalSec, 10);
  assert.deepEqual(again.getSettings().pausedHostIds, ['srv_x']);
});

const SAR_OUT = [
  'Linux 6.8.0 (srv)   09/04/26   _x86_64_   (2 CPU)',
  '',
  '00:00:01        CPU     %usr   %nice    %sys  %iowait   %irq   %soft  %steal  %guest  %gnice   %idle',
  '00:10:01        all     1.52   0.00    1.20    0.01   0.00    0.01    0.00    0.00    0.00   97.26',
  '01:20:01        all     2.00   0.00    1.00    0.00   0.00    0.00    0.00    0.00    0.00   97.00',
  'Average:        all     1.76   0.00    1.10    0.01   0.00    0.01    0.00    0.00    0.00   97.13',
  '@@SAR-R@@',
  '00:00:01 kbmemfree kbavail kbmemused %memused kbbuffers kbcached kbcommit %commit kbactive kbinact kbdirty',
  '00:10:01    123456  654321    987654    37.40     1024   234567  1234567  45.67   345678  123456   123',
  '01:20:01    120000  650000    991110    38.00     1024   234000  1234000  45.70   346000  123400   130',
  'Average:       xxx     xxx       xxx    37.70      xxx      xxx      xxx    xxx      xxx     xxx   xxx',
].join('\n');

test('sar 回填:表头定位列,Average 行与非法值忽略', () => {
  const rows = parseSarRows(SAR_OUT);
  assert.equal(rows.length, 2);
  // clamp01 保留 1 位小数:100 - 97.26 = 2.74 → 2.7
  assert.equal(rows[0].cpu, 2.7);
  assert.equal(rows[0].mem, 37.4);
  assert.equal(rows[1].cpu, 3);
  assert.equal(rows[1].mem, 38);
});

test('sar 回填:小时位映射进窗口(本地/UTC 择优)', () => {
  const rows = parseSarRows(SAR_OUT);
  const now = Date.parse('2026-09-04T02:00:00+08:00');
  const samples = sarRowsToSamples(rows, now - 5 * 3600_000, now, now);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].online, true);
  assert.ok(samples[0].t >= now - 5 * 3600_000 && samples[0].t <= now);
  // 磁盘无法回填:样本不含 disk
  assert.equal(samples[0].disk, undefined);
});
