/**
 * /server-deck/api REST 路由:
 *   GET    /hosts                 台账列表(无秘密)
 *   POST   /hosts                 新增(可含 password/passphrase,落 0600 secrets)
 *   PATCH  /hosts/<id>            更新
 *   DELETE /hosts/<id>            删除
 *   POST   /hosts/<id>/test       独立短连接测试
 *   GET    /status                全量状态探测(并发 4,Linux/Darwin 指标)
 *   POST   /import-ssh-config     解析 ~/.ssh/config 并导入新主机
 * 访问面:仅回环放行(与 side-panel 同款防护)。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostEntry, HostInput, HostStatus } from '../types.ts';
import type { HostPool } from './pool.ts';
import { PROBE_SCRIPT, parseProbeOutput } from './probe.ts';
import type { HostStore } from './store.ts';
import { parseSshConfig } from './sshconfig.ts';

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 4;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 仅回环放行(DNS rebinding / 局域网直连防护)。 */
export function isLoopback(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 256 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const text = await readBody(req);
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw Object.assign(new Error('JSON 解析失败'), { status: 400 });
  }
}

/** 全量探测(带并发上限与缓存快照)。 */
export async function probeAll(pool: HostStore, ssh: HostPool): Promise<HostStatus[]> {
  const hosts = [...pool.list()];
  const results = new Map<string, HostStatus>();
  for (const h of hosts) results.set(h.id, { id: h.id, state: 'probing', probedAt: new Date().toISOString() });

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < hosts.length) {
      const host = hosts[cursor++];
      const base = results.get(host.id) ?? { id: host.id, state: 'probing' as const };
      try {
        await ssh.connect(host.id);
        const started = Date.now();
        const { stdout } = await ssh.exec(host.id, PROBE_SCRIPT, PROBE_TIMEOUT_MS);
        const latencyMs = Date.now() - started;
        const parsed = parseProbeOutput(stdout);
        results.set(host.id, { ...base, ...parsed, state: 'online', latencyMs, probedAt: new Date().toISOString() });
      } catch (error) {
        results.set(host.id, {
          ...base,
          state: 'offline',
          error: error instanceof Error ? error.message : String(error),
          probedAt: new Date().toISOString(),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, hosts.length) }, worker));
  return hosts.map((h) => results.get(h.id) ?? { id: h.id, state: 'unknown' });
}

interface ImportBody { dryRun?: boolean }

/** Git 托管平台的 SSH 端点:密钥别名指向它们,不是可管理服务器。 */
const GIT_HOSTING_HOSTS = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org', 'gitee.com', 'e.coding.net',
  'codeberg.org', 'ssh.dev.azure.com', 'git.sr.ht', 'chromium.googlesource.com',
]);

function isGitHostingHost(hostname: string, username: string): boolean {
  if (GIT_HOSTING_HOSTS.has(hostname.toLowerCase())) return true;
  // 泛匹配常见自建 Git 子域(如 github.mycompany.com)
  if (/^(github|gitlab|gitee)\./i.test(hostname)) return true;
  return username === 'git';
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** 多别名行优先取非 IP 的语义化别名做展示名(如 moiraism-com-prod)。 */
function pickDisplayName(c: { alias: string; aliases?: string[] }): string {
  const names = c.aliases ?? [c.alias];
  return names.find((n) => !IPV4_RE.test(n)) ?? c.alias;
}

/** 创建 API 路由处理器(prefix:/server-deck/api)。 */
export function createApiRouter(
  store: HostStore,
  ssh: HostPool,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: '仅允许本机访问' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://loopback');
    // webserver 不改写 req.url:prefix 路由收到全路径。兼容两种形态,尾部斜杠归一。
    const raw = url.pathname;
    const stripped = raw.startsWith('/server-deck/api') ? raw.slice('/server-deck/api'.length) : raw;
    const path = stripped.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    try {
      // ---- 集合级 ----
      if (path === '/hosts' && method === 'GET') {
        sendJson(res, 200, { ok: true, hosts: store.list() });
        return;
      }
      if (path === '/hosts' && method === 'POST') {
        const body = await readJsonBody<HostInput>(req);
        const entry = await store.create(body);
        sendJson(res, 201, { ok: true, host: entry });
        return;
      }
      if (path === '/status' && method === 'GET') {
        const statuses = await probeAll(store, ssh);
        sendJson(res, 200, { ok: true, statuses });
        return;
      }
      if (path === '/import-ssh-config' && method === 'POST') {
        const body = await readJsonBody<ImportBody>(req);
        const raw = await readFile(join(homedir(), '.ssh', 'config'), 'utf8');
        const { candidates } = parseSshConfig(raw);
        const existing = new Set(store.list().map((h) => `${h.username}@${h.host}:${h.port}`));
        const imported: HostEntry[] = [];
        let skipped = 0;
        let gitAliases = 0;
        for (const c of candidates) {
          const hostName = c.hostname ?? c.alias;
          const username = c.user ?? '';
          const port = c.port ?? 22;
          // Git 托管平台的密钥别名(如 Host github.com-xxx / User git)不是可管理
          // 的服务器,连上也没有 shell——跳过不导入。
          if (isGitHostingHost(hostName, username)) {
            gitAliases += 1;
            continue;
          }
          if (username.length === 0 || existing.has(`${username}@${hostName}:${port}`)) {
            skipped += 1;
            continue;
          }
          if (body.dryRun === true) { continue; }
          // 多别名行(Host ip alias1 alias2):优先用语义化别名做展示名
          const displayName = pickDisplayName(c);
          imported.push(await store.create({
            name: displayName, host: hostName, port, username,
            auth: 'key', keyPath: c.identityFile ?? '~/.ssh/id_ed25519',
            tags: ['ssh-config'], notes: c.proxyJump !== undefined ? `ProxyJump ${c.proxyJump}` : undefined,
          }));
          existing.add(`${username}@${hostName}:${port}`);
        }
        sendJson(res, 200, { ok: true, found: candidates.length, importedCount: imported.length, skipped, gitAliases, imported });
        return;
      }

      // ---- 单主机:/hosts/<id>[/test] ----
      const m = /^\/hosts\/([^/]+)(\/test)?$/.exec(path);
      if (m !== null) {
        const id = decodeURIComponent(m[1]);
        if (method === 'PATCH') {
          const body = await readJsonBody<HostInput>(req);
          const entry = await store.update(id, body);
          sendJson(res, 200, { ok: true, host: entry });
          return;
        }
        if (method === 'DELETE') {
          ssh.close(id);
          const removed = await store.remove(id);
          sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: '主机不存在' });
          return;
        }
        if (method === 'POST' && m[2] === '/test') {
          const host = store.get(id);
          if (host === undefined) { sendJson(res, 404, { error: '主机不存在' }); return; }
          const result = await ssh.test(host);
          sendJson(res, 200, result);
          return;
        }
      }

      sendJson(res, 404, { error: `未知路由 ${method} ${path}` });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
