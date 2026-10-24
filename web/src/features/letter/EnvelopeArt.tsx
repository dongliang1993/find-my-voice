import { cn } from '@/lib/utils';

/**
 * The envelope, drawn: a cream rectangle, the flap as two thin lines meeting
 * in the middle, and where they meet, a seal. Not an icon — it is the same
 * object on the stage, in the history and in the inbox, at different sizes.
 *
 * `seal`: `filled` sealed and unread, `hollow` read, `none` still being written.
 */
export function EnvelopeArt({ seal, className }: { seal: 'filled' | 'hollow' | 'none'; className?: string }) {
  return (
    <svg viewBox="0 0 56 40" aria-hidden="true" className={cn('block overflow-visible', className)}>
      <rect x="0.5" y="0.5" width="55" height="39" rx="2" className="fill-(--paper) stroke-(--paper-edge)" strokeWidth="0.8" />
      {/* The lower folds, fainter than the flap. */}
      <path d="M1.5 38.5 L22 19.5 M54.5 38.5 L34 19.5" fill="none" className="stroke-(--paper-edge)" strokeWidth="0.6" />
      {/* The flap: the line that says "envelope". */}
      <path d="M1.5 1.8 L28 23 L54.5 1.8" fill="none" className="stroke-(--paper-fold)" strokeWidth="0.9" strokeLinejoin="round" />
      {seal !== 'none' && (
        <circle cx="28" cy="23" r="3.4" strokeWidth="1"
          className={seal === 'filled' ? 'fill-(--paper-seal) stroke-(--paper-seal)' : 'fill-(--paper) stroke-(--paper-seal)'} />
      )}
    </svg>
  );
}
