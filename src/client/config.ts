/**
 * 客户端本地偏好:面板宽度 / 自动刷新周期 / 趋势窗口与粒度(localStorage,损坏自动回落)。
 */

const WIDTH_KEY = 'serverDeck.width';
const REFRESH_KEY = 'serverDeck.refreshSec';
const RANGE_KEY = 'serverDeck.trendRange';
const BUCKET_KEY = 'serverDeck.trendBucket';

export function loadPanelWidth(): number {
  const raw = globalThis.localStorage?.getItem(WIDTH_KEY);
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(760, Math.max(380, n)) : 480;
}

export function savePanelWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(WIDTH_KEY, String(Math.min(760, Math.max(380, Math.round(width)))));
  } catch { /* 隐私模式等 */ }
}

export function loadRefreshSec(): number {
  const raw = globalThis.localStorage?.getItem(REFRESH_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(120, n) : 15;
}

export function saveRefreshSec(sec: number): void {
  try {
    globalThis.localStorage?.setItem(REFRESH_KEY, String(Math.min(120, Math.max(0, Math.round(sec)))));
  } catch { /* 同上 */ }
}

export type TrendRangePref = '1h' | '24h' | '7d' | '30d' | 'custom';

const RANGE_PREFS: readonly TrendRangePref[] = ['1h', '24h', '7d', '30d', 'custom'];

export function loadTrendRange(): TrendRangePref {
  const raw = globalThis.localStorage?.getItem(RANGE_KEY);
  if (raw === '3h') return '1h'; // 旧偏好迁移
  if (raw === 'today') return '24h';
  return RANGE_PREFS.includes(raw as TrendRangePref) ? (raw as TrendRangePref) : '1h';
}

export function saveTrendRange(range: TrendRangePref): void {
  try {
    globalThis.localStorage?.setItem(RANGE_KEY, range);
  } catch { /* 同上 */ }
}

const BUCKET_PREFS = ['auto', '10s', '30s', '1m', '5m', '15m', '1h'];

export function loadTrendBucket(): string {
  const raw = globalThis.localStorage?.getItem(BUCKET_KEY);
  return BUCKET_PREFS.includes(raw ?? '') ? (raw as string) : 'auto';
}

export function saveTrendBucket(bucket: string): void {
  try {
    globalThis.localStorage?.setItem(BUCKET_KEY, bucket);
  } catch { /* 同上 */ }
}
