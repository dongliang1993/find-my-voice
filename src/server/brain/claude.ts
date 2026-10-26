import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSdkMcpServer, query, tool, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AsyncQueue } from './queue.js';
import { parsePartialJson } from '../letters/partial.js';
import { describeLetter, describeNote, editLetterShape, editNoteShape, preferencesShape, toBlocks, toTitle, writeLetterShape, writeNoteShape } from '../letters/schema.js';
import type { BrainAuth } from './auth.js';
import type { Brain, BrainSink, PreferencesPatch } from './types.js';

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
const LETTER_TOOL = `mcp__${TOOL_SERVER}__write_letter`;
const EDIT_TOOL = `mcp__${TOOL_SERVER}__edit_letter`;
const NOTE_TOOL = `mcp__${TOOL_SERVER}__write_note`;
const EDIT_NOTE_TOOL = `mcp__${TOOL_SERVER}__edit_note`;
const KEEP_NOTE_TOOL = `mcp__${TOOL_SERVER}__keep_note`;
const PREFERENCES_TOOL = `mcp__${TOOL_SERVER}__update_preferences`;
/** How often a letter or note still being written is sent on. The pen is slower than the model; finer adds nothing. */
const LETTER_PROGRESS_MS = 150;

const WRITE_LETTER_DESCRIPTION = `把值得留下的内容写成一封信交给对方。信不会被念出来，对方会在信纸上看你写。
什么时候写信：一组可以挑的东西（3 个及以上的电影、歌、书、地点）；有步骤或结构的内容（计划、菜谱、清单）；对方明确要你写下来的东西（一首诗、一段话、一封信）；对方要你总结一段长对话。
什么时候不写、只说话：闲聊、安慰、回答简单的问题、只推荐一个、不到 3 条或很短的内容、对方正在倾诉情绪。拿不准就只说话。
写信时：先用 send_voice 或文字说一两句口语，带一点你自己的看法（比如「如果只看一部，我会选《花样年华》」），明确说你写了一封信、放进了信箱（比如「我写了封信给你，在信箱里」），不要说「在这里」「在里面」；不要复述信的内容。然后再调用这个工具。
信的写法：title 是几个字的标题；blocks 从上到下，paragraph 是一段话，heading 是小标题（比如「电影」「歌」），item 是一个条目（name 是名字，note 是一句你的理由，不超过 20 个字，可以加 link 让对方点开去找）。每组条目最多 5 条，整封信不超过约 400 字。
任何字段都不要写 HTML、Markdown 符号、序号或网址。`;

const EDIT_LETTER_DESCRIPTION = `修改一封已经交给对方、对方也看过的信：换掉、删掉或加上其中一块。只给出改动，不要重写整封。
blockId 用这封信每一块的 id（写信和改信的结果里都列着）。改之前先用一句口语回应，比如「好，换一首安静点的」。
对方说得不明确（比如只说「换一个」）就先问清楚是哪一个，不要猜。对方要整封重写，就说一句「我重新写一封」，然后用 write_letter 写一封新的。`;

const WRITE_NOTE_DESCRIPTION = `把当下要用的内容写成一张便签，摆在舞台旁边。便签比信轻：看完就收走；对方想留着，会收进信箱。
什么时候写便签：清单、步骤、安排、三五条要做的事，这种当下用一下的内容。
什么时候写信、不写便签：值得留下的东西（要收藏的推荐、对方要你写下来的话）用 write_letter。
便签同时只有一张。已经有一张时：还是同一件事，就接着往下写（或者用 edit_note 改）；换了一个新话题，就填 fresh: true，擦掉重写——旧的内容对话里还留着。
写法和信一样：title 几个字（比如「今天要做的事」），blocks 从上到下，item 的 name 是条目、note 是一句话说明。
要办的事（todo、待办、出门带什么、今天做哪几件事）用 check 块：text 是这件事，done 填 false；对方做完一件会自己勾上。对方说某一件办完了，用 edit_note 把那块换成 done: true。
写的时候先说一句口语，明确说你写在了一张小便签上（比如「我写在一张小便签上了，放你旁边」），不要说「在这里」「在里面」。
便签要短，几行就够。任何字段都不要写 HTML、Markdown 符号、序号或网址。`;

const EDIT_NOTE_DESCRIPTION = `修改桌上那张便签：换掉、删掉或加上其中一块。只给出改动，不要重写整张。
blockId 用便签每一块的 id（写便签的结果里列着）。便签很轻，改一两句就行，不要当成信来改。`;

const KEEP_NOTE_DESCRIPTION = `对方想留着桌上那张便签（比如说「留着」「收起来」「帮我存一下」）：你在末尾签上名，它就变成一封信收进信箱。调用前先用一句口语回应，比如「好，我签个名收进信箱」。`;

const PREFERENCES_DESCRIPTION = `对方明确要你改一个习惯时用：「以后用中文跟我说」改 language；「这几天别主动找我」「可以多找我聊」改 initiative。只填对方要改的那一项。
改完用一句口语确认，比如「好，以后跟你说中文」「好，这几天我不主动找你」。对方只是随口一说、没有要你改的意思，就不要用。`;

type Streaming = { tool: string; json: string; letterId?: string; noteId?: string; sentAt: number; sent: string };

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
   * Voice messages already sent the moment their tool call finished streaming.
   * The tool handler only runs once the whole message is done — after a letter
   * that may take ten seconds to write — so waiting for it would hold her
   * voice back until then. The handler finds its text here and does nothing.
   */
  private voicedEarly: string[] = [];
  /** Letters whose envelope is already out, waiting for their tool handler, in order. */
  private lettersStarted: string[] = [];
  /** The note whose card is already up, waiting for its tool handler. At most one. */
  private notesStarted: string[] = [];

  constructor(private options: ClaudeBrainOptions) {
    const workspace = resolve(options.dataDir, 'workspace');
    const configDir = resolve(options.dataDir, 'claude');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });

    const sendVoice = tool('send_voice', '给对方发一条语音消息。text 是要说出口的话（纯口语，不含表情或动作描写）；emotion 是语气，如 温柔、开心、撒娇、委屈、认真。',
      { text: z.string().min(1).max(500), emotion: z.string().max(20).optional() },
      async ({ text, emotion }) => {
        const early = this.voicedEarly.indexOf(text);
        if (early >= 0) this.voicedEarly.splice(early, 1);
        else this.sink?.({ type: 'voice', text, emotion: emotion ?? null });
        return { content: [{ type: 'text', text: '语音已发送。' }] };
      });

    const writeLetter = tool('write_letter', WRITE_LETTER_DESCRIPTION, writeLetterShape, async ({ title, blocks }) => {
      // Normally the envelope went out as the call started streaming; if it did
      // not (no stream events), it goes out now.
      const letterId = this.lettersStarted.shift() ?? this.startLetter();
      const letter = { id: letterId, title: toTitle(title) || '无题', blocks: toBlocks(blocks) };
      this.sink?.({ type: 'letter_done', letterId, title: letter.title, blocks: letter.blocks });
      if (!letter.blocks.length) {
        return { content: [{ type: 'text', text: '这封信没写成：里面没有一块是完整的。不要再试，口头回应就好。' }] };
      }
      return { content: [{ type: 'text', text: `信已经交给对方了。\n${describeLetter(letter)}\n以后要改这封信，用 edit_letter，并引用这些 id。` }] };
    });

    const editLetter = tool('edit_letter', EDIT_LETTER_DESCRIPTION, editLetterShape, async ({ letterId, ops }) => {
      const result = await new Promise<string>(respond => {
        if (!this.sink) return respond('现在改不了这封信。');
        this.sink({ type: 'letter_edit', letterId, ops, respond });
      });
      return { content: [{ type: 'text', text: result }] };
    });

    const writeNote = tool('write_note', WRITE_NOTE_DESCRIPTION, writeNoteShape, async ({ title, blocks, fresh }) => {
      // As with a letter: the card went up as the call started streaming; if it
      // did not, it goes up now. Whether this is a new note or lines added to
      // the one already there is the chat layer's to decide.
      const noteId = this.notesStarted.shift() ?? this.startNote();
      const note = { id: noteId, title: toTitle(title) || '便签', blocks: toBlocks(blocks) };
      this.sink?.({ type: 'note_done', noteId, title: note.title, blocks: note.blocks, fresh: fresh === true });
      if (!note.blocks.length) {
        return { content: [{ type: 'text', text: '这张便签没写成：里面没有一块是完整的。不要再试，口头回应就好。' }] };
      }
      return { content: [{ type: 'text', text: `便签放在对方手边了。\n${describeNote(note)}\n以后要改它，用 edit_note，并引用这些 id。` }] };
    });

    const editNote = tool('edit_note', EDIT_NOTE_DESCRIPTION, editNoteShape, async ({ ops }) => {
      const result = await new Promise<string>(respond => {
        if (!this.sink) return respond('现在改不了这张便签。');
        this.sink({ type: 'note_edit', ops, respond });
      });
      return { content: [{ type: 'text', text: result }] };
    });

    const keepNote = tool('keep_note', KEEP_NOTE_DESCRIPTION, {}, async () => {
      const result = await new Promise<string>(respond => {
        if (!this.sink) return respond('现在收不了这张便签。');
        this.sink({ type: 'note_keep', respond });
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
        mcpServers: { [TOOL_SERVER]: createSdkMcpServer({ name: TOOL_SERVER, tools: [sendVoice, writeLetter, editLetter, writeNote, editNote, keepNote, updatePreferences] }) },
        allowedTools: [VOICE_TOOL, LETTER_TOOL, EDIT_TOOL, NOTE_TOOL, EDIT_NOTE_TOOL, KEEP_NOTE_TOOL, PREFERENCES_TOOL],
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

  private startLetter(): string {
    const letterId = randomUUID();
    this.sink?.({ type: 'letter_start', letterId });
    return letterId;
  }

  private startNote(): string {
    // A note already streaming in this turn: another card going up for it
    // would double it. The one already up takes what comes.
    if (this.notesStarted.length) return this.notesStarted[0]!;
    const noteId = randomUUID();
    this.sink?.({ type: 'note_start', noteId });
    this.notesStarted.push(noteId);
    return noteId;
  }

  /** What the letter being streamed looks like so far, sent on when it has grown and enough time has passed. */
  private letterProgress(call: Streaming, force: boolean) {
    if (!call.letterId) return;
    const now = Date.now();
    if (!force && now - call.sentAt < LETTER_PROGRESS_MS) return;
    const draft = (parsePartialJson(call.json) ?? {}) as { title?: unknown; blocks?: unknown };
    const progress = { title: toTitle(draft.title), blocks: toBlocks(draft.blocks) };
    const key = JSON.stringify(progress);
    if (key === call.sent) return;
    call.sent = key;
    call.sentAt = now;
    this.sink?.({ type: 'letter_progress', letterId: call.letterId, ...progress });
  }

  /** The same, for the note being streamed. */
  private noteProgress(call: Streaming, force: boolean) {
    if (!call.noteId) return;
    const now = Date.now();
    if (!force && now - call.sentAt < LETTER_PROGRESS_MS) return;
    const draft = (parsePartialJson(call.json) ?? {}) as { title?: unknown; blocks?: unknown; fresh?: unknown };
    const progress = { title: toTitle(draft.title), blocks: toBlocks(draft.blocks), fresh: draft.fresh === true };
    const key = JSON.stringify(progress);
    if (key === call.sent) return;
    call.sent = key;
    call.sentAt = now;
    this.sink?.({ type: 'note_progress', noteId: call.noteId, ...progress });
  }

  /**
   * Stream events from the model. Text goes straight on. Tool calls are read
   * as they are written: a voice message is sent as soon as its call is
   * complete, and a letter is passed along while it is still being written.
   */
  private stream(event: Extract<SDKMessage, { type: 'stream_event' }>['event']) {
    if (event.type === 'message_start') {
      this.streaming.clear();
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      const call: Streaming = { tool: event.content_block.name, json: '', sentAt: 0, sent: '' };
      if (call.tool === LETTER_TOOL) {
        call.letterId = this.startLetter();
        this.lettersStarted.push(call.letterId);
      } else if (call.tool === NOTE_TOOL) {
        call.noteId = this.startNote();
      }
      this.streaming.set(event.index, call);
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        this.sink?.({ type: 'text_delta', text: event.delta.text });
      } else if (event.delta.type === 'input_json_delta') {
        const call = this.streaming.get(event.index);
        if (!call) return;
        call.json += event.delta.partial_json;
        this.letterProgress(call, false);
        this.noteProgress(call, false);
      }
    } else if (event.type === 'content_block_stop') {
      const call = this.streaming.get(event.index);
      if (!call) return;
      this.streaming.delete(event.index);
      if (call.tool === LETTER_TOOL) this.letterProgress(call, true);
      if (call.tool === NOTE_TOOL) this.noteProgress(call, true);
      if (call.tool !== VOICE_TOOL) return;
      try {
        const { text, emotion } = JSON.parse(call.json) as { text?: unknown; emotion?: unknown };
        if (typeof text !== 'string' || !text) return;
        this.voicedEarly.push(text);
        this.sink?.({ type: 'voice', text, emotion: typeof emotion === 'string' ? emotion : null });
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
    this.voicedEarly = [];
    this.lettersStarted = [];
    this.notesStarted = [];
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
