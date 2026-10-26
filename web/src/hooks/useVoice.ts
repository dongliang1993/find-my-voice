import { useEffect, useRef, useSyncExternalStore } from 'react';
import { audio } from '@/lib/audio';
import { frames } from '@/lib/frames';

/** Re-renders when what is playing changes. */
export function usePlaying() {
  return useSyncExternalStore(cb => audio.subscribe(cb), () => audio.playing);
}

/** Re-renders when she is held mid-sentence or let go. */
export function usePaused() {
  return useSyncExternalStore(cb => audio.subscribe(cb), () => audio.paused);
}

/** Her smoothed loudness (0..1), for canvas drawing that cannot read CSS cheaply. */
export const voiceLevel = { current: 0 };

/**
 * Writes her live loudness into a CSS variable on <html> every frame, so the
 * whole page can breathe with her voice without React re-rendering.
 */
export function useVoiceGlow() {
  const level = useRef(0);
  useEffect(() => {
    const root = document.documentElement;
    const loop = frames(() => {
      // Fast attack, slow release: reads as breath rather than flicker.
      const target = audio.level();
      level.current += (target - level.current) * (target > level.current ? 0.5 : 0.08);
      voiceLevel.current = level.current;
      root.style.setProperty('--voice', level.current.toFixed(3));
    });
    return loop.stop;
  }, []);
}
