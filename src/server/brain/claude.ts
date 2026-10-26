import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSdkMcpServer, query, tool, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AsyncQueue } from './queue.js';
import { parsePartialJson } from '../papers/partial.js';
import { describePaper, editPaperShape, preferencesShape, toBlocks, toTitle, writePaperShape } from '../papers/schema.js';
import type { BrainAuth } from './auth.js';
import type { Brain, BrainSink, PreferencesPatch } from './types.js';
import { VoiceOnce } from './once.js';

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
const PAPER_TOOL = `mcp__${TOOL_SERVER}__write_paper`;
const EDIT_PAPER_TOOL = `mcp__${TOOL_SERVER}__edit_paper`;
const SAVE_PAPER_TOOL = `mcp__${TOOL_SERVER}__save_paper`;
const PREFERENCES_TOOL = `mcp__${TOOL_SERVER}__update_preferences`;
const REST_TOOL = `mcp__${TOOL_SERVER}__rest`;
/** How often a paper still being written is sent on. The pen is slower than the model; finer adds nothing. */
const PAPER_PROGRESS_MS = 150;

const WRITE_PAPER_DESCRIPTION = `把要看清楚的东西写下来，放在舞台上对方面前。写下的东西不会被念出来，对方会看着你一笔一笔写。
什么时候写：一组可以挑的东西（3 个及以上的电影、歌、书、地点）；清单、步骤、计划、菜谱、要做的几件事；一段长对话的总结；对方要你写下来的东西（一封信、一首诗、一段话）；对方告诉你一件对自己很重要的事，你有话想认真回应，一两句口语装不下。
什么时候不写、只说话：闲聊、安慰、回答简单的问题、只推荐一两个（直接说）、对方正在倾诉情绪（先陪着，不要把心事变成一份交付物）。拿不准就只说话。
舞台上同时只放一份：写新的会把上一份换下去（上一份不会丢）。还是同一件事、只是要加几条或改几处，用 edit_paper，不要重写一份。
写之前先用 send_voice 或文字说一两句口语，带一点你自己的看法（比如「如果只看一部，我会选《花样年华》」），说你写下来了（比如「我写下来了，放你面前」），不要说「在这里」「在里面」；不要复述写下的内容。
写法：title 几个字；blocks 从上到下。heading 是小标题（比如「电影」「歌」）；item 是一个条目，name 是名字，note 是一句你的理由，不超过 20 个字，能在网上找到的东西加 link；要办的事（待办、出门带什么）用 check 块，done 填 false；paragraph 是一段话。每组条目最多 5 条，一份不超过约 400 字。
写一封信时主要用 paragraph，写你想对这个人说的话，提到对方说过的事照对方的原意，末尾可以单独一段落上你的名字。清单不落款。
任何字段都不要写 HTML、Markdown 符号、序号或网址。`;

const EDIT_PAPER_DESCRIPTION = `修改你写下的一份：换掉、删掉或加上其中一块。只给出改动，不要重写整份。不填 paperId 就是对方面前那份（对方在 Papers 里打开着的，或者舞台上的）。
blockId 用每一块的 id（写下和修改的结果里都列着）。改之前先用一句口语回应，比如「好，换一首安静点的」。对方说某件事办完了，把那条 check 换成 done: true。
对方说得不明确（比如只说「换一个」）就先问清楚是哪一个，不要猜。对方要整份重写，就说一句「我重新写一份」，然后用 write_paper。`;

const SAVE_PAPER_DESCRIPTION = `对方想留着面前这一份（比如说「留着」「存一下」「收起来」）：把它存进 Papers。存了它还留在舞台上。调用前先用一句口语回应，比如「好，帮你存起来」。`;

const REST_DESCRIPTION = `对方明确要离开、结束这次聊天时用：「晚安」「我要睡了」「拜拜，我去忙了」「先这样，我休息了」。先用一句口语跟对方道别（用 send_voice），再调用这个工具；之后房间会暗下来，等对方回来。
不要用：对方只是提到「拜拜」这个词（比如在讲别人、讲分手、开玩笑）；「我休息一下」「等我五分钟」这种马上回来的；你觉得对方该去睡了但对方没说要走。拿不准就不用，正常聊下去。
这是对方要走，不是你要走：你自己不要提出结束聊天。`;

const PREFERENCES_DESCRIPTION = `对方明确要你改一个习惯时用：「以后用中文跟我说」改 language；「这几天别主动找我」「可以多找我聊」改 initiative。只填对方要改的那一项。
改完用一句口语确认，比如「好，以后跟你说中文」「好，这几天我不主动找你」。对方只是随口一说、没有要你改的意思，就不要用。`;

type Streaming = { tool: string; json: string; paperId?: string; sentAt: number; sent: string };

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
  /** Tool calls being streamed in, by their index in the current message. */
  private streaming = new Map<number, Streaming>();
  /**
   * Voice messages are sent the moment their tool call finishes streaming,
   * not when the handler runs — after a paper that may take ten seconds to
   * write, that would hold her voice back until then. Both sightings claim it
   * here; only the first sends.
   */
  private voiced = new VoiceOnce();
  /**
   * Papers already on the stage from their call streaming in, waiting for
   * their tool handler, in order. A handler can run before the stream gets
   * there — the SDK answers tool calls at once, stream events wait in line —
   * so one that had to start its own paper leaves it in `papersAhead`, for
   * the stream to pick up instead of starting a second.
   */
  private papersStarted: string[] = [];
  private papersAhead: string[] = [];

  constructor(private options: ClaudeBrainOptions) {
    const workspace = resolve(options.dataDir, 'workspace');
    const configDir = resolve(options.dataDir, 'claude');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });

    const sendVoice = tool('send_voice', '给对方发一条语音消息。text 是要说出口的话（纯口语，不含表情或动作描写）；emotion 是语气，如 温柔、开心、撒娇、委屈、认真。',
      { text: z.string().min(1).max(500), emotion: z.string().max(20).optional() },
      async ({ text, emotion }) => {
        if (this.voiced.claim('tool', text)) this.sink?.({ type: 'voice', text, emotion: emotion ?? null });
        return { content: [{ type: 'text', text: '语音已发送。' }] };
      });

    const writePaper = tool('write_paper', WRITE_PAPER_DESCRIPTION, writePaperShape, async ({ title, blocks }) => {
      const started = this.papersStarted.shift();
      const paperId = started ?? this.startPaper();
      if (!started) this.papersAhead.push(paperId);
      const paper = { id: paperId, title: toTitle(title) || '无题', blocks: toBlocks(blocks) };
      this.sink?.({ type: 'paper_done', paperId, title: paper.title, blocks: paper.blocks });
      if (!paper.blocks.length) {
        return { content: [{ type: 'text', text: '没写成：里面没有一块是完整的。不要再试，口头回应就好。' }] };
      }
      return { content: [{ type: 'text', text: `写好了，放在对方面前。\n${describePaper(paper)}\n以后要改它，用 edit_paper，并引用这些 id。` }] };
    });

    const editPaper = tool('edit_paper', EDIT_PAPER_DESCRIPTION, editPaperShape, async ({ paperId, ops }) => {
      const result = await new Promise<string>(respond => {
        if (!this.sink) return respond('现在改不了。');
        this.sink({ type: 'paper_edit', ...(paperId ? { paperId } : {}), ops, respond });
      });
      return { content: [{ type: 'text', text: result }] };
    });

    const savePaper = tool('save_paper', SAVE_PAPER_DESCRIPTION, {}, async () => {
      const result = await new Promise<string>(respond => {
        if (!this.sink) return respond('现在存不了。');
        this.sink({ type: 'paper_save', respond });
      });
      return { content: [{ type: 'text', text: result }] };
    });

    const rest = tool('rest', REST_DESCRIPTION, {}, async () => {
      const result = await new Promise<string>(respond => {
        if (!this.sink) return respond('现在不能休息。');
        this.sink({ type: 'rest', respond });
      });
      return { content: [{ type: 'text', text: result }] };
    });

    const updatePreferences = tool('update_preferences', PREFERENCES_DESCRIPTION, preferencesShape, async ({ language, initiative }) => {
      const patch: PreferencesPatch = { ...(language ? { language } : {}), ...(initiative ? { initiative } : {}) };
      const result = await new Promise<string>(respond => {
        if (!this.sink) return respond('现在改不了。');
        this.sink({ type: 'preferences', patch, respond });
      });
      return { content: [{ type: 'text', text: result }] };
    });

    this.session = query({
      prompt: this.input,
      options: {
        // Render fresh on every request. The SDK otherwise records the prompt at the
        // start of a conversation and ignores later ones on resume, so edits to
        // IDENTITY.md / MEMORY.md and the current time would never reach her.
        systemPrompt: { type: 'custom', prompt: options.systemPrompt, snapshot: false },
        model: options.auth.model,
        env: { ...options.auth.env, CLAUDE_CONFIG_DIR: configDir },
        cwd: workspace,
        settingSources: [],
        tools: [],
        mcpServers: { [TOOL_SERVER]: createSdkMcpServer({ name: TOOL_SERVER, tools: [sendVoice, writePaper, editPaper, savePaper, updatePreferences, rest] }) },
        allowedTools: [VOICE_TOOL, PAPER_TOOL, EDIT_PAPER_TOOL, SAVE_PAPER_TOOL, PREFERENCES_TOOL, REST_TOOL],
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
      this.stream(message.event);
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

  private startPaper(): string {
    const paperId = randomUUID();
    this.sink?.({ type: 'paper_start', paperId });
    return paperId;
  }

  /** What the paper being streamed looks like so far, sent on when it has grown and enough time has passed. */
  private paperProgress(call: Streaming, force: boolean) {
    if (!call.paperId) return;
    const now = Date.now();
    if (!force && now - call.sentAt < PAPER_PROGRESS_MS) return;
    const draft = (parsePartialJson(call.json) ?? {}) as { title?: unknown; blocks?: unknown };
    const progress = { title: toTitle(draft.title), blocks: toBlocks(draft.blocks) };
    const key = JSON.stringify(progress);
    if (key === call.sent) return;
    call.sent = key;
    call.sentAt = now;
    this.sink?.({ type: 'paper_progress', paperId: call.paperId, ...progress });
  }

  /**
   * Stream events from the model. Text goes straight on. Tool calls are read
   * as they are written: a voice message is sent as soon as its call is
   * complete, and a paper is passed along while it is still being written.
   */
  private stream(event: Extract<SDKMessage, { type: 'stream_event' }>['event']) {
    if (event.type === 'message_start') {
      this.streaming.clear();
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      const call: Streaming = { tool: event.content_block.name, json: '', sentAt: 0, sent: '' };
      if (call.tool === PAPER_TOOL) {
        // Its handler already ran and put the paper up: nothing more to stream into it.
        const ahead = this.papersAhead.shift();
        if (!ahead) {
          call.paperId = this.startPaper();
          this.papersStarted.push(call.paperId);
        }
      }
      this.streaming.set(event.index, call);
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        this.sink?.({ type: 'text_delta', text: event.delta.text });
      } else if (event.delta.type === 'input_json_delta') {
        const call = this.streaming.get(event.index);
        if (!call) return;
        call.json += event.delta.partial_json;
        this.paperProgress(call, false);
      }
    } else if (event.type === 'content_block_stop') {
      const call = this.streaming.get(event.index);
      if (!call) return;
      this.streaming.delete(event.index);
      if (call.tool === PAPER_TOOL) this.paperProgress(call, true);
      if (call.tool !== VOICE_TOOL) return;
      try {
        const { text, emotion } = JSON.parse(call.json) as { text?: unknown; emotion?: unknown };
        if (typeof text !== 'string' || !text) return;
        if (this.voiced.claim('stream', text)) this.sink?.({ type: 'voice', text, emotion: typeof emotion === 'string' ? emotion : null });
      } catch {
        // Not valid yet; the tool handler will send it once the SDK has checked it.
      }
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
    // Anything still pending belonged to a turn that is over: an interrupted
    // call never reaches its handler, and must not be matched to the next one.
    this.streaming.clear();
    this.voiced.reset();
    this.papersStarted = [];
    this.papersAhead = [];
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
