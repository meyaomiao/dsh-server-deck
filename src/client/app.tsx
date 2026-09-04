/**
 * 主应用视图:卡片(grid)/ 趋势(trend)/ 主机表单(form)/ 交互终端(terminal)。
 * 趋势视图按窗口(1h/24h 滚动、7d/30d 自然日、自定义)与粒度(10s~1h)拉取历史序列,
 * 每台主机 CPU / 内存 / 磁盘三张独立趋势图 + 最新/平均指标。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HostEntry,
  HostInput,
  HostMetricSeries,
  HostStatus,
  MetricRangeKind,
  MetricsSettings,
} from '../types.ts';
import { BUCKET_MS } from '../metrics.ts';
import * as api from './api.ts';
import {
  loadRefreshSec,
  loadTrendBucket,
  loadTrendRange,
  saveRefreshSec,
  saveTrendBucket,
  saveTrendRange,
  type TrendRangePref,
} from './config.ts';
import { Sparkline, valueClass } from './sparkline.tsx';
import { TerminalPane } from './terminal.tsx';

type View =
  | { kind: 'grid' }
  | { kind: 'trend' }
  | { kind: 'form'; host?: HostEntry }
  | { kind: 'terminal'; host: HostEntry };

interface Banner { kind: 'ok' | 'err'; text: string }

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时区短时间:MM-DD HH:mm。 */
function fmtClock(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** datetime-local 输入值(本地时区)。 */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtPct(v: number | undefined): string {
  return v === undefined ? '—' : `${String(Math.round(v * 10) / 10)}%`;
}

export function ServerDeckApp(props: { visible: boolean }): React.ReactNode {
  const [hosts, setHosts] = useState<readonly HostEntry[]>([]);
  const [statuses, setStatuses] = useState<Record<string, HostStatus>>({});
  const [view, setView] = useState<View>({ kind: 'grid' });
  const [refreshSec, setRefreshSec] = useState(loadRefreshSec());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  // ---- 趋势视图状态 ----
  const [trendRange, setTrendRange] = useState<TrendRangePref>(loadTrendRange());
  const [trendBucket, setTrendBucket] = useState<string>(loadTrendBucket());
  const now0 = Date.now();
  const [customFrom, setCustomFrom] = useState<string>(toLocalInput(now0 - 6 * 3600_000));
  const [customTo, setCustomTo] = useState<string>(toLocalInput(now0));
  const [seriesMap, setSeriesMap] = useState<Record<string, HostMetricSeries>>({});
  const [trendMeta, setTrendMeta] = useState<{ from: number; to: number; bucketUsed: string } | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [settings, setSettings] = useState<MetricsSettings | null>(null);

  /** 启动时的 location.hash,等首份主机列表到位后消费一次。 */
  const bootHashRef = useRef<string | null>(
    typeof location !== 'undefined' && location.hash.startsWith('#sd-') ? location.hash : null,
  );

  const customFromMs = trendRange === 'custom' && customFrom.length > 0 ? Date.parse(customFrom) : undefined;
  const customToMs = trendRange === 'custom' && customTo.length > 0 ? Date.parse(customTo) : undefined;
  const customReady = trendRange !== 'custom'
    || (customFromMs !== undefined && !Number.isNaN(customFromMs)
      && customToMs !== undefined && !Number.isNaN(customToMs)
      && customToMs > customFromMs);

  const refreshStatuses = useCallback(async (force = false): Promise<void> => {
    try {
      const { statuses } = await api.getStatuses(force);
      const map: Record<string, HostStatus> = {};
      for (const s of statuses) map[s.id] = s;
      setStatuses(map);
    } catch { /* 下轮重试 */ }
  }, []);

  const refreshHosts = useCallback(async (): Promise<void> => {
    try {
      const { hosts } = await api.listHosts();
      setHosts(hosts);
      // hash 深链(仅启动时消费一次):#sd-terminal/<hostId> 直开终端,#sd-form/#sd-trend 切视图
      const raw = bootHashRef.current;
      if (raw !== null) {
        bootHashRef.current = null;
        const mTerm = /^#sd-terminal\/(.+)$/.exec(raw);
        if (mTerm !== null) {
          const host = hosts.find((h) => h.id === decodeURIComponent(mTerm[1]));
          if (host !== undefined) setView({ kind: 'terminal', host });
          return;
        }
        if (/^#sd-form/.test(raw)) setView({ kind: 'form' });
        else if (/^#sd-trend/.test(raw)) setView({ kind: 'trend' });
      }
    } catch (error) {
      setBanner({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  // hosts 镜像供 hash 回调读取
  const hostsRef = useRef<readonly HostEntry[]>([]);
  useEffect(() => { hostsRef.current = hosts; }, [hosts]);

  // hashchange 动态切换视图:#sd-terminal/<id> / #sd-form / #sd-grid / #sd-trend
  useEffect(() => {
    const onHash = (): void => {
      const raw = location.hash;
      if (!raw.startsWith('#sd-')) return;
      const mTerm = /^#sd-terminal\/(.+)$/.exec(raw);
      if (mTerm !== null) {
        const host = hostsRef.current.find((h) => h.id === decodeURIComponent(mTerm[1]));
        if (host !== undefined) setView({ kind: 'terminal', host });
        return;
      }
      if (/^#sd-form/.test(raw)) setView({ kind: 'form' });
      else if (/^#sd-trend/.test(raw)) setView({ kind: 'trend' });
      else if (/^#sd-grid/.test(raw)) setView({ kind: 'grid' });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 卡片 / 趋势视图 + 可见时:按周期自动刷新最新状态(读快照,不再现场 SSH)
  useEffect(() => {
    if (view.kind !== 'grid' && view.kind !== 'trend') return undefined;
    void refreshHosts();
    void refreshStatuses(false);
    if (!props.visible || refreshSec <= 0) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refreshStatuses(false);
    }, refreshSec * 1000);
    return () => clearInterval(timer);
  }, [view.kind, props.visible, refreshSec, refreshHosts, refreshStatuses]);

  // 采集设置(一次性拉取)
  useEffect(() => {
    void api.getMetricsSettings().then((r) => setSettings(r.settings)).catch(() => { /* 忽略 */ });
  }, []);

  // 趋势序列:窗口 / 粒度 / 自定义起止变化时拉取;可见时每 30s 自动刷新
  const loadSeries = useCallback(async (): Promise<void> => {
    if (!customReady) return;
    setTrendLoading(true);
    try {
      const r = await api.getMetricSeries({
        range: trendRange,
        bucket: trendBucket === 'auto' ? 'auto' : (trendBucket as never),
        from: customFromMs,
        to: customToMs,
      });
      const map: Record<string, HostMetricSeries> = {};
      for (const s of r.series) map[s.hostId] = s;
      setSeriesMap(map);
      setTrendMeta({ from: r.from, to: r.to, bucketUsed: r.bucketUsed });
      setTrendError(null);
    } catch (error) {
      setTrendError(error instanceof Error ? error.message : String(error));
    } finally {
      setTrendLoading(false);
    }
  }, [trendRange, trendBucket, customFromMs, customToMs, customReady]);

  useEffect(() => {
    if (view.kind !== 'trend') return undefined;
    if (!customReady) return undefined;
    void loadSeries();
    if (!props.visible) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void loadSeries();
    }, 30_000);
    return () => clearInterval(timer);
  }, [view.kind, props.visible, customReady, loadSeries]);

  const runTest = useCallback(async (host: HostEntry): Promise<void> => {
    setBusyId(host.id);
    setBanner(null);
    try {
      const r = await api.testHost(host.id);
      setBanner(r.ok
        ? { kind: 'ok', text: `✓ ${host.name} 连接成功(${String(r.latencyMs ?? '?')}ms)` }
        : { kind: 'err', text: `✗ ${host.name}:${r.error ?? '连接失败'}` });
    } catch (error) {
      setBanner({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  }, []);

  const runDelete = useCallback(async (host: HostEntry): Promise<void> => {
    if (!globalThis.confirm(`确定删除「${host.name}」?台账与其历史趋势记录将一并移除,不会登录服务器执行任何操作。`)) return;
    setBusyId(host.id);
    try {
      await api.deleteHost(host.id);
      await refreshHosts();
      void refreshStatuses(false);
      if (view.kind === 'trend') void loadSeries();
      setView({ kind: 'grid' });
    } catch (error) {
      setBanner({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  }, [refreshHosts, refreshStatuses, view.kind, loadSeries]);

  const runImport = useCallback(async (): Promise<void> => {
    setProbing(true);
    setBanner(null);
    try {
      const r = await api.importSshConfig(false);
      await refreshHosts();
      setBanner({
        kind: 'ok',
        text: `ssh config 解析完成:发现 ${String(r.found)} 条,新导入 ${String(r.importedCount)} 台,跳过 ${String(r.skipped)} 条`,
      });
    } catch (error) {
      setBanner({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setProbing(false);
    }
  }, [refreshHosts]);

  // 工具栏「刷新」:立即探测一轮并取最新快照
  const manualProbe = useCallback(async (): Promise<void> => {
    setProbing(true);
    try { await refreshStatuses(true); } finally { setProbing(false); }
  }, [refreshStatuses]);

  const changeRefresh = useCallback((sec: number): void => {
    setRefreshSec(sec);
    saveRefreshSec(sec);
  }, []);

  const changeTrendRange = useCallback((r: TrendRangePref): void => {
    setTrendRange(r);
    saveTrendRange(r);
  }, []);

  const changeTrendBucket = useCallback((b: string): void => {
    setTrendBucket(b);
    saveTrendBucket(b);
  }, []);

  const changeCollect = useCallback(async (sec: number): Promise<void> => {
    try {
      const r = await api.patchMetricsSettings({ collectIntervalSec: sec as MetricsSettings['collectIntervalSec'] });
      setSettings(r.settings);
      setBanner({ kind: 'ok', text: `✓ 采集周期已改为 ${String(sec)} 秒,主机侧立即生效` });
    } catch (error) {
      setBanner({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  // ---------- 渲染 ----------
  const title = view.kind === 'grid'
    ? '服务器'
    : view.kind === 'trend'
      ? '趋势'
      : view.kind === 'form'
        ? (view.host !== undefined ? '编辑主机' : '添加服务器')
        : view.host.name;

  const bucketUsedText = trendMeta !== null
    ? ({ '10s': '10 秒', '30s': '30 秒', '1m': '1 分钟', '5m': '5 分钟', '15m': '15 分钟', '1h': '1 小时' } as Record<string, string>)[trendMeta.bucketUsed] ?? trendMeta.bucketUsed
    : null;

  // 最早样本时刻:记录刚开启时窗口左侧无数据,明示起点避免误读为「没数据」
  const dataStart = (() => {
    let min: number | undefined;
    for (const s of Object.values(seriesMap)) {
      for (const p of s.points) {
        if (min === undefined || p.t < min) min = p.t;
      }
    }
    return min;
  })();
  const bucketUsedMs = trendMeta !== null
    ? BUCKET_MS[trendMeta.bucketUsed as keyof typeof BUCKET_MS] ?? 30_000
    : 30_000;
  const showDataStart = dataStart !== undefined
    && trendMeta !== null
    && dataStart - trendMeta.from > bucketUsedMs * 3;

  return (
    <div className="sd-app">
      <div className="sd-toolbar">
        {view.kind === 'trend' ? <button className="sd-btn" onClick={() => setView({ kind: 'grid' })}>← 卡片</button> : null}
        {view.kind === 'grid' ? <button className="sd-btn" onClick={() => setView({ kind: 'trend' })}>📈 趋势</button> : null}
        {view.kind === 'form' || view.kind === 'terminal'
          ? <button className="sd-btn" onClick={() => setView({ kind: 'grid' })}>← 卡片</button>
          : null}
        <h2>{title}</h2>
        {view.kind === 'grid' ? (
          <>
            <select
              className="sd-btn"
              value={refreshSec}
              onChange={(e) => changeRefresh(Number(e.target.value))}
              title="状态刷新周期(读主机侧快照)"
            >
              <option value={0}>手动</option>
              <option value={10}>10s</option>
              <option value={15}>15s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
            </select>
            <button className="sd-btn" disabled={probing} onClick={() => void manualProbe()}>
              {probing ? <><i className="sd-spin" /> 探测中</> : '⟳ 刷新'}
            </button>
            <button className="sd-btn" disabled={probing} onClick={() => void runImport()} title="解析 ~/.ssh/config 并导入新主机">
              ⤓ 导入
            </button>
            <button className="sd-btn primary" onClick={() => setView({ kind: 'form' })}>＋ 添加</button>
          </>
        ) : null}
        {view.kind === 'trend' ? (
          <button className="sd-btn" disabled={trendLoading} onClick={() => void loadSeries()}>
            {trendLoading ? <><i className="sd-spin" /> 加载中</> : '⟳ 刷新'}
          </button>
        ) : null}
      </div>

      {view.kind === 'trend' ? (
        <div className="sd-trend-bar">
          <label className="sd-tb-item">窗口
            <select value={trendRange} onChange={(e) => changeTrendRange(e.target.value as TrendRangePref)}>
              <option value="1h">1 小时</option>
              <option value="24h">24 小时</option>
              <option value="7d">一周</option>
              <option value="30d">一个月</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          <label className="sd-tb-item">粒度
            <select value={trendBucket} onChange={(e) => changeTrendBucket(e.target.value)}>
              <option value="auto">自动</option>
              <option value="10s">10 秒</option>
              <option value="30s">30 秒</option>
              <option value="1m">1 分钟</option>
              <option value="5m">5 分钟</option>
              <option value="15m">15 分钟</option>
              <option value="1h">1 小时</option>
            </select>
          </label>
          {trendRange === 'custom' ? (
            <>
              <label className="sd-tb-item">起
                <input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              </label>
              <label className="sd-tb-item">止
                <input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </label>
            </>
          ) : null}
          <label className="sd-tb-item" title="主机侧采集周期(常驻,与面板是否打开无关)">采集
            <select
              value={String(settings?.collectIntervalSec ?? 30)}
              onChange={(e) => void changeCollect(Number(e.target.value))}
            >
              <option value="10">10 秒</option>
              <option value="30">30 秒</option>
              <option value="60">1 分钟</option>
              <option value="300">5 分钟</option>
            </select>
          </label>
          <span className="sd-tb-meta">
            {trendError !== null
              ? <span style={{ color: '#ff7b72' }}>✗ {trendError}</span>
              : trendMeta !== null
                ? `${fmtClock(trendMeta.from)} → ${fmtClock(trendMeta.to)} · 实际粒度 ${bucketUsedText ?? '—'}${showDataStart ? ` · 数据自 ${fmtClock(dataStart ?? 0)} 起(更早无记录)` : ''}${settings?.recording === false ? ' · 记录已暂停' : ''}`
                : (customReady ? '加载中…' : '请选择有效的自定义起止时间')}
          </span>
        </div>
      ) : null}

      {banner !== null ? (
        <div style={{ padding: '8px 12px 0' }}>
          <div className={`sd-msg ${banner.kind}`}>{banner.text}</div>
        </div>
      ) : null}

      {view.kind === 'grid' ? (
        <div className="sd-body">
          {hosts.length === 0 ? (
            <div className="sd-empty">
              还没有服务器。<br />点右上角「＋ 添加」手工录入,或用「⤓ 导入 ssh config」一键导入。
            </div>
          ) : (
            <div className="sd-grid">
              {hosts.map((h) => (
                <ServerCard
                  key={h.id}
                  host={h}
                  status={statuses[h.id]}
                  busy={busyId === h.id}
                  onTerminal={() => setView({ kind: 'terminal', host: h })}
                  onTest={() => void runTest(h)}
                  onEdit={() => setView({ kind: 'form', host: h })}
                  onDelete={() => void runDelete(h)}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {view.kind === 'trend' ? (
        <div className="sd-body">
          {hosts.length === 0 ? (
            <div className="sd-empty">
              还没有服务器。先回卡片视图添加或导入。
            </div>
          ) : (
            <div className="sd-tgrid">
              {hosts.map((h) => (
                <TrendCard
                  key={h.id}
                  host={h}
                  status={statuses[h.id]}
                  series={seriesMap[h.id]}
                  from={trendMeta?.from ?? (customReady && customFromMs !== undefined ? customFromMs : Date.now() - 3600_000)}
                  to={trendMeta?.to ?? (customReady && customToMs !== undefined ? customToMs : Date.now())}
                  bucketMs={BUCKET_MS[(trendMeta?.bucketUsed ?? '30s') as keyof typeof BUCKET_MS] ?? 30_000}
                  busy={busyId === h.id}
                  onTerminal={() => setView({ kind: 'terminal', host: h })}
                  onTest={() => void runTest(h)}
                  onEdit={() => setView({ kind: 'form', host: h })}
                  onDelete={() => void runDelete(h)}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {view.kind === 'form' ? (
        <div className="sd-body">
          <HostForm
            initial={view.host}
            onCancel={() => setView({ kind: 'grid' })}
            onSaved={(host) => { setBanner({ kind: 'ok', text: `✓ 已保存 ${host.name}` }); setView({ kind: 'grid' }); void refreshHosts(); }}
          />
        </div>
      ) : null}

      {view.kind === 'terminal' ? (
        <TerminalPane
          hostId={view.host.id}
          name={view.host.name}
          endpoint={`${view.host.username}@${view.host.host}:${String(view.host.port)}`}
          onBack={() => setView({ kind: 'grid' })}
        />
      ) : null}
    </div>
  );
}

// ---------- 卡片视图 ----------

function dotClass(state: HostStatus['state'] | undefined): string {
  switch (state) {
    case 'online': return 'sd-dot online';
    case 'offline': return 'sd-dot offline';
    case 'probing': return 'sd-dot probing';
    default: return 'sd-dot unknown';
  }
}

function Meter(props: { label: string; value?: number }): React.ReactNode {
  const v = props.value;
  const cls = v === undefined ? '' : valueClass(v);
  return (
    <div className="sd-meter">
      <b>{props.label}</b>
      <span className="sd-bar"><i className={cls} style={{ width: `${v === undefined ? 0 : Math.min(100, v)}%` }} /></span>
      <span className="sd-meter-val">{v === undefined ? '—' : `${String(Math.round(v))}%`}</span>
    </div>
  );
}

function ServerCard(props: {
  host: HostEntry;
  status?: HostStatus;
  busy: boolean;
  onTerminal: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): React.ReactNode {
  const { host, status } = props;
  return (
    <div className="sd-card">
      <div className="sd-card-head">
        <span className={dotClass(status?.state)} title={status?.state ?? 'unknown'} />
        <span className="sd-name" title={host.name}>{host.name}</span>
        {(host.tags ?? []).slice(0, 3).map((t) => <span key={t} className="sd-tag">{t}</span>)}
      </div>
      <div className="sd-line">{host.username}@{host.host}:{String(host.port)}</div>
      <div className="sd-line">
        {status?.osName ?? '系统未知'}
        {status?.uptimeText !== undefined && status.uptimeText.length > 0 ? ` · 已运行 ${status.uptimeText}` : ''}
        {status?.cores !== undefined ? ` · ${String(status.cores)} 核` : ''}
        {status?.latencyMs !== undefined ? ` · ${String(status.latencyMs)}ms` : ''}
      </div>
      {status?.state === 'offline' && status.error !== undefined ? (
        <div className="sd-line" style={{ color: '#ff7b72' }} title={status.error}>
          ✗ {status.error.length > 64 ? `${status.error.slice(0, 64)}…` : status.error}
        </div>
      ) : null}
      <div className="sd-meters">
        <Meter label="CPU" value={status?.cpuPercent} />
        <Meter label="内存" value={status?.memPercent} />
        <Meter label="磁盘" value={status?.diskPercent} />
      </div>
      <div className="sd-card-foot">
        <button
          className="sd-btn primary"
          disabled={props.busy || status?.state === 'offline'}
          onClick={props.onTerminal}
          title={status?.state === 'offline' ? '主机当前离线' : '打开交互终端'}
        >
          ⌨ 终端
        </button>
        <button className="sd-btn" disabled={props.busy} onClick={props.onTest}>{props.busy ? <i className="sd-spin" /> : '测试'}</button>
        <button className="sd-btn" onClick={props.onEdit}>✎</button>
        <button className="sd-btn danger" disabled={props.busy} onClick={props.onDelete}>🗑</button>
      </div>
    </div>
  );
}

// ---------- 趋势视图 ----------

function TrendMetric(props: {
  label: string;
  series?: HostMetricSeries;
  field: 'cpu' | 'mem' | 'disk';
  from: number;
  to: number;
  bucketMs: number;
}): React.ReactNode {
  const sum = props.series !== undefined ? props.series[props.field] : undefined;
  const latest = sum?.latest;
  const tip = sum !== undefined && sum.samples > 0
    ? `最高 ${fmtPct(sum.max)} · 最低 ${fmtPct(sum.min)} · 样本 ${String(sum.samples)}`
    : '暂无历史样本(记录开启后约一个采集周期出现第一个点)';
  return (
    <div className="sd-tmetric" title={tip}>
      <div className="sd-tmetric-head">
        <b>{props.label}</b>
        <span className="sd-tval">现 {fmtPct(latest)}</span>
        <span className="sd-tval dim">均 {fmtPct(sum?.avg)}</span>
      </div>
      <Sparkline
        points={props.series?.points ?? []}
        field={props.field}
        from={props.from}
        to={props.to}
        bucketMs={props.bucketMs}
        height={46}
        grid
      />
    </div>
  );
}

function TrendCard(props: {
  host: HostEntry;
  status?: HostStatus;
  series?: HostMetricSeries;
  from: number;
  to: number;
  bucketMs: number;
  busy: boolean;
  onTerminal: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): React.ReactNode {
  const { host, status } = props;
  return (
    <div className="sd-card sd-tcard">
      <div className="sd-card-head">
        <span className={dotClass(status?.state)} title={status?.state ?? 'unknown'} />
        <span className="sd-name" title={host.name}>{host.name}</span>
        {(host.tags ?? []).slice(0, 3).map((t) => <span key={t} className="sd-tag">{t}</span>)}
      </div>
      <div className="sd-line">
        {host.username}@{host.host}:{String(host.port)}
        {status?.latencyMs !== undefined ? ` · ${String(status.latencyMs)}ms` : ''}
      </div>
      <div className="sd-tmetrics">
        <TrendMetric label="CPU" series={props.series} field="cpu" from={props.from} to={props.to} bucketMs={props.bucketMs} />
        <TrendMetric label="内存" series={props.series} field="mem" from={props.from} to={props.to} bucketMs={props.bucketMs} />
        <TrendMetric label="磁盘" series={props.series} field="disk" from={props.from} to={props.to} bucketMs={props.bucketMs} />
      </div>
      <div className="sd-taxis">
        <span>{fmtClock(props.from)}</span>
        <span>{fmtClock(props.to)}</span>
      </div>
      <div className="sd-card-foot">
        <button
          className="sd-btn primary"
          disabled={props.busy || status?.state === 'offline'}
          onClick={props.onTerminal}
          title={status?.state === 'offline' ? '主机当前离线' : '打开交互终端'}
        >
          ⌨ 终端
        </button>
        <button className="sd-btn" disabled={props.busy} onClick={props.onTest}>{props.busy ? <i className="sd-spin" /> : '测试'}</button>
        <button className="sd-btn" onClick={props.onEdit}>✎</button>
        <button className="sd-btn danger" disabled={props.busy} onClick={props.onDelete}>🗑</button>
      </div>
    </div>
  );
}

// ---------- 表单 ----------

function HostForm(props: {
  initial?: HostEntry;
  onCancel: () => void;
  onSaved: (host: HostEntry) => void;
}): React.ReactNode {
  const editing = props.initial;
  const [name, setName] = useState(editing?.name ?? '');
  const [host, setHost] = useState(editing?.host ?? '');
  const [port, setPort] = useState(String(editing?.port ?? 22));
  const [username, setUsername] = useState(editing?.username ?? '');
  const [auth, setAuth] = useState<HostEntry['auth']>(editing?.auth ?? 'key');
  const [keyPath, setKeyPath] = useState(editing?.keyPath ?? '~/.ssh/id_ed25519');
  const [tags, setTags] = useState((editing?.tags ?? []).join(','));
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const secretDirty = password.length > 0 || passphrase.length > 0;
  const secretHint = editing !== undefined && !secretDirty
    ? (editing.auth === 'password' ? '(留空 = 不修改已存密码)' : '(留空 = 不修改已存口令)')
    : '';

  const submit = useCallback(async (): Promise<void> => {
    setError(null);
    const p = Number(port);
    if (host.trim().length === 0 || username.trim().length === 0) {
      setError('主机地址与用户名为必填');
      return;
    }
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      setError('端口必须是 1-65535 的整数');
      return;
    }
    const input: HostInput = {
      name: name.trim(),
      host: host.trim(),
      port: p,
      username: username.trim(),
      auth,
      keyPath: auth === 'key' ? keyPath.trim() : undefined,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      ...(password.length > 0 ? { password } : {}),
      ...(passphrase.length > 0 ? { passphrase } : {}),
    };
    setSaving(true);
    try {
      const result = editing !== undefined
        ? await api.updateHost(editing.id, input)
        : await api.createHost(input);
      props.onSaved(result.host);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [name, host, port, username, auth, keyPath, tags, password, passphrase, editing, props]);

  return (
    <div className="sd-form">
      <label>展示名<input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 生产网关(留空则用 user@host)" /></label>
      <div className="sd-row">
        <label>主机地址 *<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="IP 或域名" /></label>
        <label style={{ maxWidth: 96 }}>端口<input value={port} onChange={(e) => setPort(e.target.value)} /></label>
      </div>
      <label>用户名 *<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" /></label>
      <label>认证方式
        <select value={auth} onChange={(e) => setAuth(e.target.value as HostEntry['auth'])}>
          <option value="key">私钥文件</option>
          <option value="password">密码</option>
          <option value="agent">SSH Agent</option>
        </select>
      </label>
      {auth === 'key' ? (
        <label>私钥路径<input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" /></label>
      ) : null}
      {auth === 'password' ? (
        <label>密码 {secretHint}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /></label>
      ) : null}
      {auth === 'key' ? (
        <label>私钥口令 {secretHint}<input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" /></label>
      ) : null}
      <label>标签(逗号分隔)<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="生产, 华东" /></label>
      {error !== null ? <div className="sd-msg err">{error}</div> : null}
      <div className="sd-row">
        <button className="sd-btn primary" disabled={saving} onClick={() => void submit()}>
          {saving ? <><i className="sd-spin" /> 保存中</> : '保存'}
        </button>
        <button className="sd-btn" onClick={props.onCancel}>取消</button>
      </div>
      <div className="sd-line">密码/口令只保存在本机 ~/.dsh/server-deck.secrets.json(0600),不随台账回传。</div>
    </div>
  );
}
