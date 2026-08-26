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
