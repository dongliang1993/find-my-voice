import { useEffect, useRef } from 'react';
import { voiceLevel } from '@/hooks/useVoice';
import { useTheme } from '@/lib/theme';
import { frames } from '@/lib/frames';
import { cn } from '@/lib/utils';

const STRANDS = 3;
const POINTS = 160;
const TURNS = 3.2;
const TILT = 0.5;
const GROW_MS = 1600;
/** One breath of the resting line: up and back down. */
const BREATH_MS = 1100;

/**
 * asleep: her line, lying flat.
 * awake: that same line coils up into her. A spiral mounted awake starts
 * fully coiled.
 * Either way it is drawn out from the middle as far as `reach`.
 */
export type SpiralStage = 'asleep' | 'awake';

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
  /** How much of the line exists, 0..1, from the middle out. Changes glide rather than jump. */
  reach?: number;
  /** Asleep: the pointer is on her line, and it stirs. */
  hover?: boolean;
  /** Bumped to have the line breathe once: the loading is done, she is here. */
  breath?: number;
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
   * A change eases over a second or so rather than snapping.
   */
  rest?: number;
  /**
   * The user is typing to her: the line narrows to half its width and a
   * hairline, barely moving — listening — and `keystroke`, bumped on every
   * key, sends one small swell through it.
   */
  typing?: boolean;
  keystroke?: number;
  className?: string;
};

/**
 * Her presence, after OS1: a coil lying on its side, seen slightly from
 * above. Idle, it breathes and turns slowly; while she thinks it turns
 * faster; while she speaks it opens up and spins with her loudness.
 */
export function Spiral({ thinking, stage = 'awake', tone, weight = 1 / 40, reach = 1, hover = false, breath = 0, listening = false, rest = 1, typing = false, keystroke = 0, className }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const busy = useRef(thinking);
  const stroke = useRef('#e2574c');
  /** The stroke at no opacity, for the line's softened ends. */
  const clear = useRef('rgba(226,87,76,0)');
  // When the line started coiling; 0 means long ago (already done).
  const born = useRef<number | null>(stage === 'awake' ? 0 : null);
  const current = useRef(stage);
  const reachTarget = useRef(reach);
  reachTarget.current = reach;
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  /** When the last breath started. */
  const breathed = useRef<number | null>(null);
  const ear = useRef(listening);
  const typingRef = useRef(typing);
  /** 0..1, decaying: what is left of the last keystroke's swell. */
  const swell = useRef(0);
  const restTarget = useRef(rest);
  restTarget.current = rest;
  /** Restarts a loop that settled on a still frame (reduced motion) or paused while hidden. */
  const wake = useRef<() => void>(() => {});
  const { dark } = useTheme();

  useEffect(() => { busy.current = thinking; wake.current(); }, [thinking]);
  useEffect(() => { current.current = stage; wake.current(); }, [stage]);
  useEffect(() => { ear.current = listening; wake.current(); }, [listening]);
  useEffect(() => { wake.current(); }, [rest, reach, hover]);
  useEffect(() => {
    if (!breath) return;
    breathed.current = performance.now();
    wake.current();
  }, [breath]);
  useEffect(() => { typingRef.current = typing; wake.current(); }, [typing]);
  useEffect(() => {
    if (!keystroke) return;
    swell.current = Math.min(1, swell.current + 0.6);
    wake.current();
  }, [keystroke]);
  useEffect(() => {
    if (!canvas.current) return;
    const style = getComputedStyle(canvas.current);
    stroke.current = style.getPropertyValue('--spiral').trim() || stroke.current;
    clear.current = transparentOf(canvas.current, stroke.current);
  }, [tone, dark]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Idle, the phase runs at a steady rate, so seeding it from the clock lets
    // a spiral mounted under another one (the gate's, fading out) turn in step with it.
    let phase = (performance.now() / 1000) * 0.8;
    let last = performance.now();
    let open = 0;
    /** 0..1, eased: how far she has drawn in to listen. */
    let hush = 0;
    let calm = restTarget.current;
    /** 0..1, eased: how far the line has narrowed for typing. */
    let typed = typingRef.current ? 1 : 0;
    /** How much of the line is drawn, eased towards `reach`. */
    // It picks the line up as far as it already reaches: the screen before drew it there.
    let extentNow = reachTarget.current;
    /** 0..1, eased: how far the line has stirred under the pointer. */
    let lift = 0;

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      // Wide on the stage: the wave lies along the panel, so the box is a
      // rectangle. `size` is the short side — the coil's own scale — and the
      // wave runs the width at the same weight.
      const size = Math.min(el.clientWidth, el.clientHeight);
      const width = el.clientWidth;
      if (el.width !== Math.round(width * dpr) || el.height !== Math.round(size * dpr)) {
        el.width = Math.round(width * dpr);
        el.height = Math.round(size * dpr);
      }
      // Clamped, so a loop resumed after the window was hidden does not jump.
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (current.current === 'awake') born.current ??= now;
      const asleep = current.current === 'asleep';
      const goal = reachTarget.current;
      extentNow = still ? goal : extentNow + (goal - extentNow) * 0.06;
      lift = still ? 0 : lift + ((asleep && hoverRef.current ? 1 : 0) - lift) * 0.08;
      const since = breathed.current === null ? Infinity : (now - breathed.current) / BREATH_MS;
      const inhale = still || since >= 1 ? 0 : Math.sin(Math.PI * since);
      const coil = born.current === null ? 0 : still ? 1 : 1 - (1 - Math.min(1, (now - born.current) / GROW_MS)) ** 3;
      hush += ((ear.current ? 1 : 0) - hush) * 0.08;
      typed = still ? (typingRef.current ? 1 : 0) : typed + ((typingRef.current ? 1 : 0) - typed) * 0.1;
      swell.current = still ? 0 : swell.current * Math.exp(-dt * 6);
      // Opens with her voice and settles slowly, like the glow.
      const level = voiceLevel.current;
      open += (level - open) * (level > open ? 0.3 : 0.05);
      // Silence leaves a flat line where `rest` is low, and a full wave where it is 1.
      calm += (restTarget.current - calm) * (still ? 1 : 0.04);
      const quiet = calm + (1 - calm) * Math.min(1, open * 4);
      // Listening, she holds still.
      phase += dt * (1 - hush) * (0.8 + (busy.current ? 2.2 : 0) + open * 7);
      const breath = still ? 1 : 1 + (0.05 + 0.05 * hush) * Math.sin(now / (1100 + 500 * hush));

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, size);
      // The centre of the box, horizontally: the coil's middle, square or not.
      const mid = width / 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = stroke.current;
      const [sinT, cosT] = [Math.sin(TILT), Math.cos(TILT)];
      // The wave runs along the box's width; its height stays scaled to the
      // short side. On a square (the first meeting) the two are the same.
      const halfW = width * 0.4 * (1 - 0.5 * typed);
      const halfH = size * 0.4;

      // How much of the line exists yet, growing out from the middle.
      const extent = extentNow;
      // Still flat, the line's ends soften into the panel rather than stopping
      // at a cap; as it coils they fill in, the coil's own taper taking over.
      const reachPx = halfW * extent;
      const ends = ctx.createLinearGradient(mid - reachPx, 0, mid + reachPx, 0);
      const soft = 1 - coil;
      ends.addColorStop(0, soft > 0.5 ? clear.current : stroke.current);
      ends.addColorStop(0.18 * soft, stroke.current);
      ends.addColorStop(1 - 0.18 * soft, stroke.current);
      ends.addColorStop(1, soft > 0.5 ? clear.current : stroke.current);
      ctx.strokeStyle = soft > 0 && reachPx > 1 ? ends : stroke.current;

      if (extent > 0.002) {
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
            const taper = Math.sin(Math.PI * u) ** 0.7;
            const voiced = coil * (0.22 - 0.1 * hush + open * (0.2 + 0.1 * hush)) * quiet * breath * taper;
            // Flat, the line only stirs under the pointer; flat or coiled, it swells in its one breath.
            const stir = taper * ((1 - coil) * 0.035 * lift + 0.13 * inhale);
            const r = voiced + (coil * (0.05 + 0.14 * swell.current) * taper - voiced) * typed + stir;
            const a = u * TURNS * Math.PI * 2 + phase + offset;
            const py = Math.sin(a) * r * cosT - Math.cos(a) * r * sinT;
            if (i === from) ctx.moveTo(mid + x * halfW, size / 2 + py * halfH);
            else ctx.lineTo(mid + x * halfW, size / 2 + py * halfH);
          }
          // Typing, the coil is one strand: the others fade out under it.
          ctx.globalAlpha = s === 0 ? 1 : (0.55 - s * 0.12) * coil * (1 - typed);
          const full = Math.max(1, size * weight) * (s === 0 ? 1.15 : 0.8);
          ctx.lineWidth = full + (1.5 - full) * typed;
          ctx.stroke();
        }
      }

      return !still || coil < 1 || ear.current || typingRef.current !== (typed === 1);
    };
    const loop = frames(draw);
    wake.current = loop.wake;
    return () => { loop.stop(); wake.current = () => {}; };
  }, [weight]);

  return <canvas ref={canvas} aria-hidden="true" className={cn('spiral-glow flex-none', className)} />;
}

/** The same colour at no opacity, so a gradient to it fades rather than greys. */
function transparentOf(el: HTMLCanvasElement, color: string): string {
  const ctx = el.getContext('2d');
  if (!ctx) return 'rgba(0,0,0,0)';
  ctx.fillStyle = color;
  const resolved = String(ctx.fillStyle);
  const hex = /^#([0-9a-f]{6})$/i.exec(resolved);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0)`;
  }
  return resolved.replace(/rgba?\(([^,]+),([^,]+),([^,)]+)(?:,[^)]*)?\)/, 'rgba($1,$2,$3,0)');
}
