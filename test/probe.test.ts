import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeOutput } from '../src/server/probe.ts';

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

test('探针脚本不依赖登录壳语法', async () => {
  const { PROBE_SCRIPT } = await import('../src/server/probe.ts');
  assert.equal(PROBE_SCRIPT.includes('(top'), false);
  assert.equal(PROBE_SCRIPT.includes('nproc'), false);
  assert.equal(PROBE_SCRIPT.includes('free -m'), false);
});
