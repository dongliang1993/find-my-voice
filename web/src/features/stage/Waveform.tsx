import { useEffect, useRef, type RefObject } from 'react';
import type { StateVisual } from '@/features/stage/state';

type Props = {
  visual: StateVisual;
  /** Live loudness 0..1, read every frame; only used when `driver` is audio. */
  level: RefObject<number>;
  className?: string;
};

/**
 * Her line: the thin film waveform, a stroke with a fainter echo behind it.
 * Amplitude eases towards whatever the state asks for, so a change of state
 * swells or settles instead of jumping.
 */
export function Waveform({ visual, level, className }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(visual);
  latest.current = visual;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let amp = latest.current.restAmp;
    let spread = latest.current.spread;
    let stroke = latest.current.stroke;
    let phase = 0;
    let frame = 0;
    let last = performance.now();

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (el.width !== Math.round(width * dpr)) { el.width = Math.round(width * dpr); el.height = Math.round(height * dpr); }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const v = latest.current;
      const t = now / 1000;

      // Where the amplitude wants to be: a slow breath, a waiting pulse, or the voice itself.
      let target = v.restAmp;
      if (v.driver === 'breath') target = v.restAmp * (0.6 + 0.4 * Math.sin((t * 2 * Math.PI) / v.period));
      else if (v.driver === 'pulse') target = v.restAmp * (0.5 + 0.5 * Math.abs(Math.sin((t * Math.PI) / v.period)));
      else target = v.restAmp + (v.maxAmp - v.restAmp) * level.current;
      if (still) target = Math.min(target, 0.15);

      // ~600ms to converge, whatever the frame rate.
      const k = Math.min(1, dt * 6);
      amp += (target - amp) * k;
      spread += (v.spread - spread) * k;
      stroke += (v.stroke - stroke) * k;
      phase += dt * (v.driver === 'audio' ? 5 : 1.6);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const mid = height / 2;
      const reach = height * 0.42;
      const line = (offset: number, alpha: number, weight: number) => {
        ctx.beginPath();
        for (let x = 0; x <= width; x += 2) {
          const u = x / width;
          // Only the middle `spread` of the width moves; the ends settle to a straight line.
          const uu = (u - 0.5) / spread + 0.5;
          const envelope = uu > 0 && uu < 1 ? Math.sin(Math.PI * uu) ** 1.6 : 0;
          const y = mid + reach * amp * envelope * (Math.sin(u * 11 + phase + offset) * 0.7 + Math.sin(u * 23 - phase * 1.3) * 0.3);
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'currentColor';
        ctx.globalAlpha = alpha;
        ctx.lineWidth = weight;
        ctx.lineCap = 'round';
        ctx.stroke();
      };
      line(0.9, 0.35, stroke * 0.8);
      line(0, 1, stroke);
      ctx.globalAlpha = 1;

      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [level]);

  return <canvas ref={canvas} aria-hidden="true" className={className} />;
}
