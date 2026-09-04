/**
 * 历史回填:本地时序没有覆盖到的窗口,尝试从服务器上的 sysstat(sar)
 * 日志抓历史 CPU/内存,并进本地时序。磁盘容量 sar 不记录,无法回填。
 *
 * 触发条件(全部满足才真正发 SSH):
 *   - 该主机距上次尝试 ≥ 10 分钟(限频);
 *   - 本地最早样本晚于窗口起点(本地数据没覆盖住)。
 * sar 未安装 / 主机离线 → 静默跳过,不影响正常查询。
 */

import type { MetricSample } from '../types.ts';
import type { HostPool } from './pool.ts';
import type { MetricStore } from './metric-store.ts';

const SAR_CMD = 'LC_ALL=C sar -u 2>/dev/null; echo "@@SAR-R@@"; LC_ALL=C sar -r 2>/dev/null';
const ATTEMPT_GAP_MS = 10 * 60_000;
const SAR_TIMEOUT_MS = 12_000;

function clamp01(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

interface SarRow { h: number; m: number; s: number; cpu?: number; mem?: number }

/** 表头行里取列索引(表头 token 在 sysstat 各版本间稳定)。 */
function headerIndex(line: string, token: string): number {
  return line.trim().split(/\s+/).indexOf(token);
}

/** 解析 sar -u / sar -r 输出为带小时位的行。 */
export function parseSarRows(raw: string): SarRow[] {
  const [cpuPart, memPart = ''] = raw.split('@@SAR-R@@');
  const rows = new Map<string, SarRow>();

  const cpuLines = cpuPart.split('\n');
  const cpuHeader = cpuLines.find((l) => l.includes('%idle'));
  const idleIdx = cpuHeader !== undefined ? headerIndex(cpuHeader, '%idle') : -1;
  if (idleIdx >= 0) {
    for (const line of cpuLines) {
      const cols = line.trim().split(/\s+/);
      // "00:05:01  all  1.2  ..." — 单机聚合行第二列为 all
      if (!/^\d{1,2}:\d{2}:\d{2}$/.test(cols[0] ?? '') || cols[1] !== 'all') continue;
      const idle = Number(cols[idleIdx]);
      if (!Number.isFinite(idle)) continue;
      const [h, m, s] = cols[0].split(':').map(Number);
      rows.set(cols[0], { h, m, s, cpu: clamp01(100 - idle) });
    }
  }

  const memLines = memPart.split('\n');
  const memHeader = memLines.find((l) => l.includes('%memused'));
  const memIdx = memHeader !== undefined ? headerIndex(memHeader, '%memused') : -1;
  if (memIdx >= 0) {
    for (const line of memLines) {
      const cols = line.trim().split(/\s+/);
      if (!/^\d{1,2}:\d{2}:\d{2}$/.test(cols[0] ?? '')) continue;
      const mem = Number(cols[memIdx]);
      if (!Number.isFinite(mem)) continue;
      const [h, m, s] = cols[0].split(':').map(Number);
      const exist = rows.get(cols[0]);
      if (exist !== undefined) exist.mem = clamp01(mem);
      else rows.set(cols[0], { h, m, s, mem: clamp01(mem) });
    }
  }
  return [...rows.values()];
}

/** 把小时位映射成时间戳:sar 是「服务器本地时间」,时区未知 → 本地/UTC 两种解释取窗口命中多者。 */
export function sarRowsToSamples(rows: SarRow[], from: number, to: number, now: number): MetricSample[] {
  if (rows.length === 0) return [];
  const base = new Date(now);
  const y = base.getFullYear();
  const mo = base.getMonth();
  const d = base.getDate();
  const build = (utc: boolean): MetricSample[] =>
    rows.flatMap((r) => {
      const t = utc
        ? Date.UTC(y, mo, d, r.h, r.m, r.s)
        : new Date(y, mo, d, r.h, r.m, r.s).getTime();
      if (t < from - 60_000 || t > to) return [];
      return [{ t, cpu: r.cpu, mem: r.mem, online: true }];
    });
  const localHits = build(false);
  const utcHits = build(true);
  const pick = utcHits.length > localHits.length ? utcHits : localHits;
  return pick.sort((a, b) => a.t - b.t);
}

export class SarBackfill {
  private lastAttempt = new Map<string, number>();

  constructor(
    private readonly pool: HostPool,
    private readonly metrics: MetricStore,
  ) {}

  /** 查询前调用:需要且允许时,从服务器 sar 回填一段历史。 */
  async ensure(hostId: string, from: number, to: number): Promise<void> {
    const now = Date.now();
    const last = this.lastAttempt.get(hostId) ?? 0;
    if (now - last < ATTEMPT_GAP_MS) return;
    const oldest = await this.metrics.oldestT(hostId);
    // 本地数据已覆盖窗口起点(或查的是近期窗口)→ 不打扰服务器
    if (oldest !== undefined && from >= oldest - 60_000) return;
    this.lastAttempt.set(hostId, now);
    try {
      const { stdout } = await this.pool.exec(hostId, SAR_CMD, SAR_TIMEOUT_MS);
      const samples = sarRowsToSamples(parseSarRows(stdout), from, to, now);
      if (samples.length > 0) await this.metrics.appendMany(hostId, samples);
    } catch {
      // sar 缺失 / 主机离线:静默跳过
    }
  }
}
