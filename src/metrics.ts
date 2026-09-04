/**
 * 趋势窗口 / 粒度 / rollup / 摘要——纯函数,host 与单测共用。
 */

import type {
  HostMetricSeries,
  MetricBucket,
  MetricFieldSummary,
  MetricPoint,
  MetricRangeKind,
  MetricSample,
  MetricsSettings,
} from './types.ts';

export const BUCKET_MS: Record<MetricBucket, number> = {
  '10s': 10_000,
  '30s': 30_000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
};

export const ALL_BUCKETS: readonly MetricBucket[] = ['10s', '30s', '1m', '5m', '15m', '1h'];

/** 单次查询点数上限;3h@10s = 1080,因此放到 1200。 */
export const MAX_POINTS = 1200;

const THREE_H_MS = 3 * 3600_000;
const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 31 * DAY_MS;

export const DEFAULT_SETTINGS: MetricsSettings = {
  collectIntervalSec: 10,
  recording: true,
  pausedHostIds: [],
};

export function isMetricRangeKind(v: string): v is MetricRangeKind {
  return v === '1h' || v === '24h' || v === '7d' || v === '30d' || v === 'custom';
}

export function isMetricBucket(v: string): v is MetricBucket {
  return v === '10s' || v === '30s' || v === '1m' || v === '5m' || v === '15m' || v === '1h';
}

/** 本地 0 点(unix ms)。 */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 解析时间窗口(全部按本地时区):
 *   1h  = 滚动最近 1 小时(默认实时视图)
 *   24h = 滚动过去 24 小时
 *   7d  = 最近 7 个自然日(6 天前 0 点起,含今天)
 *   30d = 最近 30 个自然日(29 天前 0 点起,含今天)
 *   custom = 起止毫秒,最长 31 天
 */
export function resolveRange(
  kind: MetricRangeKind,
  now: number,
  custom?: { from: number; to: number },
): { from: number; to: number } {
  if (kind === 'custom') {
    if (
      custom === undefined
      || !Number.isFinite(custom.from)
      || !Number.isFinite(custom.to)
      || custom.to <= custom.from
    ) {
      throw Object.assign(new Error('自定义周期无效'), { status: 400 });
    }
    if (custom.to - custom.from > MONTH_MS + 60_000) {
      throw Object.assign(new Error('自定义周期最长 31 天'), { status: 400 });
    }
    return { from: Math.round(custom.from), to: Math.round(custom.to) };
  }
  if (kind === '1h') return { from: now - 3600_000, to: now };
  if (kind === '24h') return { from: now - DAY_MS, to: now };
  if (kind === '7d') return { from: startOfDay(now) - 6 * DAY_MS, to: now };
  if (kind === '30d') return { from: startOfDay(now) - 29 * DAY_MS, to: now };
  return { from: now - DAY_MS, to: now };
}

export function autoBucket(rangeMs: number): MetricBucket {
  if (rangeMs <= 3600_000 + 60_000) return '10s';
  if (rangeMs <= DAY_MS + 60_000) return '1m';
  if (rangeMs <= WEEK_MS + 60_000) return '15m';
  return '1h';
}

/**
 * 选定展示粒度:10s 配合 10s 探针,在点数上限内任意窗口可用;
 * 超过 MAX_POINTS(1200) 自动升档。
 */
export function resolveBucket(
  rangeMs: number,
  requested: MetricBucket | 'auto' = 'auto',
): { requested: MetricBucket | 'auto'; bucketUsed: MetricBucket } {
  if (requested === 'auto') {
    return { requested: 'auto', bucketUsed: autoBucket(rangeMs) };
  }
  if (rangeMs / BUCKET_MS[requested] > MAX_POINTS) {
    return { requested, bucketUsed: autoBucket(rangeMs) };
  }
  return { requested, bucketUsed: requested };
}

/** 当前窗口允许手动选择的粒度(点数上限内)。 */
export function allowedBuckets(rangeMs: number): MetricBucket[] {
  return ALL_BUCKETS.filter((b) => rangeMs / BUCKET_MS[b] <= MAX_POINTS);
}

function avg(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

function avgPoint(t: number, group: MetricSample[]): MetricPoint {
  const online = group.filter((s) => s.online);
  const pick = (field: 'cpu' | 'mem' | 'disk' | 'latencyMs'): number | undefined =>
    avg(online.map((s) => s[field]).filter((n): n is number => n !== undefined));
  return {
    t,
    cpu: pick('cpu'),
    mem: pick('mem'),
    disk: pick('disk'),
    latencyMs: pick('latencyMs'),
    online: online.length > 0,
  };
}

/** 按 bucket 对齐;空桶省略,前端按时间间隔断开折线。 */
export function rollup(samples: MetricSample[], from: number, to: number, bucketMs: number): MetricPoint[] {
  if (!(to > from) || !(bucketMs > 0)) return [];
  const n = Math.max(1, Math.ceil((to - from) / bucketMs));
  const buckets: MetricSample[][] = Array.from({ length: n }, () => []);
  for (const s of samples) {
    if (s.t < from || s.t > to) continue;
    const idx = Math.min(n - 1, Math.floor((s.t - from) / bucketMs));
    buckets[idx].push(s);
  }
  const points: MetricPoint[] = [];
  for (let i = 0; i < n; i++) {
    const group = buckets[i];
    if (group.length === 0) continue;
    points.push(avgPoint(from + i * bucketMs, group));
  }
  return points;
}

export function summarizeField(
  samples: readonly MetricSample[],
  field: 'cpu' | 'mem' | 'disk',
): MetricFieldSummary {
  const vals: number[] = [];
  let latest: number | undefined;
  for (const s of samples) {
    if (!s.online) continue;
    const v = s[field];
    if (v === undefined) continue;
    vals.push(v);
    latest = v;
  }
  if (vals.length === 0) return { samples: 0 };
  return {
    latest,
    avg: avg(vals),
    max: Math.max(...vals),
    min: Math.min(...vals),
    samples: vals.length,
  };
}

export function buildSeries(
  hostId: string,
  samples: MetricSample[],
  from: number,
  to: number,
  bucketUsed: MetricBucket,
): HostMetricSeries {
  return {
    hostId,
    from,
    to,
    bucket: bucketUsed,
    bucketUsed,
    points: rollup(samples, from, to, BUCKET_MS[bucketUsed]),
    cpu: summarizeField(samples, 'cpu'),
    mem: summarizeField(samples, 'mem'),
    disk: summarizeField(samples, 'disk'),
  };
}

export function normalizeSettings(raw: unknown): MetricsSettings {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const sec = Number(o.collectIntervalSec);
  const collectIntervalSec: MetricsSettings['collectIntervalSec'] =
    sec === 10 || sec === 30 || sec === 60 || sec === 300 ? sec : DEFAULT_SETTINGS.collectIntervalSec;
  const recording = o.recording !== false;
  const pausedHostIds = Array.isArray(o.pausedHostIds)
    ? o.pausedHostIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return { collectIntervalSec, recording, pausedHostIds };
}

/** 拒绝路径穿越。台账 id 形如 srv_<base36>_<rand>。 */
export function assertHostId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) {
    throw Object.assign(new Error('主机 id 无效'), { status: 400 });
  }
  return id;
}
