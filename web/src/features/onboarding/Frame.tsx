import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Volume2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { Spiral, type SpiralStage } from '@/components/Spiral';
import { useThrough } from '@/features/onboarding/through';
import { Progress, type ProgressMode } from '@/features/onboarding/progress';
import {
  CARD, CARD_SURFACE, CORAL, CORAL_CLOSED, CORAL_OPEN, CORAL_SURFACE, MAT, ORB_SLOT, ORB_SLOT_TOP, PANEL, SCREEN,
  STAGE_ARRIVING, STAGE_CAPTION, STAGE_COIL, STAGE_LINE,
} from '@/features/onboarding/layout';
import { useAmbientTheme } from '@/features/stage/ambient';
import { STAGE_REST } from '@/features/stage/state';
import { cn } from '@/lib/utils';

/** Children share one grid cell, so an outgoing beat and an incoming one overlap without layout jumps. */
export function Stack({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('grid *:col-start-1 *:row-start-1', className)}>{children}</div>;
}

/**
 * The way to the stage, in three beats: everything but her coil and the
 * circle fades, the screen holds still, then the curtain — the mat sinks and
 * the coral comes down over it, filling the card, while the room around the
 * card darkens into a frame. One motion, one direction: opening out to the
 * window and coming back read as the stage growing and shrinking again.
 */
export const ARRIVAL = { fadeMs: 400, pauseMs: 500, curtainMs: 1500 } as const;
const CURTAIN_EASE = [0.65, 0, 0.35, 1] as const;

/**
 * Breaks after sentence ends and commas, so a wrapped line never splits a
 * phrase. Latin punctuation keeps its trailing space with the next phrase.
 */
const sentences = (text: string) => text.split(/(?<=[。？！，：])|(?<=[?!,:.]) /).filter(Boolean);

type FrameProps = {
  thinking: boolean; progress: ProgressMode; clip: string | null; boot?: number; line: string;
  /** What this step answers with besides the circle (cards, buttons); null while it is her turn. */
  below: ReactNode; belowKey: string | null;
  /** The circle, always in the middle of the mat. */
  orb: ReactNode;
  orbShown: boolean;
  /** Under the circle, on its own line: a way past, or why a spoken answer did not land. */
  under: ReactNode;
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
  /** The meeting is over and the curtain is going up on the stage; a click anywhere cuts to it. */
  arriving: boolean;
  onSkip: () => void;
};

/**
 * The OS1 screen: a cream mat around a coral panel, her coil at its exact
 * centre. Her words hang below her on the panel; whatever you answer with
 * lives on the mat below it. Every part keeps its size from the first frame,
 * so nothing that appears ever moves her.
 */
export function Frame({
  thinking, progress, clip, boot, line, below, belowKey, orb, orbShown, under, stage,
  onBegin, onReplay, ask, onQuit, listening, said, arriving, onSkip,
}: FrameProps) {
  const through = useThrough();
  const still = useReducedMotion() ?? false;
  const screen = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const coral = useRef<HTMLElement>(null);
  // The room takes the stage's light for the hour, so the stage is not a change of weather —
  // the mat and its answers too, so a cream card never sits in a room that has gone dark.
  useAmbientTheme(screen, 'calm', { page: true });
  // The coral covers the mat until the first answer is due, then lifts off it for good:
  // going back to coral between answers would move her every step.
  const [open, setOpen] = useState(false);
  if ((belowKey || orbShown) && !open) setOpen(true);

  /** The curtain's two shapes: the panel, and the whole card, which is the stage. */
  const [curtain, setCurtain] = useState<string[] | null>(null);
  useLayoutEffect(() => {
    if (!arriving || !screen.current || !card.current || !coral.current) return;
    const room = screen.current.getBoundingClientRect();
    const inset = (rect: DOMRect, round: number) =>
      `inset(${rect.top - room.top}px ${room.right - rect.right}px ${room.bottom - rect.bottom}px ${rect.left - room.left}px round ${round}px)`;
    setCurtain([inset(coral.current.getBoundingClientRect(), 2), inset(card.current.getBoundingClientRect(), 3)]);
  }, [arriving]);
  const curtainDelay = (ARRIVAL.fadeMs + ARRIVAL.pauseMs) / 1000;

  return (
    <div ref={screen} className={cn(SCREEN, 'transition-colors duration-[1200ms]')}>
      {/* Kept through the arrival: the stage has the same one, so the room keeps breathing across the hand-off. */}
      <div className="glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[70%]" aria-hidden="true" />
      <div className={cn('grain pointer-events-none absolute inset-0 z-50 transition-opacity duration-1000', arriving && 'opacity-0')} aria-hidden="true" />

      {curtain && (
        <motion.div aria-hidden="true" className="absolute inset-0 z-5 bg-(--her)"
          initial={{ clipPath: curtain[0], opacity: still ? 0 : 1 }}
          animate={{ clipPath: curtain[1], opacity: 1 }}
          transition={{ delay: curtainDelay, duration: still ? 0 : ARRIVAL.curtainMs / 1000, ease: CURTAIN_EASE }} />
      )}
      {/* A click anywhere goes straight to the stage. */}
      {arriving && <button type="button" onClick={onSkip} aria-label="Skip" className="absolute inset-0 z-60 cursor-default outline-none" />}

      <div ref={card} className={cn(CARD, 'transition-[background-color,box-shadow] duration-700', CARD_SURFACE)}>
        {/* The whole screen is the button, and it is invisible: "Begin" is drawn on her canvas below. */}
        {onBegin && (
          <button type="button" onClick={onBegin} aria-label="Begin"
            className="absolute inset-0 z-30 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-(--os1-ink)/60 focus-visible:ring-inset" />
        )}
        {/* Holds the panel's place; the coral is drawn over the card below. */}
        <div className={PANEL} aria-hidden="true" />

        {/* The mat: the circle in the middle, whatever else the step needs around it.
            Above the curtain on the way out, so the circle stays while the rest sinks. */}
        <div className={cn(MAT, 'relative min-h-0', arriving && 'z-20')}>
          <motion.div className="absolute inset-0 flex flex-col justify-center overflow-y-auto px-6 sm:px-2"
            initial={false} animate={arriving ? { y: 32, opacity: 0 } : { y: 0, opacity: 1 }}
            transition={{ duration: arriving ? 0.9 : 0, delay: arriving ? curtainDelay - 0.2 : 0, ease: CURTAIN_EASE }}>
            {said && (
              <motion.p key={said} {...through}
                className="absolute inset-x-6 top-4 mx-auto max-w-[360px] text-center text-[13px] leading-relaxed text-muted-foreground">
                {said}
              </motion.p>
            )}
            {belowKey && (
              <motion.div key={belowKey} {...through} className="mx-auto w-full max-w-[400px]">
                {below}
              </motion.div>
            )}
          </motion.div>
          {/* On the way out the circle rises to where the stage keeps it, so the
              hand-off does not move it. */}
          <div className={cn(arriving ? ORB_SLOT_TOP : ORB_SLOT, arriving && 'on-stage')}>
            <motion.div layoutId="orb" initial={false} animate={{ opacity: orbShown ? 1 : 0 }} transition={{ duration: 0.4 }}
              className={cn('relative', !orbShown && 'pointer-events-none')} inert={!orbShown}>
              {orb}
              <div className={cn('absolute inset-x-0 top-full mt-3 flex justify-center transition-opacity duration-300', arriving && 'opacity-0')}>
                {under}
              </div>
            </motion.div>
          </div>
        </div>

        <section ref={coral} aria-live="polite"
          className={cn(CORAL, open ? CORAL_OPEN : CORAL_CLOSED, arriving ? 'bg-(--her)' : CORAL_SURFACE)}>
          {/* How many questions are left. Dots, not "2/5": the count reads at a glance. */}
          {ask && (
            <div className={cn('absolute inset-x-0 top-5 flex justify-center gap-1.5 transition-opacity duration-[400ms]', arriving && 'opacity-0')} aria-label={`Question ${ask.index} of ${ask.total}`}>
              {Array.from({ length: ask.total }, (_, i) => (
                <span key={i} aria-hidden="true"
                  className={cn('size-1.5 rounded-full transition-colors duration-500',
                    i < ask.index ? 'bg-(--os1-ink)' : 'bg-(--os1-ink)/30')} />
              ))}
            </div>
          )}
          {/* Her coil and her words are one centred column, not two layers: a long
              line then pushes her up instead of running off the bottom of the panel.
              On the way out the column takes the stage's shape, so the coil glides
              to where the stage keeps her. */}
          <div className={cn('flex h-full flex-col items-center px-8',
            arriving ? STAGE_ARRIVING : 'justify-center gap-6 py-14')}>
            <div className={cn(STAGE_CAPTION, !arriving && 'hidden')} aria-hidden="true" />
            {/* Begin is drawn on her own canvas, not laid over it: the word has to
                become the line, and that is only seamless on one surface. */}
            <motion.div layoutId="her-spiral" layout layoutDependency={arriving}
              transition={{ layout: { delay: arriving ? curtainDelay : 0, duration: ARRIVAL.curtainMs / 1000, ease: CURTAIN_EASE } }}
              className={cn(arriving ? STAGE_COIL : 'size-32 flex-none sm:size-40', '[--spiral:var(--os1-ink)]')}>
              <Spiral thinking={thinking} stage={stage} weight={1 / 70} rest={arriving ? STAGE_REST : 1}
                label={stage === 'awake' ? null : 'Begin'} listening={listening} className="size-full" />
            </motion.div>
            {/* On the way out this takes the stage's subtitle box, fixed height and all,
                so the coil lands exactly where the stage keeps it. */}
            <div className={cn('flex flex-col items-center gap-6 transition-opacity',
              arriving ? cn(STAGE_LINE, 'overflow-hidden opacity-0 duration-[400ms]') : 'duration-0')}>
              <Progress mode={progress} clip={clip} boot={boot} />
              <Stack className="w-full max-w-xl place-items-start justify-items-center text-center">
                {/* Wide enough for a full English sentence per line; 15em was a
                    Chinese measure and broke these lines every four or five words. */}
                {line && (
                  <motion.p key={line} {...through} className="letter max-w-[24em] text-[20px] leading-[1.45] sm:text-[22px]">
                    {/* Each phrase holds together; lines break between phrases. */}
                    {sentences(line).map((part, i, all) => <span key={i} className="inline-block">{part}{/[?!,:.]$/.test(part) && i < all.length - 1 ? ' ' : ''}</span>)}
                  </motion.p>
                )}
              </Stack>
            </div>
          </div>
          {/* A quieter way out than anything on the mat: the rest is picked up later. */}
          {onQuit && (
            <button type="button" onClick={onQuit}
              className={cn('absolute top-4 right-4 rounded-full px-2.5 py-1 text-[11px] text-(--os1-ink)/55 transition-[color,background-color,opacity] duration-[400ms] hover:bg-(--os1-ink)/10 hover:text-(--os1-ink)/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--os1-ink)/50', arriving && 'opacity-0')}>
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
