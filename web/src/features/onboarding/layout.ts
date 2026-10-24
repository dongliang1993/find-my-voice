/**
 * The OS1 screen's measurements, shared by the loading gate and the first
 * meeting so the hand-off between them never changes a size. The card's
 * layout is fixed from the first frame; only the coral changes. It starts
 * covering the whole card and, the first time an answer is due, lifts to
 * the panel's height and uncovers the cream mat. Her coil stays at the exact
 * centre of the coral throughout, as in the film.
 *
 * Once the mat is open the divider moves with the turn: it rises while she
 * speaks and settles back when the answer is yours, so the empty space is
 * never just empty — it is her turn or yours.
 */

import { cn } from '@/lib/utils';

/** The page around the card, in the stage's light for the hour (useAmbientTheme writes --base). */
export const SCREEN = 'relative isolate flex h-dvh items-stretch justify-center bg-(--base) sm:items-center sm:p-8';
/** The cream card: the coral panel on top, the mat for your answers below. */
export const CARD = 'relative flex w-full max-w-[880px] flex-col sm:rounded-[3px]';
export const CARD_SURFACE = 'bg-card sm:shadow-(--panel-shadow) sm:ring-1 sm:ring-hairline';
/**
 * The panel's height once the mat is open. Desktop sizes come from
 * --os1-panel-h / --os1-mat-h in index.css, so they can be tuned live in
 * DevTools; on a phone the panel takes a share of the screen and the mat the rest.
 *
 * The divider never moves after it has opened. An open question already fills
 * the mat, so there is no room to give back — lifting the panel only grew the
 * card, and the card recentring under it read as a jump.
 */
export const PANEL_HEIGHT = 'h-[58dvh] sm:h-(--os1-panel-h)';
/** Holds the panel's place in the card's layout; the coral itself is drawn over it. */
export const PANEL = `flex-none ${PANEL_HEIGHT}`;
/** The mat. Reserved even while covered, so the card's size never changes. */
export const MAT = 'flex-1 sm:h-(--os1-mat-h) sm:flex-none';

/** The coral. Absolutely placed over the card so it can cover the mat and then lift off it. */
export const CORAL = 'absolute inset-x-0 top-0 z-10 overflow-hidden text-(--os1-ink) transition-[height,background-color,box-shadow] duration-700 ease-[cubic-bezier(0.65,0,0.35,1)] sm:rounded-[2px]';
/** Her coral for the hour, the stage's own, so the curtain does not change colour on the way there. */
export const CORAL_SURFACE = 'bg-(--her) sm:shadow-[inset_0_1px_4px_rgb(60_10_0/0.25)]';
/** Covering the whole card, before anything has been asked. */
export const CORAL_CLOSED = 'h-full';
/** Lifted to the panel, the mat uncovered — and it stays there. */
export const CORAL_OPEN = PANEL_HEIGHT;

/** Centres her coil in the coral. */
export const CENTRE = 'pointer-events-none absolute inset-0 flex items-center justify-center';

/*
 * The stage's measurements, shared with the first meeting's last beat: on the
 * way out the first meeting takes this exact shape, so the stage that replaces
 * it lands on top of it without a pixel moving.
 */
/**
 * Her half of the stage: her coil on a fixed line, not centred with her words.
 * The height is PANEL_HEIGHT itself — the first meeting lifts its coral to
 * exactly this, so the stage that replaces it lands with nothing moving.
 *
 * The column hangs from the bottom, the way a subtitle sits in its frame: her
 * words stay just above the mat, and the space she is not using opens upward.
 */
export const STAGE_PANEL = cn('relative flex flex-none flex-col items-center justify-end overflow-hidden px-8 pt-4 pb-18 text-center', PANEL_HEIGHT);
/** On the way out the first meeting's column takes the stage's shape exactly, so the coil lands where it stays. */
export const STAGE_ARRIVING = 'justify-end pt-4 pb-18';
/** Room for your words above her coil, kept even when empty. */
export const STAGE_CAPTION = 'mb-4 min-h-[1.6em] max-w-[34em] text-[15px] leading-relaxed';
/**
 * Her whole reply, opened over the column instead of in it: making room in
 * the column would push her coil up under the pointer. It ends exactly where
 * the closed line ends (bottom-12 + py-6 inside it = the panel's pb-18) and
 * fades out at both edges, so a long reply reads as going on, not cut off.
 */
export const STAGE_OPEN_LINE = 'absolute inset-x-8 top-14 bottom-12 block overflow-y-auto [mask-image:linear-gradient(transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]';
/**
 * Her words, close under her coil, in a box that never changes height: one
 * faded line for the beat before (0.8 × 1.6em) and three for the current one
 * (3 × 1.6em). The column is bottom-anchored, so a box that grew with the
 * text would push the coil and your words up and drop them again on every
 * beat — and an empty one, between your turn and hers, would let them fall.
 * The font size is set here so the ems mean the same wherever this is used.
 */
export const STAGE_LINE = 'mt-5 h-[6.1em] flex-none text-[19px] leading-[1.6] sm:text-[21px]';
/**
 * Her coil, wide rather than tall: the wave lies along the panel, so its width
 * is bound by the room beside it. Only its height is bound by the subtitle
 * room under it — three lines still fit on a short one.
 */
export const STAGE_COIL = 'w-[clamp(10rem,36dvh,24rem)] h-[clamp(3rem,14dvh,10rem)] flex-none';
/** The circle's place: the middle of the mat, whatever else the mat holds. */
export const ORB_SLOT = 'pointer-events-none absolute inset-x-0 top-0 bottom-[env(safe-area-inset-bottom)] grid place-items-center *:pointer-events-auto';
/**
 * The same, just under the divider. Once the questions are done the mat holds
 * nothing else, so a centred circle would leave a hand's width of empty coral
 * between it and her words.
 */
export const ORB_SLOT_TOP = 'pointer-events-none absolute inset-x-0 top-2 grid place-items-center *:pointer-events-auto';
