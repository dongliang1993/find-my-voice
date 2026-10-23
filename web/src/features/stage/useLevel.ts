import { useEffect, useRef } from 'react';
import { audio } from '@/lib/audio';
import { microphone } from '@/lib/microphone';

/**
 * Loudness of whoever has the floor, 0..1, as a ref. Read inside a frame loop
 * so a hundred frames a second never cost a React render.
 *
 * Her voice comes from the shared audio engine's own analyser (it is already
 * decoding); the user's comes from the microphone while a clip records. When
 * neither is live the ref falls to zero, which is what makes the waveform
 * settle back instead of freezing at its last peak.
 */
export function useLevel(live: 'her' | 'you' | null) {
  const level = useRef(0);

  useEffect(() => {
    if (!live) { level.current = 0; return; }
    let frame = 0;
    const tick = () => {
      const target = live === 'her' ? audio.level() : microphone.level();
      // Fast attack, slow release: reads as breath rather than flicker.
      level.current += (target - level.current) * (target > level.current ? 0.5 : 0.08);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live]);

  return level;
}
