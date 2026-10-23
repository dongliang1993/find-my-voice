import { useEffect, useState } from 'react';

const WAKE = ['mousemove', 'mousedown', 'keydown', 'wheel'] as const;

/**
 * True once the pointer and keyboard have been still for `delay` ms, so the
 * chrome can fade back and leave only her and the field.
 *
 * `paused` freezes the current answer rather than forcing it either way: while
 * the user is speaking the buttons must not disappear under their hand, and
 * they must not pop back on every mouse twitch either.
 */
export function useIdleChrome(delay = 3000, paused = false) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let timer = window.setTimeout(() => setHidden(true), delay);
    const wake = () => {
      if (paused) return;
      setHidden(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setHidden(true), delay);
    };
    for (const event of WAKE) window.addEventListener(event, wake, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const event of WAKE) window.removeEventListener(event, wake);
    };
  }, [delay, paused]);

  return hidden;
}
