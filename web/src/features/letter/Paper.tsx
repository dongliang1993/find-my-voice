import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Letter, LetterBlock } from '@shared/protocol';
import { linkUrl } from '@shared/links';
import { Spiral } from '@/components/Spiral';
import { blockSegments, caughtUp, letterSegments, shownChunks, type Segment } from '@/features/letter/pace';
import { useEditPlayer, type Row } from '@/features/letter/useEditPlayer';
import { usePen, type PenMode } from '@/features/letter/usePen';
import { cn } from '@/lib/utils';
import type { LetterEdit } from '@/hooks/useChat';
import { api } from '@/lib/api';
import { dayOf, useSay, useUi } from '@/lib/locale';
import { useScrollFade } from '@/hooks/useScrollFade';

type Props = {
  letter: Letter;
  mode: PenMode;
  edits: LetterEdit[];
  /** The user's last words, and her last line: the conversation goes on under the paper. */
  caption: string;
  herLine: string;
  thinking: boolean;
  listening: boolean;
  onClose: () => void;
  /**
   * `overlay` (default): unfolded over a dimmed stage. `embedded`: the paper
   * alone, filling whatever box it is in — the right column of the inbox.
   */
  embedded?: boolean;
};

const UNFOLD = { duration: 0.7, ease: [0.65, 0, 0.35, 1] as const };

/** What a field shows: the chunks written so far, or null for all of it. */
type Source = (segment: Segment) => { at: number; text: string }[] | null;
/** Where her cursor is: the key of the segment it sits at the end of. */
type Cursor = { key: string; stamp: number } | null;

function Ink({ segment, source, cursor }: { segment: Segment; source: Source; cursor: Cursor }) {
  const chunks = source(segment);
  return (
    <>
      {chunks === null ? segment.text : chunks.map(c => <span key={c.at} className="ink-in">{c.text}</span>)}
      {/* Remounted with every chunk, so it holds still while writing and blinks once she pauses. */}
      {cursor?.key === segment.key && (
        <span key={cursor.stamp} aria-hidden="true" className="pen-cursor ml-px inline-block h-[1em] w-[1.5px] translate-y-[0.16em] bg-(--paper-seal)" />
      )}
    </>
  );
}

/**
 * One block of the letter. Items are a name and a line of hers after it, the
 * name the only thing on the paper that does anything: it opens the search for
 * it in the user's own browser.
 */
function Block({ block, source, cursor, letterId }: { block: LetterBlock; source: Source; cursor: Cursor; letterId: string }) {
  const say = useSay();
  const [first, second] = blockSegments(block);
  if (!first) return null;
  if (block.type === 'heading') {
    return <h3 className="mt-8 mb-1 font-heading text-[16px] text-(--paper-quiet) italic first:mt-0"><Ink segment={first} source={source} cursor={cursor} /></h3>;
  }
  if (block.type === 'paragraph') {
    return <p className="my-3 font-heading text-[15px] leading-[1.8] whitespace-pre-line"><Ink segment={first} source={source} cursor={cursor} /></p>;
  }
  // A check line, were one ever on a letter: the words, no box — a letter is read, not worked through.
  if (block.type === 'check') {
    return <p className={cn('my-2 font-heading text-[15px] leading-[1.8]', block.done && 'text-(--paper-quiet)')}>{block.done ? block.text : <Ink segment={first} source={source} cursor={cursor} />}</p>;
  }
  const open = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!block.link) return;
    const url = linkUrl(block.link);
    // The server opens it in the system browser; where it cannot, this page does.
    api.openLetterLink(letterId, block.id).catch(() => window.open(url, '_blank', 'noopener'));
  };
  return (
    <p className="my-2 font-heading text-[15px] leading-[1.8]">
      {block.link ? (
        <button type="button" onClick={open} title={say(`去找「${block.name}」`, `Look for “${block.name}”`)}
          className="cursor-pointer text-left decoration-transparent decoration-[0.5px] underline underline-offset-4 transition-[text-decoration-color] duration-200 hover:decoration-(--paper-quiet)/60 focus-visible:outline-none focus-visible:decoration-(--paper-quiet)/60">
          <Ink segment={first} source={source} cursor={cursor} />
        </button>
      ) : <Ink segment={first} source={source} cursor={cursor} />}
      {second && <span className="ml-3 text-[15px] text-(--paper-quiet)"><Ink segment={second} source={source} cursor={cursor} /></span>}
    </p>
  );
}

/** A line she is writing fresh during an edit: its own pen, at the writing pace. */
function Rewrite({ block, letterId, still, onWritten }: { block: LetterBlock; letterId: string; still: boolean; onWritten: () => void }) {
  const segments = useMemo(() => blockSegments(block), [block]);
  const { pen } = usePen(segments, 'live', still);
  const done = caughtUp(pen, segments);
  useEffect(() => { if (done) onWritten(); }, [done, onWritten]);
  const source: Source = s => shownChunks(pen, segments, segments.findIndex(x => x.key === s.key));
  const at = segments[Math.min(pen.seg, segments.length - 1)];
  return <Block block={block} source={source} cursor={done || !at ? null : { key: at.key, stamp: pen.lastAt }} letterId={letterId} />;
}

/**
 * The letter, unfolded from its envelope over a dimmed stage. She writes it
 * here at a hand's pace; a click anywhere on the paper skips to what she has
 * written so far. Changes she makes while it is open are shown being made.
 *
 * Not a dialog, deliberately: the circle's Space key ignores anything inside
 * one, and holding Space to talk to her has to keep working with the letter open.
 */
export function Paper({ letter, mode, edits, caption, herLine, thinking, listening, onClose, embedded = false }: Props) {
  const ui = useUi();
  const say = useSay();
  const still = useReducedMotion() ?? false;
  const segments = useMemo(() => letterSegments(letter), [letter]);
  const { pen, skip } = usePen(segments, mode, still);
  const writing = letter.status === 'writing' || !caughtUp(pen, segments);
  const scroller = useRef<HTMLDivElement>(null);
  const fade = useScrollFade<HTMLDivElement>();
  const scrollerRef = useCallback((el: HTMLDivElement | null) => { scroller.current = el; return fade(el); }, [fade]);
  const lines = useRef(new Map<string, HTMLElement>());
  /** Follows the pen down while she writes, until the user scrolls up to reread. */
  const follow = useRef(true);

  const scrollTo = useCallback((blockId: string) => {
    const box = scroller.current;
    const line = lines.current.get(blockId);
    if (box && line) box.scrollTo({ top: Math.max(0, line.offsetTop - box.clientHeight / 3), behavior: still ? 'auto' : 'smooth' });
  }, [still]);
  const { rows, resting, onWritten } = useEditPlayer({ letterId: letter.id, edits, ready: !writing, still, scrollTo });

  // In the inbox the whole panel closes together, Escape included.
  useEffect(() => {
    if (embedded) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [embedded, onClose]);

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && writing && follow.current) box.scrollTop = box.scrollHeight;
  }, [pen, writing]);

  // By key, not by object: a block rebuilds its own segments, equal but never the same.
  const source: Source = s => shownChunks(pen, segments, segments.findIndex(x => x.key === s.key));
  const current = segments[Math.min(pen.seg, segments.length - 1)];
  const cursor: Cursor = writing && current ? { key: current.key, stamp: pen.lastAt } : null;
  const whole: Source = () => null;

  /**
   * The letter as it stands, or the lines of an edit being played. While she
   * writes, a block the pen has not reached is not on the paper at all — an
   * empty line waiting for words would give away what is coming.
   */
  const reached = (block: LetterBlock) => pen.instant || segments.findIndex(s => s.key === blockSegments(block)[0]?.key) <= pen.seg;
  const body: Row[] = rows ?? letter.blocks.filter(reached).map(block => ({ key: block.id, block, phase: 'shown' }));

  // The paper itself: everything above the sheet is the overlay's.
  const sheet = (
    <motion.article layoutId={embedded ? undefined : `letter-${letter.id}`} transition={{ layout: still ? { duration: 0 } : UNFOLD }}
      initial={{ opacity: 0, scale: embedded ? 1 : 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
      aria-label={say(`信：${letter.title}`, `Letter: ${letter.title}`)} onClick={writing ? skip : undefined}
      className={embedded
        ? 'relative h-full overflow-hidden bg-(--paper) text-(--paper-ink)'
        : 'relative w-[min(640px,86vw)] overflow-hidden rounded-[3px] bg-(--paper) text-(--paper-ink) shadow-[0_30px_80px_-20px_rgb(20_6_2/0.55)]'}>
      {/* Full height when embedded, or the scroller inside has no height to scroll in and the paper simply cuts off. */}
      <motion.div className={embedded ? 'h-full' : undefined} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: still ? 0 : 0.45, duration: 0.3 } }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}>
        <div className="grain pointer-events-none absolute inset-0 [--grain-opacity:0.08]" aria-hidden="true" />
        {!embedded && (
          <button type="button" onClick={event => { event.stopPropagation(); onClose(); }} aria-label={say('收起信', 'Put the letter away')}
            className="absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-full text-(--paper-quiet)/45 transition-colors hover:text-(--paper-quiet) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--paper-quiet)/50">
            <X className="size-4" />
          </button>
        )}
        <div ref={scrollerRef} onScroll={() => {
          const box = scroller.current;
          if (box) follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
        }} className={embedded
          ? 'scroll-fade relative h-full overflow-y-auto overscroll-contain px-8 pt-4 pb-10 sm:px-14 sm:pt-6'
          : 'scroll-fade relative max-h-[calc(100dvh-12rem)] overflow-y-auto overscroll-contain px-8 pt-10 pb-12 sm:px-14 sm:pt-12 sm:pb-14'}>
            {/* She is still here, and can still hear: a small wave at the top of the page. */}
            {!embedded && (
              <Spiral thinking={thinking} listening={listening} stage="awake" rest={0.12} weight={1 / 40}
                className="mx-auto -mt-4 mb-6 h-5 w-20 [--spiral:var(--paper-seal)]" />
            )}
            {letter.title && (
              <h2 className="mb-6 font-heading text-[26px] leading-snug">
                <Ink segment={segments[0]!} source={rows ? whole : source} cursor={rows ? null : cursor} />
              </h2>
            )}
            {body.map(({ key, block, phase }) => (
              <AnimatePresence key={key} initial={false}>
                {phase !== 'gone' && (
                  <motion.div ref={el => { if (el) lines.current.set(block.id, el); }}
                    initial={phase === 'write' && !still ? { height: 0, opacity: 0 } : false}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0, transition: { duration: still ? 0 : 0.3 } }}
                    transition={{ duration: still ? 0 : 0.3 }}
                    className="relative">
                    {phase === 'write'
                      ? <Rewrite block={block} letterId={letter.id} still={still} onWritten={onWritten} />
                      : <Block block={block} letterId={letter.id} source={rows ? whole : source}
                        cursor={rows ? (resting === block.id ? { key: blockSegments(block).at(-1)!.key, stamp: 0 } : null) : cursor} />}
                    {phase === 'strike' && (
                      <span aria-hidden="true" className="ink-strike pointer-events-none absolute top-[calc(0.5rem+0.9em)] right-0 left-0 h-[1.5px] bg-(--paper-seal)" />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            ))}
            {/* Not written out: once the last word is down, her name simply appears. */}
            <motion.footer initial={false} animate={{ opacity: writing ? 0 : 1 }} transition={{ duration: still ? 0 : 0.8 }}
              className="mt-10 text-right">
              <p className="font-heading text-[18px] italic">{letter.signature}</p>
              <p className="mt-1 text-[13px] text-(--paper-quiet)">{dayOf(letter.createdAt, ui, true)}</p>
            </motion.footer>
            {letter.status === 'broken' && (
              <p className="mt-6 text-center text-[13px] text-(--paper-quiet)">{say('这封信写到一半断了。', 'This letter broke off halfway.')}</p>
            )}
          </div>
        </motion.div>
      </motion.article>
  );

  // Embedded: the sheet alone, in whatever box it was given.
  if (embedded) return sheet;

  return (
    <motion.div className="absolute inset-0 z-40 flex flex-col items-center justify-center px-4 py-6"
      initial={{ opacity: 1 }} exit={{ opacity: 1 }}>
      {/* The stage steps back: darker, a little out of focus. A click on it puts the letter away. */}
      <motion.button type="button" aria-label={say('收起信', 'Put the letter away')} onClick={onClose} tabIndex={-1}
        className="absolute inset-0 cursor-default bg-[rgb(28_10_6/0.5)] backdrop-blur-[3px]"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: still ? 0 : 0.6 }} />
      {sheet}
    </motion.div>
  );
}
