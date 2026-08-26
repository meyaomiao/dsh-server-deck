/**
 * ~/.ssh/config 解析(纯函数,便于单测):
 * 支持 Host / HostName / User / Port / IdentityFile / ProxyJump 与通配 Host 行
 * (通配 pattern 含 * 或 ? 的条目跳过)。Include 不展开(标注 skipped)。
 */

export interface SshConfigCandidate {
  alias: string;
  /** 同一 Host 行的全部非通配别名(多别名共享一个 HostName)。 */
  aliases: string[];
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

export interface SshConfigParseResult {
  candidates: SshConfigCandidate[];
  includes: string[];
}

/** 解析 ssh config 文本为候选主机列表。 */
export function parseSshConfig(text: string): SshConfigParseResult {
  const candidates: SshConfigCandidate[] = [];
  const includes: string[] = [];
  let current: SshConfigCandidate | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (m === null) continue;
    const keyword = m[1].toLowerCase();
    const value = m[2].trim();

    if (keyword === 'host') {
      current = null;
      const names = value.split(/\s+/).filter((n) => !n.includes('*') && !n.includes('?'));
      if (names.length > 0) {
        current = { alias: names[0], aliases: names };
        candidates.push(current);
      }
      continue;
    }
    if (keyword === 'include') {
      for (const inc of value.split(/\s+/)) includes.push(inc);
      continue;
    }
    if (current === null) continue;
    if (keyword === 'hostname') current.hostname = value;
    else if (keyword === 'user') current.user = value;
    else if (keyword === 'port') {
      const p = Number(value);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) current.port = p;
    } else if (keyword === 'identityfile') current.identityFile = value.replace(/^~(?=\/|$)/, homedirPrefix());
    else if (keyword === 'proxyjump') current.proxyJump = value.split(/\s+/)[0];
  }

  return { candidates, includes };
}

function homedirPrefix(): string {
  try {
    return osHomedir();
  } catch {
    return '~';
  }
}

import { homedir as osHomedir } from 'node:os';
