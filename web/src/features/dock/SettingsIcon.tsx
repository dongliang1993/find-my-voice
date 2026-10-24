/**
 * The dock's settings icon: a gear, the one everybody knows — the app
 * underneath everything else. Drawn like the note icon: ink, no fill.
 */
export function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      {/* A gear: a toothed ring with a hole, not a sun — rays would say brightness. */}
      <path
        d="M16 12.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm8.1 5.2a7 7 0 0 0 0-3.6l2.5-1.5a.8.8 0 0 0 .3-1l-1.9-3.2a.8.8 0 0 0-1-.3l-2.4 1.4a9.4 9.4 0 0 0-3.1-1.8V4.7a.8.8 0 0 0-.8-.8h-3.7a.8.8 0 0 0-.8.8v3.1a9.4 9.4 0 0 0-3.1 1.8L7.7 8.2a.8.8 0 0 0-1 .3l-1.9 3.2a.8.8 0 0 0 .3 1l2.5 1.5a7 7 0 0 0 0 3.6l-2.5 1.5a.8.8 0 0 0-.3 1l1.9 3.2a.8.8 0 0 0 1 .3l2.4-1.4a9.4 9.4 0 0 0 3.1 1.8v3.1c0 .5.3.8.8.8h3.7c.4 0 .8-.3.8-.8v-3.1a9.4 9.4 0 0 0 3.1-1.8l2.4 1.4a.8.8 0 0 0 1-.3l1.9-3.2a.8.8 0 0 0-.3-1l-2.5-1.5Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
      />
    </svg>
  );
}
