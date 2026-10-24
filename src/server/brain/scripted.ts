// A brain that plays a script instead of thinking. Development only, switched
// on by FMV_BRAIN_SCRIPT=<path to a JSON script>: it drives the page through a
// letter — written, edited, broken off — with no model call and no API key.
//
// The script is a list of turns, one per message the user sends (the last one
// repeats). Each turn is a list of steps:
//   { "wait": 800 }                                   pause
//   { "say": "…" }                                    a voice message
//   { "text": "…" }                                   a typed message, streamed
//   { "letter": { "title": "…", "blocks": [ … ] }, "ms": 4000 }
//                                                     a letter, streamed over `ms`, through the real parser
//   { "letter": …, "breakAt": 0.5 }                   …that breaks off half-way: the model errors mid-letter
//   { "note": { "title": "…", "blocks": [ … ] }, "ms": 2500 }
//                                                     a note, streamed the same way
//   { "note_edit": { "ops": [ … ] } }                 an edit to the note on the table
//   { "edit": { "ops": [ … ] } }                      an edit to the last letter (or `letterId`)
//   { "fail": "…" }                                   the model errors out here
import { randomUUID } from 'node:crypto';
import { parsePartialJson } from '../letters/partial.js';
import { toBlocks, toTitle } from '../letters/schema.js';
import type { Brain, BrainSink } from './types.js';

export type ScriptStep =
  | { wait: number }
  | { say: string; emotion?: string }
  | { text: string }
  | { letter: { title: string; blocks: unknown[] }; ms?: number; breakAt?: number }
  | { note: { title: string; blocks: unknown[] }; ms?: number }
  | { note_edit: { ops: unknown[] } }
  | { edit: { letterId?: string; ops: unknown[] } }
  | { fail: string };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** How often a scripted letter sends what it has: the same cadence the real brain throttles to. */
const PROGRESS_MS = 150;

export class ScriptBrain implements Brain {
  closed = false;
  private turn = 0;
  private stopped = false;
  private lastLetter: string | null = null;

  constructor(private script: ScriptStep[][], private onLog?: (line: string) => void) {}

  async reply(_text: string, sink: BrainSink) {
    const steps = this.script[Math.min(this.turn++, this.script.length - 1)] ?? [];
    this.stopped = false;
    for (const step of steps) {
      if (this.stopped) return;
      if ('wait' in step) await sleep(step.wait);
      else if ('say' in step) sink({ type: 'voice', text: step.say, emotion: step.emotion ?? null });
      else if ('text' in step) {
        for (const piece of step.text.match(/.{1,3}/gsu) ?? []) { sink({ type: 'text_delta', text: piece }); await sleep(40); }
      } else if ('letter' in step) {
        const finished = await this.write(step.letter, step.ms ?? 4000, sink, step.breakAt);
        if (!finished) { sink({ type: 'error', code: 'BRAIN_OVERLOADED', message: '模型服务繁忙，稍后再试。' }); return; }
      } else if ('note' in step) {
        await this.writeNote(step.note, step.ms ?? 2500, sink);
      } else if ('note_edit' in step) {
        await new Promise<void>(done => sink({ type: 'note_edit', ops: step.note_edit.ops, respond: result => { this.onLog?.(`note edit: ${result}`); done(); } }));
      } else if ('edit' in step) {
        const letterId = step.edit.letterId ?? this.lastLetter ?? '';
        await new Promise<void>(done => sink({ type: 'letter_edit', letterId, ops: step.edit.ops, respond: result => { this.onLog?.(`edit: ${result}`); done(); } }));
      } else if ('fail' in step) {
        sink({ type: 'error', code: 'BRAIN_OVERLOADED', message: step.fail });
        return;
      }
    }
  }

  /**
   * Streams the letter's JSON a slice at a time through the same parser the real
   * brain uses. With `breakAt`, stops that far in, as if the model had failed,
   * and returns false.
   */
  private async write(letter: { title: string; blocks: unknown[] }, ms: number, sink: BrainSink, breakAt = 1): Promise<boolean> {
    const letterId = randomUUID();
    this.lastLetter = letterId;
    sink({ type: 'letter_start', letterId });
    const json = JSON.stringify(letter);
    const steps = Math.max(1, Math.round(ms / PROGRESS_MS));
    let sent = '';
    for (let i = 1; i <= steps && !this.stopped; i++) {
      if (i / steps > breakAt) return false;
      await sleep(PROGRESS_MS);
      const draft = (parsePartialJson(json.slice(0, Math.round((json.length * i) / steps))) ?? {}) as { title?: unknown; blocks?: unknown };
      const progress = { title: toTitle(draft.title), blocks: toBlocks(draft.blocks) };
      const key = JSON.stringify(progress);
      if (key !== sent) { sent = key; sink({ type: 'letter_progress', letterId, ...progress }); }
    }
    if (this.stopped) return false;
    sink({ type: 'letter_done', letterId, title: toTitle(letter.title), blocks: toBlocks(letter.blocks) });
    return true;
  }

  /**
   * Streams the note's JSON the same way. No break: a note never breaks —
   * whatever is on it when it stops is simply what it says.
   */
  private async writeNote(note: { title: string; blocks: unknown[] }, ms: number, sink: BrainSink): Promise<boolean> {
    const noteId = randomUUID();
    sink({ type: 'note_start', noteId });
    const json = JSON.stringify(note);
    const steps = Math.max(1, Math.round(ms / PROGRESS_MS));
    let sent = '';
    for (let i = 1; i <= steps && !this.stopped; i++) {
      await sleep(PROGRESS_MS);
      const draft = (parsePartialJson(json.slice(0, Math.round((json.length * i) / steps))) ?? {}) as { title?: unknown; blocks?: unknown };
      const progress = { title: toTitle(draft.title), blocks: toBlocks(draft.blocks) };
      const key = JSON.stringify(progress);
      if (key !== sent) { sent = key; sink({ type: 'note_progress', noteId, ...progress }); }
    }
    if (this.stopped) return false;
    sink({ type: 'note_done', noteId, title: toTitle(note.title), blocks: toBlocks(note.blocks) });
    return true;
  }

  async interrupt() { this.stopped = true; }
  async close() { this.closed = true; this.stopped = true; }
}
