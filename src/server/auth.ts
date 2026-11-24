import type { IncomingMessage } from 'node:http';

/** Request admission on older DSH hosts that do not pass a Peer to route handlers. */
export interface RequestConnection {
  requestRejection?(request: IncomingMessage): number | undefined;
}

/** The fields used from the Peer supplied by an authenticated WebServer route. */
export interface RequestPeer {
  readonly principal: { readonly kind: string };
  readonly signal: Pick<AbortSignal, 'aborted'>;
}

export interface RequestRejection {
  status: 401 | 403 | 503;
  error: string;
}

const unavailable: RequestRejection = { status: 503, error: '宿主请求鉴权不可用' };
const loginRequired: RequestRejection = { status: 401, error: '请先登录 DSH' };

/** Preserve the plugin's local-only access boundary in addition to host authentication. */
export function isLoopback(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/** Host/Origin trust and credential verification belong to the host, not the plugin. */
export function requestRejection(
  req: IncomingMessage,
  connection?: RequestConnection,
  peer?: RequestPeer,
): RequestRejection | undefined {
  if (!isLoopback(req)) return { status: 403, error: '仅允许本机访问' };
  if (peer !== undefined) {
    if (typeof peer?.signal?.aborted !== 'boolean' || typeof peer.principal?.kind !== 'string') return unavailable;
    if (peer.signal.aborted) return loginRequired;
    if (peer.principal.kind !== 'owner') return { status: 403, error: '仅 DSH 所有者可访问' };
    return undefined;
  }

  // New hosts authenticate before dispatch. Only the legacy API can admit a request without a Peer.
  try {
    if (typeof connection?.requestRejection !== 'function') return unavailable;
    const status = connection.requestRejection(req);
    if (status === undefined) return undefined;
    if (status === 401) return loginRequired;
    if (status === 403) return { status, error: '请求来源不受信任' };
  } catch { /* A failed legacy verifier must never grant access. */ }
  return unavailable;
}
