/**
 * PTY WebSocket 桥:/server-deck/ws/pty?host=<id>&cols=<n>&rows=<n>
 *
 * dsh-host-webserver 的升级路由把协商交给路由所有者——这里用 ws 的
 * noServer 模式完成握手,然后把 xterm 的帧双向桥接到 ssh2 shell 流。
 * 帧协议:二进制/text 帧 = 终端 stdin;`{"type":"resize",...}` JSON 帧 =
 * 调整窗口大小。访问面与 REST 一致:仅回环。
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { HostPool } from './pool.ts';

export interface PtyRoute {
  path: string;
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export function createPtyRoute(pool: HostPool, resolveHostId: (id: string) => boolean): PtyRoute {
  const wss = new WebSocketServer({ noServer: true });

  return {
    path: '/server-deck/ws/pty',
    handler(req, socket, head) {
      const remote = req.socket.remoteAddress ?? '';
      if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
        socket.destroy();
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
  const closeBoth = (): void => {
    if (stream !== null) {
      try { stream.end(); stream.close(); } catch { /* 已断 */ }
      stream = null;
    }
    if (ws.readyState === ws.OPEN) ws.close(1000, 'closed');
  };

  try {
    stream = await pool.shell(hostId, cols, rows);
  } catch (error) {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\x1b[31m[server-deck] ${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
      ws.close(1011, 'shell failed');
    }
    return;
  }

  stream.on('data', (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  stream.on('close', () => {
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
  ws.on('close', closeBoth);
  ws.on('error', closeBoth);
}
