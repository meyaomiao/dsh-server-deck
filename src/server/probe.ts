/**
 * 指标探测:POSIX sh 脚本(stdin 交给 /bin/sh -s,不经过登录壳语法)
 * + Windows CIM(EncodedCommand,避开 PowerShell 登录壳语法)
 * + 宽容解析器。Linux 主路径读 /proc;无 /proc 时 FreeBSD/OpenBSD 读 sysctl;
 * Darwin 回退 top/vm_stat。任何字段解析失败都置空,由前端显示「—」。
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
  'elif c1=$(sysctl -n kern.cp_time 2>/dev/null) && [ -n "$c1" ]; then',
  '  sleep 1',
  '  c2=$(sysctl -n kern.cp_time 2>/dev/null)',
  '  echo "cp_time $c1 $c2"',
  'else',
  '  top -l 2 2>/dev/null | grep -i "CPU usage" | tail -n 1',
  'fi',
  'echo "@@MEM@@"',
  'if [ -r /proc/meminfo ]; then',
  '  grep -E "^(MemTotal|MemAvailable|MemFree|Buffers|Cached):" /proc/meminfo',
  'else',
  '  vm_stat 2>/dev/null',
  '  sysctl -n hw.memsize 2>/dev/null',
  '  phys=$(sysctl -n hw.physmem 2>/dev/null)',
  '  pgsz=$(sysctl -n hw.pagesize 2>/dev/null)',
  '  free=$(sysctl -n vm.stats.vm.v_free_count 2>/dev/null)',
  '  if [ -z "$free" ]; then',
  '    free=$(sysctl -n vm.uvmexp.free 2>/dev/null)',
  '  fi',
  '  inact=$(sysctl -n vm.stats.vm.v_inactive_count 2>/dev/null)',
  '  if [ -z "$inact" ]; then',
  '    inact=$(sysctl -n vm.uvmexp.inactive 2>/dev/null)',
  '  fi',
  '  if [ -n "$phys" ] && [ -n "$free" ]; then',
  '    echo "physmem $phys ${pgsz:-4096} $free ${inact:-0}"',
  '  fi',
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

/**
 * Windows OpenSSH 默认壳是 PowerShell,没有 /bin/sh。
 * EncodedCommand 是单个 base64 token,登录壳不会把 && / || 当语法。
 */
export const WINDOWS_PROBE_SCRIPT = [
  "$ProgressPreference='SilentlyContinue'",
  "$ErrorActionPreference='SilentlyContinue'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$os=Get-CimInstance Win32_OperatingSystem',
  '$cs=Get-CimInstance Win32_ComputerSystem',
  '$cpu=@(Get-CimInstance Win32_Processor)',
  '$ld=Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Sort-Object DeviceID | Select-Object -First 1',
  "Write-Output '@@OS@@'",
  "Write-Output 'Windows'",
  '$cap=[string]$os.Caption',
  "if ([string]::IsNullOrWhiteSpace($cap)) { $cap='Windows' }",
  'Write-Output (\'PRETTY_NAME="\' + $cap + \'"\')',
  "Write-Output '@@UP@@'",
  '$boot=[datetime]$os.LastBootUpTime',
  'Write-Output ([int]((Get-Date)-$boot).TotalSeconds)',
  "Write-Output '@@CORES@@'",
  '$cores=$cs.NumberOfLogicalProcessors',
  'if ($null -eq $cores -or $cores -eq 0) { $cores=$cs.NumberOfProcessors }',
  'Write-Output $cores',
  "Write-Output '@@CPU@@'",
  '$avg=($cpu | ForEach-Object { $_.LoadPercentage } | Measure-Object -Average).Average',
  'if ($null -eq $avg) { $avg=0 }',
  "Write-Output ('winload=' + [int][math]::Round($avg))",
  "Write-Output '@@MEM@@'",
  "Write-Output ('MemTotal: ' + $os.TotalVisibleMemorySize + ' kB')",
  "Write-Output ('MemFree: ' + $os.FreePhysicalMemory + ' kB')",
  "Write-Output '@@DISK@@'",
  'if ($null -ne $ld -and $ld.Size -gt 0) {',
  '  $pct=[int][math]::Round((($ld.Size-$ld.FreeSpace)*100.0)/$ld.Size)',
  '  $totalK=[int64]($ld.Size/1024)',
  '  $usedK=[int64](($ld.Size-$ld.FreeSpace)/1024)',
  '  $freeK=[int64]($ld.FreeSpace/1024)',
  '  Write-Output ($ld.DeviceID + \' \' + $totalK + \' \' + $usedK + \' \' + $freeK + \' \' + $pct + \'% \' + $ld.DeviceID + \'\\\')',
  '}',
].join('\n');

export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export const WINDOWS_PROBE_COMMAND = [
  'cmd.exe /c',
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy Bypass',
  '-EncodedCommand',
  encodePowerShell(WINDOWS_PROBE_SCRIPT),
].join(' ');

export interface ProbeResult {
  osName?: string;
  uptimeText?: string;
  cores?: number;
  cpuPercent?: number;
  memPercent?: number;
  diskPercent?: number;
}

/** POSIX 探针拿不到 CPU 且拿不到内存时,才打 Windows CIM(Linux 零额外 RTT)。 */
export function hasUsefulMetrics(parsed: ProbeResult): boolean {
  return parsed.cpuPercent !== undefined || parsed.memPercent !== undefined;
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

/** FreeBSD/OpenBSD `kern.cp_time`: user nice sys intr idle, 两次样本。 */
function parseCpTime(cpuSection: string): number | undefined {
  const line = cpuSection.split('\n').map((l) => l.trim()).find((l) => l.startsWith('cp_time'));
  if (line === undefined) return undefined;
  const nums = line.replace(/^cp_time\s+/i, '').split(/[^\d.]+/).filter((p) => p.length > 0).map(Number);
  if (nums.length < 10 || nums.some((n) => !Number.isFinite(n))) return undefined;
  const a = nums.slice(0, 5);
  const b = nums.slice(5, 10);
  const t1 = a.reduce((s, n) => s + n, 0);
  const t2 = b.reduce((s, n) => s + n, 0);
  const idle = b[4]! - a[4]!;
  const total = t2 - t1;
  if (total <= 0) return undefined;
  return pctClamp((1 - idle / total) * 100);
}

function parseWinLoad(cpuSection: string): number | undefined {
  const m = /winload=(\d+)/.exec(cpuSection);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? pctClamp(n) : undefined;
}

function parsePhysmem(memSection: string): number | undefined {
  const m = /physmem\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(memSection);
  if (m === null) return undefined;
  const total = Number(m[1]);
  const pageSize = Number(m[2]);
  const freePages = Number(m[3]);
  const inactPages = Number(m[4]);
  if (!Number.isFinite(total) || total <= 0) return undefined;
  const psz = pageSize > 0 ? pageSize : 4096;
  const freeBytes = (freePages + inactPages) * psz;
  return pctClamp((1 - freeBytes / total) * 100);
}

/** 解析探针输出。兼容 0.2.2 GNU top/free、/proc、Windows CIM、BSD sysctl。 */
export function parseProbeOutput(raw: string): ProbeResult {
  const text = raw.replace(/\r/g, '');
  const result: ProbeResult = {};

  const osSection = section(text, '@@OS@@');
  const pretty = /PRETTY_NAME="?([^"\n]+)"?/.exec(osSection)?.[1];
  const unameLine = osSection.split('\n').map((l) => l.trim()).find((l) => /^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|Windows|MINGW|MSYS|CYGWIN)/.test(l));
  if (pretty !== undefined) result.osName = pretty;
  else if (unameLine === 'Darwin') result.osName = 'macOS';
  else if (unameLine !== undefined && /^(Windows|MINGW|MSYS|CYGWIN)/.test(unameLine)) result.osName = 'Windows';
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
  const cpTimeCpu = parseCpTime(cpuSection);
  const winCpu = parseWinLoad(cpuSection);
  if (procCpu !== undefined) {
    result.cpuPercent = procCpu;
  } else if (cpTimeCpu !== undefined) {
    result.cpuPercent = cpTimeCpu;
  } else if (winCpu !== undefined) {
    result.cpuPercent = winCpu;
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
      const physPct = parsePhysmem(memSection);
      if (physPct !== undefined) {
        result.memPercent = physPct;
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
  }

  const diskSection = section(text, '@@DISK@@');
  const dfLine = diskSection.split('\n').map((l) => l.trim()).find((l) => /\d+%/.test(l));
  if (dfLine !== undefined) {
    const capNum = /(\d+)%/.exec(dfLine);
    if (capNum !== null) result.diskPercent = pctClamp(Number(capNum[1]));
  }

  return result;
}
