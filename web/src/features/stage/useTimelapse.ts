import { useEffect, useRef, useState, type RefObject } from 'react';
import { paintAt, type Mood } from '@/features/stage/ambient';
import { lapseAt, readLapse, type Lapse } from '@/features/stage/timelapse';

/** The first and last frames are held this long: a clean cut in and out for the edit. */
const HOLD_MS = 1000;

/**
 * A day of her light, run on the room for recording: ⌥⇧T starts it, Esc lets
 * the real hour back. It waits on the first hour, runs, and stays on the last
 * until let go. Each frame writes the colours straight onto the room — no
 * React state per frame — and `lapsing` (set only at start and end) holds the
 * ambient clock off and puts the chrome away. The demo starts one by `run`,
 * a new `seq` each time.
 */
export function useTimelapse(room: RefObject<HTMLElement | null>, mood: Mood, run: { seq: number; lapse: Lapse } | null = null) {
  const [lapse, setLapse] = useState<Lapse | null>(null);
  const lapsing = lapse !== null;
  const moodRef = useRef(mood);
  moodRef.current = mood;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'Escape' && lapsing) { event.preventDefault(); setLapse(null); return; }
      if (event.code === 'KeyT' && event.altKey && event.shiftKey && !lapsing) { event.preventDefault(); setLapse(readLapse(location.search)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lapsing]);

  useEffect(() => { if (run) setLapse(run.lapse); }, [run?.seq]);

  useEffect(() => {
    const el = room.current;
    if (!lapse || !el) return;
    const day = new Date();
    const start = performance.now() + HOLD_MS;
    let frame = 0;
    const draw = (now: number) => {
      const progress = (now - start) / lapse.ms;
      paintAt(el, lapseAt(lapse, progress, day), moodRef.current);
      // Past the end it stays on the last frame; nothing more to draw.
      if (progress < 1) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [lapse, room]);

  return lapsing;
}
