import { useCallback, useEffect, useRef, useState } from 'react';
import { advance, startPen, type Pen, type Segment } from '@/features/paper/pace';

/**
 * How the pen starts:
 * - `live`: writing as she writes, from the first word.
 * - `replay`: she finished before it was opened; written again from the top, twice as fast.
 * - `resume`: opened before, still being written; what is there shows, the rest is paced.
 * - `instant`: read before; all of it, at once.
 */
export type PenMode = 'live' | 'replay' | 'resume' | 'instant';

/** How often the pen looks at the clock. Timers, not frames: frames stop in a background tab. */
const TICK_MS = 40;

const sameView = (a: Pen, b: Pen) => a.seg === b.seg && a.off === b.off && a.instant === b.instant;

/**
 * Drives the pen over segments that may still be growing. Re-renders only when
 * something new is on the paper — the clock ticking while she waits for the
 * model is not a change.
 */
export function usePen(segments: Segment[], mode: PenMode, still: boolean) {
  const latest = useRef(segments);
  latest.current = segments;
  const pen = useRef<Pen>(startPen(performance.now(), segments, { atEnd: mode === 'resume', instant: mode === 'instant' || still }));
  const [view, setView] = useState(pen.current);
  const speed = mode === 'replay' ? 2 : 1;

  useEffect(() => {
    let timer: number;
    const tick = () => {
      const next = advance(pen.current, latest.current, performance.now(), { speed });
      pen.current = next;
      setView(shown => (sameView(shown, next) && Object.keys(shown.marks).length === Object.keys(next.marks).length ? shown : next));
      timer = window.setTimeout(tick, TICK_MS);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [speed]);

  /** Everything now, and whatever comes after the moment it arrives. */
  const skip = useCallback(() => {
    pen.current = { ...pen.current, instant: true };
    setView(advance(pen.current, latest.current, performance.now()));
  }, []);

  return { pen: view, skip };
}
