import type { IncomingMessage } from 'node:http';

/** Admission the host returns from `connection.admit()` (DSH 0.2.3-alpha.1 and newer). */
export interface RequestAdmission {
  readonly peer?: unknown;
  readonly rejection?: 401 | 403 | 503;
}

/**
 * Host Connection admission surface the plugin adapts to.
 *
 * `requestRejection()` is the 0.2.1-rc.5…0.2.2-rc.5 surface; `admit()` replaced
 * it in 0.2.3-alpha.1 with the same role: Host/Origin trust plus credential
 * verification, returning the admitted Peer or a rejection status.
 */
export interface RequestConnection {
  requestRejection?(request: IncomingMessage): number | undefined;
  admit?(request: IncomingMessage): RequestAdmission | undefined;
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

/**
 * Read one admission status from whichever surface the host provides.
 * @returns the rejection status, `undefined` when admitted, or `null` when the
 * host exposes no usable admission surface.
 */
function admissionStatus(connection: RequestConnection, req: IncomingMessage): number | undefined | null {
  try {
    if (typeof connection.requestRejection === 'function') return connection.requestRejection(req);
    if (typeof connection.admit === 'function') {
      const admission = connection.admit(req);
      if (admission === undefined) return null;
      return admission.rejection;
    }
  } catch { /* Missing or failed host admission must never become loopback-only access. */ }
  return null;
}

/** Host/Origin trust and credential verification belong to the host, not the plugin. */
export function requestRejection(req: IncomingMessage, connection?: RequestConnection): RequestRejection | undefined {
  if (!isLoopback(req)) return { status: 403, error: '仅允许本机访问' };
  const unavailable: RequestRejection = { status: 503, error: '宿主请求鉴权不可用,请升级至 DSH 0.2.1-rc.5 或更新版本' };
  if (connection === undefined) return unavailable;
  const status = admissionStatus(connection, req);
  if (status === undefined) return undefined;
  if (status === 401) return { status, error: '请先登录 DSH' };
  if (status === 403) return { status, error: '请求来源不受信任' };
  return unavailable;
}
