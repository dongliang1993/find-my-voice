import { useEffect, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ChatMessage } from '@shared/protocol';
import { audio } from '@/audio';
import { Badge } from '@/components/ui/badge';
import { usePlaying } from '@/useVoice';
import { cn } from '@/lib/utils';

const MAX_BARS = 28;

// Stable pseudo-waveform per message: the real samples are not worth shipping.
function barsFor(id: string, text: string) {
  let seed = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const count = Math.max(16, Math.min(MAX_BARS, Math.round(text.length / 1.6)));
  return Array.from({ length: count }, (_, i) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const envelope = Math.sin(Math.PI * (i + 0.5) / count) * 0.55 + 0.45;
    return 0.22 + envelope * 0.78 * ((seed % 1000) / 1000 * 0.6 + 0.4);
  });
}

const formatDuration = (seconds: number | null) => {
  if (seconds === null) return '';
  const s = Math.max(1, Math.round(seconds));
  return s < 60 ? `${s}″` : `${Math.floor(s / 60)}′${String(s % 60).padStart(2, '0')}″`;
};

type State = 'idle' | 'pending' | 'playing' | 'failed';

export function VoiceBubble({ message }: { message: ChatMessage }) {
  const info = message.audio!;
  const playing = usePlaying();
  const [progress, setProgress] = useState<number | null>(null);
  const [showText, setShowText] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const live = playing === info.id && audio.isStreaming(info.id);
  const active = playing === info.id;
  const bars = barsFor(info.id, message.text);
  // 0..1 relative length drives the pill width; estimated from text until the real duration is known.
  const seconds = info.durationSeconds ?? message.text.length * 0.22;
  const len = Math.min(1, Math.max(0, (seconds - 1) / 14));

  useEffect(() => {
    if (!active || live) { setProgress(null); return; }
    let frame = 0;
    const tick = () => { setProgress(audio.clipProgress(info.id)); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, live, info.id]);

  const toggle = async () => {
    if (active) { audio.stopAll(); return; }
    if (info.state !== 'ready') return;
    try { setLoadError(false); await audio.playClip(info.id, `/api/audio/${info.id}`); }
    catch { setLoadError(true); }
  };

  const state: State = info.state === 'failed' || loadError ? 'failed'
    : info.state === 'streaming' && !live ? 'pending' : active ? 'playing' : 'idle';
  // A stopped voice has no archive to replay; it reads as a cut-off note, not an error.
  const stopped = info.state === 'stopped';
  const label = state === 'failed' ? '语音没发出来' : stopped ? '已停下' : state === 'pending' ? '正在开口…' : formatDuration(info.durationSeconds);

  return (
    <div className="grid max-w-[min(86%,420px)] grid-cols-[auto_auto_1fr] items-center gap-x-2.5 gap-y-1.5">
      <motion.button type="button" onClick={toggle} disabled={state === 'pending' || state === 'failed' || stopped}
        aria-label={active ? '停止播放' : '播放语音'} whileTap={state === 'idle' || state === 'playing' ? { scale: 0.97 } : undefined}
        style={{ width: `calc(220px + ${len} * 180px)` }}
        className={cn(
          'col-span-full flex max-w-full items-center gap-3 rounded-[20px] rounded-bl-md border py-2.5 pr-4 pl-3 text-amber-hot transition-[border-color,box-shadow] duration-300',
          'border-primary/35 bg-linear-to-br from-primary/20 to-primary/5 shadow-[inset_0_1px_0_oklch(0.95_0.05_75/0.12)] enabled:hover:border-primary/60',
          state === 'playing' && 'voice-glow border-primary',
          state === 'failed' && 'border-destructive/40 from-destructive/10 to-transparent text-destructive',
          stopped && 'opacity-60',
        )}>
        <span className={cn('grid size-7.5 flex-none place-items-center rounded-full bg-primary text-primary-foreground', state === 'failed' && 'bg-destructive')}>
          {active ? <Square className="size-3 fill-current" /> : <Play className="ml-0.5 size-3.5 fill-current" />}
        </span>
        <span className="flex h-6.5 flex-1 items-center justify-between gap-0.5" aria-hidden="true">
          {bars.map((height, i) => (
            <i key={i} style={{ height: `${height * 100}%`, '--i': i, animationDelay: `${i * 45}ms` } as React.CSSProperties}
              className={cn(
                'w-[3px] flex-none rounded-full bg-current transition-opacity duration-150',
                progress !== null && i / bars.length > progress ? 'opacity-35' : 'opacity-85',
                state === 'playing' && 'voice-bar-live',
                state === 'pending' && 'animate-pulse opacity-45',
              )} />
          ))}
        </span>
        <span className={cn('min-w-[3.2em] flex-none text-right font-heading text-sm font-medium tabular-nums', state === 'failed' && 'min-w-0 font-sans text-[13px]')}>
          {label}
        </span>
      </motion.button>

      {message.emotion && <Badge variant="outline" className="h-5 rounded-full border-border px-2 text-xs font-normal text-muted-foreground">{message.emotion}</Badge>}
      <button type="button" onClick={() => setShowText(v => !v)} aria-expanded={showText}
        className="justify-self-start px-1 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground">
        {showText ? '收起' : '转文字'}
      </button>
      <AnimatePresence initial={false}>
        {(showText || state === 'failed' || stopped) && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="col-span-full mb-1.5 overflow-hidden px-1 text-[15px] text-muted-foreground">
            {message.text}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
