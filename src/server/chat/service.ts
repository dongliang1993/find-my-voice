import { randomUUID } from 'node:crypto';
import type { Brain, BrainEvent, BrainFactory, PreferencesPatch } from '../brain/types.js';
import type { AudioInfo, ChatMessage, CompanionStatus, InitiativeKind, Letter, LetterBlock, LetterOp, Note, ServerEvent } from '../../shared/protocol.js';
import type { ChatStore } from './store.js';
import { plainText } from '../../shared/plain.js';
import { applyOps, describeLetter, describeNote, letterSummary, nextBlockNumber, parseNoteText } from '../letters/schema.js';

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
  /**
   * Changes whenever the persona prompt would render differently (MEMORY.md or
   * IDENTITY.md edited, a new day). A long-lived brain is rebuilt when it does.
   */
  promptVersion?: () => string;
  /** Her name as she signs a letter. */
  signature?: () => string;
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
  | { type: 'speak_up'; request: SpeakUpRequest; settle: (result: SpeakUpResult) => void }
  /** Write a letter again that broke off; `auto` is the one retry she makes on her own. */
  | { type: 'rewrite'; letterId: string; auto: boolean };

/** A letter started in the current turn, and whether it was finished. */
type TurnLetter = { messageId: string; done: boolean };

/** A letter older than this is no longer "the one on the stage" as far as her context goes. */
const STAGE_LETTER_MS = 12 * 3600_000;
const HIDDEN = '[系统提示，对方看不到这条]';

const RECENT_CLIENT_IDS = 200;
const PASS = /^\s*PASS\s*[.。]?\s*$/i;

/** The note she gets when she might speak first. Never stored or shown. */
const nudge = (reason: string) => `[系统提示，对方看不到这条] 你想起了一件事，想主动和对方说一句。
${reason}

如果你觉得现在想主动和对方说点什么，就直接说，像你平时发消息一样自然；不用提到这条提示，也不要说"我注意到"之类的话。
主动找人时只说一句短短的话：要么一条文字，要么一条语音，不要两样都发，也不要换个说法再说一遍。主动找人时不要写信。
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
  /**
   * What was on the note when the write_note call now streaming began. Each
   * progress tick replaces what the call has written on top of it; the base
   * itself never moves while it streams.
   */
  private noteBase: LetterBlock[] = [];
  private voiceJobs = new Map<string, VoiceJob>();
  /** Bumped by interrupt(); a buffered initiative turn that sees it changed is discarded. */
  private interruptions = 0;
  /** The letter open on the page, if any: what the user says next is about it. */
  private reading: string | null = null;
  /** Letters she has already retried on her own; a second failure is left for the user to retry. */
  private retried = new Set<string>();

  constructor(private options: ChatServiceOptions) {
    options.store.moveFiledNotes(options.signature?.() ?? '');
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): Extract<ServerEvent, { type: 'hello' }> {
    const { store } = this.options;
    return { type: 'hello', messages: store.recent(), status: this.status, letters: store.letters(), note: store.note() };
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
        else if (job.type === 'rewrite') await this.runRewrite(job.letterId, job.auto);
        else job.settle(await this.runSpeakUp(job.request));
      }
    } finally {
      this.setStatus('idle');
    }
  }

  private async runReply(text: string) {
    try {
      // What she sees is the user's words plus a note about the letter in front of
      // them; what is stored and shown is only the words.
      await this.runTurn(this.letterContext() + text, { initiative: null });
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

  // ---- letters ----

  /** The page says which letter is open. */
  setReading(letterId: string | null) {
    this.reading = letterId;
  }

  /**
   * A hidden note ahead of the user's words. With the letter open, she sees
   * the whole of it, ids and all, so "the third song" means something. With it
   * only on the stage, one line naming it — the ids are already in the session
   * from when she wrote it, and the full text every turn would only pile up.
   */
  private letterContext(): string {
    const { store } = this.options;
    const reading = this.reading ? store.letter(this.reading) : null;
    if (reading) return `${HIDDEN} 对方正打开着你写的信，接下来说的话多半是关于这封信的：\n${describeLetter(reading)}\n\n`;
    const stage = store.letters(1)[0];
    if (stage?.status === 'done' && Date.now() - Date.parse(stage.createdAt) < STAGE_LETTER_MS) {
      return `${HIDDEN} 舞台上还放着你写的信「${stage.title}」（id: ${stage.id}），对方${stage.openedAt ? '看过了' : '还没打开'}。对方明确提到它时才改它。\n\n`;
    }
    return '';
  }

  /** The user opened a letter: remembered, and every page told. */
  openLetter(letterId: string) {
    const letter = this.options.store.openLetter(letterId);
    if (letter) this.emit({ type: 'letter', letter });
    return letter;
  }

  deleteLetter(letterId: string) {
    const deleted = this.options.store.deleteLetter(letterId);
    if (deleted) {
      if (this.reading === letterId) this.reading = null;
      this.emit({ type: 'letter_removed', letterId });
    }
    return deleted;
  }

  /** "没写完" was clicked: she writes it again, however many times it has failed. */
  rewriteLetter(letterId: string): boolean {
    if (this.options.store.letter(letterId)?.status !== 'broken') return false;
    this.jobs.push({ type: 'rewrite', letterId, auto: false });
    void this.start();
    return true;
  }

  private async runRewrite(letterId: string, auto: boolean) {
    const broken = this.options.store.letter(letterId);
    if (!broken || broken.status !== 'broken') return;
    const say = auto ? '先用一句口语告诉对方「写到一半断了，我再试一次」，' : '先用一句口语回应一下，';
    const note = `${HIDDEN} 你刚才写给对方的信「${broken.title || '无题'}」写到一半断了。${say}然后用 write_letter 把这封信完整地重新写一遍。`;
    try {
      await this.runTurn(note, { initiative: null, replacing: letterId });
    } catch (error) {
      this.options.onLog?.(`rewrite failed: ${(error as Error).stack ?? error}`);
    }
  }

  private beginLetter(letterId: string): TurnLetter {
    const { store } = this.options;
    const letter = store.createLetter({ id: letterId, signature: this.options.signature?.() ?? '' });
    const message = this.publish(store.append({ role: 'assistant', kind: 'letter', text: letterSummary(letter), letterId }));
    store.linkLetter(letterId, message.id);
    this.emit({ type: 'letter', letter });
    return { messageId: message.id, done: false };
  }

  private draftLetter(letterId: string, title: string, blocks: LetterBlock[]) {
    this.emit({ type: 'letter', letter: this.options.store.writeLetter(letterId, { title, blocks }) });
  }

  /**
   * The letter as written, checked block by block already. One with nothing
   * left in it never happened: the letter and its message go, and only what
   * she said remains.
   */
  private finishLetter(letterId: string, turn: TurnLetter, title: string, blocks: LetterBlock[]) {
    const { store } = this.options;
    turn.done = true;
    if (!blocks.length) {
      this.dropLetter(letterId);
      return;
    }
    const letter = store.writeLetter(letterId, { title, blocks, status: 'done' });
    this.publish(store.update(turn.messageId, { text: letterSummary(letter) }));
    this.emit({ type: 'letter', letter });
  }

  private dropLetter(letterId: string) {
    const { store } = this.options;
    const messageId = store.letterMessageId(letterId);
    store.removeLetter(letterId);
    if (messageId) store.removeMessage(messageId);
    this.emit({ type: 'letter_removed', letterId });
  }

  // ---- notes ----

  /** The page closed the note: gone at once. Nothing is kept, so nothing is asked. */
  closeNote(): boolean {
    const note = this.options.store.note();
    if (!note) return false;
    this.options.store.removeNote(note.id);
    this.emit({ type: 'note_removed', noteId: note.id });
    return true;
  }

  /**
   * The note kept: she signs it, and it goes into the inbox as a letter —
   * dated now, unread. The table is empty after; her next note is a new one.
   * A note still being written is kept as far as it got.
   */
  fileNote(): Letter | null {
    const { store } = this.options;
    const note = store.note();
    if (!note || !note.blocks.length) return null;
    const letter = store.keepNote(note, this.options.signature?.() ?? '');
    const message = this.publish(store.append({ role: 'assistant', kind: 'letter', text: letterSummary(letter), letterId: letter.id }));
    store.linkLetter(letter.id, message.id);
    this.emit({ type: 'letter', letter });
    this.emit({ type: 'note_filed', noteId: note.id, letter });
    return letter;
  }

  /**
   * The user edited a block of the note by hand. Not her edit — no ops, no
   * playthrough — the block simply says what it now says, and every page is
   * told. No `note_edit`: that event carries the changes to show her making
   * them, and this was the user's own hand.
   */
  patchNoteBlock(blockId: string, text: string): Note | null {
    const { store } = this.options;
    const note = store.note();
    if (!note) return null;
    const line = plainText(text).slice(0, 1200);
    const blocks = note.blocks.map(b => (b.id === blockId
      ? b.type === 'item'
        ? { ...b, name: line || b.name }
        : b.type === 'heading' ? { ...b, text: line.slice(0, 40) } : { ...b, text: line }
      : b));
    const revised = store.reviseNote(note.id, blocks);
    if (revised) this.emit({ type: 'note', note: revised });
    return revised;
  }

  /** A tick in a check box: the user's own hand, the same as any other edit. */
  tickNoteCheck(blockId: string, done: boolean): Note | null {
    const { store } = this.options;
    const note = store.note();
    if (!note) return null;
    const blocks = note.blocks.map(b => (b.id === blockId && b.type === 'check' ? { ...b, done } : b));
    const revised = store.reviseNote(note.id, blocks);
    if (revised) this.emit({ type: 'note', note: revised });
    return revised;
  }

  /**
   * The whole card, rewritten by hand in one piece. No ops, no playthrough —
   * the note simply says what it now says. Ids are handed out past any ever
   * used, so a block she is asked to change later never answers to two lines.
   */
  rewriteNoteText(raw: unknown): Note | null {
    const { store } = this.options;
    const note = store.note();
    if (!note) return null;
    let next = nextBlockNumber(note.blocks);
    const blocks = parseNoteText(raw).map(block => ({ ...block, id: `b${next++}` }));
    const revised = store.reviseNote(note.id, blocks);
    if (revised) this.emit({ type: 'note', note: revised });
    return revised;
  }

  /** The card that went up with the call, with no line that ever stuck: down again. */
  private dropNote(noteId: string) {
    if (this.options.store.removeNote(noteId)) this.emit({ type: 'note_removed', noteId });
  }

  /**
   * The card goes up the moment the tool call starts, not when it finishes:
   * what comes after is watched being written, cursor and all. A note already
   * on the table stays as it is — the streamed lines append under it — and
   * what is on it at that moment is the base they append to, fixed for the
   * call: each tick replaces what the call has written so far on top of it.
   */
  private beginNote(noteId: string) {
    const existing = this.options.store.note();
    if (existing) {
      this.noteBase = existing.blocks;
      return;
    }
    this.noteBase = [];
    this.emit({ type: 'note', note: this.options.store.putNote({ id: noteId, title: '', blocks: [] }) });
  }

  /**
   * A call that broke off, was stopped, or wrote nothing. A card that went up
   * with it and never caught a line never happened; one that caught some is
   * simply finished there — a note never breaks, it says what it says.
   */
  private settleNote(noteId: string | null, broken: boolean) {
    if (!noteId) return;
    const note = this.options.store.note();
    if (!note) return;
    if (!note.blocks.length) {
      this.dropNote(note.id);
    } else if (broken) {
      const done = this.options.store.writeNote(note.id, { title: note.title, blocks: note.blocks, status: 'done' });
      if (done) this.emit({ type: 'note', note: done });
    }
  }

  /**
   * The note as she finished writing it. A note already on the table takes the
   * new blocks appended — she went on writing the same one — with ids that
   * cannot collide with its own. Nothing there yet, or one the page closed
   * while she wrote: a new note, and it goes up on its own.
   */
  private putNote(noteId: string, title: string, blocks: LetterBlock[], fresh: boolean): Note | null {
    const { store } = this.options;
    const existing = store.note();
    if (fresh && existing && existing.id !== noteId) return this.wipeNote(existing.id, title, blocks, 'done');
    // She wrote nothing but a title, or nothing at all: nothing goes up — and
    // the card that came up with the call goes back down with it.
    if (!blocks.length && (!existing || existing.id === noteId)) {
      if (existing?.id === noteId && !existing.blocks.length) this.dropNote(noteId);
      return null;
    }
    if (existing && existing.id !== noteId) {
      const firstFree = nextBlockNumber(this.noteBase);
      const renumbered = blocks.map((block, i) => ({ ...block, id: `b${firstFree + i}` }));
      const note = store.putNote({ id: existing.id, title: existing.title || title, blocks: [...this.noteBase, ...renumbered], status: 'done' });
      this.emit({ type: 'note', note });
      return note;
    }
    if (!blocks.length) return null;
    const note = store.putNote({ id: noteId, title, blocks, status: 'done' });
    this.emit({ type: 'note', note });
    return note;
  }

  /**
   * A new topic on the card already up: what was on it is wiped and the new
   * lines take its place. The card is the same one — it stays where it is —
   * and what it said before is still in the conversation.
   */
  private wipeNote(id: string, title: string, blocks: LetterBlock[], status?: 'done'): Note | null {
    const { store } = this.options;
    if (!blocks.length && status) return store.note(id);
    const note = store.writeNote(id, { title, blocks, status });
    if (note) this.emit({ type: 'note', note });
    return note;
  }

  private draftNote(noteId: string, title: string, blocks: LetterBlock[], fresh: boolean) {
    const { store } = this.options;
    const existing = store.note();
    if (fresh && existing && existing.id !== noteId) {
      // Nothing of the new topic yet: the old lines stay until the first new one lands.
      if (blocks.length) this.wipeNote(existing.id, title, blocks);
      return;
    }
    // Appending to one already on the table: the streamed call is only the new
    // lines, written on past its base; what was already there is kept under
    // them, unmoved, while she writes.
    if (existing && existing.id !== noteId) {
      const firstFree = nextBlockNumber(this.noteBase);
      const renumbered = blocks.map((block, i) => ({ ...block, id: `b${firstFree + i}` }));
      const note = store.writeNote(existing.id, { title: existing.title || title, blocks: [...this.noteBase, ...renumbered] });
      if (note) this.emit({ type: 'note', note });
      return;
    }
    const note = store.writeNote(noteId, { title, blocks });
    if (note) this.emit({ type: 'note', note });
  }

  /**
   * An edit she asked for. Lighter than a letter's: nothing needs to have been
   * read, and no history is kept — the note is whatever it now says.
   */
  private editNote(rawOps: unknown): string {
    const { store } = this.options;
    const note = store.note();
    if (!note) return '桌上没有便签，可能已经被收走了。要写一张新的就用 write_note。';
    const { blocks, ops, errors } = applyOps(note.blocks, rawOps, nextBlockNumber(note.blocks));
    if (!ops.length) return `没有改成：${errors.join('；') || '没有给出改动'}。`;
    const revised = store.reviseNote(note.id, blocks);
    if (revised) this.emit({ type: 'note_edit', note: revised, ops: ops as LetterOp[] });
    return [`改好了，对方能看到你在便签上改。\n${describeNote(revised ?? note)}`, errors.length ? `没改成的：${errors.join('；')}` : '']
      .filter(Boolean).join('\n');
  }

  /**
   * An edit she asked for. Only on a letter that is finished and has been
   * read — changing something unread is just writing it differently. Ops are
   * checked one by one; the answer tells her what changed and what did not,
   * so she can say so instead of claiming a change that never happened.
   */
  private editLetter(letterId: string, rawOps: unknown): string {
    const { store } = this.options;
    const letter = store.letter(letterId);
    if (!letter) return '找不到这封信，可能已经被删掉了。';
    if (letter.status !== 'done') return '这封信还没写完，改不了。可以重新写一封。';
    if (!letter.openedAt) return '对方还没打开这封信，先不要改。';
    const earlier = store.letterHistory(letterId).map(v => v.blocks);
    const { blocks, ops, errors } = applyOps(letter.blocks, rawOps, nextBlockNumber(letter.blocks, ...earlier));
    if (!ops.length) return `没有改成：${errors.join('；') || '没有给出改动'}。`;
    const revised = store.reviseLetter(letterId, blocks);
    const messageId = store.letterMessageId(letterId);
    if (messageId) this.publish(store.update(messageId, { text: letterSummary(revised) }));
    this.emit({ type: 'letter_edit', letter: revised, ops });
    return [`改好了，对方能看到你在信上改。\n${describeLetter(revised)}`, errors.length ? `没改成的：${errors.join('；')}` : '']
      .filter(Boolean).join('\n');
  }

  private keepNoteAsked(): string {
    const letter = this.fileNote();
    return letter
      ? `收好了：签上你的名字，放进了信箱，标题「${letter.title || '无题'}」。桌上空了，下次写便签是新的一张。`
      : '桌上没有便签可以收。';
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
  private async runTurn(text: string, { initiative, fresh = false, isStopped = () => false, replacing }: {
    initiative: InitiativeKind | null; fresh?: boolean; isStopped?: () => boolean;
    /** A broken letter this turn is writing again; it goes once the new one is finished. */
    replacing?: string;
  }): Promise<string[]> {
    const { store } = this.options;
    const ids: string[] = [];
    const live = initiative === null;
    const interruptionsBefore = this.interruptions;
    /** Letters started this turn. Unprompted turns never write one: she only writes when asked. */
    const letters = new Map<string, TurnLetter>();
    /** The note whose card went up this turn, if it never caught a line. */
    let noteStarted: string | null = null;
    let failed = false;
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
      } else if (event.type === 'letter_start') {
        if (!live) return;
        // Whatever she said before it stays above the envelope in the history.
        closeBubble();
        letters.set(event.letterId, this.beginLetter(event.letterId));
        ids.push(letters.get(event.letterId)!.messageId);
      } else if (event.type === 'letter_progress') {
        if (letters.has(event.letterId)) this.draftLetter(event.letterId, event.title, event.blocks);
      } else if (event.type === 'letter_done') {
        const turn = letters.get(event.letterId);
        if (!turn) return;
        this.finishLetter(event.letterId, turn, event.title, event.blocks);
        if (replacing && event.blocks.length) { this.dropLetter(replacing); replacing = undefined; }
      } else if (event.type === 'letter_edit') {
        event.respond(live ? this.editLetter(event.letterId, event.ops) : '现在不能改信。');
      } else if (event.type === 'note_start') {
        if (live) { noteStarted = event.noteId; this.beginNote(event.noteId); }
      } else if (event.type === 'note_progress') {
        if (live) this.draftNote(event.noteId, event.title, event.blocks, event.fresh);
      } else if (event.type === 'note_done') {
        if (!live) return;
        noteStarted = null;
        this.putNote(event.noteId, event.title, event.blocks, event.fresh);
      } else if (event.type === 'note_edit') {
        event.respond(live ? this.editNote(event.ops) : '现在不能改便签。');
      } else if (event.type === 'note_keep') {
        event.respond(live ? this.keepNoteAsked() : '现在不能收便签。');
      } else if (event.type === 'preferences') {
        event.respond(this.preferencesAsked(event.patch));
      } else if (event.type === 'session_lost') {
        lost = true;
      } else {
        failed = true;
        this.emit({ type: 'error', code: event.code, message: event.message });
      }
    };
    try {
      await this.ensureBrain(fresh).reply(text, onEvent);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      closeBubble();
      this.settleLetters(letters, { failed, interrupted: this.interruptions !== interruptionsBefore });
      // A card that went up with the call and never caught a line — the call
      // broke, was stopped, or wrote nothing — goes back down; one with lines
      // on it is finished there, not broken.
      this.settleNote(noteStarted, failed || this.interruptions !== interruptionsBefore);
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

  /**
   * The turn is over; any letter it left unfinished broke off. What was written
   * stays. If it broke on an error — not because the user stopped her — she
   * tries once more on her own, saying so; after that it waits for the user.
   */
  private settleLetters(letters: Map<string, TurnLetter>, { failed, interrupted }: { failed: boolean; interrupted: boolean }) {
    for (const [letterId, turn] of letters) {
      if (turn.done) continue;
      const letter = this.options.store.setLetterStatus(letterId, 'broken');
      if (letter) this.emit({ type: 'letter', letter });
      if (failed && !interrupted && !this.retried.has(letterId)) {
        this.retried.add(letterId);
        this.jobs.push({ type: 'rewrite', letterId, auto: true });
      }
    }
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
    if (message?.role !== 'assistant' || message.kind === 'letter') return null;
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
    const done = voice.speak(audioId, text, {
      signal: controller.signal,
      onChunk: pcm => this.emit({ type: 'audio_chunk', audioId, data: pcm.toString('base64') }),
      onLine: line => this.emit({ type: 'speech_line', audioId, ...line }),
    }).then(
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
