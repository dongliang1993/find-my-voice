import { useEffect, useRef, useState } from 'react';
import { audio } from '@/lib/audio';

type Line = { key: string; text: string };

/** Anything that counts as the user doing something. Moving the mouse is not: people read with it. */
const ACTIVITY = ['keydown', 'pointerdown'] as const;
const readingMs = (text: string) => Math.min(4000, 900 + text.length * 110);

/**
 * She speaks up when someone is stuck, and only then: after `ms` of nothing
 * while `id` is set, she says `line` once. Each id is hinted at most once;
 * after that the circle just goes on breathing. Pass a null id whenever it
 * is not the user's move (she is talking, they are recording), which also
 * restarts the wait.
 *
 * The line is a pre-generated archive, played without calling synthesis.
 * Returns its text while she says it, for the screen to show in her place.
 */
export function useHint(id: string | null, ms: number, line: Line): string | null {
  const [aside, setAside] = useState<string | null>(null);
  const said = useRef(new Set<string>());
  const current = useRef(line);
  current.current = line;

  useEffect(() => {
    if (!id || said.current.has(id)) return;
    let timer = 0;
    let gone = false;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        said.current.add(id);
        const { key, text } = current.current;
        setAside(text);
        void audio.playClip(`hint-${key}`, `/onboarding/${key}.wav`)
          .then(({ ended }) => ended)
          // Without sound the line is still read, for as long as reading it takes.
          .catch(() => new Promise(resolve => setTimeout(resolve, readingMs(text))))
          .finally(() => { if (!gone) setAside(null); });
      }, ms);
    };
    arm();
    for (const event of ACTIVITY) window.addEventListener(event, arm);
    return () => {
      gone = true;
      window.clearTimeout(timer);
      // The user moved first: she stops mid-hint rather than talking over them.
      if (audio.playing?.startsWith('hint-')) audio.stopAll();
      for (const event of ACTIVITY) window.removeEventListener(event, arm);
      setAside(null);
    };
  }, [id, ms]);

  return aside;
}
