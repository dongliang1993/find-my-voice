/** The switcher's Papers icon: two sheets, the front one's corner turned down. */
export function PapersIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <path d="M11 6.5h8.5L24 11v13.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 10 24.5V8a1.5 1.5 0 0 1 1-1.5Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M19.5 6.5V11H24" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7 10v14.5A3.5 3.5 0 0 0 10.5 28H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
