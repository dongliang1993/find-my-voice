import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, Letter } from '@shared/protocol';
import { envelopeDue } from '@/features/letter/cue';
import type { SpeechLines } from '@/hooks/useChat';
import { audio } from '@/lib/audio';

/** How often the cue listens for the handing-over sentence. */
const LISTEN_MS = 150;

/**
 * Whether the envelope for this letter may be on the stage yet. Waits for her
 * to say she has written it; once out, it stays out.
 */
export function useEnvelopeCue(letter: Letter | null, messages: ChatMessage[], playing: string | null, lines: SpeechLines) {
  const shown = useRef(new Set<string>());
  const [, wake] = useState(0);
  const input = useRef({ messages, playing, lines });
  input.current = { messages, playing, lines };

  const id = letter?.id ?? null;
  const createdAt = letter?.createdAt ?? '';
  useEffect(() => {
    if (!id || shown.current.has(id)) return;
    const check = () => {
      const { messages, playing, lines } = input.current;
      const due = envelopeDue({
        letter: { id, createdAt }, messages, playing, lines, now: Date.now(),
        heard: playing ? audio.heardTime(playing) : null,
      });
      if (!due) return false;
      shown.current.add(id);
      wake(n => n + 1);
      return true;
    };
    if (check()) return;
    const timer = window.setInterval(() => { if (check()) window.clearInterval(timer); }, LISTEN_MS);
    return () => window.clearInterval(timer);
  }, [id, createdAt]);

  return id !== null && shown.current.has(id);
}
