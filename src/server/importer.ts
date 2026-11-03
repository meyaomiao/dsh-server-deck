/* Import planning is read-only. Only confirm() may call the store's mutation methods. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostEntry, HostInput, ImportCandidate, ImportConfirmation, ImportPreview, ImportResult } from '../types.ts';
import { assertJumpTarget, normalizeInput } from './store.ts';
import { parseSshConfig, type SshConfigCandidate } from './sshconfig.ts';

/** No load/getSecret is needed by an importer, including during preview. */
export interface ImportStore {
  list(): readonly HostEntry[];
  create(input: HostInput): Promise<HostEntry>;
  update(id: string, input: HostInput): Promise<HostEntry>;
}

interface Node {
  row: ImportCandidate;
  source?: SshConfigCandidate;
  existing?: HostEntry;
  input?: HostInput;
  error?: string;
  route?: string[];
  jump?: string;
  explicitNone?: boolean;
  excluded?: boolean;
}
interface Plan { preview: ImportPreview; nodes: Map<string, Node>; hosts: readonly HostEntry[] }
const GIT_HOSTS = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org', 'gitee.com', 'e.coding.net',
  'codeberg.org', 'ssh.dev.azure.com', 'git.sr.ht', 'chromium.googlesource.com',
]);
const endpoint = (user: string, host: string, port: number): string => JSON.stringify([user, host.toLowerCase(), port]);
const failure = (message: string, status = 400): Error => Object.assign(new Error(message), { status });
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const selectable = (row: ImportCandidate): boolean => row.action === 'create' || row.action === 'update';

/** A jump token is an alias/host with optional user and port, never an opaque alias. */
function parseJump(raw: string): { alias: string; user?: string; port?: number } {
  const match = /^(?:([^\s@,:]+)@)?(\[[^\]]+\]|[^\s@,:]+)(?::(\d+))?$/.exec(raw);
  if (!match) throw failure(`无效 ProxyJump 引用：${raw}`);
  const port = match[3] === undefined ? undefined : Number(match[3]);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw failure(`ProxyJump 端口无效：${raw}`);
  }
  return { alias: match[2].replace(/^\[|\]$/g, ''), user: match[1], port };
}

/** Keep rejected Host patterns visible; the legacy parser intentionally omits them. */
function sections(text: string): Array<{ text: string; names: string[]; badPort: boolean; unsupported: boolean }> {
  const result: ReturnType<typeof sections> = [];
  let current: ReturnType<typeof sections>[number] | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const canonical = raw.replace(/^(\s*[A-Za-z][\w]*)\s*=\s*/, '$1 ');
    const line = canonical.replace(/#.*$/, '').trim();
    const host = /^host\s+(.+)$/i.exec(line);
    if (host) {
      current = { text: canonical, names: host[1].split(/\s+/), badPort: false, unsupported: false };
      result.push(current);
    } else if (/^match\s/i.test(line)) {
      current = undefined;
    } else if (current) {
      current.text += `\n${canonical}`;
      const port = /^port\s+(.+)$/i.exec(line);
      if (port && (!/^\d+$/.test(port[1]) || Number(port[1]) < 1 || Number(port[1]) > 65535)) current.badPort = true;
      if (/^proxycommand\s+(?!none$)/i.test(line)) current.unsupported = true;
    }
  }
  return result;
}

/** Construct the entire candidate graph before writing any host. */
function planImport(text: string, hosts: readonly HostEntry[]): Plan {
  const nodes = new Map<string, Node>();
  const endpoints = new Map<string, Node>();
  const aliases = new Map<string, Set<Node>>();
  const warnings: string[] = [];
  const addAlias = (alias: string, node: Node): void => {
    const key = alias.toLowerCase();
    const values = aliases.get(key) ?? new Set<Node>();
    values.add(node);
    aliases.set(key, values);
  };
  const add = (source: SshConfigCandidate, extraError?: string, dependency = false): Node => {
    const host = source.hostname ?? source.alias;
    const username = source.user ?? '';
    const port = source.port ?? 22;
    const key = endpoint(username, host, port);
    const found = endpoints.get(key);
    if (found) {
      found.error ??= extraError;
      if ((found.source?.proxyJump ?? '').toLowerCase() !== (source.proxyJump ?? '').toLowerCase()) {
        found.error = '同一连接端点有不同 ProxyJump，无法用单一跳板关联表示';
      }
      found.row.aliases = [...new Set([...found.row.aliases, ...source.aliases])];
      for (const alias of source.aliases) addAlias(alias, found);
      return found;
    }
    const matches = hosts.filter((h) => endpoint(h.username, h.host, h.port) === key);
    const existing = matches.length === 1 ? matches[0] : undefined;
    const name = source.aliases.find((n) => !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(n)) ?? source.alias;
    const node: Node = {
      row: { id: existing ? `host:${existing.id}` : `candidate:${nodes.size}`, name, aliases: [...source.aliases], host, username, port,
        proxyJump: source.proxyJump, action: 'create', reason: dependency ? 'ProxyJump 必需依赖' : '可新增', dependencies: [] },
      source, existing,
      input: { name, host, username, port, auth: 'key', keyPath: source.identityFile ?? '~/.ssh/id_ed25519', tags: ['ssh-config'],
        ...(source.proxyJump ? { notes: `SSH ProxyJump: ${source.proxyJump}` } : {}) },
      error: extraError,
    };
    if (matches.length > 1) node.error = '台账有多个相同连接端点，无法确定要关联的主机';
    if (!username.trim()) node.error ??= '缺少用户名（未推测本机用户名或通配配置）';
    if (!host.trim() || /[\s*?%]/.test(host)) node.error ??= 'HostName 无效或含未展开的通配/变量';
    if (GIT_HOSTS.has(host.toLowerCase()) || /^(github|gitlab|gitee)\./i.test(host) || username === 'git') {
      node.row.action = 'skip';
      node.row.reason = 'Git 托管 SSH 端点，不是可管理服务器';
      node.excluded = true;
      node.error = undefined;
    }
    nodes.set(node.row.id, node);
    endpoints.set(key, node);
    for (const alias of source.aliases) addAlias(alias, node);
    return node;
  };

  for (const block of sections(text)) {
    const patterns = block.names.filter((name) => /[*?!]/.test(name));
    const names = block.names.filter((name) => !/[*?!]/.test(name));
    if (patterns.length) {
      const id = `pattern:${nodes.size}`;
      nodes.set(id, { row: { id, name: patterns.join(' '), aliases: patterns, host: '', username: '', port: 22,
        action: 'skip', reason: '通配或否定 Host 规则不会作为主机导入，也不展开默认值', dependencies: [] } });
    }
    if (!names.length) continue;
    const source = parseSshConfig(`Host ${names.join(' ')}\n${block.text.split('\n').slice(1).join('\n')}`).candidates[0];
    if (source) {
      const jumpLine = block.text.split('\n').map((line) => /^\s*proxyjump\s+(.+)$/i.exec(line.replace(/#.*$/, ''))).filter((match) => match !== null).at(-1);
      if (jumpLine) source.proxyJump = jumpLine[1].trim();
      add(source, block.badPort ? '端口必须是 1–65535 的整数' : block.unsupported ? 'ProxyCommand 无法用跳板关联表示' : undefined);
    }
  }
  if (/^\s*include\s/im.test(text)) warnings.push('Include 文件未展开；请将需要导入的 Host 放入当前 SSH 配置后重新检测。');
  if (/^\s*match\s/im.test(text)) warnings.push('Match 条件未展开；条件内的配置不参与导入。');

  const existingNode = (host: HostEntry): Node => {
    const id = `host:${host.id}`;
    const found = nodes.get(id);
    if (found) return found;
    const node: Node = { existing: host, row: { id, name: host.name, aliases: [], host: host.host, username: host.username,
      port: host.port, action: 'skip', reason: '已有跳板主机，无需修改', dependencies: [] } };
    nodes.set(id, node);
    return node;
  };
  const resolve = (token: string): Node => {
    const ref = parseJump(token);
    let choices = [...(aliases.get(ref.alias.toLowerCase()) ?? [])];
    if (!choices.length) {
      const matches = hosts.filter((h) => (h.name.toLowerCase() === ref.alias.toLowerCase() || h.host.toLowerCase() === ref.alias.toLowerCase())
        && (ref.user === undefined || ref.user === h.username) && (ref.port === undefined || ref.port === h.port));
      choices = matches.map(existingNode);
    }
    if (choices.length !== 1) throw failure(choices.length ? `ProxyJump 引用不唯一：${token}` : `ProxyJump 引用不存在：${token}`);
    const base = choices[0];
    if (base.error && !base.error.startsWith('缺少用户名')) throw failure(`跳板不可导入：${base.row.name}（${base.error}）`);
    const user = ref.user ?? base.row.username;
    const port = ref.port ?? base.row.port;
    if (user === base.row.username && port === base.row.port) return base;
    if (!base.source) throw failure(`ProxyJump 用户或端口与已有主机不匹配：${token}`);
    // Overrides create a distinct endpoint, preserving the alias's key reference and jump declaration.
    const key = endpoint(user, base.row.host, port);
    return endpoints.get(key) ?? add({ ...base.source, alias: token, aliases: [], user, port }, undefined, true);
  };

  // Map iteration also visits qualified variants added by resolve().
  for (const node of nodes.values()) {
    if (!node.source || node.error || node.row.action === 'skip') continue;
    const raw = node.source.proxyJump;
    if (!raw) continue;
    if (raw.toLowerCase() === 'none') { node.explicitNone = true; continue; }
    try {
      const tokens = raw.split(',').map((token) => token.trim());
      if (tokens.some((token) => !token) || tokens.some((token) => token.toLowerCase() === 'none')) throw failure('ProxyJump none 不能与其他跳板混用');
      node.route = tokens.map((token) => resolve(token).row.id);
      if (new Set([node.row.id, ...node.route]).size !== node.route.length + 1) throw failure('ProxyJump 自指或链内重复主机');
      node.jump = node.route.at(-1);
    } catch (error) { node.error = (error as Error).message; }
  }

  // A comma list needs intermediate hosts to share the same single-parent graph.
  const claims = new Map<string, Array<{ owner: Node; jump: string }>>();
  for (const owner of nodes.values()) {
    if (owner.error) continue;
    for (let i = 1; i < (owner.route?.length ?? 0); i += 1) {
      const id = owner.route![i];
      const jump = owner.route![i - 1];
      const intermediate = nodes.get(id)!;
      const own = intermediate.jump ?? (intermediate.existing?.jumpHostId ? `host:${intermediate.existing.jumpHostId}` : undefined);
      if (intermediate.explicitNone || (own !== undefined && own !== jump)) {
        owner.error = `跳板链冲突：${intermediate.row.name} 已有不同跳板或显式 none`;
      }
      const values = claims.get(id) ?? [];
      values.push({ owner, jump });
      claims.set(id, values);
    }
  }
  for (const values of claims.values()) {
    const valid = values.filter(({ owner }) => !owner.error);
    if (new Set(valid.map(({ jump }) => jump)).size > 1) {
      for (const { owner } of valid) owner.error = '多个 ProxyJump 链要求同一主机使用不同跳板，无法用单一关联表示';
    }
  }
  for (const [id, values] of claims) {
    const active = values.find(({ owner }) => !owner.error);
    if (active) nodes.get(id)!.jump = active.jump;
  }
  for (const node of nodes.values()) {
    const old = node.existing?.jumpHostId;
    if (old && ((node.jump && node.jump !== `host:${old}`) || node.explicitNone)) {
      node.error ??= '已有主机使用不同跳板；保留用户关联，请手动处理后重新检测';
    }
  }

  // Existing paths are part of validation even if absent from the SSH file.
  const walk = (id: string, seen: Set<string>): void => {
    if (seen.has(id)) throw failure('ProxyJump 存在循环引用');
    const node = nodes.get(id);
    if (!node) {
      const host = hosts.find((h) => `host:${h.id}` === id);
      if (!host) throw failure('跳板链引用不存在');
      if (host.jumpHostId) walk(`host:${host.jumpHostId}`, new Set([...seen, id]));
      return;
    }
    if (node.error) throw failure(node.error);
    if (node.excluded || (!node.existing && (node.row.action === 'skip' || !node.input))) throw failure(`跳板不可导入：${node.row.name}`);
    const jump = node.jump ?? (node.existing?.jumpHostId ? `host:${node.existing.jumpHostId}` : undefined);
    if (jump) walk(jump, new Set([...seen, id]));
  };
  for (const node of nodes.values()) {
    if (!node.source && !node.existing) continue;
    if (!node.error && node.row.action !== 'skip') {
      try { walk(node.row.id, new Set()); } catch (error) { node.error = (error as Error).message; }
    }
  }
  for (const node of nodes.values()) {
    if (node.error) { node.row.action = 'invalid'; node.row.reason = node.error; continue; }
    if (node.row.action === 'skip' && (!node.existing || node.excluded)) continue;
    if (node.existing) {
      node.row.action = node.jump && !node.existing.jumpHostId ? 'update' : 'skip';
      node.row.reason = node.row.action === 'update' ? '已有主机，可补充跳板关联（保留其余设置）' : '已在台账中，无需修改';
    }
    if (node.jump) node.row.dependencies = [node.jump];
    if (node.row.action === 'create' && node.jump) node.row.reason = '可新增；必需跳板会自动包含';
  }
  const preview: ImportPreview = {
    fingerprint: digest({ text, hosts: [...hosts].sort((a, b) => a.id.localeCompare(b.id)) }),
    candidates: [...nodes.values()].map((node) => node.row), warnings,
  };
  return { preview, nodes, hosts };
}

export function previewSshImport(text: string, hosts: readonly HostEntry[]): ImportPreview {
  return planImport(text, hosts).preview;
}

/** Selection contains IDs only. The server derives every HostInput from a fresh plan. */
async function execute(store: ImportStore, plan: Plan, request: ImportConfirmation, onUpdated?: (id: string) => void): Promise<ImportResult> {
  if (request.fingerprint !== plan.preview.fingerprint) throw failure('SSH 配置或台账已变更，请重新检测后确认', 409);
  if (!Array.isArray(request.selectedIds) || request.selectedIds.length === 0 || request.selectedIds.length > plan.nodes.size
    || !request.selectedIds.every((id) => typeof id === 'string') || new Set(request.selectedIds).size !== request.selectedIds.length) {
    throw failure('请选择有效的导入条目');
  }
  const selected = new Set<string>();
  const order: Node[] = [];
  const include = (id: string): void => {
    if (selected.has(id)) return;
    const node = plan.nodes.get(id);
    if (!node || node.error) throw failure(`选择或跳板依赖无效：${node?.row.name ?? id}`);
    selected.add(id);
    for (const dependency of node.row.dependencies) include(dependency);
    if (selectable(node.row)) order.push(node);
  };
  for (const id of request.selectedIds) {
    const row = plan.nodes.get(id)?.row;
    if (!row || !selectable(row)) throw failure(`条目不可选择：${row?.name ?? id}`);
    include(id);
  }
  // Preflight exactly the selected final graph, before the first create/update call.
  const ids = new Map([...plan.nodes.values()].map((node) => [node.row.id, node.existing?.id ?? node.row.id]));
  const simulated = new Map(plan.hosts.map((host) => [host.id, host]));
  for (const node of order) {
    const jumpHostId = node.jump ? ids.get(node.jump) : undefined;
    const input = node.existing ? { jumpHostId } : { ...node.input, jumpHostId };
    const { fields } = normalizeInput(input);
    simulated.set(ids.get(node.row.id)!, { ...(node.existing ?? { id: node.row.id, createdAt: '' }), ...fields } as HostEntry);
  }
  for (const node of order) {
    const host = simulated.get(ids.get(node.row.id)!)!;
    assertJumpTarget(host.id, host.jumpHostId, [...simulated.values()]);
  }
  const result: ImportResult = {
    createdCount: 0, updatedCount: 0,
    skippedCount: plan.preview.candidates.filter((row) => !order.some((node) => node.row.id === row.id)).length,
    includedDependencies: order.filter((node) => !request.selectedIds.includes(node.row.id)).length,
  };
  for (const node of order) {
    const jumpHostId = node.jump ? ids.get(node.jump) : undefined;
    try {
      if (node.existing) {
        await store.update(node.existing.id, { jumpHostId });
        result.updatedCount += 1;
        onUpdated?.(node.existing.id);
      } else {
        const entry = await store.create({ ...node.input, jumpHostId });
        ids.set(node.row.id, entry.id);
        result.createdCount += 1;
      }
    } catch {
      result.error = `写入「${node.row.name}」失败，请重新检测核对台账后重试`;
      result.skippedCount += order.length - result.createdCount - result.updatedCount;
      return result;
    }
  }
  return result;
}

/** Only reads config for preview; confirm serializes writes and re-reads after acquiring the lock. */
export function createSshImporter(
  store: ImportStore,
  readConfig: () => Promise<string> = () => readFile(join(homedir(), '.ssh', 'config'), 'utf8'),
  onUpdated?: (id: string) => void,
): { preview(): Promise<ImportPreview>; confirm(request: ImportConfirmation): Promise<ImportResult> } {
  let writing = false;
  const readPlan = async (): Promise<Plan> => {
    let text: string;
    try { text = await readConfig(); } catch { throw failure('无法读取 SSH 配置，请检查配置文件是否存在且可读'); }
    return planImport(text, store.list());
  };
  return {
    async preview() { return (await readPlan()).preview; },
    async confirm(request) {
      if (writing) throw failure('导入正在执行，请等待结果', 409);
      writing = true;
      try { return await execute(store, await readPlan(), request, onUpdated); } finally { writing = false; }
    },
  };
}
