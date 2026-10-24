// Relative, not `@shared`: the server-side tsconfig has no vite aliases, and
// this module is also loaded by the test runner.
import type { ChatMessage } from '../../../../src/shared/protocol.js';
import { plainText } from '../../../../src/shared/plain.js';

/**
 * The message the stage is showing, with the audio it is being read from, if
 * any. The text is plain: a reply still streaming in has not been cleaned by
 * the server yet, and a half-written `<p` must not flash on the stage.
 */
export type Line = { id: string; text: string; audioId: string | null };

/**
 * Her most recent line, if the turn is still being played out. A voice message
 * is followed by its own short text, which would otherwise take the line over
 * while the voice is still speaking — so whatever is audible wins.
 *
 * Its own module so it can be tested without the component's alias imports.
 */
export function latestLine(messages: ChatMessage[], playingId: string | null): Line | null {
  if (playingId) {
    const audible = messages.find(m => m.audio?.id === playingId);
    if (audible?.text) return { id: audible.id, text: plainText(audible.text), audioId: playingId };
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    // A letter is handed over, not said: its line in the history is not hers to speak.
    if (m.role === 'assistant' && m.kind !== 'letter' && plainText(m.text).trim()) return { id: m.id, text: plainText(m.text), audioId: m.audio?.id ?? null };
    if (m.role === 'user') return null;
  }
  return null;
}
