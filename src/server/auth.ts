import type { IncomingMessage } from 'node:http';

/** Public host Connection admission surface (DSH 0.2.1-rc.5). */
export interface RequestConnection {
  requestRejection(request: IncomingMessage): number | undefined;
}

export interface RequestRejection {
  status: 401 | 403 | 503;
  error: string;
}

/** Preserve the plugin's local-only access boundary in addition to host authentication. */
export function isLoopback(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/** Host/Origin trust and credential verification belong to the host, not the plugin. */
export function requestRejection(req: IncomingMessage, connection?: RequestConnection): RequestRejection | undefined {
  if (!isLoopback(req)) return { status: 403, error: '仅允许本机访问' };
  const unavailable: RequestRejection = { status: 503, error: '宿主请求鉴权不可用,请升级至 DSH 0.2.1-rc.5 或更新版本' };
  if (typeof connection?.requestRejection !== 'function') return unavailable;
  try {
    const status = connection.requestRejection(req);
    if (status === undefined) return undefined;
    if (status === 401) return { status, error: '请先登录 DSH' };
    if (status === 403) return { status, error: '请求来源不受信任' };
  } catch { /* Missing or failed host admission must never become loopback-only access. */ }
  return unavailable;
}
