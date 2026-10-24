import { useCallback, useEffect, useRef, useState } from 'react';

export type Box = { x: number; y: number; w: number; h: number };

/** The note's smallest self: the size it comes up as, and never gets under. */
export const NOTE_MIN = { w: 320, h: 260 };
/** Never more than twice the size it comes up as. */
const NOTE_MAX = { w: NOTE_MIN.w * 2, h: NOTE_MIN.h * 2 };
/** Where it starts: by the right edge, a fifth of the way down the stage. */
const START = { right: 12, topFrac: 0.2 };

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const has = (dir: ResizeDir, side: 'n' | 's' | 'e' | 'w') => dir.includes(side);

/** One box, kept inside the viewport, never under the minimum, never over the max. */
const clamp = (box: Box): Box => {
  const w = Math.min(Math.max(box.w, NOTE_MIN.w), Math.min(NOTE_MAX.w, window.innerWidth));
  const h = Math.min(Math.max(box.h, NOTE_MIN.h), Math.min(NOTE_MAX.h, window.innerHeight));
  return {
    w, h,
    x: Math.min(Math.max(box.x, 0), Math.max(0, window.innerWidth - w)),
    y: Math.min(Math.max(box.y, 0), Math.max(0, window.innerHeight - h)),
  };
};

/** What a resize does to the box: the far edge moves, the near one follows. */
const resizeBox = (start: Box, dx: number, dy: number, dir: ResizeDir): Box => {
  let { x, y, w, h } = start;
  if (has(dir, 'e')) w = start.w + dx;
  if (has(dir, 's')) h = start.h + dy;
  if (has(dir, 'w')) { w = start.w - dx; x = start.x + dx; }
  if (has(dir, 'n')) { h = start.h - dy; y = start.y + dy; }
  // Clamped under the minimum, the near edge is pushed back out to it.
  if (w < NOTE_MIN.w && has(dir, 'w')) x = start.x + start.w - NOTE_MIN.w;
  if (h < NOTE_MIN.h && has(dir, 'n')) y = start.y + start.h - NOTE_MIN.h;
  return clamp({ x, y, w, h });
};

/**
 * Where the note sits and how big it is, moved by its head and sized by its
 * edges and corners, the way a desktop note is. The pointer owns the page
 * while it holds the note; a resized viewport gathers the note back in.
 *
 * A drag never re-renders: while the hand holds the note, each frame is one
 * `transform` on the card — the compositor's own layer, no layout, no paint
 * of what sits under it. Only when the hand lets go does the box land in
 * state, `left` and `top` taking over from the transform in the same frame.
 */
export function useNoteBox() {
  const [box, setBox] = useState<Box>(() => clamp({
    x: window.innerWidth - NOTE_MIN.w - START.right,
    y: window.innerHeight * START.topFrac,
    w: NOTE_MIN.w, h: NOTE_MIN.h,
  }));
  const boxRef = useRef(box);
  boxRef.current = box;
  /** The card itself, for the frames React never sees. */
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** A drag or a resize is under way: no transitions, no text selection. */
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    const gather = () => setBox(clamp);
    window.addEventListener('resize', gather);
    return () => window.removeEventListener('resize', gather);
  }, []);

  /** Runs one pointer gesture: `move` receives each pointer position. */
  const gesture = useCallback((event: React.PointerEvent, move: (e: PointerEvent) => void) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setMoving(true);
    const done = () => {
      setMoving(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  }, []);

  /** The head: the whole note goes where it is taken, on the compositor. */
  const startDrag = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = { px: event.clientX, py: event.clientY, ...boxRef.current };
    const card = cardRef.current;
    // Where the gesture is heading; handed to state only when it ends.
    let target = boxRef.current;
    setMoving(true);
    const move = (e: PointerEvent) => {
      target = clamp({
        ...start,
        x: start.x + e.clientX - start.px,
        y: start.y + e.clientY - start.py,
      });
      if (card) card.style.transform = `translate3d(${target.x - start.x}px, ${target.y - start.y}px, 0)`;
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      // The transform comes off in the same recalculation that moves
      // `left` and `top` to where it had held the card: no frame between.
      if (card) card.style.transform = '';
      setBox(target);
      setMoving(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  }, []);

  /** An edge or a corner: that one is held, the rest give way. */
  const startResize = useCallback((event: React.PointerEvent, dir: ResizeDir) => {
    const start = { px: event.clientX, py: event.clientY, ...boxRef.current };
    gesture(event, e => setBox(resizeBox(start, e.clientX - start.px, e.clientY - start.py, dir)));
  }, [gesture]);

  return { box, cardRef, moving, startDrag, startResize };
}
