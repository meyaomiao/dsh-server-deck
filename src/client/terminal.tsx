/**
 * 终端视图:xterm.js ↔ /server-deck/ws/pty WebSocket。
 * 帧协议见 src/server/pty.ts——stdin 直传,{"type":"resize"} 调窗。
 */

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ptyUrl } from './api.ts';

export interface TerminalPaneProps {
  hostId: string;
  /** 展示名(标题,可收缩省略)。 */
  name: string;
  /** user@host:port(副标签)。 */
  endpoint: string;
  onBack: () => void;
}

export function TerminalPane(props: TerminalPaneProps): React.ReactNode {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef(props.onBack);
  backRef.current = props.onBack;

  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return undefined;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      fontFamily: "'JetBrains Mono','Fira Code',Menlo,Consolas,'Courier New',monospace",
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(88,166,255,.30)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.writeln(`\x1b[90m[server-deck] 正在连接 ${props.name}(${props.endpoint}) …\x1b[0m`);
    try { fit.fit(); } catch { /* 容器未布局完 */ }

    let ws: WebSocket | null = null;
    let disposed = false;

    ws = new WebSocket(ptyUrl(props.hostId, Math.max(term.cols, 2), Math.max(term.rows, 2)));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (!disposed) term.reset();
    };
    ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
      if (disposed) return;
      term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    };
    ws.onclose = (ev: CloseEvent) => {
      if (!disposed) term.writeln(`\r\n\x1b[90m[server-deck] 连接已关闭${ev.reason !== '' && ev.reason.length > 0 ? ':' + ev.reason : ''}\x1b[0m`);
    };
    ws.onerror = () => {
      if (!disposed) term.writeln('\r\n\x1b[31m[server-deck] WebSocket 错误\x1b[0m');
    };
    const dataSub = term.onData((d) => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(d);
    });

    const sendResize = (): void => {
      try { fit.fit(); } catch { /* 尺寸为 0 时忽略 */ }
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => sendResize()) : null;
    if (ro !== null) ro.observe(el);

    return () => {
      disposed = true;
      dataSub.dispose();
      ro?.disconnect();
      try { ws?.close(); } catch { /* 已断 */ }
      term.dispose();
    };
  }, [props.hostId, props.name, props.endpoint]);

  return (
    <div className="sd-term-wrap">
      <div className="sd-term-head">
        <button className="sd-btn" onClick={() => backRef.current()}>← 返回</button>
        <span className="sd-title" title={`${props.name} · ${props.endpoint}`}>{props.name}</span>
        <span className="sd-line">{props.endpoint}</span>
      </div>
      <div className="sd-term-body">
        <div ref={bodyRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
    </div>
  );
}
