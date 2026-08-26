/**
 * 浏览器端 API 封装:/server-deck/api/*。
 */

import type { HostEntry, HostInput, HostStatus } from '../types.ts';

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/server-deck/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export function listHosts(): Promise<{ hosts: HostEntry[] }> {
  return jfetch('/hosts');
}

export function createHost(input: HostInput): Promise<{ host: HostEntry }> {
  return jfetch('/hosts', { method: 'POST', body: JSON.stringify(input) });
}

export function updateHost(id: string, input: HostInput): Promise<{ host: HostEntry }> {
  return jfetch(`/hosts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteHost(id: string): Promise<void> {
  return jfetch(`/hosts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function testHost(id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return jfetch(`/hosts/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' });
}

export function getStatuses(): Promise<{ statuses: HostStatus[] }> {
  return jfetch('/status');
}

export function importSshConfig(dryRun = false): Promise<{
  found: number;
  importedCount: number;
  skipped: number;
}> {
  return jfetch('/import-ssh-config', { method: 'POST', body: JSON.stringify({ dryRun }) });
}

/** PTY WebSocket 地址(同源)。 */
export function ptyUrl(hostId: string, cols: number, rows: number): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ host: hostId, cols: String(cols), rows: String(rows) });
  return `${proto}://${location.host}/server-deck/ws/pty?${q}`;
}

export { type HostEntry, type HostInput, type HostStatus };
