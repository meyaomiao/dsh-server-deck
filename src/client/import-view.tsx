import { useEffect, useRef, useState } from 'react';
import type { ImportPreview, ImportResult } from '../types.ts';
import { confirmSshImport, previewSshConfig } from './api.ts';

const canSelect = (action: string): boolean => action === 'create' || action === 'update';
const actionText = { create: '新增', update: '补关联', skip: '跳过', invalid: '不可导入' };

/** A panel-sized preview. Mounting and cancelling never submit a confirmation. */
export function ImportView(props: { onCancel(): void; onImported(): void }): React.ReactNode {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>('preview');
  const [error, setError] = useState<string | null>(null);
  const [needsPreview, setNeedsPreview] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const lock = useRef(false);
  const mounted = useRef(false);

  const detect = async (): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusy('preview');
    setError(null);
    setResult(null);
    setPreview(null);
    try {
      const value = await previewSshConfig();
      if (!mounted.current) return;
      setPreview(value);
      setSelected(new Set(value.candidates.filter((row) => canSelect(row.action)).map((row) => row.id)));
      setNeedsPreview(false);
    } catch (value) {
      if (mounted.current) setError(value instanceof Error ? value.message : String(value));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void detect();
    return () => { mounted.current = false; };
  }, []);

  const rows = preview?.candidates ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const included = new Set<string>();
  const include = (id: string): void => {
    if (included.has(id)) return;
    included.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) include(dependency);
  };
  for (const id of selected) include(id);
  const creates = rows.filter((row) => included.has(row.id) && row.action === 'create').length;
  const updates = rows.filter((row) => included.has(row.id) && row.action === 'update').length;
  const automatic = rows.filter((row) => included.has(row.id) && !selected.has(row.id) && canSelect(row.action)).length;

  const confirm = async (): Promise<void> => {
    if (lock.current || !preview || needsPreview || selected.size === 0 || result) return;
    lock.current = true;
    setBusy('confirm');
    setError(null);
    try {
      const value = await confirmSshImport({ fingerprint: preview.fingerprint, selectedIds: [...selected] });
      if (!mounted.current) return;
      setResult(value);
      props.onImported();
    } catch (value) {
      if (mounted.current) {
        setError(value instanceof Error ? value.message : String(value));
        setNeedsPreview(true);
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <div className="sd-body sd-import" aria-busy={busy !== null}>
      <p className="sd-import-intro">先检测 SSH 配置并选择主机，确认后写入台账。必需跳板会自动包含。</p>
      {busy === 'preview' ? <div className="sd-hint" role="status"><i className="sd-spin" /> 正在只读检测…</div> : null}
      {error ? <div className="sd-msg err" role="alert">{error}</div> : null}
      {result ? (
        <div className={`sd-msg ${result.error ? 'err' : 'ok'}`} role="status">
          {result.error ? '导入未全部完成' : '导入完成'}：新增 {result.createdCount} 台，更新跳板关联 {result.updatedCount} 台，跳过 {result.skippedCount} 条。
          {result.includedDependencies > 0 ? ` 已自动包含 ${result.includedDependencies} 个跳板依赖。` : ''}
          {result.error ? ` ${result.error}` : ''}
        </div>
      ) : null}
      {preview && !result ? (
        <>
          {preview.warnings.map((warning) => <div className="sd-hint" key={warning}>{warning}</div>)}
          <div className="sd-import-actions">
            <span>检测到 {rows.length} 条</span>
            <button className="sd-btn" disabled={busy !== null || needsPreview} onClick={() => setSelected(new Set(rows.filter((row) => canSelect(row.action)).map((row) => row.id)))}>全选有效项</button>
            <button className="sd-btn" disabled={busy !== null || needsPreview} onClick={() => setSelected(new Set())}>取消全选</button>
          </div>
          <div className="sd-import-list">
            {rows.map((row) => {
              const required = included.has(row.id) && !selected.has(row.id);
              const writable = canSelect(row.action);
              return (
                <label className={`sd-import-item ${row.action === 'invalid' ? 'invalid' : ''}`} key={row.id}>
                  <input type="checkbox" aria-label={row.name} checked={included.has(row.id)}
                    disabled={!writable || required || busy !== null || needsPreview}
                    onChange={(event) => setSelected((old) => {
                      const next = new Set(old);
                      if (event.target.checked) next.add(row.id); else next.delete(row.id);
                      return next;
                    })} />
                  <span className="sd-import-detail">
                    <span className="sd-import-name">{row.name} <span className="sd-tag">{actionText[row.action]}</span>{required ? <span className="sd-tag">自动包含</span> : null}</span>
                    {row.host ? <span>{row.username || '缺少用户名'}@{row.host}:{row.port}</span> : null}
                    {row.aliases.length > 1 ? <span>别名：{row.aliases.join('、')}</span> : null}
                    <span>{row.reason}</span>
                    {row.proxyJump ? <span>ProxyJump：{row.proxyJump}</span> : null}
                    {row.dependencies.length ? <span>依赖：{row.dependencies.map((id) => byId.get(id)?.name ?? id).join('、')}</span> : null}
                  </span>
                </label>
              );
            })}
            {rows.length === 0 ? <div className="sd-hint">没有检测到 Host 条目。</div> : null}
          </div>
          <div className="sd-import-summary" aria-live="polite">将新增 {creates} 台，更新跳板关联 {updates} 台{automatic > 0 ? `（自动包含 ${automatic} 个依赖）` : ''}。</div>
        </>
      ) : null}
      <div className="sd-import-actions">
        {!result ? <button className="sd-btn primary" disabled={busy !== null || !preview || needsPreview || creates + updates === 0} onClick={() => void confirm()}>
          {busy === 'confirm' ? <><i className="sd-spin" /> 导入中…</> : '确认导入'}
        </button> : null}
        <button className="sd-btn" disabled={busy !== null} onClick={() => void detect()}>重新检测</button>
        <button className="sd-btn" disabled={busy === 'confirm'} onClick={props.onCancel}>{result ? '返回服务器' : '取消'}</button>
      </div>
    </div>
  );
}
