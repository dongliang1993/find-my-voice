import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Spiral } from '@/components/Spiral';
import { useBoot } from '@/features/loading/boot';
import {
  CARD, CARD_SURFACE, CORAL, CORAL_CLOSED, CORAL_SURFACE, HER_COLUMN, MAT, PANEL, SCREEN, VIGNETTE,
  STAGE_CAPTION, STAGE_COIL, STAGE_LINE, STAGE_PANEL,
} from '@/features/onboarding/layout';
import { useAmbientTheme } from '@/features/stage/ambient';
import { STAGE_REST } from '@/features/stage/state';
import { useSay } from '@/lib/locale';
import { cn } from '@/lib/utils';
import { useGlobal } from '@/store/global';

/** The line's one breath when everything is in, before the next screen takes over. */
const BREATH_MS = 1100;
/** The screen under the gate draws the same line in the same place, so leaving is only a short fade. */
const FADE_MS = 300;

/**
 * Loading is her line being drawn: out from the middle towards both ends, as
 * far as what has to be ready is ready. Once it all is, the line breathes
 * once and hands over in place — to Begin over the same flat line on a first
 * meeting, or to the stage, already in the stage's coil. So it is drawn where
 * and as the next screen keeps it, and only once that screen is known.
 */
export function LoadingGate() {
  const known = useGlobal(store => store.ready);
  const first = useGlobal(store => store.onboarding?.completedAt === null);
  const { reach, done, slow, enter } = useBoot();
  const say = useSay();
  const screen = useRef<HTMLDivElement>(null);
  // Already in the hour's light, so neither the first meeting nor the stage under it changes the weather.
  const ambient = useAmbientTheme(screen, 'calm', { page: true });

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(enter, BREATH_MS);
    return () => window.clearTimeout(timer);
  }, [done, enter]);

  const breath = done ? 1 : 0;
  const quiet = (
    <AnimatePresence>
      {slow && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 0.7 }} exit={{ opacity: 0 }} transition={{ duration: 0.8 }}
          className="absolute inset-x-0 top-full mt-2 text-center text-[13px] whitespace-nowrap">
          {say('网络有点慢，再等我一下', 'The network is slow. Give me a moment.')}
        </motion.p>
      )}
    </AnimatePresence>
  );

  return (
    <motion.div ref={screen} {...ambient} role="status" aria-label={say('正在启动', 'Starting')}
      exit={{ opacity: 0, transition: { duration: FADE_MS / 1000, ease: 'easeIn' } }}
      className={cn(SCREEN, 'fixed inset-0 z-[100]')}>
      <div className="glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[70%]" aria-hidden="true" />
      <div className="grain pointer-events-none absolute inset-0 z-50" aria-hidden="true" />

      {/* The same card the first meeting and the stage stand up, to the pixel, so the line hands over in place. */}
      <div className={cn(CARD, CARD_SURFACE)}>
        <div className={PANEL} />
        <div className={MAT} />
        <section className={cn(CORAL, CORAL_CLOSED, CORAL_SURFACE, 'overflow-hidden')}>
          <div className={VIGNETTE} aria-hidden="true" />
          {known && first && (
            <div className={cn('pointer-events-none absolute inset-0', HER_COLUMN)}>
              <div className={cn(STAGE_COIL, 'relative [--spiral:var(--os1-ink)]')}>
                <Spiral thinking={false} stage="asleep" reach={reach} breath={breath} rest={STAGE_REST} weight={1 / 70} className="size-full" />
                {quiet}
              </div>
            </div>
          )}
          {known && !first && (
            <div className={cn(STAGE_PANEL, 'text-white')}>
              <div className={STAGE_CAPTION} />
              <div className={cn(STAGE_COIL, 'relative [--spiral:#fff]')}>
                <Spiral thinking={false} reach={reach} breath={breath} rest={STAGE_REST} weight={1 / 70} className="size-full" />
                {quiet}
              </div>
              <div className={cn('w-full', STAGE_LINE)} />
            </div>
          )}
        </section>
      </div>
    </motion.div>
  );
}
