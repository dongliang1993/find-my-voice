import { useState, type ReactNode } from 'react';
import { Volume2 } from 'lucide-react';
import { motion } from 'motion/react';
import { Spiral, type SpiralStage } from '@/components/Spiral';
import { useThrough } from '@/features/onboarding/through';
import { Progress, type ProgressMode } from '@/features/onboarding/progress';
import { CARD, CARD_SURFACE, CORAL, CORAL_CLOSED, CORAL_OPEN, CORAL_SURFACE, MAT, PANEL, SCREEN } from '@/features/onboarding/layout';
import { cn } from '@/lib/utils';

/** Children share one grid cell, so an outgoing beat and an incoming one overlap without layout jumps. */
export function Stack({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('grid *:col-start-1 *:row-start-1', className)}>{children}</div>;
}

/**
 * Breaks after sentence ends and commas, so a wrapped line never splits a
 * phrase. Latin punctuation keeps its trailing space with the next phrase.
 */
const sentences = (text: string) => text.split(/(?<=[。？！，：])|(?<=[?!,:.]) /).filter(Boolean);

type FrameProps = {
  thinking: boolean; progress: ProgressMode; clip: string | null; boot?: number; line: string; below: ReactNode; belowKey: string | null;
  /** Her line: not there yet, drawing itself across, or coiled up. */
  stage: SpiralStage;
  /** Set before the opening: a click on Begin starts it. */
  onBegin: (() => void) | null;
  /** Set when the browser kept her from saying the line out loud; a click replays it. */
  onReplay: (() => void) | null;
  /** How far into the questions this is, for the dots; null before Begin and on the way out. */
  ask: { index: number; total: number } | null;
  /** Leaving early: the rest is asked again another day. */
  onQuit: (() => void) | null;
  /** The user is answering aloud: she hushes and holds still while they speak. */
  listening: boolean;
  /** What the user just answered, still on the mat while she takes it in. */
  said: string | null;
  /** Onboarding is over: the panel dissolves into the page and her coil takes the page colour, ready to fly to the chat header. */
  leaving: boolean;
};

/**
 * The OS1 screen: a cream mat around a coral panel, her coil at its exact
 * centre. Her words hang below her on the panel; whatever you answer with
 * lives on the mat below it. Every part keeps its size from the first frame,
 * so nothing that appears ever moves her.
 */
export function Frame({ thinking, progress, clip, boot, line, below, belowKey, stage, onBegin, onReplay, ask, onQuit, listening, said, leaving }: FrameProps) {
  const through = useThrough();
  // The coral covers the mat until the first answer is due, then lifts off it for good:
  // going back to coral between answers would move her every step.
  const [open, setOpen] = useState(false);
  if (belowKey && !open) setOpen(true);
  return (
    <div className={SCREEN}>
      <div className="glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[70%]" aria-hidden="true" />
      <div className="grain pointer-events-none absolute inset-0 z-50" aria-hidden="true" />

      <div className={cn(CARD, 'transition-[background-color,box-shadow] duration-700', leaving ? 'bg-transparent' : CARD_SURFACE)}>
        {/* The whole screen is the button, and it is invisible: "Begin" is drawn on her canvas below. */}
        {onBegin && (
          <button type="button" onClick={onBegin} aria-label="Begin"
            className="absolute inset-0 z-30 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-(--os1-ink)/60 focus-visible:ring-inset" />
        )}
        {/* Holds the panel's place; the coral is drawn over the card below. */}
        <div className={PANEL} aria-hidden="true" />

        {/* The mat: whatever this step answers with, centred as one block. No
            vertical padding — an open question already fills the mat, and its
            top and bottom are the first thing to be clipped. */}
        <div className={cn(MAT, 'flex min-h-0 flex-col justify-center gap-3 overflow-y-auto px-6 sm:px-2')}>
          {said && (
            <motion.p key={said} {...through}
              className="mx-auto w-full max-w-[360px] text-center text-[13px] leading-relaxed text-muted-foreground">
              {said}
            </motion.p>
          )}
          {belowKey && (
            <motion.div key={belowKey} {...through} className="mx-auto w-full max-w-[400px]">
              {below}
            </motion.div>
          )}
        </div>

        <section aria-live="polite"
          className={cn(CORAL, open ? CORAL_OPEN : CORAL_CLOSED, leaving ? 'bg-transparent' : CORAL_SURFACE)}>
          {/* How many questions are left. Dots, not "2/5": the count reads at a glance. */}
          {ask && (
            <div className="absolute inset-x-0 top-5 flex justify-center gap-1.5" aria-label={`Question ${ask.index} of ${ask.total}`}>
              {Array.from({ length: ask.total }, (_, i) => (
                <span key={i} aria-hidden="true"
                  className={cn('size-1.5 rounded-full transition-colors duration-500',
                    i < ask.index ? 'bg-(--os1-ink)' : 'bg-(--os1-ink)/30')} />
              ))}
            </div>
          )}
          {/* Her coil and her words are one centred column, not two layers: a long
              line then pushes her up instead of running off the bottom of the panel. */}
          <div className="flex h-full flex-col items-center justify-center gap-6 px-8 py-14">
            {/* Begin is drawn on her own canvas, not laid over it: the word has to
                become the line, and that is only seamless on one surface. */}
            <motion.div layoutId="her-spiral" layoutDependency={leaving}
              className={cn('size-32 flex-none sm:size-40', !leaving && '[--spiral:var(--os1-ink)]')}>
              <Spiral thinking={thinking} stage={stage} tone={leaving ? 'page' : 'panel'} weight={1 / 70}
                label={stage === 'awake' ? null : 'Begin'} listening={listening} className="size-full" />
            </motion.div>
            <Progress mode={progress} clip={clip} boot={boot} />
            <Stack className="w-full max-w-xl place-items-start justify-items-center text-center">
              {/* Wide enough for a full English sentence per line; 15em was a
                  Chinese measure and broke these lines every four or five words. */}
              {line && (
                <motion.p key={line} {...through} className="letter max-w-[24em] text-[20px] leading-[1.45] sm:text-[22px]">
                  {/* Each phrase holds together; lines break between phrases. */}
                  {sentences(line).map((part, i, all) => <span key={i} className="inline-block">{part}{/[?!,:.]$/.test(part) && i < all.length - 1 ? '\u00a0' : ''}</span>)}
                </motion.p>
              )}
            </Stack>
          </div>
          {/* A quieter way out than anything on the mat: the rest is picked up later. */}
          {onQuit && (
            <button type="button" onClick={onQuit}
              className="absolute top-4 right-4 rounded-full px-2.5 py-1 text-[11px] text-(--os1-ink)/55 transition-colors hover:bg-(--os1-ink)/10 hover:text-(--os1-ink)/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--os1-ink)/50">
              Later
            </button>
          )}
          {onReplay && (
            <motion.button type="button" onClick={onReplay} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.6 } }}
              className="absolute right-4 bottom-4 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-(--os1-ink)/85 ring-1 ring-(--os1-ink)/40 transition-colors hover:bg-(--os1-ink)/10 hover:text-(--os1-ink)">
              <Volume2 className="size-3.5" />Say it again
            </motion.button>
          )}
        </section>
      </div>
    </div>
  );
}
