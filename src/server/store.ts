/**
 * 主机台账持久化:`~/.dsh/server-deck.json`(公开字段,0644)
 * + `~/.dsh/server-deck.secrets.json`(password/passphrase,0600,永不回传)。
 * 原子写:临时文件 + rename。
 */

import { mkdir, readFile, chmod, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthKind, HostEntry, HostInput } from '../types.ts';

const DSH_DIR = join(homedir(), '.dsh');
const HOSTS_FILE = join(DSH_DIR, 'server-deck.json');
const SECRETS_FILE = join(DSH_DIR, 'server-deck.secrets.json');

interface SecretsBlob {
  [hostId: string]: { password?: string; passphrase?: string };
}

interface HostsBlob {
  version: 1;
  hosts: HostEntry[];
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 校验并规范化客户端输入;返回(公开字段 + 秘密)二元组。 */
export function normalizeInput(raw: HostInput): {
  fields: Partial<Omit<HostEntry, 'id' | 'createdAt'>>;
  secret: { password?: string; passphrase?: string };
} {
  const fields: Partial<Omit<HostEntry, 'id' | 'createdAt'>> = {};
  const secret: { password?: string; passphrase?: string } = {};

  if (raw.name !== undefined) {
    if (!isStr(raw.name)) throw new Error('name 无效');
    fields.name = raw.name.trim();
  }
  if (raw.host !== undefined) {
    if (!isStr(raw.host)) throw new Error('host 无效');
    fields.host = raw.host.trim();
  }
  if (raw.port !== undefined) {
    const p = Number(raw.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('port 无效');
    fields.port = p;
  }
  if (raw.username !== undefined) {
    if (!isStr(raw.username)) throw new Error('username 无效');
    fields.username = raw.username.trim();
  }
  if (raw.auth !== undefined) {
    if (raw.auth !== 'password' && raw.auth !== 'key' && raw.auth !== 'agent') {
      throw new Error('auth 必须是 password | key | agent');
    }
    fields.auth = raw.auth as AuthKind;
  }
  if (raw.keyPath !== undefined) {
    if (typeof raw.keyPath !== 'string') throw new Error('keyPath 无效');
    fields.keyPath = raw.keyPath.trim() || undefined;
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === 'string')) {
      throw new Error('tags 必须是字符串数组');
    }
    fields.tags = raw.tags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (raw.notes !== undefined) {
    if (typeof raw.notes !== 'string') throw new Error('notes 无效');
    fields.notes = raw.notes.trim() || undefined;
  }
  if (typeof raw.password === 'string' && raw.password.length > 0) secret.password = raw.password;
  else if (raw.password === null) secret.password = undefined;
  if (typeof raw.passphrase === 'string' && raw.passphrase.length > 0) secret.passphrase = raw.passphrase;
  else if (raw.passphrase === null) secret.passphrase = undefined;

  return { fields, secret };
}

async function atomicWrite(path: string, data: string, mode?: number): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, 'utf8');
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, path);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 台账仓库:内存缓存 + 原子落盘。 */
export class HostStore {
  private blob: HostsBlob = { version: 1, hosts: [] };
  private secrets: SecretsBlob = {};

  async load(): Promise<void> {
    await mkdir(DSH_DIR, { recursive: true });
    this.blob = await readJson<HostsBlob>(HOSTS_FILE, { version: 1, hosts: [] });
    if (!Array.isArray(this.blob.hosts)) this.blob.hosts = [];
    this.secrets = await readJson<SecretsBlob>(SECRETS_FILE, {});
  }

  list(): readonly HostEntry[] {
    return this.blob.hosts;
  }

  get(id: string): HostEntry | undefined {
    return this.blob.hosts.find((h) => h.id === id);
  }

  getSecret(id: string): { password?: string; passphrase?: string } {
    return this.secrets[id] ?? {};
  }

  async create(input: HostInput): Promise<HostEntry> {
    const { fields, secret } = normalizeInput(input);
    if (!isStr(fields.host) || !isStr(fields.username) || !fields.auth) {
      throw new Error('host / username / auth 为必填');
    }
    const entry: HostEntry = {
      id: `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: fields.name?.trim() || `${fields.username}@${fields.host}`,
      host: fields.host,
      port: fields.port ?? 22,
      username: fields.username,
      auth: fields.auth,
      keyPath: fields.keyPath,
      tags: fields.tags,
      notes: fields.notes,
      createdAt: new Date().toISOString(),
    };
    this.blob.hosts.push(entry);
    if (secret.password !== undefined || secret.passphrase !== undefined) {
      this.secrets[entry.id] = secret;
      await atomicWrite(SECRETS_FILE, JSON.stringify(this.secrets, null, 2), 0o600);
    }
    await atomicWrite(HOSTS_FILE, JSON.stringify(this.blob, null, 2));
    return entry;
  }

  async update(id: string, input: HostInput): Promise<HostEntry> {
    const entry = this.get(id);
    if (entry === undefined) throw Object.assign(new Error('主机不存在'), { status: 404 });
    const { fields, secret } = normalizeInput(input);
    const next = { ...entry, ...fields } as HostEntry;
    next.name = next.name || `${next.username}@${next.host}`;
    const idx = this.blob.hosts.indexOf(entry);
    this.blob.hosts[idx] = next;
    if (secret.password !== undefined || secret.passphrase !== undefined) {
      this.secrets[id] = { ...this.secrets[id], ...secret };
      // 显式清除:password/passphrase 传 null 时 normalize 得到 undefined,这里删除键
      for (const k of ['password', 'passphrase'] as const) {
        if (this.secrets[id][k] === undefined) delete this.secrets[id][k];
      }
      if (Object.keys(this.secrets[id]).length === 0) delete this.secrets[id];
      await atomicWrite(SECRETS_FILE, JSON.stringify(this.secrets, null, 2), 0o600);
    }
    await atomicWrite(HOSTS_FILE, JSON.stringify(this.blob, null, 2));
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.blob.hosts.length;
    this.blob.hosts = this.blob.hosts.filter((h) => h.id !== id);
    if (this.blob.hosts.length === before) return false;
    if (id in this.secrets) {
      delete this.secrets[id];
      await atomicWrite(SECRETS_FILE, JSON.stringify(this.secrets, null, 2), 0o600);
    }
    await atomicWrite(HOSTS_FILE, JSON.stringify(this.blob, null, 2));
    return true;
  }
}
