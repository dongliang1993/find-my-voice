import { useEffect, useRef } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { microphone } from '@/lib/microphone';
import { cn } from '@/lib/utils';

export type EarState = 'off' | 'listening' | 'hearing';

/** Diameter of the button; the ring is drawn this size plus room to swell. */
const SIZE = 56;
const RING = 22;

/**
 * Your voice, as a ring around the button: flat while you are quiet, swelling
 * with each word. Its own canvas, so it moves every frame without React.
 * Nothing on the coral ever does this — the coral is hers.
 */
function VoiceRing({ live }: { live: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const on = useRef(live);
  const smoothed = useRef(0);
  useEffect(() => { on.current = live; }, [live]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const size = el.clientWidth;
      if (el.width !== Math.round(size * dpr)) { el.width = el.height = Math.round(size * dpr); }
      const level = on.current ? microphone.level() : 0;
      smoothed.current += (level - smoothed.current) * (level > smoothed.current ? 0.5 : 0.08);
      const v = still ? 0 : smoothed.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.strokeStyle = getComputedStyle(el).color;
      // Two rings, the outer one fainter and further out: reads as sound leaving the button.
      for (const [spread, alpha, width] of [[0, 0.85, 2], [1, 0.4, 1.5]] as const) {
        ctx.globalAlpha = alpha * (on.current ? 0.35 + v * 0.65 : 0.18);
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, SIZE / 2 + 5 + v * RING * (spread ? 1.35 : 1), 0, Math.PI * 2);
        ctx.stroke();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full text-primary" />;
}

type Props = {
  ear: EarState;
  /** False: she cannot hear (no key, no microphone, permission refused), so the button is inert. */
  canSpeak: boolean;
  onStart: () => void;
  onStop: () => void;
};

/**
 * The centre of the answer mat: one round button that starts and stops an
 * answer, by a tap or a held Space. There is no typing mode to switch to —
 * the field above is always editable, so reaching for it is the switch.
 */
export function MicButton({ ear, canSpeak, onStart, onStop }: Props) {
  const listening = ear === 'listening';
  const hearing = ear === 'hearing';

  // Hold Space to speak. Ignored while typing in a field and while a system
  // dialog (such as the permission prompt) has the keyboard.
  useEffect(() => {
    if (!canSpeak) return;
    let held = false;
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      if (listening || hearing) return;
      held = true;
      onStart();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !held) return;
      held = false;
      onStop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [canSpeak, listening, hearing, onStart, onStop]);

  const label = !canSpeak ? 'Microphone unavailable' : hearing ? 'Working it out' : listening ? 'Stop listening' : 'Start talking';

  return (
    <button type="button" onClick={listening ? onStop : hearing ? undefined : onStart} disabled={!canSpeak}
      aria-label={label} aria-pressed={listening} title={label}
      className={cn(
        'relative grid size-14 place-items-center rounded-full text-primary-foreground transition-[transform,background-color] duration-200',
        'bg-primary shadow-[0_10px_28px_-12px_var(--primary)] enabled:hover:scale-[1.04] enabled:active:scale-95',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card',
        (hearing || !canSpeak) && 'cursor-default',
        hearing && 'opacity-90',
        !canSpeak && 'bg-transparent text-muted-foreground shadow-none ring-1 ring-(--field-edge)/60',
      )}>
      <VoiceRing live={listening} />
      {hearing ? <Loader2 className="size-5 animate-spin" /> : listening ? <Square className="size-4 fill-current" /> : <Mic className="size-5" />}
    </button>
  );
}
