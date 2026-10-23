import { useEffect, useRef } from 'react';
import { voiceLevel } from '@/hooks/useVoice';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const STRANDS = 3;
const POINTS = 160;
const TURNS = 3.2;
const TILT = 0.5;
const GROW_MS = 1600;
/** How long the word takes to stretch out into her line. */
export const UNFOLD_MS = 900;
/** The word is drawn at this size and scaled from here, so the stretch is a transform, not a re-layout. */
const FONT_PX = 28;

/**
 * asleep: the word alone. drawing: the word stretches out left and right until
 * it is her line. awake: that same line coils up into her. A spiral mounted
 * awake starts fully coiled.
 */
export type SpiralStage = 'asleep' | 'drawing' | 'awake';

type Props = {
  thinking: boolean;
  stage?: SpiralStage;
  /**
   * Changes whenever the inherited --spiral colour may have changed (e.g. the
   * OS1 panel recolours it), so it is read again. Theme changes are tracked already.
   */
  tone?: string;
  /** Line width as a fraction of the canvas size. */
  weight?: number;
  /**
   * A word drawn on the same canvas as the line. On `drawing` it stretches
   * sideways into the line itself — no seam between word and line, because
   * there is no seam: one surface, one continuous shape.
   */
  label?: string | null;
  /**
   * The user is speaking to her. She draws in to a quiet breath and holds
   * still. The coil only ever shows her own voice; the user's has its own
   * place below, so who is talking is never in doubt.
   */
  listening?: boolean;
  /**
   * How much of the wave survives silence, 0..1. At 1 the coil keeps its full
   * height when nobody is talking; lower it on a stage where silence is the
   * normal state and a full wave reads as activity that is not happening.
   */
  rest?: number;
  className?: string;
};

/** 0 before `a`, 1 after `b`, eased in between. */
const smoothstep = (a: number, b: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Her presence, after OS1: a coil lying on its side, seen slightly from
 * above. Idle, it breathes and turns slowly; while she thinks it turns
 * faster; while she speaks it opens up and spins with her loudness.
 */
export function Spiral({ thinking, stage = 'awake', tone, weight = 1 / 40, label = null, listening = false, rest = 1, className }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const busy = useRef(thinking);
  const stroke = useRef('#e2574c');
  const ink = useRef('serif');
  // When the word started stretching and when the line started coiling; 0 means long ago (already done).
  const unfolded = useRef<number | null>(stage === 'awake' ? 0 : null);
  const born = useRef<number | null>(stage === 'awake' ? 0 : null);
  const current = useRef(stage);
  /** When the word first appeared, so it fades in instead of popping. */
  const shown = useRef<number | null>(null);
  const word = useRef(label);
  const ear = useRef(listening);
  const { dark } = useTheme();

  if (label && shown.current === null) shown.current = performance.now();
  word.current = label;
  useEffect(() => { busy.current = thinking; }, [thinking]);
  useEffect(() => { current.current = stage; }, [stage]);
  useEffect(() => { ear.current = listening; }, [listening]);
  useEffect(() => {
    if (!canvas.current) return;
    const style = getComputedStyle(canvas.current);
    stroke.current = style.getPropertyValue('--spiral').trim() || stroke.current;
    // The letter face, the one .letter would have set on a span.
    ink.current = style.getPropertyValue('--font-letter').trim() || style.fontFamily || ink.current;
  }, [tone, dark, label]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let phase = 0;
    let last = performance.now();
    let open = 0;
    /** 0..1, eased: how far she has drawn in to listen. */
    let hush = 0;

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const size = el.clientWidth;
      if (el.width !== Math.round(size * dpr)) { el.width = el.height = Math.round(size * dpr); }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // Woken without unfolding first (a resumed onboarding): the line is simply there, and coils.
      if (current.current === 'awake') born.current ??= now;
      if (current.current === 'drawing' && unfolded.current === null) unfolded.current = now;

      const raw = unfolded.current === null ? 0 : still ? 1 : Math.min(1, (now - unfolded.current) / UNFOLD_MS);
      const unfold = raw < 0.5 ? 4 * raw ** 3 : 1 - (-2 * raw + 2) ** 3 / 2;
      const coil = born.current === null ? 0 : still ? 1 : 1 - (1 - Math.min(1, (now - born.current) / GROW_MS)) ** 3;
      hush += ((ear.current ? 1 : 0) - hush) * 0.08;
      // Opens with her voice and settles slowly, like the glow.
      const level = voiceLevel.current;
      open += (level - open) * (level > open ? 0.3 : 0.05);
      // Silence leaves a flat line where `rest` is low, and a full wave where it is 1.
      const quiet = rest + (1 - rest) * Math.min(1, open * 4);
      // Listening, she holds still.
      phase += dt * (1 - hush) * (0.8 + (busy.current ? 2.2 : 0) + open * 7);
      const breath = still ? 1 : 1 + (0.05 + 0.05 * hush) * Math.sin(now / (1100 + 500 * hush));

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = stroke.current;
      const [sinT, cosT] = [Math.sin(TILT), Math.cos(TILT)];
      const half = size * 0.4;
      const track = 2 * half;

      // How much of the line exists yet: none, growing out from the middle, or all of it.
      const extent = current.current === 'asleep' ? 0 : current.current === 'awake' ? 1 : unfold;

      // The word. It stretches left and right while flattening, and the line
      // comes up through it; by the time it has faded the line holds its shape.
      if (word.current && current.current !== 'awake') {
        ctx.font = `${FONT_PX}px ${ink.current}`;
        const width = Math.max(1, ctx.measureText(word.current).width);
        const stretchTo = Math.max(1, track / width);
        const appear = still ? 1 : Math.min(1, (now - (shown.current ?? now)) / 1200);
        ctx.save();
        ctx.globalAlpha = appear * (1 - smoothstep(0.55, 1, unfold));
        ctx.fillStyle = stroke.current;
        ctx.translate(size / 2, size / 2 + (still ? 0 : (1 - appear) * 8));
        ctx.scale(1 + (stretchTo - 1) * unfold, 1 - 0.92 * unfold);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(word.current, 0, 0);
        ctx.restore();
      }

      if (extent > 0) {
        ctx.globalAlpha = current.current === 'awake' ? 1 : smoothstep(0.25, 1, unfold);
        for (let s = 0; s < STRANDS; s++) {
          const offset = (s / STRANDS) * Math.PI * 2 * (0.08 + open * 0.5);
          ctx.beginPath();
          // Only the part of the line that exists is drawn, growing from the centre out.
          const from = Math.round(POINTS * (1 - extent) / 2);
          const to = Math.round(POINTS * (1 + extent) / 2);
          for (let i = from; i <= to; i++) {
            const u = i / POINTS;
            const x = u * 2 - 1;
            // Tapered at both ends, fullest in the middle.
            const r = coil * (0.22 - 0.1 * hush + open * (0.2 + 0.1 * hush)) * quiet * breath * Math.sin(Math.PI * u) ** 0.7;
            const a = u * TURNS * Math.PI * 2 + phase + offset;
            const py = Math.sin(a) * r * cosT - Math.cos(a) * r * sinT;
            if (i === from) ctx.moveTo(size / 2 + x * half, size / 2 + py * half);
            else ctx.lineTo(size / 2 + x * half, size / 2 + py * half);
          }
          ctx.globalAlpha = (current.current === 'awake' ? 1 : smoothstep(0.25, 1, unfold)) * (s === 0 ? 1 : (0.55 - s * 0.12) * coil);
          ctx.lineWidth = Math.max(1, size * weight) * (s === 0 ? 1.15 : 0.8);
          ctx.stroke();
        }
      }

      if (!still || coil < 1 || current.current === 'drawing' || ear.current) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [weight, rest]);

  return <canvas ref={canvas} aria-hidden="true" className={cn('spiral-glow flex-none', className)} />;
}
