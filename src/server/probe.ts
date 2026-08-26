/**
 * 指标探测:一段 POSIX sh 探针脚本(Linux 优先,Darwin 回退)+
 * 宽容解析器(纯函数,可单测)。任何字段解析失败都置空,由前端显示「—」。
 */

export const PROBE_SCRIPT = [
  'echo "@@OS@@"',
  'uname -s 2>/dev/null',
  "grep -h PRETTY_NAME /etc/os-release 2>/dev/null | head -1",
  'echo "@@UP@@"',
  'uptime 2>/dev/null',
  'echo "@@CORES@@"',
  'nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null',
  'echo "@@CPU@@"',
  '(top -bn2 -d0.2 2>/dev/null | grep -iE "^%?Cpu\\(s\\)" | tail -1)',
  "(top -l 2 2>/dev/null | grep -i 'CPU usage' | tail -1)",
  'echo "@@MEM@@"',
  'free -m 2>/dev/null | grep -iE "^Mem"',
  'vm_stat 2>/dev/null',
  'sysctl -n hw.memsize 2>/dev/null',
  'echo "@@DISK@@"',
  'df -P / 2>/dev/null | tail -1',
].join('; ');

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

/** 解析探针输出。 */
export function parseProbeOutput(raw: string): ProbeResult {
  const text = raw.replace(/\r/g, '');
  const result: ProbeResult = {};

  // OS:uname 行 + PRETTY_NAME
  const osSection = section(text, '@@OS@@');
  const pretty = /PRETTY_NAME="?([^"\n]+)"?/.exec(osSection)?.[1];
  const unameLine = osSection.split('\n').map((l) => l.trim()).find((l) => /^(Linux|Darwin|FreeBSD|OpenBSD)/.test(l));
  if (pretty !== undefined) result.osName = pretty;
  else if (unameLine === 'Darwin') result.osName = 'macOS';
  else if (unameLine !== undefined) result.osName = unameLine;

  // uptime:"up 3 days,  4:21,  2 users, ..." → up 到 users 前
  const upSection = section(text, '@@UP@@');
  const upMatch = /\bup\s+(.+?),?\s*\n?\s*(\d+\s+users?|$)/i.exec(upSection.replace(/\s+/g, ' '));
  if (upMatch !== null) {
    const seg = upMatch[1].trim().replace(/,\s*$/, '');
    if (seg.length > 0 && seg.length < 64) result.uptimeText = seg;
  }

  // cores
  const coresRaw = section(text, '@@CORES@@').split('\n')[0];
  const cores = num(coresRaw?.trim());
  if (cores !== undefined && cores > 0) result.cores = Math.round(cores);

  // CPU:linux "%Cpu(s): 12.3 us, 4.5 sy" / darwin "CPU usage: 5.02% user, 8.10% sys"
  const cpuSection = section(text, '@@CPU@@');
  const linuxCpu = /Cpu\(s\):\s*([\d.]+)\s*us,\s*([\d.]+)\s*sy/i.exec(cpuSection);
  const darwinCpu = /CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/i.exec(cpuSection);
  if (linuxCpu !== null) {
    const total = Number(linuxCpu[1]) + Number(linuxCpu[2]);
    if (Number.isFinite(total)) result.cpuPercent = pctClamp(total);
  } else if (darwinCpu !== null) {
    const total = Number(darwinCpu[1]) + Number(darwinCpu[2]);
    if (Number.isFinite(total)) result.cpuPercent = pctClamp(total);
  }

  // MEM:linux free -m "Mem:  total used free shared buff/cache available"
  //     darwin vm_stat + hw.memsize(近似)
  const memSection = section(text, '@@MEM@@');
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

  // DISK:df -P / → "Filesystem 1024-blocks Used Available Capacity Mounted"
  const diskSection = section(text, '@@DISK@@');
  const dfLine = diskSection.split('\n').map((l) => l.trim()).find((l) => /\d+%/.test(l));
  if (dfLine !== undefined) {
    const capNum = /(\d+)%/.exec(dfLine);
    if (capNum !== null) result.diskPercent = pctClamp(Number(capNum[1]));
  }

  return result;
}
