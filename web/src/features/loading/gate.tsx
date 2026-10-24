import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { CARD, CARD_SURFACE, CENTRE, CORAL, CORAL_CLOSED, CORAL_SURFACE, MAT, PANEL, SCREEN } from '@/features/onboarding/layout';
import { useAmbientTheme } from '@/features/stage/ambient';
import { cn } from '@/lib/utils';
import { useGlobal } from '@/store/global';

/** How long the line takes to cross. Long enough to read as a real wait, short enough not to be one. */
const DRAW_MS = 2500;
/** How long the finished line is held before it fades. */
const HOLD_MS = 420;
/** How long the fade off takes. */
const FADE_MS = 420;

/** Slow, fast, slow — the same curve her coil draws with. */
const easeInOutQuad = (d: number) => d < 0.5 ? 2 * d * d : 1 - (-2 * d + 2) ** 2 / 2;

/**
 * The line from the opening, drawn on a canvas the way her coil is: a faint
 * track with the line running out across it over DRAW_MS. Nothing here goes
 * through React state, so it holds its frame rate the way the coil does.
 */
function LoadingLine() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const started = performance.now();
    let frame = 0;

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const size = el.clientWidth;
      if (el.width !== Math.round(size * dpr)) el.width = el.height = Math.round(size * dpr);

      const d = still ? 1 : Math.min(1, (now - started) / DRAW_MS);
      const reach = easeInOutQuad(d);
      const half = size * 0.4;
      const width = Math.max(1, size / 70);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = 'round';
      // Inherited from the panel the line sits on, exactly as Spiral reads it.
      ctx.strokeStyle = getComputedStyle(el).getPropertyValue('--spiral').trim() || 'currentColor';

      // The faint track the line draws over.
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(size / 2 - half, size / 2);
      ctx.lineTo(size / 2 + half, size / 2);
      ctx.stroke();

      // Only the part reached so far exists.
      ctx.globalAlpha = 1;
      ctx.lineWidth = width * 1.15;
      ctx.beginPath();
      ctx.moveTo(size / 2 - half, size / 2);
      ctx.lineTo(size / 2 - half + 2 * half * reach, size / 2);
      ctx.stroke();

      if (d < 1) frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvas} aria-hidden="true" className="size-32 flex-none sm:size-40" />;
}

/**
 * The opening's own mat and coral panel, stood up while the first fetch is
 * out, so the hand-off to it is a dissolve and not a jump.
 *
 * The line always draws the full way; `ready` only decides when the fade
 * begins, and never before the line has been seen to arrive.
 */
export function LoadingGate() {
  const ready = useGlobal(store => store.ready);
  const started = useRef(performance.now());
  const screen = useRef<HTMLDivElement>(null);
  // Already in the hour's light, so neither the first meeting nor the stage under it changes the weather.
  useAmbientTheme(screen, 'calm', { page: true });

  // On the render where `ready` flips: how much of the draw is left to wait for.
  const closing = ready ? Math.max(0, DRAW_MS - (performance.now() - started.current)) : DRAW_MS;

  return (
    <motion.div ref={screen}
      role="status"
      aria-label="正在启动"
      // The delay is the line finishing plus a beat to read it, not dead time.
      exit={{ opacity: 0, transition: { duration: FADE_MS / 1000, delay: (closing + HOLD_MS) / 1000, ease: 'easeIn' } }}
      className={cn(SCREEN, 'fixed inset-0 z-[100]')}>
      <div className="glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[70%]" aria-hidden="true" />
      <div className="grain pointer-events-none absolute inset-0 z-50" aria-hidden="true" />

      {/* The same card the first meeting stands up, to the pixel, so the line hands over in place. */}
      <div className={cn(CARD, CARD_SURFACE)}>
        <div className={PANEL} />
        <div className={MAT} />
        {/* All coral, as the first meeting opens: nothing has been asked yet. */}
        <section className={cn(CORAL, CORAL_CLOSED, CORAL_SURFACE, '[--spiral:var(--os1-ink)]')}>
          <div className={CENTRE}><LoadingLine /></div>
        </section>
      </div>
    </motion.div>
  );
}
