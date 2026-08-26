/**
 * 客户端本地偏好:面板宽度 / 自动刷新周期(localStorage,损坏自动回落)。
 */

const WIDTH_KEY = 'serverDeck.width';
const REFRESH_KEY = 'serverDeck.refreshSec';

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
