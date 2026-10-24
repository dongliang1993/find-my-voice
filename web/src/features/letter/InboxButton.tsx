import { EnvelopeArt } from '@/features/letter/EnvelopeArt';
import { cn } from '@/lib/utils';

/**
 * The inbox, at the corner of the room — always there, never hiding with the
 * rest of the chrome. The seal is the wax: pressed red while a finished letter
 * waits unread, hollow once everything has been read. What she is still
 * writing carries no seal yet; one arrives with the finishing.
 */
export function InboxButton({ seal, open, onToggle }: { seal: 'filled' | 'hollow' | 'none'; open: boolean; onToggle: () => void }) {
  const unread = seal === 'filled';
  return (
    <button type="button" onClick={onToggle} aria-pressed={open} aria-label={unread ? '信箱，有没读过的信' : '信箱'}
      className={cn('relative grid size-12 place-items-center rounded-sm bg-(--paper) ring-1 ring-(--paper-edge)',
        'shadow-[0_6px_16px_-8px_rgb(60_20_10/0.4)] transition-transform duration-300 hover:-translate-y-0.5',
        'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--paper-seal)/60')}>
      <EnvelopeArt seal={seal} className="h-8 w-8" />
    </button>
  );
}
