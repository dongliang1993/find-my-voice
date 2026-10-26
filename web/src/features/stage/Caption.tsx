import { useEffect, useMemo, useRef, useState } from 'react';
import { STAGE_OPEN_LINE } from '@/features/onboarding/layout';
import { cn } from '@/lib/utils';
import { audio } from '@/lib/audio';
import { beats as toBeats, MAX_EM, width, type TimedLine } from '@/features/stage/subtitles';

/** Fast enough for the eye to follow, cheap enough to leave running. */
const TICK_MS = 100;
/**
 * The beat before a line starts reading itself. It covers the first synthesis
 * and the jitter lead, so the words do not run out ahead of the voice.
 */
const GRACE_S = 1.2;

type Props = {
  /** The message being shown; a new one starts over. */
  messageId: string;
  text: string;
  /** The stream it is read from, and where each sentence starts in it. */
  audioId: string | null;
  timed: TimedLine[] | null;
  expanded: boolean;
  /** A mouse is only resting on the line; the stage sizes the box the same way. */
  preview: boolean;
  onPreview: (on: boolean) => void;
  onToggle: () => void;
  opacity: number;
};

/**
 * Her words as film subtitles: one sentence at a time, pushed forward by the
 * voice. The previous line lingers above, faded, then leaves — the stage never
 * holds more than a beat, however long she talks.
 *
 * Hovering opens the whole reply; clicking pins it open. Without audio (sound
 * off, or a reply she only typed) the same pace is kept by hand, at reading
 * speed, so text still arrives as speech and not all at once.
 */
export function Caption({ messageId, text, audioId, timed, expanded, preview, onPreview, onToggle, opacity }: Props) {
  const beats = useMemo(() => toBeats(text, timed), [text, timed]);
  /** Seconds since this line appeared; only consulted while nothing is audible. */
  const [waited, setWaited] = useState(0);
  const opened = useRef(performance.now());

  useEffect(() => { setWaited(0); opened.current = performance.now(); }, [messageId]);

  // Derived, not stepped: a text reply grows while it is written, and the
  // elapsed time simply lands on whatever beat now belongs at that second.
  let index = 0;
  while (index < beats.length - 1 && beats[index + 1]!.at <= waited) index++;
  const open = expanded || preview;

  useEffect(() => {
    // Open, or held on the last beat, there is nothing left to advance.
    if (open || index >= beats.length - 1) return;
    const timer = window.setInterval(() => {
      // The voice is the clock whenever there is one; until it arrives, the
      // grace lets it catch up rather than letting the words run ahead.
      const heard = audioId ? audio.heardTime(audioId) : null;
      const elapsed = (performance.now() - opened.current) / 1000 - GRACE_S;
      // Never back: an interrupt drops the stream, and its clock with it.
      setWaited(waited => Math.max(waited, heard ?? elapsed));
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [audioId, open, index, beats.length]);

  const current = beats[index]?.text ?? '';
  const previous = index > 0 ? beats[index - 1]?.text : '';

  // A click has to win over a resting pointer, or the line could never be closed again.
  const toggle = () => { onPreview(false); onToggle(); };
  /** A reply that is one beat already shows in full: opening it would only take her coil away. */
  const more = beats.length > 1;

  return (
    <button type="button" onClick={more ? toggle : undefined} aria-expanded={expanded} disabled={!text}
      // A mouse opens it just by resting on the line. Touch cannot: there is no
      // leave to undo it, so a tap would never be able to close it again.
      onPointerEnter={e => { if (more && e.pointerType === 'mouse') onPreview(true); }}
      onPointerLeave={e => { if (e.pointerType === 'mouse') onPreview(false); }}
      className={cn('mx-auto block max-w-[22em] font-heading leading-[1.6] transition-opacity duration-[600ms]',
        more ? 'cursor-pointer' : 'cursor-default')}
      style={{ opacity }}>
      {/* The beats keep their place while the reply is open, so nothing on the stage moves under the pointer. */}
      <span className={cn('block transition-opacity duration-300', open && 'opacity-0')} aria-hidden={open}>
        <span aria-hidden="true"
          className="block h-[1.6em] truncate text-[0.8em] text-white/40">
          {previous}
        </span>
        {/* Balanced, so a sentence that wraps never leaves one word alone on its
            second line. Capped by height rather than line-clamp, whose -webkit-box
            would undo the balancing. A long beat steps down to fit three lines in
            the two-line box; only the beat shrinks — the box around it is fixed by
            the stage. A beat is a whole sentence, so it shrinks rather than being cut. */}
        <span key={index} className={cn('subtitles-in block overflow-hidden text-balance',
          width(current) > MAX_EM ? 'max-h-[4.8em] text-[0.66em]' : 'max-h-[3.2em]')}>{current}</span>
      </span>
      {open && (
        <span className={cn(STAGE_OPEN_LINE, 'subtitles-in text-[clamp(19px,1.6vw,24px)]')}>
          <span className="flex min-h-full flex-col justify-end py-6">
            {/* As wide as the words, then centred: a short reply stays where its subtitle was,
                a long one reads as a left-aligned paragraph. */}
            <span className="mx-auto block w-fit max-w-[22em] text-left">{text}</span>
          </span>
        </span>
      )}
    </button>
  );
}
