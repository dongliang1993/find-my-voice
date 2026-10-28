import type { ReactNode } from 'react';
import { STAGE_OPEN_LINE } from '@/features/onboarding/layout';
import { cn } from '@/lib/utils';
import { MAX_EM, width, type TimedLine } from '@/features/stage/subtitles';

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
 * Her words, the whole reply at once, where the subtitles sit. A reply longer
 * than the box opens in full on a resting pointer; a click pins it open.
 */

/**
 * Her words, set so a line never breaks badly: a dash keeps to the word
 * before it, so no line starts with one, and a hyphenated word ("action-y")
 * stays whole. Not U+2011: a font without that glyph would set it in another.
 */
function keepWhole(text: string): ReactNode[] {
  return text.replace(/\s+([—–])/g, '\u00a0$1').split(/(\S+-\S+)/).map((part, i) =>
    i % 2 ? <span key={i} className="whitespace-nowrap">{part}</span> : part);
}

export function Caption({ text, expanded, preview, onPreview, onToggle, opacity }: Props) {
  const open = expanded || preview;
  /** A reply that already fits has nothing more to open: opening it would only take her coil away. */
  const more = width(text) > MAX_EM;

  // A click has to win over a resting pointer, or the line could never be closed again.
  const toggle = () => { onPreview(false); onToggle(); };
  return (
    <button type="button" onClick={more ? toggle : undefined} aria-expanded={open} disabled={!text}
      // A mouse opens it just by resting on the line. Touch cannot: there is no
      // leave to undo it, so a tap would never be able to close it again.
      onPointerEnter={e => { if (more && e.pointerType === 'mouse') onPreview(true); }}
      onPointerLeave={e => { if (e.pointerType === 'mouse') onPreview(false); }}
      // w-full: a button only grows to its content, and past a narrow window that pushes it off centre.
      className={cn('mx-auto block w-full max-w-[22em] font-heading leading-[1.6] transition-opacity duration-[600ms]',
        more ? 'cursor-pointer' : 'cursor-default')}
      style={{ opacity }}>
      {/* Balanced, so a wrapped line never leaves one word alone. Capped by height rather than
          line-clamp, whose -webkit-box would undo the balancing. */}
      <span className={cn('block max-h-[4.8em] overflow-hidden text-balance transition-opacity duration-300', open && 'opacity-0')}
        aria-hidden={open}>{keepWhole(text)}</span>
      {open && (
        <span className={cn(STAGE_OPEN_LINE, 'subtitles-in text-[clamp(19px,1.6vw,24px)]')}>
          <span className="flex min-h-full flex-col justify-end py-6">
            {/* As wide as the words, then centred: a short reply stays where its line was,
                a long one reads as a left-aligned paragraph. */}
            <span className="mx-auto block w-fit max-w-[22em] text-left">{keepWhole(text)}</span>
          </span>
        </span>
      )}
    </button>
  );
}
