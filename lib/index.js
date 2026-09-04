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

// src/metrics.ts
var BUCKET_MS = {
  "10s": 1e4,
  "30s": 3e4,
  "1m": 6e4,
  "5m": 3e5,
  "15m": 9e5,
  "1h": 36e5
};
var ALL_BUCKETS = ["10s", "30s", "1m", "5m", "15m", "1h"];
var MAX_POINTS = 1200;
var THREE_H_MS = 3 * 36e5;
var DAY_MS = 24 * 36e5;
var WEEK_MS = 7 * DAY_MS;
var MONTH_MS = 31 * DAY_MS;
var DEFAULT_SETTINGS = {
  collectIntervalSec: 10,
  recording: true,
  pausedHostIds: []
};
function isMetricRangeKind(v) {
  return v === "1h" || v === "24h" || v === "7d" || v === "30d" || v === "custom";
}
function isMetricBucket(v) {
  return v === "10s" || v === "30s" || v === "1m" || v === "5m" || v === "15m" || v === "1h";
}
function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function resolveRange(kind, now, custom) {
  if (kind === "custom") {
    if (custom === void 0 || !Number.isFinite(custom.from) || !Number.isFinite(custom.to) || custom.to <= custom.from) {
      throw Object.assign(new Error("\u81EA\u5B9A\u4E49\u5468\u671F\u65E0\u6548"), { status: 400 });
    }
    if (custom.to - custom.from > MONTH_MS + 6e4) {
      throw Object.assign(new Error("\u81EA\u5B9A\u4E49\u5468\u671F\u6700\u957F 31 \u5929"), { status: 400 });
    }
    return { from: Math.round(custom.from), to: Math.round(custom.to) };
  }
  if (kind === "1h") return { from: now - 36e5, to: now };
  if (kind === "24h") return { from: now - DAY_MS, to: now };
  if (kind === "7d") return { from: startOfDay(now) - 6 * DAY_MS, to: now };
  if (kind === "30d") return { from: startOfDay(now) - 29 * DAY_MS, to: now };
  return { from: now - DAY_MS, to: now };
}
function autoBucket(rangeMs) {
  if (rangeMs <= 36e5 + 6e4) return "10s";
  if (rangeMs <= DAY_MS + 6e4) return "1m";
  if (rangeMs <= WEEK_MS + 6e4) return "15m";
  return "1h";
}
function resolveBucket(rangeMs, requested = "auto") {
  if (requested === "auto") {
    return { requested: "auto", bucketUsed: autoBucket(rangeMs) };
  }
  if (rangeMs / BUCKET_MS[requested] > MAX_POINTS) {
    return { requested, bucketUsed: autoBucket(rangeMs) };
  }
  return { requested, bucketUsed: requested };
}
function allowedBuckets(rangeMs) {
  return ALL_BUCKETS.filter((b) => rangeMs / BUCKET_MS[b] <= MAX_POINTS);
}
function avg(nums) {
  if (nums.length === 0) return void 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 10) / 10;
}
function avgPoint(t, group) {
  const online = group.filter((s) => s.online);
  const pick = (field) => avg(online.map((s) => s[field]).filter((n) => n !== void 0));
  return {
    t,
    cpu: pick("cpu"),
    mem: pick("mem"),
    disk: pick("disk"),
    latencyMs: pick("latencyMs"),
    online: online.length > 0
  };
}
function rollup(samples, from, to, bucketMs) {
  if (!(to > from) || !(bucketMs > 0)) return [];
  const n = Math.max(1, Math.ceil((to - from) / bucketMs));
  const buckets = Array.from({ length: n }, () => []);
  for (const s of samples) {
    if (s.t < from || s.t > to) continue;
    const idx = Math.min(n - 1, Math.floor((s.t - from) / bucketMs));
    buckets[idx].push(s);
  }
  const points = [];
  for (let i = 0; i < n; i++) {
    const group = buckets[i];
    if (group.length === 0) continue;
    points.push(avgPoint(from + i * bucketMs, group));
  }
  return points;
}
function summarizeField(samples, field) {
  const vals = [];
  let latest;
  for (const s of samples) {
    if (!s.online) continue;
    const v = s[field];
    if (v === void 0) continue;
    vals.push(v);
    latest = v;
  }
  if (vals.length === 0) return { samples: 0 };
  return {
    latest,
    avg: avg(vals),
    max: Math.max(...vals),
    min: Math.min(...vals),
    samples: vals.length
  };
}
function buildSeries(hostId, samples, from, to, bucketUsed) {
  return {
    hostId,
    from,
    to,
    bucket: bucketUsed,
    bucketUsed,
    points: rollup(samples, from, to, BUCKET_MS[bucketUsed]),
    cpu: summarizeField(samples, "cpu"),
    mem: summarizeField(samples, "mem"),
    disk: summarizeField(samples, "disk")
  };
}
function normalizeSettings(raw) {
  const o = raw !== null && typeof raw === "object" ? raw : {};
  const sec = Number(o.collectIntervalSec);
  const collectIntervalSec = sec === 10 || sec === 30 || sec === 60 || sec === 300 ? sec : DEFAULT_SETTINGS.collectIntervalSec;
  const recording = o.recording !== false;
  const pausedHostIds = Array.isArray(o.pausedHostIds) ? o.pausedHostIds.filter((id) => typeof id === "string" && id.length > 0) : [];
  return { collectIntervalSec, recording, pausedHostIds };
}
function assertHostId(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes("..")) {
    throw Object.assign(new Error("\u4E3B\u673A id \u65E0\u6548"), { status: 400 });
  }
  return id;
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
function parseMs(raw) {
  if (raw === null || raw.length === 0) return void 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : void 0;
}
function createApiRouter(store, ssh, metrics, recorder, backfill) {
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
        const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
        const statuses = force ? await recorder.tick(true) : recorder.latestStatuses();
        sendJson(res, 200, { ok: true, statuses });
        return;
      }
      if (path === "/metrics/settings" && method === "GET") {
        sendJson(res, 200, { ok: true, settings: metrics.getSettings() });
        return;
      }
      if (path === "/metrics/settings" && method === "PATCH") {
        const body = await readJsonBody(req);
        const merged = normalizeSettings({ ...metrics.getSettings(), ...body });
        const settings = await metrics.saveSettings(merged);
        recorder.arm();
        sendJson(res, 200, { ok: true, settings });
        return;
      }
      if (path === "/metrics" && method === "GET") {
        const rangeRaw = url.searchParams.get("range") ?? "3h";
        if (!isMetricRangeKind(rangeRaw)) {
          sendJson(res, 400, { error: "range \u5FC5\u987B\u662F 3h | today | 7d | 30d | custom" });
          return;
        }
        const bucketRaw = url.searchParams.get("bucket") ?? "auto";
        if (bucketRaw !== "auto" && !isMetricBucket(bucketRaw)) {
          sendJson(res, 400, { error: "bucket \u65E0\u6548" });
          return;
        }
        const now = Date.now();
        const customFrom = parseMs(url.searchParams.get("from"));
        const customTo = parseMs(url.searchParams.get("to"));
        const { from, to } = resolveRange(
          rangeRaw,
          now,
          rangeRaw === "custom" && customFrom !== void 0 && customTo !== void 0 ? { from: customFrom, to: customTo } : void 0
        );
        const { requested, bucketUsed } = resolveBucket(to - from, bucketRaw === "auto" ? "auto" : bucketRaw);
        const hostParam = url.searchParams.get("hostId");
        const ids = hostParam !== null && hostParam.length > 0 ? [assertHostId(hostParam)] : store.list().map((h) => h.id);
        const series = [];
        for (const id of ids) {
          if (backfill !== void 0) {
            try {
              await backfill.ensure(id, from, to);
            } catch {
            }
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
          series
        });
        return;
      }
      if (path === "/import-ssh-config" && method === "POST") {
        const body = await readJsonBody(req);
        const rawCfg = await readFile2(join(homedir(), ".ssh", "config"), "utf8");
        const { candidates } = parseSshConfig(rawCfg);
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
          recorder.forget(id);
          const removed = await store.remove(id);
          if (removed) await metrics.removeHost(id);
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

// src/server/metric-store.ts
import { appendFile, mkdir as mkdir2, readdir, readFile as readFile4, rename as rename2, rm, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
var DEFAULT_METRICS_DIR = join3(homedir3(), ".dsh", "server-deck-metrics");
var RAW_KEEP_MS = 3 * 36e5 + 5 * 6e4;
var M1_KEEP_MS = 24 * 36e5 + 10 * 6e4;
var M15_KEEP_MS = 7 * 24 * 36e5 + 60 * 6e4;
var H1_KEEP_MS = 31 * 24 * 36e5 + 60 * 6e4;
var COMPACT_EVERY_MS = 5 * 6e4;
function layerFile(root, hostId, layer) {
  return join3(root, hostId, `${layer}.jsonl`);
}
async function atomicWrite2(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile2(tmp, data, "utf8");
  await rename2(tmp, path);
}
function parseLine(line) {
  const t = line.trim();
  if (t.length === 0) return void 0;
  try {
    const o = JSON.parse(t);
    if (typeof o.t !== "number" || !Number.isFinite(o.t)) return void 0;
    return o;
  } catch {
    return void 0;
  }
}
async function readJsonl(path) {
  try {
    const text = await readFile4(path, "utf8");
    const out = [];
    for (const line of text.split("\n")) {
      const s = parseLine(line);
      if (s !== void 0) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}
function pointToSample(p) {
  return {
    t: p.t,
    cpu: p.cpu,
    mem: p.mem,
    disk: p.disk,
    latencyMs: p.latencyMs,
    online: p.online
  };
}
var MetricStore = class {
  constructor(rootDir = DEFAULT_METRICS_DIR) {
    this.rootDir = rootDir;
  }
  rootDir;
  lastCompactAt = 0;
  settings = { ...DEFAULT_SETTINGS };
  latest = /* @__PURE__ */ new Map();
  /** 内存环形缓冲,供 3h 细粒度查询,避免每次读盘。 */
  rawCache = /* @__PURE__ */ new Map();
  /** 已删除主机:挡住在途 compact/append 把目录重建出来(竞态)。 */
  removed = /* @__PURE__ */ new Set();
  /** 每主机写锁:append / compact / removeHost 串行,防压缩旧读数覆盖新行。 */
  locks = /* @__PURE__ */ new Map();
  withLock(hostId, fn) {
    const prev = this.locks.get(hostId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(hostId, next.catch(() => {
    }));
    return next;
  }
  async load() {
    await mkdir2(this.rootDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile4(join3(this.rootDir, "settings.json"), "utf8"));
      this.settings = normalizeSettings(raw);
      if (raw.collectIntervalSec === 30) {
        this.settings = { ...this.settings, collectIntervalSec: 10 };
        await this.saveSettings(this.settings).catch(() => {
        });
      }
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    let hostIds = [];
    try {
      hostIds = (await readdir(this.rootDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      hostIds = [];
    }
    const now = Date.now();
    for (const id of hostIds) {
      const raw = await readJsonl(layerFile(this.rootDir, id, "raw"));
      const kept = raw.filter((s) => s.t >= now - RAW_KEEP_MS);
      this.rawCache.set(id, kept);
      const last = kept[kept.length - 1] ?? await this.newestFromLayers(id);
      if (last !== void 0) this.latest.set(id, last);
    }
  }
  getSettings() {
    return this.settings;
  }
  async saveSettings(next) {
    this.settings = normalizeSettings(next);
    await mkdir2(this.rootDir, { recursive: true });
    await atomicWrite2(join3(this.rootDir, "settings.json"), JSON.stringify(this.settings, null, 2));
    return this.settings;
  }
  getLatest(hostId) {
    return this.latest.get(hostId);
  }
  allLatest() {
    return this.latest;
  }
  async append(hostId, sample) {
    if (this.removed.has(hostId)) return;
    await this.withLock(hostId, async () => {
      if (this.removed.has(hostId)) return;
      await mkdir2(join3(this.rootDir, hostId), { recursive: true });
      await appendFile(layerFile(this.rootDir, hostId, "raw"), `${JSON.stringify(sample)}
`, "utf8");
      this.latest.set(hostId, sample);
      const buf = this.rawCache.get(hostId) ?? [];
      buf.push(sample);
      const cut = sample.t - RAW_KEEP_MS;
      this.rawCache.set(hostId, buf.filter((s) => s.t >= cut));
    });
    if (Date.now() - this.lastCompactAt > COMPACT_EVERY_MS) {
      this.lastCompactAt = Date.now();
      void this.compact(hostId).catch(() => {
      });
    }
  }
  /**
   * 取窗口内样本:短窗走 raw,长窗合并 rollup 层。
   * 返回的样本已按 t 升序,可能含各层粒度混杂——调用方再 rollup。
   */
  async query(hostId, from, to) {
    const span = to - from;
    if (span <= RAW_KEEP_MS) {
      const cached = this.rawCache.get(hostId);
      if (cached !== void 0) return cached.filter((s) => s.t >= from && s.t <= to);
      const raw = await readJsonl(layerFile(this.rootDir, hostId, "raw"));
      return raw.filter((s) => s.t >= from && s.t <= to);
    }
    const layers = span <= M1_KEEP_MS ? ["raw", "m1"] : span <= M15_KEEP_MS ? ["m1", "m15"] : ["m1", "m15", "h1"];
    const merged = [];
    const seen = /* @__PURE__ */ new Set();
    for (const layer of layers) {
      const rows = layer === "raw" && this.rawCache.has(hostId) ? this.rawCache.get(hostId) ?? [] : await readJsonl(layerFile(this.rootDir, hostId, layer));
      for (const s of rows) {
        if (s.t < from || s.t > to) continue;
        if (seen.has(s.t)) continue;
        seen.add(s.t);
        merged.push(s);
      }
    }
    merged.sort((a, b) => a.t - b.t);
    return merged;
  }
  /** 批量写入(sar 回填用):单次 append,锁内执行。 */
  async appendMany(hostId, samples) {
    if (samples.length === 0 || this.removed.has(hostId)) return;
    await this.withLock(hostId, async () => {
      if (this.removed.has(hostId)) return;
      await mkdir2(join3(this.rootDir, hostId), { recursive: true });
      const body = samples.map((s) => JSON.stringify(s)).join("\n");
      await appendFile(layerFile(this.rootDir, hostId, "raw"), `${body}
`, "utf8");
      let newest = this.latest.get(hostId);
      for (const s of samples) {
        if (newest === void 0 || s.t > newest.t) newest = s;
      }
      if (newest !== void 0) this.latest.set(hostId, newest);
      const cut = Date.now() - RAW_KEEP_MS;
      const merged = [...this.rawCache.get(hostId) ?? [], ...samples].filter((s) => s.t >= cut).sort((a, b) => a.t - b.t);
      this.rawCache.set(hostId, merged);
    });
  }
  /** 本地最早的样本时刻(跨 rollup 层);完全没有数据返回 undefined。 */
  async oldestT(hostId) {
    for (const layer of ["h1", "m15", "m1", "raw"]) {
      const rows = await readJsonl(layerFile(this.rootDir, hostId, layer));
      if (rows.length > 0) return rows[0].t;
    }
    return void 0;
  }
  async removeHost(hostId) {
    this.latest.delete(hostId);
    this.rawCache.delete(hostId);
    this.removed.add(hostId);
    await this.withLock(hostId, () => rm(join3(this.rootDir, hostId), { recursive: true, force: true, maxRetries: 3 }));
  }
  /** 把 raw 压进 m1/m15/h1 并裁剪过期行。公开给单测。 */
  async compact(hostId) {
    if (this.removed.has(hostId)) return;
    await this.withLock(hostId, () => this.doCompact(hostId));
  }
  async doCompact(hostId) {
    if (this.removed.has(hostId)) return;
    const now = Date.now();
    const raw = await readJsonl(layerFile(this.rootDir, hostId, "raw"));
    const rawKeep = raw.filter((s) => s.t >= now - RAW_KEEP_MS);
    await this.writeLayer(hostId, "raw", rawKeep);
    if (!this.removed.has(hostId)) this.rawCache.set(hostId, rawKeep);
    await this.mergeLayer(hostId, "m1", raw, now - M1_KEEP_MS, now, BUCKET_MS["1m"]);
    const m1 = await readJsonl(layerFile(this.rootDir, hostId, "m1"));
    await this.mergeLayer(hostId, "m15", m1, now - M15_KEEP_MS, now, BUCKET_MS["15m"]);
    const m15 = await readJsonl(layerFile(this.rootDir, hostId, "m15"));
    await this.mergeLayer(hostId, "h1", m15, now - H1_KEEP_MS, now, BUCKET_MS["1h"]);
  }
  async mergeLayer(hostId, layer, source, keepFrom, now, bucketMs) {
    const existing = await readJsonl(layerFile(this.rootDir, hostId, layer));
    const rolled = rollup(source, keepFrom, now, bucketMs).map(pointToSample);
    const byT = /* @__PURE__ */ new Map();
    for (const s of existing) {
      if (s.t >= keepFrom) byT.set(s.t, s);
    }
    for (const s of rolled) byT.set(s.t, s);
    const next = [...byT.values()].sort((a, b) => a.t - b.t);
    await this.writeLayer(hostId, layer, next);
  }
  async writeLayer(hostId, layer, rows) {
    if (this.removed.has(hostId)) return;
    await mkdir2(join3(this.rootDir, hostId), { recursive: true });
    const body = rows.map((s) => JSON.stringify(s)).join("\n");
    await atomicWrite2(layerFile(this.rootDir, hostId, layer), body.length === 0 ? "" : `${body}
`);
  }
  async newestFromLayers(hostId) {
    for (const layer of ["raw", "m1", "m15", "h1"]) {
      const rows = await readJsonl(layerFile(this.rootDir, hostId, layer));
      if (rows.length > 0) return rows[rows.length - 1];
    }
    return void 0;
  }
};

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

// src/server/recorder.ts
var PROBE_TIMEOUT_MS = 2e4;
var PROBE_CONCURRENCY = 4;
var FULL_META_MS = 10 * 6e4;
var MetricRecorder = class {
  constructor(hosts, ssh, metrics) {
    this.hosts = hosts;
    this.ssh = ssh;
    this.metrics = metrics;
  }
  hosts;
  ssh;
  metrics;
  timer;
  ticking = false;
  lastFullAt = /* @__PURE__ */ new Map();
  meta = /* @__PURE__ */ new Map();
  snapshots = /* @__PURE__ */ new Map();
  start() {
    this.stop();
    const tick = () => {
      void this.tick(false);
    };
    tick();
    this.arm();
  }
  stop() {
    if (this.timer !== void 0) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
  }
  /** 采集周期被设置页改掉后重武装。 */
  arm() {
    if (this.timer !== void 0) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
    const sec = this.metrics.getSettings().collectIntervalSec;
    this.timer = setInterval(() => {
      void this.tick(false);
    }, sec * 1e3);
  }
  latestStatuses() {
    return this.hosts.list().map((h) => this.snapshots.get(h.id) ?? { id: h.id, state: "unknown" });
  }
  latestOf(id) {
    return this.snapshots.get(id) ?? { id, state: "unknown" };
  }
  forget(id) {
    this.snapshots.delete(id);
    this.meta.delete(id);
    this.lastFullAt.delete(id);
  }
  /** force=true 忽略 recording 开关,给工具栏「刷新」用。 */
  async tick(force) {
    if (this.ticking) return this.latestStatuses();
    const settings = this.metrics.getSettings();
    if (!force && !settings.recording) return this.latestStatuses();
    this.ticking = true;
    try {
      const paused = new Set(settings.pausedHostIds);
      const hosts = [...this.hosts.list()];
      const results = /* @__PURE__ */ new Map();
      for (const h of hosts) {
        results.set(h.id, { id: h.id, state: "probing", probedAt: (/* @__PURE__ */ new Date()).toISOString() });
      }
      let cursor = 0;
      const worker = async () => {
        while (cursor < hosts.length) {
          const host = hosts[cursor++];
          if (!force && paused.has(host.id)) {
            const prev = this.snapshots.get(host.id);
            results.set(host.id, prev ?? { id: host.id, state: "unknown" });
            continue;
          }
          results.set(host.id, await this.probeOne(host.id));
        }
      };
      await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(1, hosts.length)) }, worker));
      const out = hosts.map((h) => results.get(h.id) ?? { id: h.id, state: "unknown" });
      for (const s of out) this.snapshots.set(s.id, s);
      return out;
    } finally {
      this.ticking = false;
    }
  }
  async probeOne(id) {
    const now = Date.now();
    const base = { id, state: "probing", probedAt: (/* @__PURE__ */ new Date()).toISOString(), ...this.meta.get(id) };
    try {
      await this.ssh.connect(id);
      const started = Date.now();
      const { stdout } = await this.ssh.exec(id, PROBE_SCRIPT, PROBE_TIMEOUT_MS);
      const latencyMs = Date.now() - started;
      const parsed = parseProbeOutput(stdout);
      const needFull = (this.lastFullAt.get(id) ?? 0) + FULL_META_MS < now;
      if (needFull) {
        this.lastFullAt.set(id, now);
        this.meta.set(id, {
          osName: parsed.osName,
          uptimeText: parsed.uptimeText,
          cores: parsed.cores
        });
      }
      const status = {
        ...base,
        ...this.meta.get(id),
        cpuPercent: parsed.cpuPercent,
        memPercent: parsed.memPercent,
        diskPercent: parsed.diskPercent,
        state: "online",
        latencyMs,
        probedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.metrics.append(id, {
        t: now,
        cpu: parsed.cpuPercent,
        mem: parsed.memPercent,
        disk: parsed.diskPercent,
        latencyMs,
        online: true
      });
      return status;
    } catch (error) {
      const status = {
        ...base,
        state: "offline",
        error: error instanceof Error ? error.message : String(error),
        probedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.metrics.append(id, { t: now, online: false }).catch(() => {
      });
      return status;
    }
  }
};

// src/server/backfill.ts
var SAR_CMD = 'LC_ALL=C sar -u 2>/dev/null; echo "@@SAR-R@@"; LC_ALL=C sar -r 2>/dev/null';
var ATTEMPT_GAP_MS = 10 * 6e4;
var SAR_TIMEOUT_MS = 12e3;
function clamp01(n) {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}
function headerIndex(line, token) {
  return line.trim().split(/\s+/).indexOf(token);
}
function parseSarRows(raw) {
  const [cpuPart, memPart = ""] = raw.split("@@SAR-R@@");
  const rows = /* @__PURE__ */ new Map();
  const cpuLines = cpuPart.split("\n");
  const cpuHeader = cpuLines.find((l) => l.includes("%idle"));
  const idleIdx = cpuHeader !== void 0 ? headerIndex(cpuHeader, "%idle") : -1;
  if (idleIdx >= 0) {
    for (const line of cpuLines) {
      const cols = line.trim().split(/\s+/);
      if (!/^\d{1,2}:\d{2}:\d{2}$/.test(cols[0] ?? "") || cols[1] !== "all") continue;
      const idle = Number(cols[idleIdx]);
      if (!Number.isFinite(idle)) continue;
      const [h, m, s] = cols[0].split(":").map(Number);
      rows.set(cols[0], { h, m, s, cpu: clamp01(100 - idle) });
    }
  }
  const memLines = memPart.split("\n");
  const memHeader = memLines.find((l) => l.includes("%memused"));
  const memIdx = memHeader !== void 0 ? headerIndex(memHeader, "%memused") : -1;
  if (memIdx >= 0) {
    for (const line of memLines) {
      const cols = line.trim().split(/\s+/);
      if (!/^\d{1,2}:\d{2}:\d{2}$/.test(cols[0] ?? "")) continue;
      const mem = Number(cols[memIdx]);
      if (!Number.isFinite(mem)) continue;
      const [h, m, s] = cols[0].split(":").map(Number);
      const exist = rows.get(cols[0]);
      if (exist !== void 0) exist.mem = clamp01(mem);
      else rows.set(cols[0], { h, m, s, mem: clamp01(mem) });
    }
  }
  return [...rows.values()];
}
function sarRowsToSamples(rows, from, to, now) {
  if (rows.length === 0) return [];
  const base = new Date(now);
  const y = base.getFullYear();
  const mo = base.getMonth();
  const d = base.getDate();
  const build = (utc) => rows.flatMap((r) => {
    const t = utc ? Date.UTC(y, mo, d, r.h, r.m, r.s) : new Date(y, mo, d, r.h, r.m, r.s).getTime();
    if (t < from - 6e4 || t > to) return [];
    return [{ t, cpu: r.cpu, mem: r.mem, online: true }];
  });
  const localHits = build(false);
  const utcHits = build(true);
  const pick = utcHits.length > localHits.length ? utcHits : localHits;
  return pick.sort((a, b) => a.t - b.t);
}
var SarBackfill = class {
  constructor(pool, metrics) {
    this.pool = pool;
    this.metrics = metrics;
  }
  pool;
  metrics;
  lastAttempt = /* @__PURE__ */ new Map();
  /** 查询前调用:需要且允许时,从服务器 sar 回填一段历史。 */
  async ensure(hostId, from, to) {
    const now = Date.now();
    const last = this.lastAttempt.get(hostId) ?? 0;
    if (now - last < ATTEMPT_GAP_MS) return;
    const oldest = await this.metrics.oldestT(hostId);
    if (oldest !== void 0 && from >= oldest - 6e4) return;
    this.lastAttempt.set(hostId, now);
    try {
      const { stdout } = await this.pool.exec(hostId, SAR_CMD, SAR_TIMEOUT_MS);
      const samples = sarRowsToSamples(parseSarRows(stdout), from, to, now);
      if (samples.length > 0) await this.metrics.appendMany(hostId, samples);
    } catch {
    }
  }
};

// src/index.ts
var name = "server-deck";
var inject = ["webServer"];
function apply(ctx) {
  const store = new HostStore();
  const metrics = new MetricStore();
  const pool = new HostPool(
    (id) => store.get(id),
    (id) => store.getSecret(id)
  );
  const recorder = new MetricRecorder(store, pool, metrics);
  const backfill = new SarBackfill(pool, metrics);
  void (async () => {
    try {
      await store.load();
    } catch (error) {
      console.warn("[server-deck] \u53F0\u8D26\u52A0\u8F7D\u5931\u8D25(\u5C06\u4EE5\u7A7A\u53F0\u8D26\u8FD0\u884C):", error);
    }
    try {
      await metrics.load();
    } catch (error) {
      console.warn("[server-deck] \u6307\u6807\u5E93\u52A0\u8F7D\u5931\u8D25(\u5C06\u4EE5\u7A7A\u5E8F\u5217\u8FD0\u884C):", error);
    }
    recorder.start();
  })();
  ctx.effect(() => () => {
    recorder.stop();
    pool.closeAll();
  }, "server-deck: dispose connections");
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: "/server-deck/api",
      handler: createApiRouter(store, pool, metrics, recorder, backfill)
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
