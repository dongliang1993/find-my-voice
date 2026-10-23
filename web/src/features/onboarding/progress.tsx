import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { audio } from '@/lib/audio';
import { cn } from '@/lib/utils';

/**
 * The thin line under her, after the OS1 install bar. It does not count
 * steps; it follows the sentence she is saying.
 * empty: nothing said yet, or nothing to say · clip: fills as the line plays ·
 * flow: busy, length unknown · rest: said, waiting for you ·
 * boot: the opening's own bar, from 0.
 */
export type ProgressMode = 'empty' | 'clip' | 'flow' | 'rest' | 'boot';

export function Progress({ mode, clip, boot = 0 }: { mode: ProgressMode; clip: string | null; boot?: number }) {
  const [fill, setFill] = useState(0);

  useEffect(() => {
    if (mode !== 'clip' || !clip) {
      return;
    }

    let frame = 0;
    const tick = () => {
      setFill(audio.clipProgress(clip) ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mode, clip]);

  return (
    <div
      className={cn('relative h-0.5 w-28 overflow-hidden rounded-full bg-(--os1-ink)/25 transition-opacity duration-700',
        mode === 'empty' ? 'opacity-0' : mode === 'rest' ? 'opacity-60' : 'opacity-100')}>
      {mode === 'flow' && (
        <motion.span className="absolute inset-y-0 w-1/3 rounded-full bg-(--os1-ink)"
          initial={{ x: '-100%' }} animate={{ x: '300%' }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }} />
      )}
      {mode !== 'flow' && (
        <span className="absolute inset-y-0 left-0 rounded-full bg-(--os1-ink)"
          style={{ width: mode === 'rest' ? '100%' : mode === 'clip' ? `${fill * 100}%` : mode === 'boot' ? `${boot * 100}%` : '0%' }} />
      )}
    </div>
  );
}
