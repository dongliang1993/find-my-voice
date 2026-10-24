import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Letter } from '@shared/protocol';
import { EnvelopeArt } from '@/features/letter/EnvelopeArt';
import { cn } from '@/lib/utils';

const sealOf = (letter: Letter) => (letter.status === 'writing' ? 'none' : letter.openedAt ? 'hollow' : 'filled');
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });

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
  if (!letter) return <p className="text-[13px] text-muted-foreground italic">{summary.replace(/^（|）$/g, '')} · 已删除</p>;
  const title = letter.title || (letter.status === 'writing' ? '正在写…' : '一封信');
  return (
    <button type="button" onClick={() => onOpen(letter)}
      className="flex max-w-full items-center gap-3 rounded-[5px] bg-(--paper) px-3 py-2.5 text-left text-(--paper-ink) shadow-[0_2px_10px_-4px_rgb(60_20_10/0.35)] ring-1 ring-(--paper-edge) transition-transform duration-300 hover:-translate-y-px">
      <EnvelopeArt seal={sealOf(letter)} className="h-7 w-10 flex-none" />
      <span className="min-w-0">
        <span className="block truncate font-heading text-[15px]">{title}</span>
        <span className="block truncate text-[12px] text-(--paper-quiet)">{letter.status === 'broken' ? '没写完' : gist(letter)}</span>
      </span>
    </button>
  );
}

function InboxLetter({ letter, active, onOpen, onDelete }: { letter: Letter; active: boolean; onOpen: (letter: Letter) => void; onDelete: (letter: Letter) => void }) {
  const [confirming, setConfirming] = useState(false);
  const unread = !letter.openedAt && letter.status !== 'writing';
  return (
    <li className="group relative">
      <button type="button" onClick={() => onOpen(letter)} aria-current={active || undefined}
        className={cn('flex w-full items-baseline gap-1 rounded-[4px] px-1 py-1.5 text-left transition-colors focus-visible:outline-none',
          active ? 'bg-(--paper-ink)/[0.05]' : 'hover:bg-(--paper-ink)/[0.04] focus-visible:bg-(--paper-ink)/[0.04]')}>
        {/* Unread keeps a red dot, the seal not yet broken. What she is still
            writing keeps no dot: the seal arrives with the finishing. */}
        <span aria-hidden="true" className={cn('mt-[7px] size-[7px] flex-none rounded-full transition-colors',
          unread ? 'bg-(--paper-seal)' : 'bg-transparent')}/>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate font-heading text-[14px] leading-snug', letter.status === 'writing' && 'text-(--paper-quiet)')}>
            {letter.title || (letter.status === 'writing' ? '正在写' : '一封信')}
          </span>
          <span className="mt-0.5 block text-[10px] text-(--paper-quiet)">{letter.status === 'broken' ? '没写完' : dayOf(letter.createdAt)}</span>
        </span>
      </button>
      <button type="button" onClick={() => setConfirming(true)} aria-label={`删除「${letter.title}」`}
        className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full text-(--paper-quiet) opacity-0 transition-opacity group-hover:opacity-70 hover:opacity-100! focus-visible:opacity-100">
        <X className="size-3.5" />
      </button>
      {confirming && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[4px] bg-(--paper)/95 text-[13px]">
          <p>删掉这封信？</p>
          <div className="flex gap-2">
            <button type="button" autoFocus onClick={() => setConfirming(false)}
              className="rounded-full px-3 py-1 ring-1 ring-(--paper-edge) hover:bg-(--paper-ink)/5">留着</button>
            <button type="button" onClick={() => { setConfirming(false); onDelete(letter); }}
              className="rounded-full bg-(--paper-seal) px-3 py-1 text-white hover:opacity-90">删掉</button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Every letter she has written: the list on the left, the paper on the right.
 * The one still being written stays at the top; unread ones keep their red
 * dot until they are opened. Deleting asks first — it was a thing she made
 * for them.
 */
export function Inbox({ letters, openId, paper, onOpen, onDelete, onClose }: {
  letters: Letter[];
  /** The letter on the paper; kept so the list can show which one it is. */
  openId: string | null;
  /** The open letter as paper, or nothing while none is. */
  paper: ReactNode;
  onOpen: (letter: Letter) => void;
  onDelete: (letter: Letter) => void;
  onClose: () => void;
}) {
  // Newest first, but the one still being written stays at the top: it is the letter of the day.
  const writing = letters.filter(l => l.status === 'writing');
  const rest = letters.filter(l => l.status !== 'writing');
  const ordered = [...writing, ...rest];

  return (
    <div className="flex h-full bg-(--paper) text-(--paper-ink)">
      <div className="flex min-w-0 flex-1 flex-col sm:w-[38%] sm:flex-none sm:border-r sm:border-(--paper-edge)">
        {ordered.length ? (
          <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {ordered.map(letter => <InboxLetter key={letter.id} letter={letter} active={letter.id === openId} onOpen={onOpen} onDelete={onDelete} />)}
          </ul>
        ) : (
          <p className="grid flex-1 place-items-center px-8 pb-8 text-center text-[13px] leading-relaxed text-(--paper-quiet)">
            还没有信。她写给你的东西，会收在这里。
          </p>
        )}
      </div>
      {/* The paper: the right column keeps the letter's own size, whatever the
          list is doing. Its close sits at the panel's own corner. */}
      <div className="relative hidden min-w-0 flex-1 sm:block">
        <button type="button" onClick={onClose} aria-label="收起信"
          className="absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-full text-(--paper-quiet)/45 transition-colors hover:text-(--paper-quiet) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--paper-quiet)/50">
          <X className="size-4" />
        </button>
        {paper ?? ( null
          // <p className="grid h-full place-items-center px-8 text-center font-heading text-[15px] italic text-(--paper-quiet)">
          //   挑一封信，在灯下读。
          // </p>
        )}
      </div>
    </div>
  );
}
