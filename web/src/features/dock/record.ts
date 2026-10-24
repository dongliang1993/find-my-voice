import type { Transition } from 'motion/react';

/**
 * The record change, the one way every app window takes the stage — not a
 * left-right wheel but a slide along the diagonal: the next one comes
 * down from the top right, small and half-transparent, and the last one
 * keeps going toward the bottom-left corner, past the dock, bigger as it
 * passes you. The z order sells it: rising, the window is under the dock,
 * so it grows out from behind it; leaving, it is over even that.
 */
export const RECORD_ENTER = { opacity: 0, x: 96, y: -64, scale: 0.92, zIndex: 10 };
export const RECORD_ARRIVE = { opacity: 1, x: 0, y: 0, scale: 1, zIndex: 30 };
export const RECORD_LEAVE = { opacity: 0, x: -96, y: 64, scale: 1.07, zIndex: 40 };

export const RECORD_ARRIVE_T: Transition = { duration: 0.42, ease: [0.22, 1, 0.36, 1] };
export const RECORD_LEAVE_T: Transition = { duration: 0.3, ease: [0.55, 0, 1, 0.45] };

/** The whole change as motion props; nothing at all when the user asks for stillness. */
export const recordProps = (still: boolean) => still ? {} : {
  initial: RECORD_ENTER,
  animate: { ...RECORD_ARRIVE, transition: RECORD_ARRIVE_T },
  exit: { ...RECORD_LEAVE, transition: RECORD_LEAVE_T },
};
