import { useEffect, useRef, useSyncExternalStore } from 'react';
import { audio } from '@/audio';

/** Re-renders when what is playing changes. */
export function usePlaying() {
  return useSyncExternalStore(cb => audio.subscribe(cb), () => audio.playing);
}

/**
 * Writes her live loudness into a CSS variable on <html> every frame, so the
 * whole page can breathe with her voice without React re-rendering.
 */
export function useVoiceGlow() {
  const level = useRef(0);
  useEffect(() => {
    let frame = 0;
    const root = document.documentElement;
    const tick = () => {
      // Fast attack, slow release: reads as breath rather than flicker.
      const target = audio.level();
      level.current += (target - level.current) * (target > level.current ? 0.5 : 0.08);
      root.style.setProperty('--voice', level.current.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
}
