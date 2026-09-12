import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProbeOutput,
  hasUsefulMetrics,
  encodePowerShell,
  WINDOWS_PROBE_COMMAND,
  WINDOWS_PROBE_SCRIPT,
  PROBE_SCRIPT,
} from '../src/server/probe.ts';

const LINUX_OUT = [
  '@@OS@@', 'Linux', 'PRETTY_NAME="Ubuntu 22.04.4 LTS"', '@@UP@@',
  ' 14:32:01 up 3 days,  4:21,  2 users,  load average: 0.10, 0.15, 0.09', '@@CORES@@', '8', '@@CPU@@',
  '%Cpu(s): 12.5 us,  4.5 sy,  0.0 ni, 80.0 id', '@@MEM@@',
  'Mem:           16000        8000        2000         100        6000        7900', '@@DISK@@',
  '/dev/sda1       100000000  45000000  55000000  45% /',
].join('\n');

test('解析 Linux 探针输出', () => {
  const r = parseProbeOutput(LINUX_OUT);
  assert.equal(r.osName, 'Ubuntu 22.04.4 LTS');
  assert.equal(r.uptimeText, '3 days, 4:21');
  assert.equal(r.cores, 8);
  assert.equal(r.cpuPercent, 17);
  // available=7900 → (16000-7900)/16000 = 50.6%
  assert.ok(r.memPercent !== undefined && Math.abs(r.memPercent - 50.6) < 0.2);
  assert.equal(r.diskPercent, 45);
});

const DARWIN_OUT = [
  '@@OS@@', 'Darwin', '@@UP@@',
  '14:32  up 2 days, 10:11, 3 users, load averages: 1.20 1.30 1.40', '@@CORES@@', '10', '@@CPU@@',
  'CPU usage: 5.02% user, 8.10% sys, 86.88% idle', '@@MEM@@',
  'Pages free:                              98765.', 'Pages active:                          1234567.',
  'Pages inactive:                         234567.',
  '17179869184', '@@DISK@@',
  '/dev/disk3s1s1  4943847952 123456789 4818900000    3% /',
].join('\n');

test('解析 Darwin 回退输出', () => {
  const r = parseProbeOutput(DARWIN_OUT);
  assert.equal(r.osName, 'macOS');
  assert.equal(r.uptimeText, '2 days, 10:11');
  assert.equal(r.cores, 10);
  assert.ok(Math.abs((r.cpuPercent ?? 0) - 13.1) < 0.05);
  assert.equal(r.diskPercent, 3);
  // mem 近似:有 free/inactive 页即应产出数值
  assert.ok(r.memPercent !== undefined && r.memPercent > 0 && r.memPercent < 100);
});

test('垃圾输入全部为空', () => {
  const r = parseProbeOutput('nothing here');
  assert.equal(r.osName, undefined);
  assert.equal(r.cpuPercent, undefined);
  assert.equal(r.memPercent, undefined);
  assert.equal(r.diskPercent, undefined);
});

const PROC_OUT = [
  '@@OS@@', 'Linux', 'PRETTY_NAME="CachyOS"', '@@UP@@',
  '3790560.12 15218400.50', '@@CORES@@', '16', '@@CPU@@',
  'procstat 100 0 50 850 0 200 0 80 900 0', '@@MEM@@',
  'MemTotal:        32686080 kB',
  'MemAvailable:    20480000 kB',
  'MemFree:          8000000 kB',
  'Buffers:           200000 kB',
  'Cached:           4000000 kB',
  '@@DISK@@',
  '/dev/nvme0n1p2  996000000  542000000  454000000  55% /',
].join('\n');

test('解析 /proc 主路径(CachyOS 同类)', () => {
  const r = parseProbeOutput(PROC_OUT);
  assert.equal(r.osName, 'CachyOS');
  assert.equal(r.cores, 16);
  assert.equal(r.diskPercent, 55);
  assert.ok(r.uptimeText !== undefined && r.uptimeText.startsWith('43 days'));
  // t1=1000 t2=1180 idle=50 → (1-50/180)*100 = 72.2
  assert.ok(r.cpuPercent !== undefined && Math.abs(r.cpuPercent - 72.2) < 0.05);
  // (32686080-20480000)/32686080 ≈ 37.3
  assert.ok(r.memPercent !== undefined && Math.abs(r.memPercent - 37.3) < 0.2);
});

const ALPINE_MEM = [
  '@@OS@@', 'Linux', 'PRETTY_NAME="Alpine Linux v3.20"', '@@UP@@',
  '3600.0 7200.0', '@@CORES@@', '2', '@@CPU@@',
  'procstat 10 0 5 85 0 20 0 10 90 0', '@@MEM@@',
  'MemTotal:         256000 kB',
  'MemFree:          128000 kB',
  'Buffers:            8000 kB',
  'Cached:            40000 kB',
  '@@DISK@@',
  '/dev/sda1        1000000   400000   600000  40% /',
].join('\n');

test('Alpine 无 MemAvailable 时用 Free+Buffers+Cached', () => {
  const r = parseProbeOutput(ALPINE_MEM);
  assert.equal(r.osName, 'Alpine Linux v3.20');
  assert.equal(r.uptimeText, '1:00');
  assert.equal(r.cores, 2);
  assert.equal(r.diskPercent, 40);
  // used = 256000-128000-8000-40000 = 80000 → 31.3%
  assert.ok(r.memPercent !== undefined && Math.abs(r.memPercent - 31.3) < 0.2);
});

test('探针脚本不依赖登录壳语法', () => {
  assert.equal(PROBE_SCRIPT.includes('(top'), false);
  assert.equal(PROBE_SCRIPT.includes('nproc'), false);
  assert.equal(PROBE_SCRIPT.includes('free -m'), false);
  assert.equal(PROBE_SCRIPT.includes('kern.cp_time'), true);
  assert.equal(PROBE_SCRIPT.includes('hw.physmem'), true);
});

const WINDOWS_OUT = [
  '@@OS@@',
  'Windows',
  'PRETTY_NAME="Microsoft Windows 11 家庭版"',
  '@@UP@@',
  '12632',
  '@@CORES@@',
  '12',
  '@@CPU@@',
  'winload=28',
  '@@MEM@@',
  'MemTotal: 33410932 kB',
  'MemFree: 18645628 kB',
  '@@DISK@@',
  'C: 975391740 146911732 828480008 15% C:\\',
].join('\r\n');

test('解析 Windows CIM 探针输出(含 CRLF 与中文 Caption)', () => {
  const r = parseProbeOutput(WINDOWS_OUT);
  assert.equal(r.osName, 'Microsoft Windows 11 家庭版');
  assert.equal(r.uptimeText, '3:30');
  assert.equal(r.cores, 12);
  assert.equal(r.cpuPercent, 28);
  assert.equal(r.diskPercent, 15);
  // (33410932-18645628)/33410932 ≈ 44.2
  assert.ok(r.memPercent !== undefined && Math.abs(r.memPercent - 44.2) < 0.2);
  assert.equal(hasUsefulMetrics(r), true);
});

test('Windows EncodedCommand 避开登录壳语法', () => {
  assert.equal(WINDOWS_PROBE_COMMAND.includes('cmd.exe /c'), true);
  assert.equal(WINDOWS_PROBE_COMMAND.includes('EncodedCommand'), true);
  assert.equal(WINDOWS_PROBE_COMMAND.includes('&&'), false);
  assert.equal(WINDOWS_PROBE_SCRIPT.includes('Get-CimInstance'), true);
  const encoded = encodePowerShell(WINDOWS_PROBE_SCRIPT);
  assert.equal(encoded.length > 80, true);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), WINDOWS_PROBE_SCRIPT);
});

const FREEBSD_OUT = [
  '@@OS@@', 'FreeBSD', '@@UP@@',
  ' 10:00AM  up 5 days,  2:03, 1 user, load averages: 0.10 0.12 0.08',
  '@@CORES@@', '4', '@@CPU@@',
  'cp_time 100 0 50 10 840 200 0 80 20 900',
  '@@MEM@@',
  'physmem 8589934592 4096 524288 131072',
  '@@DISK@@',
  '/dev/ada0p2    200000000  80000000  120000000  40% /',
].join('\n');

test('解析 FreeBSD sysctl 探针输出', () => {
  const r = parseProbeOutput(FREEBSD_OUT);
  assert.equal(r.osName, 'FreeBSD');
  assert.equal(r.uptimeText, '5 days, 2:03');
  assert.equal(r.cores, 4);
  assert.equal(r.diskPercent, 40);
  // idle Δ=60 total Δ=200 → 70%
  assert.equal(r.cpuPercent, 70);
  // freeBytes=(524288+131072)*4096 / 8589934592 → 68.8% used
  assert.ok(r.memPercent !== undefined && Math.abs(r.memPercent - 68.8) < 0.2);
});

test('Linux 有 CPU 或内存时视为有用,Windows 空输出则否', () => {
  assert.equal(hasUsefulMetrics(parseProbeOutput(PROC_OUT)), true);
  assert.equal(hasUsefulMetrics(parseProbeOutput('nothing')), false);
  assert.equal(hasUsefulMetrics({ osName: 'Windows', diskPercent: 15 }), false);
});
