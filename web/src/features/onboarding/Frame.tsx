import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Volume2 } from 'lucide-react';
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react';
import { Spiral, type SpiralStage } from '@/components/Spiral';
import { useThrough } from '@/features/onboarding/through';
import {
  CARD, CARD_SURFACE, CORAL, CORAL_CLOSED, CORAL_OPEN, CORAL_SURFACE, HER_COLUMN, MAT, ORB_SLOT, ORB_SLOT_TOP, PANEL, PANEL_HEIGHT, SCREEN, VIGNETTE,
  STAGE_ARRIVING, STAGE_CAPTION, STAGE_CAPTION_TEXT, STAGE_COIL, STAGE_LINE,
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
  thinking: boolean;
  line: string;
  /** A word in her line that is about you, set apart as she says it. */
  mark: string | null;
  /** She has the floor: the coral comes down over the whole mat, as on the stage. */
  herTurn: boolean;
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
  /** What the user just answered: it rises from the mat to over her coil, where the stage keeps your words. */
  said: string | null;
  /** The meeting is over and the curtain is going up on the stage; a click anywhere cuts to it. */
  arriving: boolean;
  onSkip: () => void;
};

/**
 * The OS1 screen: a cream mat around a coral panel, her coil at its exact
 * centre. Her words hang below her on the panel; whatever you answer with
 * lives on the mat below it. The card keeps its size from the first frame;
 * only the divider moves, down while she speaks and up when it is your turn.
 */
export function Frame({
  thinking, line, mark, herTurn, below, belowKey, orb, orbShown, under, stage,
  onBegin, onReplay, ask, onQuit, listening, said, arriving, onSkip,
}: FrameProps) {
  const through = useThrough();
  const still = useReducedMotion() ?? false;
  const screen = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  /** The pointer is over Begin: her line stirs, as something you could touch. */
  const [beckoned, setBeckoned] = useState(false);
  const coral = useRef<HTMLElement>(null);
  const answered = useRef<HTMLDivElement>(null);
  // The room takes the stage's light for the hour, so the stage is not a change of weather —
  // the mat and its answers too, so a cream card never sits in a room that has gone dark.
  const ambient = useAmbientTheme(screen, 'calm', { page: true });
  // The coral covers the mat until the first answer is due; after that it only
  // comes down to a band on her turn, never back over the whole card.
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
    <div ref={screen} {...ambient} className={cn(SCREEN, 'transition-colors duration-[1200ms]')}>
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
        {/* The whole screen is the button; the word is over her line, and the line answers the pointer. */}
        {onBegin && (
          <button type="button" onClick={onBegin} aria-label="Begin"
            onPointerEnter={() => setBeckoned(true)} onPointerLeave={() => setBeckoned(false)}
            onFocus={() => setBeckoned(true)} onBlur={() => setBeckoned(false)}
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
            {belowKey && (
              <motion.div key={belowKey} {...through} className="mx-auto w-full max-w-[400px]">
                {below}
              </motion.div>
            )}
          </motion.div>
          {/* On the way out the circle rises to where the stage keeps it, so the
              hand-off does not move it. */}
          <div className={cn(arriving ? ORB_SLOT_TOP : ORB_SLOT, arriving && 'on-stage')}>
            <motion.div ref={answered} layoutId="orb" initial={false} animate={{ opacity: orbShown ? 1 : 0 }} transition={{ duration: 0.4 }}
              className={cn('relative', !orbShown && 'pointer-events-none')} inert={!orbShown}>
              {orb}
              <div className={cn('absolute inset-x-0 top-full mt-3 flex justify-center transition-opacity duration-300', arriving && 'opacity-0')}>
                {under}
              </div>
            </motion.div>
          </div>
        </div>

        {/* Unclipped while your words are on their way up from the mat. */}
        <section ref={coral} aria-live="polite"
          className={cn(CORAL, !open || herTurn || arriving ? CORAL_CLOSED : CORAL_OPEN,
            said ? 'overflow-visible' : 'overflow-hidden', arriving ? 'bg-(--her)' : CORAL_SURFACE)}>
          <div className={VIGNETTE} aria-hidden="true" />
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
          <div className={arriving ? cn('flex flex-col items-center px-8', PANEL_HEIGHT, STAGE_ARRIVING) : HER_COLUMN}>
            <div className={cn(STAGE_CAPTION, !arriving && 'hidden')} aria-hidden="true" />
            {/* Alone until she has words, so it lies exactly where loading drew the line; once they come it glides up for them. */}
            <motion.div layoutId="her-spiral" layout layoutDependency={`${arriving}-${Boolean(line)}`}
              transition={{ layout: arriving
                ? { delay: curtainDelay, duration: ARRIVAL.curtainMs / 1000, ease: CURTAIN_EASE }
                : { duration: 0.8, ease: CURTAIN_EASE } }}
              className={cn('relative [--spiral:var(--os1-ink)]', STAGE_COIL)}>
              {/* Over the coil, as on the stage; out of the column's flow, so it never moves her. */}
              {said && (
                <div className="absolute bottom-full left-1/2 w-[min(34em,80vw)] -translate-x-1/2">
                  <Flown key={said} text={said} from={answered} />
                </div>
              )}
              <AnimatePresence>
                {onBegin && (
                  <motion.span key="begin" aria-hidden="true"
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.35, duration: 0.9, ease: 'easeOut' } }}
                    exit={{ opacity: 0, transition: { duration: 0.3 } }}
                    className="letter pointer-events-none absolute inset-x-0 bottom-1/2 mb-4 text-center text-[27px] whitespace-nowrap">
                    Begin
                  </motion.span>
                )}
              </AnimatePresence>
              <Spiral thinking={thinking} stage={stage} weight={1 / 70} rest={STAGE_REST}
                hover={Boolean(onBegin) && beckoned} listening={listening} className="size-full" />
            </motion.div>
            {/* On the way out this takes the stage's subtitle box, fixed height and all,
                so the coil lands exactly where the stage keeps it. */}
            {(line || arriving) && <div className={cn('flex flex-col items-center transition-opacity',
              arriving ? cn(STAGE_LINE, 'overflow-hidden opacity-0 duration-[400ms]') : 'mt-6 duration-0')}>
              <Stack className="w-full max-w-xl place-items-start justify-items-center text-center">
                {/* Wide enough for a full English sentence per line; 15em was a
                    Chinese measure and broke these lines every four or five words. */}
                {line && (
                  <motion.p key={line} {...through} className="letter max-w-[24em] text-[20px] leading-[1.45] sm:text-[22px]">
                    {/* Each phrase holds together; lines break between phrases. */}
                    {sentences(line).map((part, i, all) => <span key={i} className="inline-block">{marked(part, mark)}{/[?!,:.]$/.test(part) && i < all.length - 1 ? ' ' : ''}</span>)}
                  </motion.p>
                )}
              </Stack>
            </div>}
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

/** The marked word in italics, lit for a moment as she gets to it. */
function marked(part: string, mark: string | null): ReactNode {
  const at = mark ? part.indexOf(mark) : -1;
  if (!mark || at < 0) return part;
  return (
    <>
      {part.slice(0, at)}
      <motion.em className="italic" initial={{ opacity: 0.7 }}
        animate={{ opacity: 1, textShadow: ['0 0 0px rgb(255 255 255 / 0)', '0 0 14px rgb(255 255 255 / 0.55)', '0 0 6px rgb(255 255 255 / 0.2)'] }}
        transition={{ delay: 0.9, duration: 1.4, ease: 'easeOut' }}>
        {mark}
      </motion.em>
      {part.slice(at + mark.length)}
    </>
  );
}

/**
 * Your answer, flown from the circle on the mat to over her coil and turned
 * into the stage's subtitle on the way, so the first meeting already shows
 * where your words go once you talk to her.
 */
function Flown({ text, from }: { text: string; from: RefObject<HTMLElement | null> }) {
  const [scope, animate] = useAnimate<HTMLParagraphElement>();
  const still = useReducedMotion() ?? false;
  useLayoutEffect(() => {
    const el = scope.current;
    const origin = from.current;
    const subtitle = 'rgb(255 255 255 / 0.75)';
    if (still || !el || !origin) { void animate(scope.current, { opacity: [0, 1], color: subtitle }, { duration: 0.3 }); return; }
    const a = origin.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    // Set before the first paint, so it never flashes in its final place.
    el.style.transform = `translateY(${dy}px)`;
    void animate(el, { y: [dy, 0], color: [getComputedStyle(origin).color, subtitle] }, { duration: 1.1, ease: CURTAIN_EASE });
  }, []);
  return <p ref={scope} className={cn(STAGE_CAPTION_TEXT, 'text-center')}>{text}</p>;
}
