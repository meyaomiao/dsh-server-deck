/**
 * 样式注入:应用 CSS + xterm.css(build 时生成到 xterm-css.generated.ts),
 * 幂等——重复挂载只插一次 <style>。颜色全部走 DSH 令牌并带暗色回退。
 */

import { XTERM_CSS } from './xterm-css.generated.ts';

const STYLE_ID = 'server-deck-styles';

const APP_CSS = `
.sd-app{display:flex;flex-direction:column;height:100%;min-height:0;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--dsw-alias-bg-layer-1,#16181d);color:var(--dsw-alias-label-primary,#e6edf3)}
.sd-toolbar{display:flex;align-items:center;gap:6px;padding:8px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));flex:none}
.sd-toolbar h2{margin:0;font-size:13px;font-weight:600;
  flex:0 1 auto;min-width:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--dsw-alias-label-primary,#e6edf3)}
.sd-toolbar h2 + *{margin-left:auto}
.sd-btn{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));
  border-radius:6px;background:var(--dsw-alias-bg-layer-2,#1c1f26);
  color:var(--dsw-alias-label-secondary,#c9d1d9);font-size:11px;padding:3px 8px;
  cursor:pointer;white-space:nowrap;flex:none}
.sd-btn:hover{filter:brightness(1.15)}
.sd-btn.primary{background:#1f6feb;border-color:#388bfd;color:#fff}
.sd-btn.danger:hover{background:#b62324;border-color:#f85149;color:#fff}
.sd-btn:disabled{opacity:.5;cursor:default}
.sd-body{flex:1;min-height:0;overflow:auto;padding:12px}
.sd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.sd-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:10px;
  padding:10px 12px;display:flex;flex-direction:column;gap:7px;
  background:var(--dsw-alias-bg-layer-2,#1c1f26);transition:border-color .15s}
.sd-card:hover{border-color:rgba(88,166,255,.55)}
.sd-card-head{display:flex;align-items:center;gap:8px;min-width:0}
.sd-dot{width:9px;height:9px;border-radius:50%;flex:none}
.sd-dot.online{background:#3fb950;box-shadow:0 0 6px rgba(63,185,80,.8)}
.sd-dot.offline{background:#f85149}
.sd-dot.probing{background:#d29922;animation:sd-pulse 1s infinite alternate}
.sd-dot.unknown{background:#6e7681}
@keyframes sd-pulse{from{opacity:.4}to{opacity:1}}
.sd-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.sd-tags{display:flex;gap:4px;flex-wrap:wrap}
.sd-tag{font-size:10px;padding:1px 6px;border-radius:8px;
  background:rgba(88,166,255,.14);color:#79c0ff}
.sd-line{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa1ab);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-meters{display:flex;flex-direction:column;gap:5px;margin-top:2px}
.sd-meter{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--dsw-alias-label-secondary,#9aa1ab)}
.sd-meter b{width:30px;text-align:right;font-weight:500}
.sd-bar{flex:1;height:5px;border-radius:3px;background:rgba(128,128,128,.18);overflow:hidden}
.sd-bar i{display:block;height:100%;border-radius:3px;background:#3fb950}
.sd-bar i.warn{background:#d29922}.sd-bar i.bad{background:#f85149}
.sd-meter-val{width:42px;text-align:right;font-variant-numeric:tabular-nums}
.sd-card-foot{display:flex;gap:6px;margin-top:4px}
.sd-card-foot .sd-btn{padding:3px 8px;font-size:11px}
.sd-empty{padding:40px 16px;text-align:center;color:var(--dsw-alias-label-secondary,#9aa1ab);font-size:13px;line-height:1.8}
.sd-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#8b949e);padding:2px 2px 8px}
.sd-form{display:flex;flex-direction:column;gap:9px;max-width:420px}
.sd-form label{display:flex;flex-direction:column;gap:4px;font-size:12px;
  color:var(--dsw-alias-label-secondary,#9aa1ab)}
.sd-form input,.sd-form select{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));
  border-radius:6px;background:var(--dsw-alias-bg-base,#0d1117);color:inherit;
  padding:6px 8px;font-size:12px;outline:none}
.sd-form input:focus,.sd-form select:focus{border-color:#388bfd}
.sd-row{display:flex;gap:8px}.sd-row>label{flex:1}
.sd-msg{font-size:12px;border-radius:6px;padding:6px 9px}
.sd-msg.err{background:rgba(248,81,73,.12);color:#ff7b72}
.sd-msg.ok{background:rgba(63,185,80,.12);color:#56d364}
.sd-term-wrap{position:absolute;inset:0;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base,#0d1117)}
.sd-term-head{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.sd-term-head .sd-title{font-size:12px;font-weight:600;flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-term-head .sd-line{flex:none;max-width:42%}
.sd-term-body{flex:1;min-height:0;position:relative}
.sd-term-body .xterm,.sd-term-body .xterm .xterm-viewport,
.sd-term-body .xterm .xterm-screen{background:transparent!important}
.sd-term-body .xterm{padding:6px 8px;height:100%}
.sd-spin{display:inline-block;width:11px;height:11px;border:2px solid rgba(128,128,128,.35);
  border-top-color:#58a6ff;border-radius:50%;animation:sd-rot .8s linear infinite;vertical-align:-2px}
@keyframes sd-rot{to{transform:rotate(360deg)}}
`;

let injected = false;

/** 注入全局样式(幂等)。 */
export function ensureStyles(): void {
  if (injected || document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${APP_CSS}\n${XTERM_CSS}`;
  document.head.appendChild(style);
  injected = true;
}
