/**
 * 时序落盘:`~/.dsh/server-deck-metrics/{hostId}/raw.jsonl` + settings.json。
 * 原始点保留约 3h;1 分钟 / 15 分钟 / 1 小时 rollup 分别留 24h / 7d / 31d。
 */

import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BUCKET_MS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  rollup,
} from '../metrics.ts';
import type { MetricPoint, MetricSample, MetricsSettings } from '../types.ts';

export const DEFAULT_METRICS_DIR = join(homedir(), '.dsh', 'server-deck-metrics');

const RAW_KEEP_MS = 3 * 3600_000 + 5 * 60_000;
const M1_KEEP_MS = 24 * 3600_000 + 10 * 60_000;
const M15_KEEP_MS = 7 * 24 * 3600_000 + 60 * 60_000;
const H1_KEEP_MS = 31 * 24 * 3600_000 + 60 * 60_000;

const COMPACT_EVERY_MS = 5 * 60_000;

type Layer = 'raw' | 'm1' | 'm15' | 'h1';

function layerFile(root: string, hostId: string, layer: Layer): string {
  return join(root, hostId, `${layer}.jsonl`);
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

function parseLine(line: string): MetricSample | undefined {
  const t = line.trim();
  if (t.length === 0) return undefined;
  try {
    const o = JSON.parse(t) as MetricSample;
    if (typeof o.t !== 'number' || !Number.isFinite(o.t)) return undefined;
    return o;
  } catch {
    return undefined;
  }
}

async function readJsonl(path: string): Promise<MetricSample[]> {
  try {
    const text = await readFile(path, 'utf8');
    const out: MetricSample[] = [];
    for (const line of text.split('\n')) {
      const s = parseLine(line);
      if (s !== undefined) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

function pointToSample(p: MetricPoint): MetricSample {
  return {
    t: p.t,
    cpu: p.cpu,
    mem: p.mem,
    disk: p.disk,
    latencyMs: p.latencyMs,
    online: p.online,
  };
}

/** 指标仓库:append-only JSONL + 定时压缩。rootDir 可注入,方便单测。 */
export class MetricStore {
  private lastCompactAt = 0;
  private settings: MetricsSettings = { ...DEFAULT_SETTINGS };
  private latest = new Map<string, MetricSample>();
  /** 内存环形缓冲,供 3h 细粒度查询,避免每次读盘。 */
  private rawCache = new Map<string, MetricSample[]>();
  /** 已删除主机:挡住在途 compact/append 把目录重建出来(竞态)。 */
  private removed = new Set<string>();
  /** 每主机写锁:append / compact / removeHost 串行,防压缩旧读数覆盖新行。 */
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(hostId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(hostId, next.catch(() => { /* 错误随调用方返回 */ }));
    return next;
  }

  constructor(private readonly rootDir: string = DEFAULT_METRICS_DIR) {}

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(join(this.rootDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
      this.settings = normalizeSettings(raw);
      // 迁移:旧版默认 30s → 新默认 10s
      if (raw.collectIntervalSec === 30) {
        this.settings = { ...this.settings, collectIntervalSec: 10 };
        await this.saveSettings(this.settings).catch(() => { /* 下次再写 */ });
      }
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    let hostIds: string[] = [];
    try {
      hostIds = (await readdir(this.rootDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      hostIds = [];
    }
    const now = Date.now();
    for (const id of hostIds) {
      const raw = await readJsonl(layerFile(this.rootDir, id, 'raw'));
      const kept = raw.filter((s) => s.t >= now - RAW_KEEP_MS);
      this.rawCache.set(id, kept);
      const last = kept[kept.length - 1] ?? (await this.newestFromLayers(id));
      if (last !== undefined) this.latest.set(id, last);
    }
  }

  getSettings(): MetricsSettings {
    return this.settings;
  }

  async saveSettings(next: MetricsSettings): Promise<MetricsSettings> {
    this.settings = normalizeSettings(next);
    await mkdir(this.rootDir, { recursive: true });
    await atomicWrite(join(this.rootDir, 'settings.json'), JSON.stringify(this.settings, null, 2));
    return this.settings;
  }

  getLatest(hostId: string): MetricSample | undefined {
    return this.latest.get(hostId);
  }

  allLatest(): ReadonlyMap<string, MetricSample> {
    return this.latest;
  }

  async append(hostId: string, sample: MetricSample): Promise<void> {
    if (this.removed.has(hostId)) return;
    await this.withLock(hostId, async () => {
      if (this.removed.has(hostId)) return;
      await mkdir(join(this.rootDir, hostId), { recursive: true });
      await appendFile(layerFile(this.rootDir, hostId, 'raw'), `${JSON.stringify(sample)}\n`, 'utf8');
      this.latest.set(hostId, sample);
      const buf = this.rawCache.get(hostId) ?? [];
      buf.push(sample);
      const cut = sample.t - RAW_KEEP_MS;
      this.rawCache.set(hostId, buf.filter((s) => s.t >= cut));
    });
    if (Date.now() - this.lastCompactAt > COMPACT_EVERY_MS) {
      this.lastCompactAt = Date.now();
      void this.compact(hostId).catch(() => { /* 下轮再压 */ });
    }
  }

  /**
   * 取窗口内样本:短窗走 raw,长窗合并 rollup 层。
   * 返回的样本已按 t 升序,可能含各层粒度混杂——调用方再 rollup。
   */
  async query(hostId: string, from: number, to: number): Promise<MetricSample[]> {
    const span = to - from;
    if (span <= RAW_KEEP_MS) {
      const cached = this.rawCache.get(hostId);
      if (cached !== undefined) return cached.filter((s) => s.t >= from && s.t <= to);
      const raw = await readJsonl(layerFile(this.rootDir, hostId, 'raw'));
      return raw.filter((s) => s.t >= from && s.t <= to);
    }
    const layers: Layer[] = span <= M1_KEEP_MS
      ? ['raw', 'm1']
      : span <= M15_KEEP_MS
        ? ['m1', 'm15']
        : ['m1', 'm15', 'h1'];
    const merged: MetricSample[] = [];
    const seen = new Set<number>();
    for (const layer of layers) {
      const rows = layer === 'raw' && this.rawCache.has(hostId)
        ? this.rawCache.get(hostId) ?? []
        : await readJsonl(layerFile(this.rootDir, hostId, layer));
      for (const s of rows) {
        if (s.t < from || s.t > to) continue;
        if (seen.has(s.t)) continue;
        seen.add(s.t);
        merged.push(s);
      }
    }
    merged.sort((a, b) => a.t - b.t);
    return merged;
  }

  /** 批量写入(sar 回填用):单次 append,锁内执行。 */
  async appendMany(hostId: string, samples: MetricSample[]): Promise<void> {
    if (samples.length === 0 || this.removed.has(hostId)) return;
    await this.withLock(hostId, async () => {
      if (this.removed.has(hostId)) return;
      await mkdir(join(this.rootDir, hostId), { recursive: true });
      const body = samples.map((s) => JSON.stringify(s)).join('\n');
      await appendFile(layerFile(this.rootDir, hostId, 'raw'), `${body}\n`, 'utf8');
      let newest = this.latest.get(hostId);
      for (const s of samples) {
        if (newest === undefined || s.t > newest.t) newest = s;
      }
      if (newest !== undefined) this.latest.set(hostId, newest);
      const cut = Date.now() - RAW_KEEP_MS;
      const merged = [...(this.rawCache.get(hostId) ?? []), ...samples]
        .filter((s) => s.t >= cut)
        .sort((a, b) => a.t - b.t);
      this.rawCache.set(hostId, merged);
    });
  }

  /** 本地最早的样本时刻(跨 rollup 层);完全没有数据返回 undefined。 */
  async oldestT(hostId: string): Promise<number | undefined> {
    for (const layer of ['h1', 'm15', 'm1', 'raw'] as const) {
      const rows = await readJsonl(layerFile(this.rootDir, hostId, layer));
      if (rows.length > 0) return rows[0].t;
    }
    return undefined;
  }

  async removeHost(hostId: string): Promise<void> {
    this.latest.delete(hostId);
    this.rawCache.delete(hostId);
    this.removed.add(hostId);
    // 等在途写完成再删,避免目录被并发写复活
    await this.withLock(hostId, () =>
      rm(join(this.rootDir, hostId), { recursive: true, force: true, maxRetries: 3 }));
  }

  /** 把 raw 压进 m1/m15/h1 并裁剪过期行。公开给单测。 */
  async compact(hostId: string): Promise<void> {
    if (this.removed.has(hostId)) return;
    await this.withLock(hostId, () => this.doCompact(hostId));
  }

  private async doCompact(hostId: string): Promise<void> {
    if (this.removed.has(hostId)) return;
    const now = Date.now();
    const raw = await readJsonl(layerFile(this.rootDir, hostId, 'raw'));
    const rawKeep = raw.filter((s) => s.t >= now - RAW_KEEP_MS);
    await this.writeLayer(hostId, 'raw', rawKeep);
    // 锁内无并发 append,缓存直接对齐本次读数;已删除主机不回写。
    if (!this.removed.has(hostId)) this.rawCache.set(hostId, rawKeep);

    await this.mergeLayer(hostId, 'm1', raw, now - M1_KEEP_MS, now, BUCKET_MS['1m']);
    const m1 = await readJsonl(layerFile(this.rootDir, hostId, 'm1'));
    await this.mergeLayer(hostId, 'm15', m1, now - M15_KEEP_MS, now, BUCKET_MS['15m']);
    const m15 = await readJsonl(layerFile(this.rootDir, hostId, 'm15'));
    await this.mergeLayer(hostId, 'h1', m15, now - H1_KEEP_MS, now, BUCKET_MS['1h']);
  }

  private async mergeLayer(
    hostId: string,
    layer: Exclude<Layer, 'raw'>,
    source: MetricSample[],
    keepFrom: number,
    now: number,
    bucketMs: number,
  ): Promise<void> {
    const existing = await readJsonl(layerFile(this.rootDir, hostId, layer));
    const rolled = rollup(source, keepFrom, now, bucketMs).map(pointToSample);
    const byT = new Map<number, MetricSample>();
    for (const s of existing) {
      if (s.t >= keepFrom) byT.set(s.t, s);
    }
    for (const s of rolled) byT.set(s.t, s);
    const next = [...byT.values()].sort((a, b) => a.t - b.t);
    await this.writeLayer(hostId, layer, next);
  }

  private async writeLayer(hostId: string, layer: Layer, rows: MetricSample[]): Promise<void> {
    if (this.removed.has(hostId)) return;
    await mkdir(join(this.rootDir, hostId), { recursive: true });
    const body = rows.map((s) => JSON.stringify(s)).join('\n');
    await atomicWrite(layerFile(this.rootDir, hostId, layer), body.length === 0 ? '' : `${body}\n`);
  }

  private async newestFromLayers(hostId: string): Promise<MetricSample | undefined> {
    for (const layer of ['raw', 'm1', 'm15', 'h1'] as const) {
      const rows = await readJsonl(layerFile(this.rootDir, hostId, layer));
      if (rows.length > 0) return rows[rows.length - 1];
    }
    return undefined;
  }
}
