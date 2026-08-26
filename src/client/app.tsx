/**
 * 主应用:卡片仪表盘(grid)/ 主机表单(form)/ 交互终端(terminal)三视图。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostEntry, HostInput, HostStatus } from '../types.ts';
import * as api from './api.ts';
import { loadRefreshSec, saveRefreshSec } from './config.ts';
import { TerminalPane } from './terminal.tsx';

type View =
  | { kind: 'grid' }
  | { kind: 'form'; host?: HostEntry }
  | { kind: 'terminal'; host: HostEntry };

interface Banner { kind: 'ok' | 'err'; text: string }

export function ServerDeckApp(props: { visible: boolean }): React.ReactNode {
  const [hosts, setHosts] = useState<readonly HostEntry[]>([]);
  const [statuses, setStatuses] = useState<Record<string, HostStatus>>({});
  const [view, setView] = useState<View>({ kind: 'grid' });
  const [refreshSec, setRefreshSec] = useState(loadRefreshSec());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  /** 启动时的 location.hash,等首份主机列表到位后消费一次。 */
  const bootHashRef = useRef<string | null>(
    typeof location !== 'undefined' && location.hash.startsWith('#sd-') ? location.hash : null,
  );

  const refreshStatuses = useCallback(async (): Promise<void> => {
    try {
      const { statuses } = await api.getStatuses();
      const map: Record<string, HostStatus> = {};
      for (const s of statuses) map[s.id] = s;
      setStatuses(map);
    } catch { /* 下轮重试 */ }
  }, []);

  const refreshHosts = useCallback(async (): Promise<void> => {
    try {
      const { hosts } = await api.listHosts();
      setHosts(hosts);
      // hash 深链(仅启动时消费一次):#sd-terminal/<hostId> 直开终端,#sd-form 直开表单
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
      }
    } catch (error) {
      setBanner({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  // hosts 镜像供 hash 回调读取
  const hostsRef = useRef<readonly HostEntry[]>([]);
  useEffect(() => { hostsRef.current = hosts; }, [hosts]);

  // hashchange 动态切换视图:#sd-terminal/<id> / #sd-form / #sd-grid
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
      else if (/^#sd-grid/.test(raw)) setView({ kind: 'grid' });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 网格视图 + 可见时:立即拉取并按周期自动刷新状态
  useEffect(() => {
    if (view.kind !== 'grid') return undefined;
    void refreshHosts();
    void refreshStatuses();
    if (!props.visible || refreshSec <= 0) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refreshStatuses();
    }, refreshSec * 1000);
    return () => clearInterval(timer);
  }, [view.kind, props.visible, refreshSec, refreshHosts, refreshStatuses]);

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
    if (!globalThis.confirm(`确定删除「${host.name}」?仅移出台账,不会登录服务器执行任何操作。`)) return;
    setBusyId(host.id);
    try {
      await api.deleteHost(host.id);
      await refreshHosts();
      setView({ kind: 'grid' });
    } catch (error) {
      setBanner({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  }, [refreshHosts]);

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

  const manualProbe = useCallback(async (): Promise<void> => {
    setProbing(true);
    try { await refreshStatuses(); } finally { setProbing(false); }
  }, [refreshStatuses]);

  const changeRefresh = useCallback((sec: number): void => {
    setRefreshSec(sec);
    saveRefreshSec(sec);
  }, []);

  // ---------- 渲染 ----------
  const title = view.kind === 'grid'
    ? '服务器'
    : view.kind === 'form'
      ? (view.host !== undefined ? '编辑主机' : '添加服务器')
      : view.host.name;

  return (
    <div className="sd-app">
      <div className="sd-toolbar">
        {view.kind !== 'grid'
          ? <button className="sd-btn" onClick={() => setView({ kind: 'grid' })}>← 卡片</button>
          : null}
        <h2>{title}</h2>
        {view.kind === 'grid' ? (
          <>
            <select
              className="sd-btn"
              value={refreshSec}
              onChange={(e) => changeRefresh(Number(e.target.value))}
              title="自动刷新周期"
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
      </div>

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

// ---------- 卡片 ----------

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
  const cls = v === undefined ? '' : v >= 85 ? 'bad' : v >= 60 ? 'warn' : '';
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
