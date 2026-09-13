/**
 * 把用户/模型给的主机查询解析成台账里唯一一台。
 * 匹配顺序:精确 id → 展示名 → IP/`user@host`/`host:port` → 唯一子串。
 */

export interface HostPick {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  tags?: string[];
}

export type ResolveHostResult =
  | { ok: true; host: HostPick }
  | { ok: false; error: string };

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function label(h: HostPick): string {
  return `${h.name} (${h.id})`;
}

/** 在台账里解析一台主机;0 或多台都失败并带原因。 */
export function resolveHost(hosts: readonly HostPick[], query: string): ResolveHostResult {
  const q = query.trim();
  if (q.length === 0) return { ok: false, error: 'host 不能为空' };
  const nq = norm(q);

  const byId = hosts.filter((h) => h.id === q);
  if (byId.length === 1) return { ok: true, host: byId[0]! };

  const byName = hosts.filter((h) => norm(h.name) === nq);
  if (byName.length === 1) return { ok: true, host: byName[0]! };
  if (byName.length > 1) {
    return { ok: false, error: `多台主机名叫 ${q}: ${byName.map(label).join(', ')}` };
  }

  const byAddr = hosts.filter((h) => {
    const host = norm(h.host);
    return host === nq
      || norm(`${h.username}@${h.host}`) === nq
      || norm(`${h.host}:${String(h.port)}`) === nq;
  });
  if (byAddr.length === 1) return { ok: true, host: byAddr[0]! };
  if (byAddr.length > 1) {
    return { ok: false, error: `多台主机匹配 ${q}: ${byAddr.map(label).join(', ')}` };
  }

  const fuzzy = hosts.filter((h) =>
    norm(h.id).includes(nq) || norm(h.name).includes(nq) || norm(h.host).includes(nq),
  );
  if (fuzzy.length === 1) return { ok: true, host: fuzzy[0]! };
  if (fuzzy.length > 1) {
    return { ok: false, error: `多台主机匹配 ${q}: ${fuzzy.map(label).join(', ')}` };
  }
  return { ok: false, error: `台账里没有主机 ${q}` };
}
