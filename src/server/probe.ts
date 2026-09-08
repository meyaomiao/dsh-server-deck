/**
 * 指标探测:POSIX sh 脚本(stdin 交给 /bin/sh -s,不经过登录壳语法)
 * + 宽容解析器。Linux 主路径读 /proc,不依赖 GNU top/free。
 * 任何字段解析失败都置空,由前端显示「—」。
 */

/** 经 HostPool.execSh 喂给 /bin/sh -s。禁止依赖登录壳;禁止 bash/fish 语法。 */
export const PROBE_SCRIPT = [
  'echo "@@OS@@"',
  'uname -s 2>/dev/null',
  'if [ -r /etc/os-release ]; then',
  '  grep PRETTY_NAME /etc/os-release 2>/dev/null | sed -n "1p"',
  'fi',
  'echo "@@UP@@"',
  'if [ -r /proc/uptime ]; then',
  '  cat /proc/uptime',
  'else',
  '  uptime 2>/dev/null',
  'fi',
  'echo "@@CORES@@"',
  'if [ -r /proc/cpuinfo ]; then',
  '  grep -c "^processor" /proc/cpuinfo 2>/dev/null',
  'elif command -v getconf >/dev/null 2>&1; then',
  '  getconf _NPROCESSORS_ONLN 2>/dev/null',
  'else',
  '  sysctl -n hw.ncpu 2>/dev/null',
  'fi',
  'echo "@@CPU@@"',
  'if [ -r /proc/stat ]; then',
  '  read -r _ u1 n1 s1 i1 w1 _rest1 < /proc/stat',
  '  sleep 1',
  '  read -r _ u2 n2 s2 i2 w2 _rest2 < /proc/stat',
  '  echo "procstat $u1 $n1 $s1 $i1 $w1 $u2 $n2 $s2 $i2 $w2"',
  'else',
  '  top -l 2 2>/dev/null | grep -i "CPU usage" | tail -n 1',
  'fi',
  'echo "@@MEM@@"',
  'if [ -r /proc/meminfo ]; then',
  '  grep -E "^(MemTotal|MemAvailable|MemFree|Buffers|Cached):" /proc/meminfo',
  'else',
  '  vm_stat 2>/dev/null',
  '  sysctl -n hw.memsize 2>/dev/null',
  'fi',
  'echo "@@DISK@@"',
  'df -P / 2>/dev/null | tail -n 1',
].join('\n');

/** sar 回填同样必须走 sh,避免 fish 登录壳把分号当语法错误。 */
export const SAR_SCRIPT = [
  'LC_ALL=C sar -u 2>/dev/null',
  'echo "@@SAR-R@@"',
  'LC_ALL=C sar -r 2>/dev/null',
].join('\n');

export interface ProbeResult {
  osName?: string;
  uptimeText?: string;
  cores?: number;
  cpuPercent?: number;
  memPercent?: number;
  diskPercent?: number;
}

function section(text: string, marker: string): string {
  const idx = text.indexOf(marker);
  if (idx < 0) return '';
  const rest = text.slice(idx + marker.length);
  const end = rest.indexOf('@@');
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pctClamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function meminfoKb(sectionText: string, key: string): number | undefined {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'im').exec(sectionText);
  return num(m?.[1]);
}

/** /proc/uptime 秒 → 卡片用的短文案。 */
export function formatUptimeSeconds(sec: number): string | undefined {
  if (!Number.isFinite(sec) || sec < 0) return undefined;
  const s = Math.floor(sec);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${String(days)} days, ${String(hours)}:${String(mins).padStart(2, '0')}`;
  if (hours > 0) return `${String(hours)}:${String(mins).padStart(2, '0')}`;
  return `${String(mins)} min`;
}

function parseProcstat(cpuSection: string): number | undefined {
  const m = /procstat\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(cpuSection);
  if (m === null) return undefined;
  const vals = m.slice(1).map(Number);
  if (vals.some((n) => !Number.isFinite(n))) return undefined;
  const t1 = vals[0]! + vals[1]! + vals[2]! + vals[3]! + vals[4]!;
  const t2 = vals[5]! + vals[6]! + vals[7]! + vals[8]! + vals[9]!;
  const idle = vals[8]! - vals[3]!;
  const total = t2 - t1;
  if (total <= 0) return undefined;
  return pctClamp((1 - idle / total) * 100);
}

/** 解析探针输出。兼容 0.2.2 的 GNU top/free 样例 + /proc 主路径。 */
export function parseProbeOutput(raw: string): ProbeResult {
  const text = raw.replace(/\r/g, '');
  const result: ProbeResult = {};

  const osSection = section(text, '@@OS@@');
  const pretty = /PRETTY_NAME="?([^"\n]+)"?/.exec(osSection)?.[1];
  const unameLine = osSection.split('\n').map((l) => l.trim()).find((l) => /^(Linux|Darwin|FreeBSD|OpenBSD)/.test(l));
  if (pretty !== undefined) result.osName = pretty;
  else if (unameLine === 'Darwin') result.osName = 'macOS';
  else if (unameLine !== undefined) result.osName = unameLine;

  const upSection = section(text, '@@UP@@');
  const procUp = /^(\d+(?:\.\d+)?)(?:\s|$)/.exec(upSection.trim());
  if (procUp !== null && !/\bup\s+/i.test(upSection)) {
    const formatted = formatUptimeSeconds(Number(procUp[1]));
    if (formatted !== undefined) result.uptimeText = formatted;
  } else {
    const upMatch = /\bup\s+(.+?),?\s*\n?\s*(\d+\s+users?|$)/i.exec(upSection.replace(/\s+/g, ' '));
    if (upMatch !== null) {
      const seg = upMatch[1].trim().replace(/,\s*$/, '');
      if (seg.length > 0 && seg.length < 64) result.uptimeText = seg;
    }
  }

  const coresRaw = section(text, '@@CORES@@').split('\n')[0];
  const cores = num(coresRaw?.trim());
  if (cores !== undefined && cores > 0) result.cores = Math.round(cores);

  const cpuSection = section(text, '@@CPU@@');
  const procCpu = parseProcstat(cpuSection);
  if (procCpu !== undefined) {
    result.cpuPercent = procCpu;
  } else {
    const linuxCpu = /Cpu\(s\):\s*([\d.]+)\s*us,\s*([\d.]+)\s*sy/i.exec(cpuSection);
    const darwinCpu = /CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/i.exec(cpuSection);
    if (linuxCpu !== null) {
      const total = Number(linuxCpu[1]) + Number(linuxCpu[2]);
      if (Number.isFinite(total)) result.cpuPercent = pctClamp(total);
    } else if (darwinCpu !== null) {
      const total = Number(darwinCpu[1]) + Number(darwinCpu[2]);
      if (Number.isFinite(total)) result.cpuPercent = pctClamp(total);
    }
  }

  const memSection = section(text, '@@MEM@@');
  const memTotal = meminfoKb(memSection, 'MemTotal');
  const memAvail = meminfoKb(memSection, 'MemAvailable');
  if (memTotal !== undefined && memTotal > 0 && memAvail !== undefined) {
    result.memPercent = pctClamp(((memTotal - memAvail) / memTotal) * 100);
  } else if (memTotal !== undefined && memTotal > 0) {
    const memFree = meminfoKb(memSection, 'MemFree') ?? 0;
    const buffers = meminfoKb(memSection, 'Buffers') ?? 0;
    const cached = meminfoKb(memSection, 'Cached') ?? 0;
    result.memPercent = pctClamp(((memTotal - memFree - buffers - cached) / memTotal) * 100);
  } else {
    const freeLine = /^Mem:\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+\d+\s+\d+\s+(\d+))?/im.exec(memSection);
    if (freeLine !== null) {
      const total = Number(freeLine[1]);
      const used = Number(freeLine[2]);
      const available = freeLine[4] !== undefined ? Number(freeLine[4]) : undefined;
      if (total > 0) {
        const usedPct = available !== undefined ? ((total - available) / total) * 100 : (used / total) * 100;
        result.memPercent = pctClamp(usedPct);
      }
    } else {
      const totalBytes = num(/hw\.memsize|^(\d+)$/m.exec(memSection.split('\n').slice(-1)[0]?.trim() ?? '')?.[1]);
      const pagesFree = num(/Pages free:\s+(\d+)/.exec(memSection)?.[1]);
      const pagesInactive = num(/Pages inactive:\s+(\d+)/.exec(memSection)?.[1]);
      const pageSize = 16384;
      if (totalBytes !== undefined && totalBytes > 0 && pagesFree !== undefined) {
        const freeBytes = (pagesFree + (pagesInactive ?? 0)) * pageSize;
        result.memPercent = pctClamp((1 - freeBytes / totalBytes) * 100);
      }
    }
  }

  const diskSection = section(text, '@@DISK@@');
  const dfLine = diskSection.split('\n').map((l) => l.trim()).find((l) => /\d+%/.test(l));
  if (dfLine !== undefined) {
    const capNum = /(\d+)%/.exec(dfLine);
    if (capNum !== null) result.diskPercent = pctClamp(Number(capNum[1]));
  }

  return result;
}
