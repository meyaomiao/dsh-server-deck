/**
 * 远端非交互命令包装。Windows OpenSSH 默认壳是 PowerShell,
 * 用户命令里的 && / || 会被拆掉;与 CIM 探针同款 EncodedCommand。
 * 命令已指定 powershell/pwsh/cmd 时不包装。
 */

import { encodePowerShell } from './probe.ts';

export function looksLikeWindows(osName: string | undefined): boolean {
  return osName !== undefined && /windows/i.test(osName);
}

const SHELL_PREFIX = /^(powershell\.exe|pwsh(?:\.exe)?|cmd(?:\.exe)?)\b/i;

/** 按对端 OS 决定是否包一层 powershell EncodedCommand。 */
export function wrapRemoteCommand(command: string, osName: string | undefined): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) throw new Error('command 不能为空');
  if (!looksLikeWindows(osName)) return trimmed;
  if (SHELL_PREFIX.test(trimmed)) return trimmed;
  const escaped = trimmed.replace(/'/g, "''");
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    "$ErrorActionPreference='Continue'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    `cmd.exe /c '${escaped}'`,
  ].join('\n');
  return [
    'cmd.exe /c',
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy Bypass',
    '-EncodedCommand',
    encodePowerShell(script),
  ].join(' ');
}

export function clampTimeoutMs(raw: number | undefined): number {
  const n = raw === undefined ? 60_000 : Number(raw);
  if (!Number.isFinite(n)) return 60_000;
  return Math.max(1_000, Math.min(300_000, Math.round(n)));
}

const MAX_CAPTURE = 32_768;

export function truncateCapture(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CAPTURE) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_CAPTURE)}\n…[truncated ${String(text.length - MAX_CAPTURE)} chars]`, truncated: true };
}
