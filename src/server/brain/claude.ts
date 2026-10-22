import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSdkMcpServer, query, tool, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AsyncQueue } from './queue.js';
import type { BrainAuth } from './auth.js';
import type { Brain, BrainSink } from './types.js';

export type ClaudeBrainOptions = {
  auth: BrainAuth;
  systemPrompt: string;
  dataDir: string;
  /** Session to continue, so the conversation survives restarts. */
  resumeSessionId: string | null;
  onSessionId: (id: string) => void;
  onLog?: (line: string) => void;
};

const TOOL_SERVER = 'companion';
const VOICE_TOOL = `mcp__${TOOL_SERVER}__send_voice`;

const ERROR_MESSAGES: Record<string, string> = {
  authentication_failed: '模型鉴权失败，请检查设置里的 API Key。',
  billing_error: '模型账户余额或计费异常。',
  rate_limit: '模型请求太频繁了，稍等一下再试。',
  overloaded: '模型服务繁忙，稍后再试。',
  model_not_found: '找不到配置的模型，请检查模型名称。',
};

/**
 * The companion's mind, backed by one long-lived Claude Agent SDK session.
 * Runs isolated from the user's own Claude Code setup: no settings, skills,
 * CLAUDE.md or built-in tools — only the companion's own tools.
 */
export class ClaudeBrain implements Brain {
  private input = new AsyncQueue<SDKUserMessage>();
  private session: Query;
  private sink: BrainSink | null = null;
  private turnDone: (() => void) | null = null;
  private pump: Promise<void>;
  private ended = false;
  /** Set by close(): the session ending is expected, not a crash to report. */
  private closing = false;
  /** An API error was already shown for this turn; don't add a generic one. */
  private reportedError = false;
  /** Lost-session is seen in both the error result and the crash that follows; report it once. */
  private reportedLost = false;

  constructor(private options: ClaudeBrainOptions) {
    const workspace = resolve(options.dataDir, 'workspace');
    const configDir = resolve(options.dataDir, 'claude');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });

    const sendVoice = tool('send_voice', '给对方发一条语音消息。text 是要说出口的话（纯口语，不含表情或动作描写）；emotion 是语气，如 温柔、开心、撒娇、委屈、认真。',
      { text: z.string().min(1).max(500), emotion: z.string().max(20).optional() },
      async ({ text, emotion }) => {
        this.sink?.({ type: 'voice', text, emotion: emotion ?? null });
        return { content: [{ type: 'text', text: '语音已发送。' }] };
      });

    this.session = query({
      prompt: this.input,
      options: {
        systemPrompt: options.systemPrompt,
        model: options.auth.model,
        env: { ...options.auth.env, CLAUDE_CONFIG_DIR: configDir },
        cwd: workspace,
        settingSources: [],
        tools: [],
        mcpServers: { [TOOL_SERVER]: createSdkMcpServer({ name: TOOL_SERVER, tools: [sendVoice] }) },
        allowedTools: [VOICE_TOOL],
        permissionMode: 'dontAsk',
        includePartialMessages: true,
        // Chat needs a fast first word, not deep reasoning; thinking added seconds per reply.
        thinking: { type: 'disabled' },
        resume: options.resumeSessionId ?? undefined,
        stderr: line => options.onLog?.(line),
      },
    });
    this.pump = this.consume();
  }

  private async consume() {
    try {
      for await (const message of this.session) this.handle(message);
    } catch (error) {
      if (this.lostSession([(error as Error).message])) this.reportLost();
      else if (!this.closing) {
        this.options.onLog?.(`brain stopped: ${(error as Error).message}`);
        this.sink?.({ type: 'error', code: 'BRAIN_CRASHED', message: '模型进程意外退出了，下一条消息会自动重连。' });
      }
    } finally {
      this.ended = true;
      this.endTurn();
    }
  }

  private handle(message: SDKMessage) {
    if (message.type === 'system' && message.subtype === 'init') {
      this.options.onSessionId(message.session_id);
      return;
    }
    if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
      const event = message.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        this.sink?.({ type: 'text_delta', text: event.delta.text });
      }
      return;
    }
    if (message.type === 'assistant' && message.error) {
      const code = message.error;
      this.reportedError = true;
      this.sink?.({ type: 'error', code: `BRAIN_${code.toUpperCase()}`, message: ERROR_MESSAGES[code] ?? '模型回复失败了。' });
      return;
    }
    if (message.type === 'result') {
      if (message.subtype !== 'success' && this.lostSession(message.errors)) {
        this.reportLost();
      } else if (message.subtype !== 'success') {
        this.options.onLog?.(`turn ended: ${message.subtype}`);
        this.sink?.({ type: 'error', code: `BRAIN_${message.subtype.toUpperCase()}`, message: '这次没能回复完整，换个说法再试试？' });
      } else if (message.is_error && !this.reportedError) {
        this.sink?.({ type: 'error', code: 'BRAIN_ERROR', message: '模型回复失败了。' });
      }
      this.endTurn();
    }
  }

  // The SDK has no reason code for this; its message is the only signal. Only
  // meaningful when we asked to resume, so unrelated errors never match.
  private lostSession(errors: readonly string[]) {
    return Boolean(this.options.resumeSessionId) && errors.some(e => /no conversation found/i.test(e));
  }

  private reportLost() {
    if (this.reportedLost) return;
    this.reportedLost = true;
    this.options.onLog?.('stored session is gone; starting a new one');
    this.sink?.({ type: 'session_lost' });
  }

  private endTurn() {
    const done = this.turnDone;
    this.sink = null;
    this.turnDone = null;
    this.reportedError = false;
    done?.();
  }

  /** True once the session ended, by close() or because the process died. */
  get closed() { return this.ended; }

  reply(text: string, sink: BrainSink): Promise<void> {
    if (this.ended) return Promise.reject(new Error('Brain is closed'));
    if (this.turnDone) return Promise.reject(new Error('A reply is already in progress'));
    return new Promise(resolve => {
      this.sink = sink;
      this.turnDone = resolve;
      this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    });
  }

  async interrupt() {
    if (this.turnDone) await this.session.interrupt();
  }

  async close() {
    this.closing = true;
    this.ended = true;
    this.input.close();
    this.session.close();
    await this.pump;
  }
}
