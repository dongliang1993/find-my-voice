/**
 * Changing apps, as the switcher stacks them: the app coming up arrives in
 * the stage's own frame, and the one it covers steps back behind it —
 * smaller, darker, out of focus — the way the cards behind the front one sit.
 * Coming back is the same motion in reverse.
 */
/** One curve for every app change and everything inside the apps: quick out of the gate, long to settle. */
export const EASE = [0.22, 1, 0.36, 1] as const;
export const APP_SWITCH = { duration: 0.5, ease: EASE } as const;
/** A panel's own pieces — a row, a confirmation, a status line — move faster than the app that holds them. */
export const PANEL = { duration: 0.25, ease: EASE } as const;
/** With reduced motion, a fade and nothing else. */
export const APP_SWITCH_STILL = { duration: 0.2 } as const;

/** The stage while another app is up in front of it. */
export const RECEDED = { scale: 0.96, filter: 'brightness(0.7) blur(3px)' } as const;
export const RECEDED_STILL = { scale: 1, filter: 'brightness(0.7) blur(0px)' } as const;
export const FORWARD = { scale: 1, filter: 'brightness(1) blur(0px)' } as const;

/** The app coming up: from just in front of the stage's frame into it. */
export const ARRIVING = { opacity: 0, scale: 1.02 } as const;
export const ARRIVED = { opacity: 1, scale: 1 } as const;
