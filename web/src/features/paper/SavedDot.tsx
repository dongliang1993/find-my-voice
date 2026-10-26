import { motion, useReducedMotion } from 'motion/react';

export type Flight = { seq: number; from: { x: number; y: number }; to: { x: number; y: number } };

/**
 * A paper just saved: one small dot of her colour leaves the card and lands
 * on Papers in the switcher, so where it went is seen, not said. Without
 * motion there is nothing to watch; the toast alone says it.
 */
export function SavedDot({ flight, onDone }: { flight: Flight | null; onDone: () => void }) {
  const still = useReducedMotion() ?? false;
  if (!flight || still) return null;
  const { from, to } = flight;
  // Up a little first, then down into the icon: an arc, not a slide.
  const lift = Math.min(from.y, to.y) - 60;
  return (
    <motion.span key={flight.seq} aria-hidden="true"
      initial={{ x: from.x, y: from.y, scale: 0.6, opacity: 0 }}
      animate={{ x: [from.x, (from.x + to.x) / 2, to.x], y: [from.y, lift, to.y], scale: [0.6, 1, 0.5], opacity: [0, 1, 0.9, 0] }}
      transition={{ duration: 0.9, ease: [0.5, 0, 0.3, 1], times: [0, 0.4, 1] }}
      onAnimationComplete={onDone}
      className="pointer-events-none fixed top-0 left-0 z-50 -mt-1.5 -ml-1.5 size-3 rounded-full bg-(--her) shadow-[0_2px_8px_rgb(60_20_10/0.35)]" />
  );
}
