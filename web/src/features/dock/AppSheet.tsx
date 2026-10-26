import { useEffect, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { Spiral } from '@/components/Spiral';
import { APP_SWITCH, APP_SWITCH_STILL, ARRIVED, ARRIVING } from '@/features/dock/appSwitch';
import { useWords } from '@/lib/locale';
import { cn } from '@/lib/utils';

/** The stage's box in the room: every app takes exactly the stage's place. */
export type Frame = { left: number; top: number; width: number; height: number };

/** What the conversation is doing, for the small wave at the top of every app. */
export type Presence = { thinking: boolean; listening: boolean };

type Props = {
  title: string;
  frame: Frame | null;
  presence: Presence;
  /** The app's own buttons, left of the close. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
};

/**
 * An app other than the conversation: a sheet of paper in the stage's frame,
 * under the switcher. Its bar mirrors the stage's — the name where hers is,
 * the close where the history button is — and her wave sits in the middle,
 * so she is still in the room while you are elsewhere.
 */
export function AppSheet({ title, frame, presence, actions, onClose, children }: Props) {
  const still = useReducedMotion() ?? false;
  const word = useWords();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div role="dialog" aria-label={title}
      initial={still ? { opacity: 0 } : ARRIVING}
      animate={ARRIVED}
      exit={still ? { opacity: 0 } : ARRIVING}
      transition={still ? APP_SWITCH_STILL : APP_SWITCH}
      style={frame ?? undefined}
      // Under the switcher, which stays the way out on a phone where the stage is the whole screen.
      className={cn('paper-sheet absolute z-10 flex flex-col overflow-hidden shadow-(--panel-shadow) ring-1 ring-(--paper-edge)',
        !frame && 'inset-0')}>
      <header className="relative flex flex-none items-center justify-between px-6 pt-[calc(1rem+env(safe-area-inset-top))] pb-2">
        <h2 className="font-heading text-[20px] font-normal italic">{title}</h2>
        <Spiral thinking={presence.thinking} listening={presence.listening} stage="awake" rest={0.12} weight={1 / 40}
          className="pointer-events-none absolute top-[calc(1rem+env(safe-area-inset-top)+8px)] left-1/2 h-5 w-20 -translate-x-1/2 [--spiral:var(--her)]" />
        <div className="flex items-center gap-2">
          {actions}
          <button type="button" onClick={onClose} aria-label={word('close')}
            className="grid size-9 place-items-center rounded-full text-muted-foreground ring-1 ring-(--paper-edge) transition-colors hover:bg-wash hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      </header>
      {children}
    </motion.div>
  );
}
