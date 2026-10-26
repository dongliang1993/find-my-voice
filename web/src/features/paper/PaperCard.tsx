import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, motion, useReducedMotion } from 'motion/react';
import { Bookmark, BookmarkCheck, X } from 'lucide-react';
import type { Paper } from '@shared/protocol';
import { PaperBody } from '@/features/paper/PaperBody';
import type { PaperEdit } from '@/hooks/useChat';
import { useUi, WORDS } from '@/lib/locale';
import { cn } from '@/lib/utils';

type Props = {
  paper: Paper;
  edits: PaperEdit[];
  /** Its width: the right of the stage it takes. */
  width: number;
  /** Her name, for the line she signs with. */
  signer: string;
  onSave: () => void;
  /** Off the stage. It is still in the history, and in Papers if it was saved. */
  onClose: () => void;
  /** Esc: down to a paper corner at the stage's edge, still on the stage. */
  onFold: () => void;
  /** Where it was in Papers, when it was taken from there: it flies over from that spot instead of sliding in. */
  from?: DOMRect;
};

/**
 * The paper on the stage: a sheet laid over its right side, top to bottom,
 * the stage split in two rather than a card floating on it. It slides in
 * from the stage's right edge as she starts writing and stays — saved or
 * not — until it is closed or she writes another; long, it scrolls inside
 * itself. Nothing on it but the words: its two acts come up only under the hand.
 */
export function PaperCard({ paper, edits, width, signer, onSave, onClose, onFold, from }: Props) {
  const still = useReducedMotion() ?? false;
  const ui = useUi();
  /** Her pen is still moving: saving half a paper would only save half. */
  const [writing, setWriting] = useState(paper.status === 'writing');

  // Esc puts it away, unless a field — the paper's own surface included — has the keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      onFold();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFold]);

  const hidden = still ? { opacity: 0 } : { x: '100%' };
  const card = useRef<HTMLDivElement>(null);
  const flying = Boolean(from) && !still;

  // Taken from Papers: the sheet it was, shrunk into this one. Both hang from
  // the stage's right edge, so scaling from the top right corner lands it.
  // Measured before the first paint, so it is never seen in its place first.
  useLayoutEffect(() => {
    const el = card.current;
    if (!flying || !from || !el) return;
    const to = el.getBoundingClientRect();
    animate(el, {
      x: [from.right - to.right, 0],
      y: [from.top - to.top, 0],
      scale: [from.width / to.width, 1],
      opacity: [1, 1],
    }, { duration: 0.6, ease: [0.22, 1, 0.36, 1] });
  }, []);
  const saved = Boolean(paper.savedAt);

  return (
    <motion.div ref={card}
      initial={flying ? { opacity: 0 } : hidden}
      animate={flying ? undefined : { opacity: 1, x: 0 }}
      exit={{ ...hidden, transition: { duration: still ? 0.2 : 0.5, ease: [0.4, 0, 0.2, 1] } }}
      transition={{ duration: still ? 0.2 : 0.6, ease: [0.22, 1, 0.36, 1] }}
      data-stage-paper
      style={{ width, transformOrigin: 'top right' }}
      // A sheet lying on the stage: one soft shadow off its left edge, nothing around the rest.
      className={cn('group absolute inset-y-0 right-0 z-20 flex flex-col overflow-hidden bg-(--paper) text-(--paper-ink) select-none',
        'shadow-[-14px_0_32px_-18px_rgb(60_20_10/0.55)]')}>
      <div className="grain pointer-events-none absolute inset-0 [--grain-opacity:0.06]" aria-hidden="true" />
      {/* Its two acts, under the hand, in the corner above the title: the title keeps its whole line. */}
      <div className="absolute top-3 right-3 z-10 flex gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
        <CardAction label={saved ? WORDS.saved[ui] : WORDS.save[ui]} onClick={onSave} disabled={saved || writing}>
          {saved ? <BookmarkCheck className="size-3.5" /> : <Bookmark className="size-3.5" />}
        </CardAction>
        <CardAction label={WORDS.close[ui]} onClick={onClose}><X className="size-3.5" /></CardAction>
      </div>
      <PaperBody key={paper.id} paper={paper} edits={edits} still={still} signer={signer} onWriting={setWriting} />
    </motion.div>
  );
}

/** One of the card's two acts, its name shown under it on hover. */
function CardAction({ label, onClick, disabled = false, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <span className="group/act relative">
      <button type="button" onClick={onClick} aria-label={label} disabled={disabled}
        className="grid size-7 place-items-center rounded-full text-(--paper-quiet)/70 transition-colors hover:text-(--paper-ink) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--paper-quiet)/50 disabled:pointer-events-none">
        {children}
      </button>
      <span role="tooltip"
        className="pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-[3px] bg-(--paper-ink) px-1.5 py-0.5 text-[11px] whitespace-nowrap text-(--paper) opacity-0 transition-opacity delay-300 duration-150 group-hover/act:opacity-100">
        {label}
      </span>
    </span>
  );
}
