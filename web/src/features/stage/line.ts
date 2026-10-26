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
    // A paper is handed over, not said: its line in the history is not hers to speak.
    if (m.role === 'assistant' && m.kind !== 'paper' && plainText(m.text).trim()) return { id: m.id, text: plainText(m.text), audioId: m.audio?.id ?? null };
    if (m.role === 'user') return null;
  }
  return null;
}

/** What clicking her coil says again, and the voice it already has, if any. */
export type Take = { messageId: string; audioId: string | null };

/**
 * Her latest turn, prompted or not: its voice when she spoke it, otherwise
 * her last typed line, to be said aloud the first time it is asked for. Once
 * the user has spoken since, there is nothing of this conversation to replay.
 */
export function lastTake(messages: ChatMessage[]): Take | null {
  let typed: ChatMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') break;
    if (m.role !== 'assistant' || m.kind === 'paper') continue;
    if (m.audio && m.audio.state !== 'failed') return { messageId: m.id, audioId: m.audio.id };
    if (!typed && plainText(m.text).trim()) typed = m;
  }
  return typed && { messageId: typed.id, audioId: null };
}
