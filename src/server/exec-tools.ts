/**
 * 对话侧工具:列出台账主机 + 非交互 SSH 下发。
 * 不走卡片 xterm,不暴露浏览器 REST。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { HostEntry } from '../types.ts';
import type { HostPool } from './pool.ts';
import type { MetricRecorder } from './recorder.ts';
import type { HostStore } from './store.ts';
import { resolveHost, type HostPick } from './resolve-host.ts';
import { clampTimeoutMs, truncateCapture, wrapRemoteCommand } from './wrap-command.ts';

function toPick(h: HostEntry): HostPick {
  return { id: h.id, name: h.name, host: h.host, port: h.port, username: h.username, tags: h.tags };
}

export function registerExecTools(
  ctx: { tools: { register: (tool: unknown) => unknown }; systemPrompt: { section: (spec: { name: string; order: number; text: string }) => unknown } },
  store: HostStore,
  pool: HostPool,
  recorder: MetricRecorder,
): void {
  ctx.systemPrompt.section({
    name: 'tool:server_deck',
    order: 125,
    text: [
      'Use server_deck_hosts then server_deck_exec to run a non-interactive command on a host from the Server Deck ledger (same SSH as the card terminal, not the open xterm).',
      'Identify the machine with id / name / IP. On Windows OpenSSH, commands are wrapped for PowerShell DefaultShell; prefix cmd.exe / powershell.exe if you need a specific interpreter.',
      'Do not use these tools for interactive sudo/password prompts — tell the user to open the card terminal.',
    ].join(' '),
  });

  ctx.tools.register(
    defineTool({
      name: 'server_deck_hosts',
      description:
        'List Server Deck ledger hosts (id, name, address, username, tags, last probed OS). No secrets.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hosts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  host: { type: 'string', required: true },
                  port: { type: 'integer', required: true },
                  username: { type: 'string', required: true },
                  tags: { type: 'array', items: { type: 'string' } },
                  osName: { type: 'string' },
                  state: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = value.hosts.map((h) => {
            const tag = h.tags !== undefined && h.tags.length > 0 ? ` [${h.tags.join(',')}]` : '';
            const os = h.osName !== undefined ? ` ${h.osName}` : '';
            const st = h.state !== undefined ? ` ${h.state}` : '';
            return `- ${h.name} \`${h.id}\` ${h.username}@${h.host}:${String(h.port)}${os}${st}${tag}`;
          });
          return [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : '台账为空' }];
        },
      },
      isConcurrencySafe: () => true,
      async execute() {
        const statuses = recorder.latestStatuses();
        const hosts = store.list().map((h) => {
          const st = statuses.find((s) => s.id === h.id);
          return {
            id: h.id,
            name: h.name,
            host: h.host,
            port: h.port,
            username: h.username,
            tags: h.tags,
            osName: st?.osName,
            state: st?.state,
          };
        });
        return { hosts };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'server_deck_exec',
      description:
        'Run one non-interactive command on a Server Deck host over SSH. Returns exit code, stdout and stderr. Not the card xterm; no secrets in the result.',
      parameters: {
        host: {
          type: 'string',
          required: true,
          description: 'Host id, display name, IP, user@host, or unique substring.',
        },
        command: {
          type: 'string',
          required: true,
          description: 'Command to run. Windows DefaultShell is PowerShell; prefix cmd.exe / powershell.exe to skip wrapping.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Timeout in milliseconds (1000–300000). Default 60000.',
        },
      },
      timeoutMs: 310_000,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hostId: { type: 'string', required: true },
            name: { type: 'string', required: true },
            command: { type: 'string', required: true },
            wrapped: { type: 'boolean', required: true },
            code: { type: 'integer' },
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            timedOut: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => {
          const code = value.code === undefined ? 'timeout' : String(value.code);
          const head = `${value.name} (${value.hostId}) exit ${code}${value.timedOut ? ' timed out' : ''}`;
          const body = [value.stdout, value.stderr].filter((s) => s.length > 0).join('\n');
          return [{ type: 'text', text: body.length > 0 ? `${head}\n${body}` : head }];
        },
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const command = args.command.trim();
        if (command.length === 0) throw new Error('command 不能为空');
        const resolved = resolveHost(store.list().map(toPick), args.host);
        if (!resolved.ok) throw new Error(resolved.error);
        const osName = recorder.latestStatuses().find((s) => s.id === resolved.host.id)?.osName;
        const wrappedCmd = wrapRemoteCommand(command, osName);
        const timeoutMs = clampTimeoutMs(args.timeout_ms);
        const result = await pool.exec(resolved.host.id, wrappedCmd, timeoutMs);
        const out = truncateCapture(result.stdout);
        const err = truncateCapture(result.stderr);
        return {
          hostId: resolved.host.id,
          name: resolved.host.name,
          command,
          wrapped: wrappedCmd !== command,
          code: result.code === null ? undefined : result.code,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          timedOut: result.code === null,
        };
      },
    }),
  );
}
