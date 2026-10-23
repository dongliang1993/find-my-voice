import { useReducedMotion, type Transition } from 'motion/react';

const EASE_OUT: Transition['ease'] = [0.22, 1, 0.36, 1];
const EASE_IN: Transition['ease'] = [0.4, 0, 1, 1];

/**
 * Zoom-through: what was on screen comes towards you and dissolves, the next
 * thing surfaces from behind it. Forward motion, never a page turn: there is
 * no going back in a first meeting. Reduced motion falls back to a fade.
 */
export function useThrough() {
  const still = useReducedMotion() ?? false;
  return still
    ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: 0.2 } }, exit: { opacity: 0, transition: { duration: 0.15 } } }
    : {
      initial: { opacity: 0, scale: 0.94, filter: 'blur(6px)' },
      animate: { opacity: 1, scale: 1, filter: 'blur(0px)', transition: { duration: 0.4, delay: 0.1, ease: EASE_OUT } },
      exit: { opacity: 0, scale: 1.12, filter: 'blur(6px)', transition: { duration: 0.25, ease: EASE_IN } },
    };
}
