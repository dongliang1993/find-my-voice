// When the envelope appears: as she says she has written it, not before. Her
// spoken line comes first and the letter is handed over with its last words —
// "…写给你了" — so the envelope waits for that sentence to start playing. With
// no voice to wait for (she typed, or the sound is off) it comes at once.
//
// Relative, not `@shared`: the test runner has no vite aliases.
import type { ChatMessage, Letter } from '../../../../src/shared/protocol.js';

export type CueInput = {
  letter: Pick<Letter, 'id' | 'createdAt'>;
  messages: ChatMessage[];
  /** The audio id audible right now, if any. */
  playing: string | null;
  /** Seconds heard of the playing stream. */
  heard: number | null;
  /** Sentence starts of her voice messages, by audio id. */
  lines: Record<string, { text: string; startsAt: number }[]>;
  now: number;
};

/** However the voice goes, the envelope is not held back longer than this. */
export const CUE_MAX_MS = 15_000;
/** The sentence that hands it over. */
const HANDING = /写给你|写下来|写好了|写了一封|写了点|letter/i;

export function envelopeDue({ letter, messages, playing, heard, lines, now }: CueInput): boolean {
  if (now - Date.parse(letter.createdAt) >= CUE_MAX_MS) return true;
  const index = messages.findIndex(m => m.letterId === letter.id);
  const speech = index > 0 ? messages[index - 1] : undefined;
  // Nothing spoken right before it: nothing to wait for.
  if (!speech || speech.role !== 'assistant' || speech.kind !== 'voice' || !speech.audio) return true;
  const { id, state } = speech.audio;
  if (state === 'failed' || state === 'stopped') return true;
  if (playing !== id) {
    // Another line is still playing ahead of it, or it is not audible yet: wait.
    // Synthesised and silent means it has played (or the sound is off).
    return playing === null && state === 'ready';
  }
  const said = lines[id] ?? [];
  const last = said.at(-1);
  if (!last || heard === null || heard < last.startsAt) return false;
  // The last sentence known has started. If more may follow, only the handing-over one counts.
  return state === 'ready' || HANDING.test(last.text);
}
