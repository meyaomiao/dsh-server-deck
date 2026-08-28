// src/server/pool.ts
import { readFile } from "node:fs/promises";
import { Client } from "ssh2";
var READY_TIMEOUT_MS = 1e4;
async function buildConnectConfig(host, secret, overrides) {
  const cfg = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: 15e3,
    keepaliveCountMax: 3
  };
  if (host.auth === "password") {
    if (secret.password === void 0) throw new Error("\u8BE5\u4E3B\u673A\u672A\u4FDD\u5B58\u5BC6\u7801");
    cfg.password = secret.password;
  } else if (host.auth === "key") {
    if (host.keyPath === void 0 || host.keyPath.length === 0) throw new Error("\u8BE5\u4E3B\u673A\u672A\u914D\u7F6E\u79C1\u94A5\u8DEF\u5F84");
    try {
      cfg.privateKey = await readFile(host.keyPath, "utf8");
    } catch (error) {
      throw new Error(`\u8BFB\u53D6\u79C1\u94A5\u5931\u8D25 ${host.keyPath}:${error instanceof Error ? error.message : String(error)}`);
    }
    if (secret.passphrase !== void 0) cfg.passphrase = secret.passphrase;
  } else {
    cfg.agent = process.env.SSH_AUTH_SOCK;
  }
  return { ...cfg, ...overrides };
}
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
var HostPool = class {
  constructor(resolveHost, resolveSecret) {
    this.resolveHost = resolveHost;
    this.resolveSecret = resolveSecret;
  }
  resolveHost;
  resolveSecret;
  pool = /* @__PURE__ */ new Map();
  /** 取(或建立)主机的就绪连接。断开时经 close 事件自动出池。 */
  connect(id) {
    const cached = this.pool.get(id);
    if (cached !== void 0) {
      return Promise.resolve(cached.conn);
    }
    const host = this.resolveHost(id);
    if (host === void 0) return Promise.reject(new Error("\u4E3B\u673A\u4E0D\u5B58\u5728"));
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        this.pool.delete(id);
        try {
          conn.end();
        } catch {
        }
        reject(new Error(`SSH \u8FDE\u63A5\u5931\u8D25:${messageOf(error)}`));
      };
      conn.on("ready", () => {
        if (settled) return;
        settled = true;
        conn.on("close", () => this.pool.delete(id));
        conn.on("end", () => this.pool.delete(id));
        conn.on("error", () => this.pool.delete(id));
        this.pool.set(id, { conn });
        resolve(conn);
      });
      conn.on("error", fail);
      buildConnectConfig(host, this.resolveSecret(id)).then((cfg) => conn.connect(cfg)).catch(fail);
    });
  }
  /** 独立短连接测试(不占用连接池),返回握手延迟。 */
  test(host) {
    const started = Date.now();
    return new Promise((resolve) => {
      const conn = new Client();
      const finish = (result) => {
        try {
          conn.end();
        } catch {
        }
        resolve(result);
      };
      conn.on("ready", () => finish({ ok: true, latencyMs: Date.now() - started }));
      conn.on("error", (error) => finish({ ok: false, error: messageOf(error) }));
      buildConnectConfig(host, this.resolveSecret(host.id)).then((cfg) => conn.connect(cfg)).catch((error) => finish({ ok: false, error: messageOf(error) }));
    });
  }
  /** 在主机上执行单条命令(走池内长连接)。 */
  exec(id, command, timeoutMs = 2e4) {
    return this.connect(id).then(
      (conn) => new Promise((resolve, reject) => {
        conn.exec(command, (error, stream) => {
          if (error !== void 0 && error !== null) {
            reject(new Error(`exec \u5931\u8D25:${messageOf(error)}`));
            return;
          }
          let stdout = "";
          let stderr = "";
          const timer = setTimeout(() => {
            stream.close();
            resolve({ code: null, stdout, stderr: `${stderr}
[server-deck] \u547D\u4EE4\u8D85\u65F6(${timeoutMs}ms)` });
          }, timeoutMs);
          stream.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
          });
          stream.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
          });
          stream.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
          });
        });
      }),
      (error) => {
        throw error;
      }
    );
  }
  /** 打开交互式 shell(PTY 终端用)。 */
  shell(id, cols, rows) {
    return this.connect(id).then(
      (conn) => new Promise((resolve, reject) => {
        conn.shell({ cols, rows, term: "xterm-256color" }, (error, stream) => {
          if (error !== void 0 && error !== null) reject(new Error(`\u6253\u5F00 shell \u5931\u8D25:${messageOf(error)}`));
          else resolve(stream);
        });
      }),
      (error) => {
        throw error;
      }
    );
  }
  close(id) {
    const pooled = this.pool.get(id);
    if (pooled !== void 0) {
      this.pool.delete(id);
      try {
        pooled.conn.end();
      } catch {
      }
    }
  }
  closeAll() {
    for (const id of [...this.pool.keys()]) this.close(id);
  }
};

// src/server/router.ts
import { readFile as readFile2 } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// src/server/probe.ts
var PROBE_SCRIPT = [
  'echo "@@OS@@"',
  "uname -s 2>/dev/null",
  "grep -h PRETTY_NAME /etc/os-release 2>/dev/null | head -1",
  'echo "@@UP@@"',
  "uptime 2>/dev/null",
  'echo "@@CORES@@"',
  "nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null",
  'echo "@@CPU@@"',
  '(top -bn2 -d0.2 2>/dev/null | grep -iE "^%?Cpu\\(s\\)" | tail -1)',
  "(top -l 2 2>/dev/null | grep -i 'CPU usage' | tail -1)",
  'echo "@@MEM@@"',
  'free -m 2>/dev/null | grep -iE "^Mem"',
  "vm_stat 2>/dev/null",
  "sysctl -n hw.memsize 2>/dev/null",
  'echo "@@DISK@@"',
  "df -P / 2>/dev/null | tail -1"
].join("; ");
function section(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) return "";
  const rest = text.slice(idx + marker.length);
  const end = rest.indexOf("@@");
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}
function num(v) {
  if (v === void 0) return void 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : void 0;
}
function pctClamp(n) {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}
function parseProbeOutput(raw) {
  const text = raw.replace(/\r/g, "");
  const result = {};
  const osSection = section(text, "@@OS@@");
  const pretty = /PRETTY_NAME="?([^"\n]+)"?/.exec(osSection)?.[1];
  const unameLine = osSection.split("\n").map((l) => l.trim()).find((l) => /^(Linux|Darwin|FreeBSD|OpenBSD)/.test(l));
  if (pretty !== void 0) result.osName = pretty;
  else if (unameLine === "Darwin") result.osName = "macOS";
  else if (unameLine !== void 0) result.osName = unameLine;
  const upSection = section(text, "@@UP@@");
  const upMatch = /\bup\s+(.+?),?\s*\n?\s*(\d+\s+users?|$)/i.exec(upSection.replace(/\s+/g, " "));
  if (upMatch !== null) {
    const seg = upMatch[1].trim().replace(/,\s*$/, "");
    if (seg.length > 0 && seg.length < 64) result.uptimeText = seg;
  }
  const coresRaw = section(text, "@@CORES@@").split("\n")[0];
  const cores = num(coresRaw?.trim());
  if (cores !== void 0 && cores > 0) result.cores = Math.round(cores);
  const cpuSection = section(text, "@@CPU@@");
  const linuxCpu = /Cpu\(s\):\s*([\d.]+)\s*us,\s*([\d.]+)\s*sy/i.exec(cpuSection);
  const darwinCpu = /CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/i.exec(cpuSection);
  if (linuxCpu !== null) {
    const total = Number(linuxCpu[1]) + Number(linuxCpu[2]);
    if (Number.isFinite(total)) result.cpuPercent = pctClamp(total);
  } else if (darwinCpu !== null) {
    const total = Number(darwinCpu[1]) + Number(darwinCpu[2]);
    if (Number.isFinite(total)) result.cpuPercent = pctClamp(total);
  }
  const memSection = section(text, "@@MEM@@");
  const freeLine = /^Mem:\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+\d+\s+\d+\s+(\d+))?/im.exec(memSection);
  if (freeLine !== null) {
    const total = Number(freeLine[1]);
    const used = Number(freeLine[2]);
    const available = freeLine[4] !== void 0 ? Number(freeLine[4]) : void 0;
    if (total > 0) {
      const usedPct = available !== void 0 ? (total - available) / total * 100 : used / total * 100;
      result.memPercent = pctClamp(usedPct);
    }
  } else {
    const totalBytes = num(/hw\.memsize|^(\d+)$/m.exec(memSection.split("\n").slice(-1)[0]?.trim() ?? "")?.[1]);
    const pagesFree = num(/Pages free:\s+(\d+)/.exec(memSection)?.[1]);
    const pagesInactive = num(/Pages inactive:\s+(\d+)/.exec(memSection)?.[1]);
    const pageSize = 16384;
    if (totalBytes !== void 0 && totalBytes > 0 && pagesFree !== void 0) {
      const freeBytes = (pagesFree + (pagesInactive ?? 0)) * pageSize;
      result.memPercent = pctClamp((1 - freeBytes / totalBytes) * 100);
    }
  }
  const diskSection = section(text, "@@DISK@@");
  const dfLine = diskSection.split("\n").map((l) => l.trim()).find((l) => /\d+%/.test(l));
  if (dfLine !== void 0) {
    const capNum = /(\d+)%/.exec(dfLine);
    if (capNum !== null) result.diskPercent = pctClamp(Number(capNum[1]));
  }
  return result;
}

// src/server/sshconfig.ts
import { homedir as osHomedir } from "node:os";
function parseSshConfig(text) {
  const candidates = [];
  const includes = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (m === null) continue;
    const keyword = m[1].toLowerCase();
    const value = m[2].trim();
    if (keyword === "host") {
      current = null;
      const names = value.split(/\s+/).filter((n) => !n.includes("*") && !n.includes("?"));
      if (names.length > 0) {
        current = { alias: names[0], aliases: names };
        candidates.push(current);
      }
      continue;
    }
    if (keyword === "include") {
      for (const inc of value.split(/\s+/)) includes.push(inc);
      continue;
    }
    if (current === null) continue;
    if (keyword === "hostname") current.hostname = value;
    else if (keyword === "user") current.user = value;
    else if (keyword === "port") {
      const p = Number(value);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) current.port = p;
    } else if (keyword === "identityfile") current.identityFile = value.replace(/^~(?=\/|$)/, homedirPrefix());
    else if (keyword === "proxyjump") current.proxyJump = value.split(/\s+/)[0];
  }
  return { candidates, includes };
}
function homedirPrefix() {
  try {
    return osHomedir();
  } catch {
    return "~";
  }
}

// src/server/router.ts
var PROBE_TIMEOUT_MS = 2e4;
var PROBE_CONCURRENCY = 4;
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function isLoopback(req) {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 256 * 1024) {
        reject(new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
async function readJsonBody(req) {
  const text = await readBody(req);
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("JSON \u89E3\u6790\u5931\u8D25"), { status: 400 });
  }
}
async function probeAll(pool, ssh) {
  const hosts = [...pool.list()];
  const results = /* @__PURE__ */ new Map();
  for (const h of hosts) results.set(h.id, { id: h.id, state: "probing", probedAt: (/* @__PURE__ */ new Date()).toISOString() });
  let cursor = 0;
  async function worker() {
    while (cursor < hosts.length) {
      const host = hosts[cursor++];
      const base = results.get(host.id) ?? { id: host.id, state: "probing" };
      try {
        await ssh.connect(host.id);
        const started = Date.now();
        const { stdout } = await ssh.exec(host.id, PROBE_SCRIPT, PROBE_TIMEOUT_MS);
        const latencyMs = Date.now() - started;
        const parsed = parseProbeOutput(stdout);
        results.set(host.id, { ...base, ...parsed, state: "online", latencyMs, probedAt: (/* @__PURE__ */ new Date()).toISOString() });
      } catch (error) {
        results.set(host.id, {
          ...base,
          state: "offline",
          error: error instanceof Error ? error.message : String(error),
          probedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, hosts.length) }, worker));
  return hosts.map((h) => results.get(h.id) ?? { id: h.id, state: "unknown" });
}
var GIT_HOSTING_HOSTS = /* @__PURE__ */ new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "gitee.com",
  "e.coding.net",
  "codeberg.org",
  "ssh.dev.azure.com",
  "git.sr.ht",
  "chromium.googlesource.com"
]);
function isGitHostingHost(hostname, username) {
  if (GIT_HOSTING_HOSTS.has(hostname.toLowerCase())) return true;
  if (/^(github|gitlab|gitee)\./i.test(hostname)) return true;
  return username === "git";
}
var IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
function pickDisplayName(c) {
  const names = c.aliases ?? [c.alias];
  return names.find((n) => !IPV4_RE.test(n)) ?? c.alias;
}
function createApiRouter(store, ssh) {
  return async (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: "\u4EC5\u5141\u8BB8\u672C\u673A\u8BBF\u95EE" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://loopback");
    const raw = url.pathname;
    const stripped = raw.startsWith("/server-deck/api") ? raw.slice("/server-deck/api".length) : raw;
    const path = stripped.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    try {
      if (path === "/hosts" && method === "GET") {
        sendJson(res, 200, { ok: true, hosts: store.list() });
        return;
      }
      if (path === "/hosts" && method === "POST") {
        const body = await readJsonBody(req);
        const entry = await store.create(body);
        sendJson(res, 201, { ok: true, host: entry });
        return;
      }
      if (path === "/status" && method === "GET") {
        const statuses = await probeAll(store, ssh);
        sendJson(res, 200, { ok: true, statuses });
        return;
      }
      if (path === "/import-ssh-config" && method === "POST") {
        const body = await readJsonBody(req);
        const raw2 = await readFile2(join(homedir(), ".ssh", "config"), "utf8");
        const { candidates } = parseSshConfig(raw2);
        const existing = new Set(store.list().map((h) => `${h.username}@${h.host}:${h.port}`));
        const imported = [];
        let skipped = 0;
        let gitAliases = 0;
        for (const c of candidates) {
          const hostName = c.hostname ?? c.alias;
          const username = c.user ?? "";
          const port = c.port ?? 22;
          if (isGitHostingHost(hostName, username)) {
            gitAliases += 1;
            continue;
          }
          if (username.length === 0 || existing.has(`${username}@${hostName}:${port}`)) {
            skipped += 1;
            continue;
          }
          if (body.dryRun === true) {
            continue;
          }
          const displayName = pickDisplayName(c);
          imported.push(await store.create({
            name: displayName,
            host: hostName,
            port,
            username,
            auth: "key",
            keyPath: c.identityFile ?? "~/.ssh/id_ed25519",
            tags: ["ssh-config"],
            notes: c.proxyJump !== void 0 ? `ProxyJump ${c.proxyJump}` : void 0
          }));
          existing.add(`${username}@${hostName}:${port}`);
        }
        sendJson(res, 200, { ok: true, found: candidates.length, importedCount: imported.length, skipped, gitAliases, imported });
        return;
      }
      const m = /^\/hosts\/([^/]+)(\/test)?$/.exec(path);
      if (m !== null) {
        const id = decodeURIComponent(m[1]);
        if (method === "PATCH") {
          const body = await readJsonBody(req);
          const entry = await store.update(id, body);
          sendJson(res, 200, { ok: true, host: entry });
          return;
        }
        if (method === "DELETE") {
          ssh.close(id);
          const removed = await store.remove(id);
          sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "\u4E3B\u673A\u4E0D\u5B58\u5728" });
          return;
        }
        if (method === "POST" && m[2] === "/test") {
          const host = store.get(id);
          if (host === void 0) {
            sendJson(res, 404, { error: "\u4E3B\u673A\u4E0D\u5B58\u5728" });
            return;
          }
          const result = await ssh.test(host);
          sendJson(res, 200, result);
          return;
        }
      }
      sendJson(res, 404, { error: `\u672A\u77E5\u8DEF\u7531 ${method} ${path}` });
    } catch (error) {
      const status = error.status ?? 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

// src/server/pty.ts
import { WebSocketServer } from "ws";
function createPtyRoute(pool, resolveHostId) {
  const wss = new WebSocketServer({ noServer: true });
  return {
    path: "/server-deck/ws/pty",
    handler(req, socket, head) {
      const remote = req.socket.remoteAddress ?? "";
      if (!(remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")) {
        socket.destroy();
        return;
      }
      const url = new URL(req.url ?? "/", "http://loopback");
      const hostId = url.searchParams.get("host") ?? "";
      const cols = Math.max(2, Math.min(500, Number(url.searchParams.get("cols")) || 80));
      const rows = Math.max(2, Math.min(300, Number(url.searchParams.get("rows")) || 24));
      if (hostId.length === 0 || !resolveHostId(hostId)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void bridge(ws, pool, hostId, cols, rows);
      });
    }
  };
}
async function bridge(ws, pool, hostId, cols, rows) {
  let stream = null;
  const closeBoth = () => {
    if (stream !== null) {
      try {
        stream.end();
        stream.close();
      } catch {
      }
      stream = null;
    }
    if (ws.readyState === ws.OPEN) ws.close(1e3, "closed");
  };
  try {
    stream = await pool.shell(hostId, cols, rows);
  } catch (error) {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\x1B[31m[server-deck] ${error instanceof Error ? error.message : String(error)}\x1B[0m\r
`);
      ws.close(1011, "shell failed");
    }
    return;
  }
  stream.on("data", (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  stream.on("close", () => {
    if (ws.readyState === ws.OPEN) ws.close(1e3, "stream closed");
  });
  stream.stderr?.on?.("data", () => {
  });
  ws.on("message", (data) => {
    if (stream === null) return;
    const text = typeof data === "string" ? data : data.toString("utf8");
    if (text.startsWith('{"type":"resize"')) {
      try {
        const msg = JSON.parse(text);
        const c = Math.max(2, Math.min(500, Number(msg.cols) || cols));
        const r = Math.max(2, Math.min(300, Number(msg.rows) || rows));
        stream.setWindow(r, c, 0, 0);
      } catch {
      }
      return;
    }
    stream.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  ws.on("close", closeBoth);
  ws.on("error", closeBoth);
}

// src/server/store.ts
import { mkdir, readFile as readFile3, chmod, rename, writeFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var DSH_DIR = join2(homedir2(), ".dsh");
var HOSTS_FILE = join2(DSH_DIR, "server-deck.json");
var SECRETS_FILE = join2(DSH_DIR, "server-deck.secrets.json");
function isStr(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function normalizeInput(raw) {
  const fields = {};
  const secret = {};
  if (raw.name !== void 0) {
    if (!isStr(raw.name)) throw new Error("name \u65E0\u6548");
    fields.name = raw.name.trim();
  }
  if (raw.host !== void 0) {
    if (!isStr(raw.host)) throw new Error("host \u65E0\u6548");
    fields.host = raw.host.trim();
  }
  if (raw.port !== void 0) {
    const p = Number(raw.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("port \u65E0\u6548");
    fields.port = p;
  }
  if (raw.username !== void 0) {
    if (!isStr(raw.username)) throw new Error("username \u65E0\u6548");
    fields.username = raw.username.trim();
  }
  if (raw.auth !== void 0) {
    if (raw.auth !== "password" && raw.auth !== "key" && raw.auth !== "agent") {
      throw new Error("auth \u5FC5\u987B\u662F password | key | agent");
    }
    fields.auth = raw.auth;
  }
  if (raw.keyPath !== void 0) {
    if (typeof raw.keyPath !== "string") throw new Error("keyPath \u65E0\u6548");
    fields.keyPath = raw.keyPath.trim() || void 0;
  }
  if (raw.tags !== void 0) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === "string")) {
      throw new Error("tags \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
    }
    fields.tags = raw.tags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (raw.notes !== void 0) {
    if (typeof raw.notes !== "string") throw new Error("notes \u65E0\u6548");
    fields.notes = raw.notes.trim() || void 0;
  }
  if (typeof raw.password === "string" && raw.password.length > 0) secret.password = raw.password;
  else if (raw.password === null) secret.password = void 0;
  if (typeof raw.passphrase === "string" && raw.passphrase.length > 0) secret.passphrase = raw.passphrase;
  else if (raw.passphrase === null) secret.passphrase = void 0;
  return { fields, secret };
}
async function atomicWrite(path, data, mode) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, "utf8");
  if (mode !== void 0) await chmod(tmp, mode);
  await rename(tmp, path);
}
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile3(path, "utf8"));
  } catch {
    return fallback;
  }
}
var HostStore = class {
  blob = { version: 1, hosts: [] };
  secrets = {};
  async load() {
    await mkdir(DSH_DIR, { recursive: true });
    this.blob = await readJson(HOSTS_FILE, { version: 1, hosts: [] });
    if (!Array.isArray(this.blob.hosts)) this.blob.hosts = [];
    this.secrets = await readJson(SECRETS_FILE, {});
  }
  list() {
    return this.blob.hosts;
  }
  get(id) {
    return this.blob.hosts.find((h) => h.id === id);
  }
  getSecret(id) {
    return this.secrets[id] ?? {};
  }
  async create(input) {
    const { fields, secret } = normalizeInput(input);
    if (!isStr(fields.host) || !isStr(fields.username) || !fields.auth) {
      throw new Error("host / username / auth \u4E3A\u5FC5\u586B");
    }
    const entry = {
      id: `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: fields.name?.trim() || `${fields.username}@${fields.host}`,
      host: fields.host,
      port: fields.port ?? 22,
      username: fields.username,
      auth: fields.auth,
      keyPath: fields.keyPath,
      tags: fields.tags,
      notes: fields.notes,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.blob.hosts.push(entry);
    if (secret.password !== void 0 || secret.passphrase !== void 0) {
      this.secrets[entry.id] = secret;
      await atomicWrite(SECRETS_FILE, JSON.stringify(this.secrets, null, 2), 384);
    }
    await atomicWrite(HOSTS_FILE, JSON.stringify(this.blob, null, 2));
    return entry;
  }
  async update(id, input) {
    const entry = this.get(id);
    if (entry === void 0) throw Object.assign(new Error("\u4E3B\u673A\u4E0D\u5B58\u5728"), { status: 404 });
    const { fields, secret } = normalizeInput(input);
    const next = { ...entry, ...fields };
    next.name = next.name || `${next.username}@${next.host}`;
    const idx = this.blob.hosts.indexOf(entry);
    this.blob.hosts[idx] = next;
    if (secret.password !== void 0 || secret.passphrase !== void 0) {
      this.secrets[id] = { ...this.secrets[id], ...secret };
      for (const k of ["password", "passphrase"]) {
        if (this.secrets[id][k] === void 0) delete this.secrets[id][k];
      }
      if (Object.keys(this.secrets[id]).length === 0) delete this.secrets[id];
      await atomicWrite(SECRETS_FILE, JSON.stringify(this.secrets, null, 2), 384);
    }
    await atomicWrite(HOSTS_FILE, JSON.stringify(this.blob, null, 2));
    return next;
  }
  async remove(id) {
    const before = this.blob.hosts.length;
    this.blob.hosts = this.blob.hosts.filter((h) => h.id !== id);
    if (this.blob.hosts.length === before) return false;
    if (id in this.secrets) {
      delete this.secrets[id];
      await atomicWrite(SECRETS_FILE, JSON.stringify(this.secrets, null, 2), 384);
    }
    await atomicWrite(HOSTS_FILE, JSON.stringify(this.blob, null, 2));
    return true;
  }
};

// src/index.ts
var name = "server-deck";
var inject = ["webServer"];
function apply(ctx) {
  const store = new HostStore();
  const pool = new HostPool(
    (id) => store.get(id),
    (id) => store.getSecret(id)
  );
  void store.load().catch((error) => {
    console.warn("[server-deck] \u53F0\u8D26\u52A0\u8F7D\u5931\u8D25(\u5C06\u4EE5\u7A7A\u53F0\u8D26\u8FD0\u884C):", error);
  });
  ctx.effect(() => () => pool.closeAll(), "server-deck: dispose connections");
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: "/server-deck/api",
      handler: createApiRouter(store, pool)
    }),
    "server-deck: rest api"
  );
  ctx.effect(
    () => ctx.webServer.registerUpgrade(createPtyRoute(pool, (id) => store.get(id) !== void 0)),
    "server-deck: pty upgrade route"
  );
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
