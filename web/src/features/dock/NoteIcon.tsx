/**
 * The dock's note icon: three notes the way macOS keeps its Notes app —
 * measured off the reference, none of them tilted. The pink one sits
 * highest, right; the green one leans over its left edge and out at the
 * top; the front one lies across both their lower halves, the pink
 * corner still showing past its right. All in the paper's own ink, no
 * fill: a drawing of notes, not colored paper.
 */
export function NoteIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      {/* Back, right: the highest note, only its top and the corner past the front. */}
      <rect x="16" y="0.5" width="14.5" height="15" rx="2.5"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity="0.4" />
      {/* Middle, left: over the pink's left edge, under the front — out at the top and left. */}
      <rect x="0.5" y="3" width="18" height="18.5" rx="2.5"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity="0.55" />
      {/* In front, lower: across both their lower halves, the pink corner past its right. */}
      <rect x="7.5" y="10" width="21" height="21.5" rx="3"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      {/* A scribble, then two lines. */}
      <path d="M12 16c1.2-1.6 2.6-1.6 3.6 0s2.6 1.6 3.6 0 2.6-1.6 3.6 0"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11.5 21h13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
      <path d="M11.5 25h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}
