import { useEffect, useRef } from 'react';
import { motion, useAnimate, useIsPresent, useReducedMotion } from 'motion/react';
import type { Letter } from '@shared/protocol';
import { EnvelopeArt } from '@/features/letter/EnvelopeArt';

type Props = {
  letter: Letter;
  /** Bumped by every edit she makes; the seal flickers once when it changes. */
  pulse: number;
  onOpen: () => void;
  onRewrite: () => void;
};

/**
 * The letter on the stage, by the circle: handed over as she says so, and
 * left there. It never asks to be opened. A short line drawn over it while she
 * writes; a red seal when she is done, hollow once read. A letter that broke
 * off says so, and a click has her write it again.
 *
 * Its box shares a layout id with the paper, so opening it unfolds this very
 * envelope into the letter, and closing folds it back.
 */
export function Envelope({ letter, pulse, onOpen, onRewrite }: Props) {
  const still = useReducedMotion() ?? false;
  /** False while it fades out for a newer letter: a click then would open one that is no longer on the stage. */
  const present = useIsPresent();
  const writing = letter.status === 'writing';
  const broken = letter.status === 'broken';
  const [seal, animate] = useAnimate<HTMLSpanElement>();
  const firstPulse = useRef(pulse);

  // An edit made while the paper was closed: the seal flickers, once.
  useEffect(() => {
    if (pulse === firstPulse.current || still || !seal.current) return;
    void animate(seal.current, { scale: [1, 2.2, 1], opacity: [0.9, 0, 0] }, { duration: 0.9, ease: 'easeOut' });
  }, [pulse, still, animate, seal]);

  const label = broken ? '没写完，点一下重写' : writing ? `正在写${letter.title ? `「${letter.title}」` : ''}` : letter.title || '一封信';

  return (
    <motion.div className={`group relative ${present ? '' : 'pointer-events-none'}`}
      initial={{ opacity: 0, y: still ? 0 : 12 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: still ? 0 : -6, transition: { duration: 0.45 } }}
      transition={{ duration: still ? 0 : 0.6, ease: [0.22, 1, 0.36, 1] }}>
      <motion.button layoutId={`letter-${letter.id}`} type="button" disabled={!present} onClick={broken ? onRewrite : onOpen}
        aria-label={broken ? '这封信没写完，重新写' : `打开信：${label}`}
        transition={{ layout: { duration: still ? 0 : 0.7, ease: [0.65, 0, 0.35, 1] } }}
        className="relative block h-10 w-14 rounded-[2px] drop-shadow-[0_4px_8px_rgb(60_10_0/0.28)] transition-transform duration-300 group-hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/70">
        {writing && <span aria-hidden="true" className="letter-writing absolute -top-2.5 left-[28%] h-px w-[44%] bg-white/85" />}
        <EnvelopeArt seal={writing ? 'none' : letter.openedAt ? 'hollow' : 'filled'} className="size-full" />
        <span ref={seal} aria-hidden="true" className="pointer-events-none absolute top-[57.5%] left-1/2 size-[7px] -translate-1/2 rounded-full bg-(--paper-seal) opacity-0" />
      </motion.button>
      <span className={`pointer-events-none absolute top-full left-1/2 mt-1.5 -translate-x-1/2 text-center text-[12px] whitespace-nowrap text-white/80 transition-opacity duration-300 ${broken ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
        {label}
      </span>
    </motion.div>
  );
}
