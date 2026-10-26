import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, ChevronLeft, Copy, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Paper } from '@shared/protocol';
import { paperText } from '@shared/paper-text';
import { PANEL } from '@/features/dock/appSwitch';
import { byDay, preview, type Day } from '@/features/paper/groups';
import { PaperBody } from '@/features/paper/PaperBody';
import type { PaperEdit } from '@/hooks/useChat';
import { useScrollFade } from '@/hooks/useScrollFade';
import { dayOf, timeOf, useUi, WORDS, type Ui } from '@/lib/locale';
import { cn } from '@/lib/utils';

/** What a paper is about, in a few words: the first two things on it, or how it begins. */
export function gist(paper: Paper) {
  const names = paper.blocks.flatMap(b => (b.type === 'item' ? [b.name] : b.type === 'check' ? [b.text] : [])).slice(0, 2);
  if (names.length) return names.join(' · ');
  const first = paper.blocks.find(b => b.type === 'paragraph');
  return first?.type === 'paragraph' ? first.text.replace(/\s+/g, ' ') : '';
}

/**
 * A paper in the chat history: its title and the first things on it. Clicking
 * it puts it back on the stage, as it now stands.
 */
export function PaperChip({ paper, summary, onOpen }: { paper: Paper | undefined; summary: string; onOpen: (paper: Paper) => void }) {
  const ui = useUi();
  if (!paper) return <p className="text-[13px] text-muted-foreground italic">{summary.replace(/^（|）$/g, '')} · {ui === 'zh' ? '已删除' : 'deleted'}</p>;
  const title = paper.title || (paper.status === 'writing' ? `${WORDS.writing[ui]}…` : WORDS.untitled[ui]);
  return (
    <button type="button" onClick={() => onOpen(paper)}
      className="flex max-w-full flex-col rounded-[5px] bg-(--paper) px-3 py-2.5 text-left text-(--paper-ink) shadow-[0_2px_10px_-4px_rgb(60_20_10/0.35)] ring-1 ring-(--paper-edge) transition-transform duration-300 hover:-translate-y-px">
      <span className="block truncate font-heading text-[15px]">{title}</span>
      <span className="block truncate text-[12px] text-(--paper-quiet)">{gist(paper)}</span>
    </button>
  );
}

const dayLabel = (day: Day, ui: Ui) =>
  day === 'today' ? WORDS.today[ui] : day === 'yesterday' ? WORDS.yesterday[ui] : dayOf(day, ui);

function Row({ paper, active, onOpen }: { paper: Paper; active: boolean; onOpen: (paper: Paper) => void }) {
  const ui = useUi();
  const line = preview(paper);
  return (
    <li>
      <button type="button" onClick={() => onOpen(paper)} aria-current={active || undefined}
        className={cn('block w-full rounded-md px-3 py-2 text-left transition-colors duration-200 focus-visible:outline-none',
          active ? 'bg-primary/10' : 'hover:bg-wash focus-visible:bg-wash')}>
        <span className="flex items-baseline gap-3">
          <span className={cn('min-w-0 flex-1 truncate font-heading text-[14px] leading-snug', active && 'text-primary')}>{paper.title || WORDS.untitled[ui]}</span>
          <span className="flex-none text-[11px] text-(--paper-quiet) tabular-nums">{timeOf(paper.createdAt, ui)}</span>
        </span>
        {line && <span className="mt-0.5 block truncate text-[12px] text-(--paper-quiet)">{line}</span>}
      </button>
    </li>
  );
}

/** One of the open paper's acts: an icon, its name under it on hover. */
function Act({ label, onClick, children }: { label: string; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode }) {
  return (
    <span className="group/act relative">
      <button type="button" onClick={onClick} aria-label={label}
        className="grid size-8 place-items-center rounded-full text-(--paper-quiet) transition-colors hover:bg-wash hover:text-(--paper-ink) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--paper-quiet)/50">
        {children}
      </button>
      <span role="tooltip"
        className="pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-[3px] bg-(--paper-ink) px-1.5 py-0.5 text-[11px] whitespace-nowrap text-(--paper) opacity-0 transition-opacity delay-300 duration-150 group-hover/act:opacity-100">
        {label}
      </span>
    </span>
  );
}

/**
 * The open paper's three acts, faded in at its top right under the hand: back
 * onto the stage to go on with her, copied out as text, or deleted — that
 * one asks first, it was a thing she made.
 */
function Acts({ paper, onStage, onDelete }: { paper: Paper; onStage: (paper: Paper, from: DOMRect | null) => void; onDelete: (paper: Paper) => void }) {
  const ui = useUi();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const copy = () => {
    const text = [paper.title, paperText(paper.blocks)].filter(Boolean).join('\n\n');
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      toast(WORDS.copied[ui]);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => { });
  };
  return (
    <div className={cn('absolute top-3 right-4 z-10 flex gap-0.5 transition-opacity duration-200',
      confirming ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100')}>
      <Act label={WORDS.toStage[ui]} onClick={event => onStage(paper, event.currentTarget.closest('[data-paper-pane]')?.getBoundingClientRect() ?? null)}><SquareArrowOutUpRight className="size-4" /></Act>
      <Act label={WORDS.copy[ui]} onClick={copy}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Act>
      <Act label={WORDS.delete[ui]} onClick={() => setConfirming(true)}><Trash2 className="size-4" /></Act>
      <AnimatePresence>
        {confirming && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={PANEL}
            className="absolute top-full right-0 mt-2 flex items-center gap-3 rounded-md bg-(--paper) py-2 pr-2 pl-3 text-[13px] whitespace-nowrap shadow-[0_8px_24px_-12px_rgb(60_20_10/0.45)] ring-1 ring-(--paper-edge)">
            <p>{WORDS.deletePaper[ui]}</p>
            <div className="flex gap-1.5">
              <button type="button" autoFocus onClick={() => setConfirming(false)}
                className="rounded-full px-3 py-1 ring-1 ring-(--paper-edge) transition-colors hover:bg-wash">{WORDS.keep[ui]}</button>
              <button type="button" onClick={() => { setConfirming(false); onDelete(paper); }}
                className="rounded-full bg-(--paper-seal) px-3 py-1 text-white transition-opacity hover:opacity-90">{WORDS.delete[ui]}</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Everything saved, by the day it was written, newest first: the list on the
 * left, the paper on the right — read, ticked and rewritten by hand here as
 * on the stage, and what she is asked to change while it is open is this one.
 */
export function Papers({ papers, edits, openId, signer, onOpen, onStage, onDelete }: {
  /** The saved ones. */
  papers: Paper[];
  edits: PaperEdit[];
  openId: string | null;
  /** Her name, for the line she signs with. */
  signer: string;
  onOpen: (paper: Paper | null) => void;
  /** Back onto the stage, to go on with her there; `from` is where it was, for the flight. */
  onStage: (paper: Paper, from: DOMRect | null) => void;
  onDelete: (paper: Paper) => void;
}) {
  const ui = useUi();
  const still = useReducedMotion() ?? false;
  const fade = useScrollFade<HTMLDivElement>();
  const open = papers.find(p => p.id === openId);
  const days = byDay(papers, new Date());

  return (
    <div className="flex min-h-0 flex-1">
      {/* On a phone the list and the paper take turns; side by side from there up. */}
      <div className={cn('min-w-0 flex-1 flex-col overflow-hidden sm:flex sm:w-[300px] sm:flex-none sm:border-r sm:border-(--paper-edge)', open ? 'hidden' : 'flex')}>
        {papers.length ? (
          <div ref={fade} className="scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-28 sm:pb-10">
            {days.map(({ day, papers: those }) => (
              <section key={day} className="mb-3">
                <h3 className="px-3 pt-2 pb-1 text-[13px] text-(--paper-quiet)">{dayLabel(day, ui)}</h3>
                <ul className="grid grid-cols-1 gap-0.5">
                  {those.map(paper => <Row key={paper.id} paper={paper} active={paper.id === openId} onOpen={onOpen} />)}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="grid flex-1 place-items-center px-8 pb-8 text-center text-[13px] leading-relaxed text-(--paper-quiet)">
            {WORDS.noPapers[ui]}
          </p>
        )}
      </div>
      <div data-paper-pane className={cn('group relative min-w-0 flex-1 flex-col sm:flex', open ? 'flex' : 'hidden')}>
        {open && (
          <>
            <button type="button" onClick={() => onOpen(null)} aria-label={WORDS.close[ui]}
              className="absolute top-3.5 left-3 z-10 grid size-8 place-items-center rounded-full text-(--paper-quiet) sm:hidden">
              <ChevronLeft className="size-4" />
            </button>
            <Acts key={open.id} paper={open} onStage={onStage} onDelete={onDelete} />
            <PaperBody key={open.id} paper={open} edits={edits} still={still} signer={signer} page />
          </>
        )}
      </div>
    </div>
  );
}
