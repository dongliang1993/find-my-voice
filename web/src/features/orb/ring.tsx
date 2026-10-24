import { useEffect, useRef } from 'react';
import { frames } from '@/lib/frames';
import { microphone } from '@/lib/microphone';

/** How far the ring may swell past the circle at full loudness. */
const SWELL = 22;

/**
 * Your voice, as a halo around the circle: faint while you are quiet,
 * swelling with each word. Its own canvas, so it moves every frame without
 * React. It is drawn in the circle's own colour, `--orb`.
 */
export function VoiceRing({ live, size }: { live: boolean; size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const on = useRef(live);
  const wake = useRef<() => void>(() => {});
  useEffect(() => { on.current = live; wake.current(); }, [live]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let smoothed = 0;
    const loop = frames(() => {
      const dpr = window.devicePixelRatio || 1;
      const box = el.clientWidth;
      if (el.width !== Math.round(box * dpr)) { el.width = el.height = Math.round(box * dpr); }
      const level = on.current ? microphone.level() : 0;
      smoothed += (level - smoothed) * (level > smoothed ? 0.5 : 0.08);
      const v = still ? 0 : smoothed;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box, box);
      ctx.strokeStyle = getComputedStyle(el).color;
      // Two rings, the outer one fainter and further out: reads as sound leaving the circle.
      for (const [spread, alpha, width] of [[0, 0.85, 2], [1, 0.4, 1.5]] as const) {
        ctx.globalAlpha = alpha * (0.35 + v * 0.65);
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(box / 2, box / 2, size / 2 + 5 + v * SWELL * (spread ? 1.35 : 1), 0, Math.PI * 2);
        ctx.stroke();
      }
      // Off and faded out: nothing left to draw until the next answer.
      return on.current || smoothed > 0.002;
    });
    wake.current = loop.wake;
    return () => { loop.stop(); wake.current = () => {}; };
  }, [size]);

  return (
    <canvas ref={canvas} aria-hidden="true"
      className="pointer-events-none absolute top-1/2 left-1/2 -translate-1/2 text-(--orb) transition-opacity duration-300"
      style={{ width: size + 2 * (SWELL * 1.4 + 8), height: size + 2 * (SWELL * 1.4 + 8), opacity: live ? 1 : 0 }} />
  );
}
