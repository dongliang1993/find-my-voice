/**
 * The switcher's stage icon: her line, closed on itself — the one stroke the
 * stage is drawn around. Ink, no fill, like the others.
 */
export function HomeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <path d="M5.5 16c0-2.9 2.1-5 4.7-5 4.6 0 7 10 11.6 10 2.6 0 4.7-2.1 4.7-5s-2.1-5-4.7-5c-4.6 0-7 10-11.6 10-2.6 0-4.7-2.1-4.7-5Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
