// Runs the demo script against the real app: it stands in for the model, keeps
// the clock the scene is set at, and sets the data up the way each scene
// expects it, so any scene can be recorded again on its own.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Brain, BrainSink } from '../brain/types.js';
import { streamPaper } from '../brain/scripted.js';
import type { ChatService } from '../chat/service.js';
import type { ChatStore } from '../chat/store.js';
import type { SettingsPatch } from '../config.js';
import { toBlocks } from '../papers/schema.js';
import { firstIdentity, readProfileDocument } from '../profile/profile.js';
import type { DemoCue, ServerEvent } from '../../shared/protocol.js';
import {
  bareBlocks, blockIds, clockTime, languageAt, letters, mapOps, meetingIndex, papersBefore, replyDelay, runEnd, stops,
  type DemoBeat, type DemoScript, type PaperCue,
} from './script.js';
import { pcmToWav } from '../voice/provider.js';
import { demoSentences, type DemoVoice } from './voice.js';

/** Where a beat's own `audio` lives. */
const PUBLIC = resolve(import.meta.dirname, '../../../web/public');

export type DemoHost = {
  readonly dataDir: string;
  readonly store: ChatStore;
  readonly chat: ChatService;
  /** Written at once, without restarting the brain: the director does that itself when it has to. */
  applySettings(patch: SettingsPatch): void;
  log(line: string): void;
};

const CURSOR_KEY = 'demo_cursor';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const ask = (send: (respond: (result: string) => void) => void) => new Promise<string>(resolve => send(resolve));

/** What she writes, without the markup: how long the pen takes over it. */
const written = (cue: Extract<PaperCue, { action: 'create' }>) =>
  [cue.title, ...cue.blocks.flatMap(b => ['text', 'name', 'note'].map(key => (typeof b[key] === 'string' ? b[key] : '')))].join('').length;

export class DemoDirector {
  private scene = 0;
  private beat = 0;
  /** The scene's clock, and the real moment it was set: the demo's time runs on from there. */
  private clock: { at: number; real: number } | null = null;
  /** Set while something is written at a time of its own, like a paper from an earlier scene. */
  private pinned: Date | null = null;
  private listeners = new Set<(event: ServerEvent) => void>();
  /** Script block ids per paper, for edits; the same every run of the script. */
  private blocks = new Map<string, Map<string, string>>();

  constructor(readonly script: DemoScript, readonly voice: DemoVoice, private host: DemoHost) {
    for (const scene of script.scenes) {
      for (const beat of scene.beats) {
        const cue = beat.type === 'her' || beat.type === 'paper' ? beat.paper : undefined;
        if (cue?.action === 'create') this.blocks.set(cue.id, blockIds(cue));
        if (beat.type === 'her' && beat.audio) this.fixedTake(beat.text, beat.audio);
      }
    }
  }

  /** A line with a take of its own: it goes in the cache, so the voice pipeline plays it like any other. */
  private fixedTake(text: string, audio: string) {
    const path = resolve(PUBLIC, audio.replace(/^\//, ''));
    const sentences = demoSentences(text);
    if (sentences.length !== 1) { this.host.log(`[demo] "${text}" is ${sentences.length} sentences; one take cannot be split — synthesizing it`); return; }
    if (!existsSync(path)) { this.host.log(`[demo] no file at ${path} for "${text}"`); return; }
    try { this.voice.putWav(sentences[0]!, readFileSync(path)); }
    catch (error) { this.host.log(`[demo] ${audio}: ${(error as Error).message}`); }
  }

  /** Picks up where the last run left off, or sets the first scene up when there was none: the server restarts on every save. */
  start() {
    const saved = (() => { try { return JSON.parse(this.host.store.getState(CURSOR_KEY) ?? 'null') as { scene: number; beat: number } | null; } catch { return null; } })();
    if (saved && this.script.scenes[saved.scene]) {
      this.enter(saved.scene, saved.beat);
      return;
    }
    this.prepare(0);
  }

  subscribe(listener: (event: ServerEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The time the scene is set at, running on since it began; the real time when it names none. */
  now(): Date {
    if (this.pinned) return this.pinned;
    return this.clock ? new Date(this.clock.at + Date.now() - this.clock.real) : new Date();
  }

  state(cue?: DemoCue): Extract<ServerEvent, { type: 'demo' }> {
    return {
      type: 'demo', scene: this.scene + 1, beat: this.beat, clock: this.clock ? this.now().toISOString() : null,
      hideCursor: this.script.preset.hideCursor, meeting: this.meeting(), letters: this.letters(), ...(cue ? { cue } : {}),
    };
  }

  /** The letters she has a reading of. */
  private letters() {
    return letters(this.script).filter(l => this.voice.letter(l.paragraphs)).map(l => l.id);
  }

  /** Her reading of a letter, ready to play; null when there is none. */
  letter(paperId: string): Buffer | null {
    const letter = letters(this.script).find(l => l.id === paperId);
    const pcm = letter && this.voice.letter(letter.paragraphs);
    return pcm ? pcmToWav(pcm) : null;
  }

  private meeting() {
    const { userName, herName, onboardingAnswers: { comfort, rhythm, onMind } } = this.script.preset;
    return { alias: userName, comfort, rhythm, notes: onMind, herName, replyDelayMs: this.script.timing.replyDelayMs };
  }

  private emit(cue?: DemoCue) {
    const event = this.state(cue);
    for (const listener of this.listeners) listener(event);
  }

  private get beats(): DemoBeat[] { return this.script.scenes[this.scene]?.beats ?? []; }

  /** The latest clock any scene up to this one names. */
  private clockOf(index: number) {
    return this.script.scenes.slice(0, index + 1).findLast(s => s.clock)?.clock ?? null;
  }

  private enter(index: number, beat = 0) {
    const clock = this.clockOf(index);
    this.scene = index;
    this.clock = clock ? { at: Date.parse(clock), real: Date.now() } : null;
    this.moveTo(beat, undefined, false);
  }

  private moveTo(beat: number, cue?: DemoCue, emit = true) {
    this.beat = beat;
    this.host.store.setState(CURSOR_KEY, JSON.stringify({ scene: this.scene, beat }));
    if (emit) this.emit(cue);
  }

  private at<T>(iso: string, write: () => T): T {
    this.pinned = new Date(iso);
    try { return write(); } finally { this.pinned = null; }
  }

  // ---- what the user says ----

  /**
   * What she hears, whatever was said: the first meeting gets the preset
   * answers, and after it the line the script has the user say next. Nothing
   * when the script has nobody speaking here.
   */
  heard({ step, completedAt }: { step: number; completedAt: string | null }): string {
    const { preset } = this.script;
    if (!completedAt) return step >= 5 ? preset.herName : preset.onboardingAnswers.onMind;
    const beat = this.beats[this.beat];
    return beat?.type === 'user' ? beat.userText : '';
  }

  /** The first meeting is over: the next scene is up. */
  onboarded() {
    if (this.script.scenes[this.scene]?.onboarding && this.script.scenes[this.scene + 1]) {
      this.enter(this.scene + 1);
      this.emit();
    }
  }

  // ---- keys ----

  async next(): Promise<void> {
    const { chat } = this.host;
    if (chat.busy) { this.host.log('[demo] still playing; → waits for her'); return; }
    if (this.script.scenes[this.scene]?.onboarding) return;
    const beat = this.beats[this.beat];
    if (!beat) {
      if (!this.script.scenes[this.scene + 1]) return;
      // From an opening shot into the first meeting: it starts from nothing, as a first meeting does.
      if (this.script.scenes[this.scene + 1]!.onboarding) { await this.jump(this.scene + 1); return; }
      this.enter(this.scene + 1);
      this.emit();
      // A scene that opens on something she or the page does starts with the same press.
      if (this.beats[0] && this.beats[0].type !== 'user') await this.next();
      return;
    }
    if (beat.type === 'user') void chat.send(randomUUID(), beat.userText);
    else if (beat.type === 'her' || beat.type === 'paper') void chat.prompt();
    else if (beat.type === 'openApp') {
      this.moveTo(this.beat + 1, { type: 'openApp', app: beat.app, ...(beat.select ? { select: beat.select } : {}), ...(beat.tab ? { tab: beat.tab } : {}) });
    } else if (beat.type === 'timelapse') {
      this.moveTo(this.beat + 1, { type: 'timelapse', from: clockTime(beat.from), to: clockTime(beat.to), durationMs: beat.durationMs });
    } else {
      this.moveTo(this.beat + 1, { type: 'reload' });
    }
  }

  /** One stop back. What was said stays said; only the script's place moves. */
  async back() {
    if (this.host.chat.busy) await this.host.chat.interrupt();
    this.moveTo(stops(this.beats).filter(i => i < this.beat).at(-1) ?? 0);
  }

  /** The scene from its first beat, its data as it was when it began. */
  async jump(index = this.scene) {
    if (!this.script.scenes[index]) return;
    await this.host.chat.interrupt();
    this.prepare(index);
    await this.host.chat.resetBrain();
    this.emit({ type: 'reload' });
  }

  /** Everything the earlier scenes would have left, written straight in: no voice, no pen. */
  private prepare(index: number) {
    const { store, chat, dataDir } = this.host;
    const { preset, scenes } = this.script;
    store.clearMessages();
    for (const paper of store.papers()) store.removePaper(paper.id);
    chat.wake();
    this.enter(index);

    const days = [...new Set(preset.memory.map(m => m.date))];
    const memory = days.map(day => `## ${day}\n${preset.memory.filter(m => m.date === day).map(m => `- ${m.text}`).join('\n')}`).join('\n\n');
    writeFileSync(readProfileDocument(dataDir, 'memory').path, `# 关于你\n\n${memory}\n`, { mode: 0o600 });

    // The first meeting's own clock, not the first scene's: an opening shot may be set days later.
    const met = scenes[meetingIndex(this.script)]?.clock ?? scenes[0]?.clock ?? new Date().toISOString();
    const { comfort, rhythm, onMind } = preset.onboardingAnswers;
    const identity = readProfileDocument(dataDir, 'identity').path;
    const settings = { ui: { language: preset.uiLanguage }, initiative: { mode: 'off' as const } };
    if (scenes[index]?.onboarding) {
      rmSync(identity, { force: true });
      store.saveOnboarding(0, {}, false);
      this.host.applySettings({ ...settings, companion: { userName: '', language: languageAt(this.script, 0) } });
    } else {
      this.at(met, () => store.saveOnboarding(7, { alias: preset.userName, comfort, rhythm, notes: onMind, nameProposed: true }, true));
      writeFileSync(identity, firstIdentity(preset.herNameReason, onMind, new Date(met)), { mode: 0o600 });
      this.host.applySettings({
        ...settings,
        companion: { name: preset.herName, userName: preset.userName, comfort, rhythm, language: languageAt(this.script, index) },
      });
    }

    const keep = (paper: { id: string; title: string; blocks: Parameters<ChatStore['writePaper']>[1]['blocks']; createdAt: string }, savedAt: string | null) => {
      this.at(paper.createdAt, () => {
        store.createPaper({ id: paper.id });
        store.writePaper(paper.id, { title: paper.title, blocks: paper.blocks, status: 'done' });
      });
      if (savedAt) this.at(savedAt, () => store.savePaper(paper.id));
    };
    for (const paper of preset.papers) keep({ ...paper, blocks: toBlocks(bareBlocks(paper.blocks)) }, paper.savedAt ?? null);
    for (const paper of papersBefore(this.script, index)) keep(paper, paper.saved ? paper.createdAt : null);
  }

  // ---- her ----

  /** Stands in for the model: every turn plays the run of hers the script is at. */
  brain(): Brain {
    return new DemoBrain((sink, isStopped) => this.play(sink, isStopped));
  }

  private async play(sink: BrainSink, isStopped: () => boolean) {
    const beats = this.beats;
    const answering = beats[this.beat]?.type === 'user';
    const from = this.beat + (answering ? 1 : 0);
    const end = runEnd(beats, from);
    // Moved on before she starts, so a press while she talks never plays her line again.
    this.moveTo(end);
    if (from === end) return;
    if (answering) await sleep(replyDelay(this.script.timing.replyDelayMs));
    for (const beat of beats.slice(from, end)) {
      if (isStopped()) return;
      await this.playBeat(beat, sink, isStopped);
    }
  }

  private async playBeat(beat: DemoBeat, sink: BrainSink, isStopped: () => boolean) {
    const pause = this.script.timing.pauseAfterBeatMs;
    if (beat.type === 'paper') {
      await this.paper(beat.paper, sink, isStopped);
      await sleep(pause);
      return;
    }
    if (beat.type !== 'her') return;
    const speaking = this.voice.durationMs(beat.text);
    sink({ type: 'voice', text: beat.text, emotion: beat.mood ?? null });
    if (beat.setting) {
      const { replyLanguage } = beat.setting;
      await ask(respond => sink({ type: 'preferences', patch: { language: replyLanguage }, respond }));
    }
    const cue = beat.paper;
    // A new paper starts where her line says so; a change to one comes once she has said it.
    const offset = !cue ? 0 : cue.action === 'create' ? (cue.startAfterText ? this.voice.offsetMs(beat.text, cue.startAfterText) : 0) : speaking;
    await Promise.all([
      sleep(speaking),
      cue && sleep(offset).then(() => (isStopped() ? undefined : this.paper(cue, sink, isStopped))),
    ]);
    // Her goodbye said: she rests. The page waits for her voice to finish before the room goes down.
    if (beat.rest && !isStopped()) await ask(respond => sink({ type: 'rest', respond }));
    await sleep(pause);
  }

  private async paper(cue: PaperCue, sink: BrainSink, isStopped: () => boolean) {
    if (cue.action === 'create') {
      // A retake writes it again from nothing.
      this.host.chat.discardPaper(cue.id);
      const ms = (written(cue) / this.script.timing.paperWritingCharsPerSecond) * 1000;
      await streamPaper(cue.id, { title: cue.title, blocks: bareBlocks(cue.blocks) }, ms, sink, isStopped);
    } else if (cue.action === 'edit') {
      const ops = mapOps(cue.ops, this.blocks.get(cue.id) ?? new Map());
      const result = await ask(respond => sink({ type: 'paper_edit', paperId: cue.id, ops, respond }));
      this.host.log(`[demo] edit: ${result.split('\n')[0]}`);
    } else {
      this.host.chat.savePaper(cue.id);
    }
  }
}

class DemoBrain implements Brain {
  closed = false;
  private stopped = false;
  constructor(private run: (sink: BrainSink, isStopped: () => boolean) => Promise<void>) {}
  async reply(_text: string, sink: BrainSink) {
    this.stopped = false;
    await this.run(sink, () => this.stopped || this.closed);
  }
  async interrupt() { this.stopped = true; }
  async close() { this.closed = true; }
}
