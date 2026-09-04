/**
 * /server-deck/api REST 路由:
 *   GET    /hosts                 台账列表(无秘密)
 *   POST   /hosts                 新增(可含 password/passphrase,落 0600 secrets)
 *   PATCH  /hosts/<id>            更新
 *   DELETE /hosts/<id>            删除
 *   POST   /hosts/<id>/test       独立短连接测试
 *   GET    /status                最新快照(读 recorder, ?force=1 立即探测一轮)
 *   GET    /metrics               趋势序列 hostId&range&bucket&from&to
 *   GET    /metrics/settings      采集设置
 *   PATCH  /metrics/settings      改采集周期 / 总开关 / 每机暂停
 *   POST   /import-ssh-config     解析 ~/.ssh/config 并导入新主机
 * 访问面:仅回环放行(与 side-panel 同款防护)。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostEntry, HostInput, MetricsSettings } from '../types.ts';
import {
  allowedBuckets,
  assertHostId,
  buildSeries,
  isMetricBucket,
  isMetricRangeKind,
  normalizeSettings,
  resolveBucket,
  resolveRange,
} from '../metrics.ts';
import type { HostPool } from './pool.ts';
import type { HostStore } from './store.ts';
import type { MetricStore } from './metric-store.ts';
import type { MetricRecorder } from './recorder.ts';
import type { SarBackfill } from './backfill.ts';
import { parseSshConfig } from './sshconfig.ts';

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

interface ImportBody { dryRun?: boolean }

/** Git 托管平台的 SSH 端点:密钥别名指向它们,不是可管理服务器。 */
const GIT_HOSTING_HOSTS = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org', 'gitee.com', 'e.coding.net',
  'codeberg.org', 'ssh.dev.azure.com', 'git.sr.ht', 'chromium.googlesource.com',
]);

function isGitHostingHost(hostname: string, username: string): boolean {
  if (GIT_HOSTING_HOSTS.has(hostname.toLowerCase())) return true;
  if (/^(github|gitlab|gitee)\./i.test(hostname)) return true;
  return username === 'git';
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** 多别名行优先取非 IP 的语义化别名做展示名(如 moiraism-com-prod)。 */
function pickDisplayName(c: { alias: string; aliases?: string[] }): string {
  const names = c.aliases ?? [c.alias];
  return names.find((n) => !IPV4_RE.test(n)) ?? c.alias;
}

function parseMs(raw: string | null): number | undefined {
  if (raw === null || raw.length === 0) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 创建 API 路由处理器(prefix:/server-deck/api)。 */
export function createApiRouter(
  store: HostStore,
  ssh: HostPool,
  metrics: MetricStore,
  recorder: MetricRecorder,
  backfill?: SarBackfill,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: '仅允许本机访问' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://loopback');
    const raw = url.pathname;
    const stripped = raw.startsWith('/server-deck/api') ? raw.slice('/server-deck/api'.length) : raw;
    const path = stripped.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    try {
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
        const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
        const statuses = force ? await recorder.tick(true) : recorder.latestStatuses();
        sendJson(res, 200, { ok: true, statuses });
        return;
      }
      if (path === '/metrics/settings' && method === 'GET') {
        sendJson(res, 200, { ok: true, settings: metrics.getSettings() });
        return;
      }
      if (path === '/metrics/settings' && method === 'PATCH') {
        const body = await readJsonBody<Partial<MetricsSettings>>(req);
        const merged = normalizeSettings({ ...metrics.getSettings(), ...body });
        const settings = await metrics.saveSettings(merged);
        recorder.arm();
        sendJson(res, 200, { ok: true, settings });
        return;
      }
      if (path === '/metrics' && method === 'GET') {
        const rangeRaw = url.searchParams.get('range') ?? '3h';
        if (!isMetricRangeKind(rangeRaw)) {
          sendJson(res, 400, { error: 'range 必须是 3h | today | 7d | 30d | custom' });
          return;
        }
        const bucketRaw = url.searchParams.get('bucket') ?? 'auto';
        if (bucketRaw !== 'auto' && !isMetricBucket(bucketRaw)) {
          sendJson(res, 400, { error: 'bucket 无效' });
          return;
        }
        const now = Date.now();
        const customFrom = parseMs(url.searchParams.get('from'));
        const customTo = parseMs(url.searchParams.get('to'));
        const { from, to } = resolveRange(
          rangeRaw,
          now,
          rangeRaw === 'custom' && customFrom !== undefined && customTo !== undefined
            ? { from: customFrom, to: customTo }
            : undefined,
        );
        const { requested, bucketUsed } = resolveBucket(to - from, bucketRaw === 'auto' ? 'auto' : bucketRaw);
        const hostParam = url.searchParams.get('hostId');
        const ids = hostParam !== null && hostParam.length > 0
          ? [assertHostId(hostParam)]
          : store.list().map((h) => h.id);
        const series = [];
        for (const id of ids) {
          // 窗口早于本地最早样本时,尝试从服务器 sar 回填(限频,失败静默)
          if (backfill !== undefined) {
            try { await backfill.ensure(id, from, to); } catch { /* 忽略 */ }
          }
          const samples = await metrics.query(id, from, to);
          series.push(buildSeries(id, samples, from, to, bucketUsed));
        }
        sendJson(res, 200, {
          ok: true,
          from,
          to,
          range: rangeRaw,
          bucket: requested,
          bucketUsed,
          allowedBuckets: allowedBuckets(to - from),
          series,
        });
        return;
      }
      if (path === '/import-ssh-config' && method === 'POST') {
        const body = await readJsonBody<ImportBody>(req);
        const rawCfg = await readFile(join(homedir(), '.ssh', 'config'), 'utf8');
        const { candidates } = parseSshConfig(rawCfg);
        const existing = new Set(store.list().map((h) => `${h.username}@${h.host}:${h.port}`));
        const imported: HostEntry[] = [];
        let skipped = 0;
        let gitAliases = 0;
        for (const c of candidates) {
          const hostName = c.hostname ?? c.alias;
          const username = c.user ?? '';
          const port = c.port ?? 22;
          if (isGitHostingHost(hostName, username)) {
            gitAliases += 1;
            continue;
          }
          if (username.length === 0 || existing.has(`${username}@${hostName}:${port}`)) {
            skipped += 1;
            continue;
          }
          if (body.dryRun === true) { continue; }
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
          recorder.forget(id);
          const removed = await store.remove(id);
          if (removed) await metrics.removeHost(id);
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
