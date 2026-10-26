/** The switcher's inbox icon: an envelope, flap down. */
export function MailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <rect x="5" y="8.5" width="22" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="m6 10 10 7.5L26 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
