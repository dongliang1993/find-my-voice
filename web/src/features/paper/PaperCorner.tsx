import { motion, useReducedMotion } from 'motion/react';
import type { PaperPlace } from '@/features/paper/place';

/**
 * The paper, put away: a corner of it at the stage's edge, its top corner
 * turned down. It is still on the table — a click brings it back out.
 */
export function PaperCorner({ place, onOpen }: { place: PaperPlace; onOpen: () => void }) {
  const still = useReducedMotion() ?? false;
  const hide = still ? { opacity: 0 } : { opacity: 0, x: -10 };
  return (
    <motion.button type="button" onClick={onOpen} aria-label="Papers"
      initial={hide} animate={{ opacity: 1, x: 0 }} exit={hide}
      transition={{ duration: still ? 0.2 : 0.35, ease: [0.22, 1, 0.36, 1] }}
      whileHover={still ? undefined : { x: 3 }}
      style={{ position: 'absolute', left: place.corner.left, top: place.corner.top }}
      className="z-20 h-14 w-[18px] cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--paper-seal)/60">
      <span aria-hidden="true"
        className="absolute inset-0 rounded-r-[3px] bg-(--paper) shadow-[0_6px_14px_-8px_rgb(60_20_10/0.5)] [clip-path:polygon(0_0,calc(100%-7px)_0,100%_7px,100%_100%,0_100%)]" />
      {/* The turned-down corner. */}
      <span aria-hidden="true"
        className="absolute top-0 right-0 size-[7px] bg-(--paper-edge) [clip-path:polygon(0_0,100%_100%,0_100%)]" />
    </motion.button>
  );
}
