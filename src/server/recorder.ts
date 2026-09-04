/**
 * 主机侧常驻采集:按 collectIntervalSec tick,复用 HostPool,并发 4。
 * 与前端是否打开面板无关。面板「刷新」读 latest 快照,可选 force 打一轮。
 */

import type { HostStatus } from '../types.ts';
import type { HostPool } from './pool.ts';
import { PROBE_SCRIPT, parseProbeOutput } from './probe.ts';
import type { HostStore } from './store.ts';
import type { MetricStore } from './metric-store.ts';

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 4;
/** 完整系统信息(OS/uptime/核数)刷新间隔,趋势点只用 fast 字段。 */
const FULL_META_MS = 10 * 60_000;

export class MetricRecorder {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private lastFullAt = new Map<string, number>();
  private meta = new Map<string, Pick<HostStatus, 'osName' | 'uptimeText' | 'cores' | 'kernelOrUptime'>>();
  private snapshots = new Map<string, HostStatus>();

  constructor(
    private readonly hosts: HostStore,
    private readonly ssh: HostPool,
    private readonly metrics: MetricStore,
  ) {}

  start(): void {
    this.stop();
    const tick = (): void => { void this.tick(false); };
    tick();
    this.arm();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 采集周期被设置页改掉后重武装。 */
  arm(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const sec = this.metrics.getSettings().collectIntervalSec;
    this.timer = setInterval(() => { void this.tick(false); }, sec * 1000);
  }

  latestStatuses(): HostStatus[] {
    return this.hosts.list().map((h) => this.snapshots.get(h.id) ?? { id: h.id, state: 'unknown' });
  }

  latestOf(id: string): HostStatus {
    return this.snapshots.get(id) ?? { id, state: 'unknown' };
  }

  forget(id: string): void {
    this.snapshots.delete(id);
    this.meta.delete(id);
    this.lastFullAt.delete(id);
  }

  /** force=true 忽略 recording 开关,给工具栏「刷新」用。 */
  async tick(force: boolean): Promise<HostStatus[]> {
    if (this.ticking) return this.latestStatuses();
    const settings = this.metrics.getSettings();
    if (!force && !settings.recording) return this.latestStatuses();
    this.ticking = true;
    try {
      const paused = new Set(settings.pausedHostIds);
      const hosts = [...this.hosts.list()];
      const results = new Map<string, HostStatus>();
      for (const h of hosts) {
        results.set(h.id, { id: h.id, state: 'probing', probedAt: new Date().toISOString() });
      }
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < hosts.length) {
          const host = hosts[cursor++];
          if (!force && paused.has(host.id)) {
            const prev = this.snapshots.get(host.id);
            results.set(host.id, prev ?? { id: host.id, state: 'unknown' as const });
            continue;
          }
          results.set(host.id, await this.probeOne(host.id));
        }
      };
      await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(1, hosts.length)) }, worker));
      const out = hosts.map((h) => results.get(h.id) ?? { id: h.id, state: 'unknown' as const });
      for (const s of out) this.snapshots.set(s.id, s);
      return out;
    } finally {
      this.ticking = false;
    }
  }

  private async probeOne(id: string): Promise<HostStatus> {
    const now = Date.now();
    const base: HostStatus = { id, state: 'probing', probedAt: new Date().toISOString(), ...this.meta.get(id) };
    try {
      await this.ssh.connect(id);
      const started = Date.now();
      const { stdout } = await this.ssh.exec(id, PROBE_SCRIPT, PROBE_TIMEOUT_MS);
      const latencyMs = Date.now() - started;
      const parsed = parseProbeOutput(stdout);
      const needFull = (this.lastFullAt.get(id) ?? 0) + FULL_META_MS < now;
      if (needFull) {
        this.lastFullAt.set(id, now);
        this.meta.set(id, {
          osName: parsed.osName,
          uptimeText: parsed.uptimeText,
          cores: parsed.cores,
        });
      }
      const status: HostStatus = {
        ...base,
        ...this.meta.get(id),
        cpuPercent: parsed.cpuPercent,
        memPercent: parsed.memPercent,
        diskPercent: parsed.diskPercent,
        state: 'online',
        latencyMs,
        probedAt: new Date().toISOString(),
      };
      await this.metrics.append(id, {
        t: now,
        cpu: parsed.cpuPercent,
        mem: parsed.memPercent,
        disk: parsed.diskPercent,
        latencyMs,
        online: true,
      });
      return status;
    } catch (error) {
      const status: HostStatus = {
        ...base,
        state: 'offline',
        error: error instanceof Error ? error.message : String(error),
        probedAt: new Date().toISOString(),
      };
      await this.metrics.append(id, { t: now, online: false }).catch(() => { /* 离线也尽量记 */ });
      return status;
    }
  }
}
