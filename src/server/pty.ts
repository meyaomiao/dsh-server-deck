/**
 * PTY WebSocket 桥:/server-deck/ws/pty?host=<id>&cols=<n>&rows=<n>
 *
 * dsh-host-webserver 的升级路由把协商交给路由所有者——这里用 ws 的
 * noServer 模式完成握手,然后把 xterm 的帧双向桥接到 ssh2 shell 流。
 * 帧协议:二进制/text 帧 = 终端 stdin;`{"type":"resize",...}` JSON 帧 =
 * 调整窗口大小。访问面与 REST 一致:仅回环,并通过宿主 Connection 鉴权。
 */

import { STATUS_CODES, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Duplex } from 'node:stream';
import type { HostPool } from './pool.ts';
import { requestRejection, type RequestConnection } from './auth.ts';

export interface PtyRoute {
  path: string;
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  dispose: () => void;
}

export function createPtyRoute(pool: HostPool, resolveHostId: (id: string) => boolean, connection?: RequestConnection): PtyRoute {
  const wss = new WebSocketServer({ noServer: true });
  let disposed = false;

  return {
    path: '/server-deck/ws/pty',
    handler(req, socket, head) {
      const rejection = disposed ? { status: 503 } : requestRejection(req, connection);
      if (rejection !== undefined) {
        socket.end(`HTTP/1.1 ${rejection.status} ${STATUS_CODES[rejection.status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      const url = new URL(req.url ?? '/', 'http://loopback');
      const hostId = url.searchParams.get('host') ?? '';
      const cols = Math.max(2, Math.min(500, Number(url.searchParams.get('cols')) || 80));
      const rows = Math.max(2, Math.min(300, Number(url.searchParams.get('rows')) || 24));
      if (hostId.length === 0 || !resolveHostId(hostId)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => { void bridge(ws, pool, hostId, cols, rows); });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

async function bridge(
  ws: WebSocket,
  pool: HostPool,
  hostId: string,
  cols: number,
  rows: number,
): Promise<void> {
  let stream: Awaited<ReturnType<HostPool['shell']>> | null = null;
  let closed = false;
  const closeBoth = (): void => {
    closed = true;
    const current = stream;
    stream = null;
    if (current !== null) {
      try { current.end(); current.close(); } catch { /* 已断 */ }
    }
    if (ws.readyState === ws.OPEN) ws.close(1000, 'closed');
  };
  // A disconnect can happen while SSH is still creating the shell.
  ws.on('close', closeBoth);
  ws.on('error', closeBoth);

  try {
    stream = await pool.shell(hostId, cols, rows);
  } catch (error) {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\x1b[31m[server-deck] ${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
      ws.close(1011, 'shell failed');
    }
    return;
  }
  if (closed || ws.readyState !== ws.OPEN) {
    closeBoth();
    return;
  }

  stream.on('data', (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  stream.on('close', () => {
    stream = null;
    if (ws.readyState === ws.OPEN) ws.close(1000, 'stream closed');
  });
  stream.stderr?.on?.('data', () => { /* shell 模式无独立 stderr,防未捕获 */ });

  ws.on('message', (data) => {
    if (stream === null) return;
    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (text.startsWith('{"type":"resize"')) {
      try {
        const msg = JSON.parse(text) as { cols?: number; rows?: number };
        const c = Math.max(2, Math.min(500, Number(msg.cols) || cols));
        const r = Math.max(2, Math.min(300, Number(msg.rows) || rows));
        stream.setWindow(r, c, 0, 0);
      } catch { /* 忽略坏帧 */ }
      return;
    }
    stream.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
  });
}
