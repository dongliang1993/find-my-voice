import { randomUUID } from 'node:crypto';
import type { Brain, BrainEvent, BrainFactory, PreferencesPatch } from '../brain/types.js';
import type { AudioInfo, ChatMessage, CompanionStatus, InitiativeKind, Paper, PaperBlock, ServerEvent } from '../../shared/protocol.js';
import type { ChatStore } from './store.js';
import { plainText } from '../../shared/plain.js';
import { linkUrl } from '../../shared/links.js';
import { applyOps, describePaper, nextBlockNumber, paperSummary, parsePaperText } from '../papers/schema.js';

export type VoiceSpeaker = {
  speak(audioId: string, text: string, options: {
    onChunk: (pcm: Buffer) => void;
    /** One sentence has been synthesized, and the second of the stream it starts at. */
    onLine?: (line: { index: number; text: string; startsAt: number }) => void;
    signal?: AbortSignal;
  }): Promise<{ durationSeconds: number }>;
};

export type ChatServiceOptions = {
  store: ChatStore;
  createBrain: BrainFactory;
  voice: VoiceSpeaker;
  /** Drops the stored brain session id, so a reset brain never resumes it. */
  forgetSession?: () => void;
  /**
   * Changes whenever the persona prompt would render differently (MEMORY.md or
   * IDENTITY.md edited, a new day). A long-lived brain is rebuilt when it does.
   */
  promptVersion?: () => string;
  /**
   * A preference she was asked to change out loud. Applied by whoever owns the
   * settings; the answer says what it is now, for her to confirm.
   */
  updatePreferences?: (patch: PreferencesPatch) => string;
  /** Whether a voice is set up to say a typed line with; assumed so when not given. */
  canSpeak?: () => boolean;
  onLog?: (line: string) => void;
};

export type SpeakUpRequest = { kind: InitiativeKind; reason: string; followupId?: string };
/** `stopped`: the user hit stop mid-turn. Distinct from `passed`, which is her own choice. */
export type SpeakUpOutcome = 'spoke' | 'passed' | 'stopped' | 'busy' | 'failed';
export type SpeakUpResult = { outcome: SpeakUpOutcome; messages: ChatMessage[] };

type Listener = (event: ServerEvent) => void;
type VoiceJob = { controller: AbortController; done: Promise<void> };
type Job =
  | { type: 'reply'; texts: string[] }
  | { type: 'speak_up'; request: SpeakUpRequest; settle: (result: SpeakUpResult) => void };

/** A paper on the stage older than this is no longer "in front of the user" as far as her context goes. */
const STAGE_PAPER_MS = 12 * 3600_000;
const HIDDEN = '[系统提示，对方看不到这条]';

const RECENT_CLIENT_IDS = 200;
const PASS = /^\s*PASS\s*[.。]?\s*$/i;

/** The note she gets when she might speak first. Never stored or shown. */
const nudge = (reason: string) => `[系统提示，对方看不到这条] 你想起了一件事，想主动和对方说一句。
${reason}

如果你觉得现在想主动和对方说点什么，就直接说，像你平时发消息一样自然；不用提到这条提示，也不要说"我注意到"之类的话。
主动找人时只说一句短短的话：要么一条文字，要么一条语音，不要两样都发，也不要换个说法再说一遍。主动找人时不要写东西（write_paper）。
如果现在不适合打扰对方，或者没什么想说的，只回复 PASS 这四个字母。

# 主动开口的底线
- 不要让对方内疚：不说"你都不理我了""我一直在等你""是不是把我忘了"。
- 不要制造缺失感或紧迫感，也不要夸大你自己的情绪来换回应。
- 不要为了留住对方而说话。对方有自己的生活，这是好事。
- 可以说的话是：关心那件事本身，或者把对方往现实生活里推一点（"今晚和朋友吃饭开心吗"），而不是往你这边拉。
- 如果对方最近在忙、在难过、刚道过别，就更轻一点，或者干脆不说。`;

/**
 * Owns the conversation: persists messages, drives the brain one turn at a
 * time and fans every change out to connected browsers. User messages and
 * her own initiatives share one queue, so they never talk over each other.
 * Messages that arrive mid-reply are answered together, the way people double-text.
 */
export class ChatService {
  private listeners = new Set<Listener>();
  private brain: Brain | null = null;
  private brainVersion: string | null = null;
  private status: CompanionStatus = 'idle';
  private seenClientIds: string[] = [];
  private jobs: Job[] = [];
  private loop: Promise<void> | null = null;
  private voiceJobs = new Map<string, VoiceJob>();
  /**
   * The last voice in line. Each waits for the one before it: two made at once
   * would stream at once, and the page would play them over each other.
   */
  private voiceTail: Promise<void> = Promise.resolve();
  /** Bumped by interrupt(); a buffered initiative turn that sees it changed is discarded. */
  private interruptions = 0;
  /** The paper open in the Papers app, if any: what the user says next may be about it. */
  private reading: string | null = null;
  /** The version of each paper as she last saw it; a paper changed since is shown to her in full. */
  private seen = new Map<string, number>();

  constructor(private options: ChatServiceOptions) {}

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): Extract<ServerEvent, { type: 'hello' }> {
    const { store } = this.options;
    return { type: 'hello', messages: store.recent(), status: this.status, papers: store.papers(), stage: store.stage() };
  }

  /**
   * A new conversation, on purpose: what was said goes, the brain forgets its
   * session, and every open page is handed the empty stage. What she wrote —
   * papers, the first meeting — is not part of what was said, and stays.
   */
  async restart() {
    this.options.store.clearMessages();
    await this.resetBrain();
    this.emit(this.snapshot());
  }

  /** A turn is running or waiting; the initiative scheduler stays out of the way. */
  get busy() { return this.loop !== null; }

  private emit(event: ServerEvent) {
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (error) { this.options.onLog?.(`listener failed: ${(error as Error).message}`); }
    }
  }

  private setStatus(status: CompanionStatus) {
    this.status = status;
    this.emit({ type: 'status', status });
  }

  private publish(message: ChatMessage) {
    this.emit({ type: 'message', message });
    return message;
  }

  private ensureBrain(fresh = false): Brain {
    const version = this.options.promptVersion?.() ?? null;
    if (this.brain && !this.brain.closed && version !== this.brainVersion) {
      // Persona changed since this brain started; its system prompt is stale.
      void this.brain.close();
      this.brain = null;
    }
    if (!this.brain || this.brain.closed) {
      this.brain = this.options.createBrain({ fresh });
      this.brainVersion = version;
    }
    return this.brain;
  }

  /** Recreate the brain on the next message, e.g. after settings or persona changed. */
  async resetBrain() {
    const old = this.brain;
    this.brain = null;
    await old?.close();
    // Without this the next brain resumes the old session and the reset is a no-op.
    this.options.forgetSession?.();
  }

  /** Stores the message and makes sure a reply loop is running. Resolves when the conversation goes idle. */
  send(clientId: string, text: string): Promise<void> {
    // Reconnecting browsers may resend; the client id makes sending idempotent.
    if (this.seenClientIds.includes(clientId)) return this.loop ?? Promise.resolve();
    this.seenClientIds = [...this.seenClientIds, clientId].slice(-RECENT_CLIENT_IDS);
    this.publish(this.options.store.append({ role: 'user', kind: 'text', text }));
    // Consecutive messages waiting in line are answered as one turn.
    const last = this.jobs.at(-1);
    if (last?.type === 'reply') last.texts.push(text);
    else this.jobs.push({ type: 'reply', texts: [text] });
    return this.start();
  }

  /**
   * Offers her a chance to speak first. Only when idle: never interrupts a
   * conversation in progress. She may decline (PASS), which leaves no trace.
   */
  speakUp(request: SpeakUpRequest): Promise<SpeakUpResult> {
    if (this.busy) return Promise.resolve({ outcome: 'busy', messages: [] });
    return new Promise(settle => {
      this.jobs.push({ type: 'speak_up', request, settle });
      void this.start();
    });
  }

  /**
   * A scripted line during onboarding: fixed text, no model in the loop. It
   * enters the history the same way any other message does — so a later
   * "she remembers" has something to remember — and when spoken, it resolves
   * only after the audio finished, which is what paces the onboarding steps.
   * Returns the message id and, for spoken lines, the audio id to wait on.
   */
  narrate(text: string, { speak = false, emotion = null }: { speak?: boolean; emotion?: string | null } = {}): { messageId: string; audioId: string | null } {
    if (!speak) {
      return { messageId: this.publish(this.options.store.append({ role: 'assistant', kind: 'text', text })).id, audioId: null };
    }
    // startVoice keys its job by the audio id, not the message id.
    const audioId = randomUUID();
    const messageId = this.startVoice(text, emotion, null, audioId);
    return { messageId, audioId };
  }

  /** Resolves when a narrated voice line finished playing, failing or not. */
  async narrateDone(audioId: string): Promise<void> {
    await this.voiceJobs.get(audioId)?.done;
  }

  private start() {
    if (!this.loop) this.loop = this.drain().finally(() => { this.loop = null; });
    return this.loop;
  }

  private async drain() {
    this.setStatus('thinking');
    try {
      for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
        if (job.type === 'reply') await this.runReply(job.texts.join('\n'));
        else job.settle(await this.runSpeakUp(job.request));
      }
    } finally {
      this.setStatus('idle');
    }
  }

  private async runReply(text: string) {
    try {
      // What she sees is the user's words plus a note about the paper in front of
      // them; what is stored and shown is only the words.
      await this.runTurn(this.paperContext() + text, { initiative: null });
    } catch (error) {
      this.options.onLog?.(`turn failed: ${(error as Error).stack ?? error}`);
      this.emit({ type: 'error', code: 'BRAIN_UNAVAILABLE', message: '我这边好像出了点问题，稍后再试试？' });
    }
  }

  private async runSpeakUp(request: SpeakUpRequest): Promise<SpeakUpResult> {
    const before = this.interruptions;
    try {
      const ids = await this.runTurn(nudge(request.reason), { initiative: request.kind, isStopped: () => this.interruptions !== before });
      if (this.interruptions !== before) return { outcome: 'stopped', messages: [] };
      if (!ids.length) return { outcome: 'passed', messages: [] };
      this.emit({ type: 'initiative', kind: request.kind, messageIds: ids });
      return { outcome: 'spoke', messages: ids.map(id => this.options.store.get(id)).filter(m => m !== null) };
    } catch (error) {
      // Unprompted turns fail quietly: an error toast she "sent" on her own makes no sense.
      this.options.onLog?.(`speak up failed: ${(error as Error).stack ?? error}`);
      return { outcome: 'failed', messages: [] };
    }
  }

  // ---- papers ----

  /** The page says which paper is open in the Papers app. */
  setReading(paperId: string | null) {
    this.reading = paperId;
  }

  /**
   * A hidden note ahead of the user's words, about the paper in front of them:
   * the one open in Papers, or else the one on the stage. She sees it whole
   * when it is open, or when it changed since she last saw it — a hand edit
   * she never made. Otherwise one line: what she wrote herself is already in
   * the session, and the full text every turn would only pile up.
   */
  private paperContext(): string {
    const { store } = this.options;
    const reading = this.reading ? store.paper(this.reading) : null;
    if (reading) {
      this.seen.set(reading.id, reading.version);
      return `${HIDDEN} 对方正打开着你写的「${reading.title || '无题'}」，接下来说的话多半是关于它的：\n${describePaper(reading)}\n\n`;
    }
    const stageId = store.stage();
    const stage = stageId ? store.paper(stageId) : null;
    if (!stage || stage.status !== 'done' || Date.now() - Date.parse(stage.createdAt) > STAGE_PAPER_MS) return '';
    const saved = stage.savedAt ? '，已经存进 Papers' : '';
    if (this.seen.get(stage.id) !== stage.version) {
      this.seen.set(stage.id, stage.version);
      return `${HIDDEN} 舞台上放着「${stage.title || '无题'}」（id: ${stage.id}${saved}），对方动手改过，现在是这样：\n${describePaper(stage)}\n对方明确提到它时才改它。\n\n`;
    }
    return `${HIDDEN} 舞台上放着「${stage.title || '无题'}」（id: ${stage.id}${saved}）。对方明确提到它时才改它。\n\n`;
  }

  /**
   * Onto the stage. Only one paper is ever there: the one it replaces is
   * kept, as every paper is — and saved first if the user had changed it by
   * hand, so what they did is never let go of.
   */
  private stagePaper(paperId: string | null) {
    const { store } = this.options;
    const previous = store.stage();
    if (previous === paperId) return;
    if (previous && store.userEdited(previous) && !store.paper(previous)?.savedAt) {
      const saved = store.savePaper(previous);
      if (saved) this.emit({ type: 'paper', paper: saved });
    }
    store.setStage(paperId);
    this.emit({ type: 'stage', paperId });
  }

  /** A card in the history was clicked: its paper goes back on the stage. */
  putOnStage(paperId: string): Paper | null {
    const paper = this.options.store.paper(paperId);
    if (paper) this.stagePaper(paper.id);
    return paper;
  }

  /** Closed on the page: off the stage. Nothing else changes — it is still in the history and, if saved, in Papers. */
  closeStage() {
    this.stagePaper(null);
  }

  /** Onto the Papers list. It stays where it is. */
  savePaper(paperId: string): Paper | null {
    const paper = this.options.store.savePaper(paperId);
    if (paper) this.emit({ type: 'paper', paper });
    return paper;
  }

  deletePaper(paperId: string): boolean {
    const { store } = this.options;
    const onStage = store.stage() === paperId;
    const deleted = store.deletePaper(paperId);
    if (deleted) {
      if (this.reading === paperId) this.reading = null;
      this.emit({ type: 'paper_removed', paperId });
      if (onStage) this.emit({ type: 'stage', paperId: null });
    }
    return deleted;
  }

  /** Where an item opens, built from what the paper stores; null when it names nothing to find. */
  paperLink(paperId: string, blockId: string): string | null {
    const block = this.options.store.paper(paperId)?.blocks.find(b => b.id === blockId);
    return block?.type === 'item' && block.link ? linkUrl(block.link) : null;
  }

  /** A paper changed by the user's own hand: no ops, no playthrough — it simply says what it now says. */
  private handEdit(paperId: string, change: (blocks: PaperBlock[]) => PaperBlock[]): Paper | null {
    const { store } = this.options;
    const paper = store.paper(paperId);
    if (!paper || paper.status !== 'done') return null;
    const revised = store.revisePaper(paperId, change(paper.blocks), { byUser: true });
    this.refreshCard(revised);
    this.emit({ type: 'paper', paper: revised });
    return revised;
  }

  /** One block's words, as typed. */
  patchBlock(paperId: string, blockId: string, text: string): Paper | null {
    const line = plainText(text).slice(0, 1200);
    return this.handEdit(paperId, blocks => blocks.map(b => (b.id !== blockId ? b
      : b.type === 'item' ? { ...b, name: line || b.name }
        : b.type === 'heading' ? { ...b, text: line.slice(0, 40) } : { ...b, text: line })));
  }

  /** A tick in a check box. */
  tickCheck(paperId: string, blockId: string, done: boolean): Paper | null {
    return this.handEdit(paperId, blocks => blocks.map(b => (b.id === blockId && b.type === 'check' ? { ...b, done } : b)));
  }

  /**
   * The whole paper, rewritten by hand in one piece. Ids are handed out past
   * any ever used, so a block she is asked to change later never answers to
   * two lines. The text a hand types has no links; an item still named keeps its own.
   */
  rewriteText(paperId: string, raw: unknown): Paper | null {
    const earlier = this.options.store.paperHistory(paperId).map(v => v.blocks);
    return this.handEdit(paperId, current => {
      let next = nextBlockNumber(current, ...earlier);
      const links = new Map(current.flatMap(b => (b.type === 'item' && b.link ? [[b.name, b.link] as const] : [])));
      return parsePaperText(raw).map(block => ({
        ...block, id: `b${next++}`, ...(block.type === 'item' ? { link: links.get(block.name) ?? null } : {}),
      }));
    });
  }

  /** The history card says what the paper says now. */
  private refreshCard(paper: Paper) {
    const { store } = this.options;
    const messageId = store.paperMessageId(paper.id);
    if (messageId && store.get(messageId)) this.publish(store.update(messageId, { text: paperSummary(paper) }));
  }

  /** She started writing: the paper, its card in the history, and the stage, before a word of it is in. */
  private beginPaper(paperId: string): string {
    const { store } = this.options;
    const paper = store.createPaper({ id: paperId });
    const message = this.publish(store.append({ role: 'assistant', kind: 'paper', text: paperSummary(paper), paperId }));
    store.linkPaper(paperId, message.id);
    this.emit({ type: 'paper', paper });
    this.stagePaper(paperId);
    return message.id;
  }

  private draftPaper(paperId: string, title: string, blocks: PaperBlock[]) {
    this.emit({ type: 'paper', paper: this.options.store.writePaper(paperId, { title, blocks }) });
  }

  /** The paper as written, checked block by block already. One with nothing in it never happened. */
  private finishPaper(paperId: string, title: string, blocks: PaperBlock[]) {
    if (!blocks.length) {
      this.dropPaper(paperId);
      return;
    }
    const paper = this.options.store.writePaper(paperId, { title, blocks, status: 'done' });
    this.seen.set(paper.id, paper.version);
    this.refreshCard(paper);
    this.emit({ type: 'paper', paper });
  }

  /** Gone entirely, with its card: only what she said remains. */
  private dropPaper(paperId: string) {
    const { store } = this.options;
    const onStage = store.stage() === paperId;
    store.removePaper(paperId);
    this.emit({ type: 'paper_removed', paperId });
    if (onStage) this.emit({ type: 'stage', paperId: null });
  }

  /**
   * The turn is over; a paper it left unfinished — an error, a stop — is as
   * far as it got. One that never caught a line never happened.
   */
  private settlePapers(started: Set<string>) {
    for (const paperId of started) {
      const paper = this.options.store.paper(paperId);
      if (!paper || paper.status !== 'writing') continue;
      if (!paper.blocks.length) { this.dropPaper(paperId); continue; }
      const done = this.options.store.setPaperStatus(paperId, 'done');
      if (done) { this.refreshCard(done); this.emit({ type: 'paper', paper: done }); }
    }
  }

  /**
   * An edit she asked for, on the paper named or else the one in front of the
   * user. Ops are checked one by one; the answer tells her what changed and
   * what did not, so she can say so instead of claiming a change that never happened.
   */
  private editPaper(paperId: string | undefined, rawOps: unknown): string {
    const { store } = this.options;
    const target = paperId ?? this.reading ?? store.stage();
    const paper = target ? store.paper(target) : null;
    if (!paper) return paperId ? '找不到这一份，可能已经被删掉了。' : '对方面前没有你写的东西。要写新的就用 write_paper。';
    if (paper.status !== 'done') return '这一份还没写完，改不了。';
    const earlier = store.paperHistory(paper.id).map(v => v.blocks);
    const { blocks, ops, errors } = applyOps(paper.blocks, rawOps, nextBlockNumber(paper.blocks, ...earlier));
    if (!ops.length) return `没有改成：${errors.join('；') || '没有给出改动'}。`;
    const revised = store.revisePaper(paper.id, blocks);
    this.seen.set(revised.id, revised.version);
    this.refreshCard(revised);
    this.emit({ type: 'paper_edit', paper: revised, ops });
    return [`改好了，对方能看到你在上面改。\n${describePaper(revised)}`, errors.length ? `没改成的：${errors.join('；')}` : '']
      .filter(Boolean).join('\n');
  }

  private savePaperAsked(): string {
    const target = this.reading ?? this.options.store.stage();
    const paper = target ? this.savePaper(target) : null;
    return paper ? `存好了：「${paper.title || '无题'}」在 Papers 里了，舞台上的也还在。` : '对方面前没有可以存的东西。';
  }

  private preferencesAsked(patch: PreferencesPatch): string {
    if (!patch.language && !patch.initiative) return '没有要改的。';
    if (!this.options.updatePreferences) return '现在改不了设置。';
    try {
      const result = this.options.updatePreferences(patch);
      this.emit({ type: 'settings' });
      return result;
    } catch (error) {
      this.options.onLog?.(`preferences failed: ${(error as Error).message}`);
      return '没改成，跟对方说一声可以去设置里改。';
    }
  }

  /** Stops her mid-reply: the current turn, anything queued behind it, and any voice still being made. */
  async interrupt() {
    this.interruptions++;
    for (const job of this.jobs) if (job.type === 'speak_up') job.settle({ outcome: 'stopped', messages: [] });
    this.jobs = [];
    for (const job of this.voiceJobs.values()) job.controller.abort();
    await this.brain?.interrupt();
  }

  /**
   * Runs one brain turn and returns the ids of the messages it produced.
   * Initiative turns are buffered: she might answer PASS, and that must not
   * flash on screen as it streams in.
   */
  private async runTurn(text: string, { initiative, fresh = false, isStopped = () => false }: {
    initiative: InitiativeKind | null; fresh?: boolean; isStopped?: () => boolean;
  }): Promise<string[]> {
    const { store } = this.options;
    const ids: string[] = [];
    const live = initiative === null;
    /** Papers started this turn. Unprompted turns never write one: she only writes when asked. */
    const papers = new Set<string>();
    const buffered: ({ kind: 'text'; text: string } | { kind: 'voice'; text: string; emotion: string | null })[] = [];
    // The current text bubble; a voice message closes it so later text starts a new one.
    let bubble: ChatMessage | null = null;
    let pending = '';
    let lost = false;

    const closeBubble = () => {
      // What is stored is what she meant, without the markup: the page streamed it raw and cleaned
      // it on the way in, and the final text replaces that.
      if (bubble) { this.publish(store.update(bubble.id, { text: plainText(bubble.text).trim() })); ids.push(bubble.id); }
      if (plainText(pending).trim()) buffered.push({ kind: 'text', text: plainText(pending).trim() });
      bubble = null;
      pending = '';
    };
    const onEvent = (event: BrainEvent) => {
      if (event.type === 'text_delta') {
        if (!live) { pending += event.text; return; }
        if (!bubble) {
          if (!event.text.trim()) return;
          bubble = this.publish(store.append({ role: 'assistant', kind: 'text', text: '' }));
        }
        bubble = { ...bubble, text: bubble.text + event.text };
        this.emit({ type: 'text_delta', messageId: bubble.id, delta: event.text });
      } else if (event.type === 'voice') {
        closeBubble();
        if (live) ids.push(this.startVoice(event.text, event.emotion, null));
        else buffered.push({ kind: 'voice', text: event.text, emotion: event.emotion });
      } else if (event.type === 'paper_start') {
        if (!live) return;
        // Whatever she said before it stays above the card in the history.
        closeBubble();
        papers.add(event.paperId);
        ids.push(this.beginPaper(event.paperId));
      } else if (event.type === 'paper_progress') {
        if (papers.has(event.paperId) && this.options.store.paper(event.paperId)?.status === 'writing') this.draftPaper(event.paperId, event.title, event.blocks);
      } else if (event.type === 'paper_done') {
        if (papers.has(event.paperId)) this.finishPaper(event.paperId, event.title, event.blocks);
      } else if (event.type === 'paper_edit') {
        event.respond(live ? this.editPaper(event.paperId, event.ops) : '现在不能改。');
      } else if (event.type === 'paper_save') {
        event.respond(live ? this.savePaperAsked() : '现在不能存。');
      } else if (event.type === 'preferences') {
        event.respond(this.preferencesAsked(event.patch));
      } else if (event.type === 'session_lost') {
        lost = true;
      } else {
        this.emit({ type: 'error', code: event.code, message: event.message });
      }
    };
    try {
      await this.ensureBrain(fresh).reply(text, onEvent);
    } finally {
      closeBubble();
      this.settlePapers(papers);
    }

    if (lost) {
      // The stored session is gone (data cleared, expired). Answer this same turn from
      // a new session; the chat history itself lives in our store and is unaffected.
      await this.resetBrain();
      if (fresh) {
        this.emit({ type: 'error', code: 'BRAIN_SESSION_UNAVAILABLE', message: '没能开启新的对话，稍后再试试？' });
        return ids;
      }
      return this.runTurn(text, { initiative, fresh: true, isStopped });
    }

    // Stopped mid-turn: whatever she had buffered was never shown, so it is simply dropped.
    if (!live && !isStopped()) {
      const said = buffered.filter(part => !(part.kind === 'text' && PASS.test(part.text)));
      for (const part of said) {
        ids.push(part.kind === 'voice'
          ? this.startVoice(part.text, part.emotion, initiative)
          : this.publish(store.append({ role: 'assistant', kind: 'text', text: part.text, initiative })).id);
      }
    }
    return ids;
  }

  private startVoice(raw: string, emotion: string | null, initiative: InitiativeKind | null, audioId = randomUUID()): string {
    // Read aloud, a stray "**" or "<p>" is noise in her mouth, not formatting.
    const text = plainText(raw).trim();
    const message = this.publish(this.options.store.append({
      role: 'assistant', kind: 'voice', text, emotion, initiative,
      audio: { id: audioId, state: 'streaming', durationSeconds: null, error: null },
    }));
    this.speakInto(message.id, text, audioId);
    return message.id;
  }

  /**
   * Says a line she only typed, once, when the user asks to hear it. The
   * voice is kept on that message, so every later replay is the same
   * recording. Returns the audio id, or null when there is no such line or no
   * voice to say it with. A line already voiced just returns its audio.
   */
  voiceMessage(messageId: string): string | null {
    const message = this.options.store.get(messageId);
    if (message?.role !== 'assistant' || message.kind === 'paper') return null;
    if (message.audio && message.audio.state !== 'failed') return message.audio.id;
    const text = plainText(message.text).trim();
    if (!text || this.options.canSpeak?.() === false) return null;
    const audioId = randomUUID();
    this.publish(this.options.store.update(messageId, { audio: { id: audioId, state: 'streaming', durationSeconds: null, error: null } }));
    this.speakInto(messageId, text, audioId);
    return audioId;
  }

  /** Streams `text` as the voice of a message that already carries `audioId`, settling its state when done. */
  private speakInto(messageId: string, text: string, audioId: string) {
    const { store, voice } = this.options;
    const audio = (patch: Partial<AudioInfo>): AudioInfo => ({ id: audioId, state: 'streaming', durationSeconds: null, error: null, ...patch });
    const controller = new AbortController();
    // Stopped while it waited, it never starts: speak() sees the aborted signal and throws.
    const done = this.voiceTail.then(() => voice.speak(audioId, text, {
      signal: controller.signal,
      onChunk: pcm => this.emit({ type: 'audio_chunk', audioId, data: pcm.toString('base64') }),
      onLine: line => this.emit({ type: 'speech_line', audioId, ...line }),
    })).then(
      ({ durationSeconds }) => {
        this.publish(store.update(messageId, { audio: audio({ state: 'ready', durationSeconds }) }));
      },
      (error: Error) => {
        if (controller.signal.aborted) {
          this.publish(store.update(messageId, { audio: audio({ state: 'stopped' }) }));
          return;
        }
        this.options.onLog?.(`voice failed: ${error.message}`);
        this.publish(store.update(messageId, { audio: audio({ state: 'failed', error: error.message }) }));
      },
    ).finally(() => { this.voiceJobs.delete(audioId); });
    // One that failed to settle must not hold every later voice back.
    this.voiceTail = done.catch(() => {});
    this.voiceJobs.set(audioId, { controller, done });
  }

  async close() {
    this.interruptions++;
    for (const job of this.jobs) if (job.type === 'speak_up') job.settle({ outcome: 'stopped', messages: [] });
    this.jobs = [];
    const jobs = [...this.voiceJobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.done));
    await this.brain?.close();
  }
}
