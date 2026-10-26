import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import type { Letter } from '@shared/protocol';
import { EnvelopeArt } from '@/features/letter/EnvelopeArt';
import { PANEL } from '@/features/dock/appSwitch';
import { dayOf, useUi, WORDS } from '@/lib/locale';
import { cn } from '@/lib/utils';
import { useScrollFade } from '@/hooks/useScrollFade';

const sealOf = (letter: Letter) => (letter.status === 'writing' ? 'none' : letter.openedAt ? 'hollow' : 'filled');

/** What a letter is about, in a few words: the first two things she picked, or how it begins. */
function gist(letter: Letter) {
  const names = letter.blocks.flatMap(b => (b.type === 'item' ? [b.name] : [])).slice(0, 2);
  if (names.length) return names.join(' · ');
  const first = letter.blocks.find(b => b.type === 'paragraph');
  return first?.type === 'paragraph' ? first.text.replace(/\s+/g, ' ') : '';
}

/**
 * A letter in the chat history: a small envelope, its title, the first things
 * in it. Opening it shows the whole letter at once — it was already written.
 * Always the latest version; the edits that changed it are in the chat around it.
 */
export function LetterCard({ letter, summary, onOpen }: { letter: Letter | undefined; summary: string; onOpen: (letter: Letter) => void }) {
  const ui = useUi();
  if (!letter) return <p className="text-[13px] text-muted-foreground italic">{summary.replace(/^（|）$/g, '')} · {ui === 'zh' ? '已删除' : 'deleted'}</p>;
  const title = letter.title || (letter.status === 'writing' ? `${WORDS.writing[ui]}…` : WORDS.aLetter[ui]);
  return (
    <button type="button" onClick={() => onOpen(letter)}
      className="flex max-w-full items-center gap-3 rounded-[5px] bg-(--paper) px-3 py-2.5 text-left text-(--paper-ink) shadow-[0_2px_10px_-4px_rgb(60_20_10/0.35)] ring-1 ring-(--paper-edge) transition-transform duration-300 hover:-translate-y-px">
      <EnvelopeArt seal={sealOf(letter)} className="h-7 w-10 flex-none" />
      <span className="min-w-0">
        <span className="block truncate font-heading text-[15px]">{title}</span>
        <span className="block truncate text-[12px] text-(--paper-quiet)">{letter.status === 'broken' ? WORDS.unfinished[ui] : gist(letter)}</span>
      </span>
    </button>
  );
}

function InboxLetter({ letter, active, onOpen, onDelete }: { letter: Letter; active: boolean; onOpen: (letter: Letter) => void; onDelete: (letter: Letter) => void }) {
  const [confirming, setConfirming] = useState(false);
  const ui = useUi();
  const unread = !letter.openedAt && letter.status !== 'writing';
  return (
    <li className="group relative">
      <button type="button" onClick={() => onOpen(letter)} aria-current={active || undefined}
        className={cn('flex w-full items-baseline gap-1 rounded-md py-2 pr-8 pl-1.5 text-left transition-colors duration-200 focus-visible:outline-none',
          active ? 'bg-primary/10 text-primary' : 'hover:bg-wash focus-visible:bg-wash')}>
        {/* Unread keeps a red dot, the seal not yet broken. What she is still
            writing keeps no dot: the seal arrives with the finishing. */}
        <span aria-hidden="true" className={cn('mt-[7px] size-[7px] flex-none rounded-full transition-colors',
          unread ? 'bg-(--paper-seal)' : 'bg-transparent')}/>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate font-heading text-[14px] leading-snug', letter.status === 'writing' && !active && 'text-(--paper-quiet)')}>
            {letter.title || WORDS[letter.status === 'writing' ? 'writing' : 'aLetter'][ui]}
          </span>
          <span className={cn('mt-0.5 block text-[11px]', active ? 'text-primary/70' : 'text-(--paper-quiet)')}>
            {letter.status === 'broken' ? WORDS.unfinished[ui] : dayOf(letter.createdAt, ui)}
          </span>
        </span>
      </button>
      <button type="button" onClick={() => setConfirming(true)} aria-label={`${WORDS.delete[ui]} ${letter.title}`}
        className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-(--paper-quiet) opacity-0 transition-opacity group-hover:opacity-70 hover:opacity-100! focus-visible:opacity-100">
        <X className="size-3.5" />
      </button>
      <AnimatePresence>
        {confirming && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={PANEL}
            className="absolute inset-0 flex items-center justify-between gap-2 rounded-md bg-(--paper) px-3 text-[13px] ring-1 ring-(--paper-edge)">
            <p>{WORDS.deleteLetter[ui]}</p>
            <div className="flex gap-1.5">
              <button type="button" autoFocus onClick={() => setConfirming(false)}
                className="rounded-full px-3 py-1 ring-1 ring-(--paper-edge) transition-colors hover:bg-wash">{WORDS.keep[ui]}</button>
              <button type="button" onClick={() => { setConfirming(false); onDelete(letter); }}
                className="rounded-full bg-(--paper-seal) px-3 py-1 text-white transition-opacity hover:opacity-90">{WORDS.delete[ui]}</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/**
 * Every letter she has written: the list on the left, the paper on the right.
 * The one still being written stays at the top; unread ones keep their red
 * dot until they are opened. Deleting asks first — it was a thing she made
 * for them.
 */
export function Inbox({ letters, openId, paper, onOpen, onDelete }: {
  letters: Letter[];
  /** The letter on the paper; kept so the list can show which one it is. */
  openId: string | null;
  /** The open letter as paper, or nothing while none is. */
  paper: ReactNode;
  onOpen: (letter: Letter) => void;
  onDelete: (letter: Letter) => void;
}) {
  const ui = useUi();
  const fade = useScrollFade<HTMLUListElement>();
  // Newest first, but the one still being written stays at the top: it is the letter of the day.
  const writing = letters.filter(l => l.status === 'writing');
  const rest = letters.filter(l => l.status !== 'writing');
  const ordered = [...writing, ...rest];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col sm:w-[300px] sm:flex-none sm:border-r sm:border-(--paper-edge)">
        {ordered.length ? (
          <ul ref={fade} className="scroll-fade grid min-h-0 flex-1 content-start gap-0.5 overflow-y-auto overscroll-contain px-4 pt-3 pb-28 sm:pb-10">
            {ordered.map(letter => <InboxLetter key={letter.id} letter={letter} active={letter.id === openId} onOpen={onOpen} onDelete={onDelete} />)}
          </ul>
        ) : (
          <p className="grid flex-1 place-items-center px-8 pb-8 text-center text-[13px] leading-relaxed text-(--paper-quiet)">
            {WORDS.noLetters[ui]}
          </p>
        )}
      </div>
      {/* The paper: the right column keeps the letter's own size, whatever the list is doing. */}
      <div className="relative hidden min-w-0 flex-1 sm:block">
        {paper}
      </div>
    </div>
  );
}
