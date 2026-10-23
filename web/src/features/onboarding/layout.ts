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

/** The page around the card. */
export const SCREEN = 'relative isolate flex h-dvh items-stretch justify-center bg-background sm:items-center sm:p-8';
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
const PANEL_HEIGHT = 'h-[58dvh] sm:h-(--os1-panel-h)';
/** Holds the panel's place in the card's layout; the coral itself is drawn over it. */
export const PANEL = `flex-none ${PANEL_HEIGHT}`;
/** The mat. Reserved even while covered, so the card's size never changes. */
export const MAT = 'flex-1 sm:h-(--os1-mat-h) sm:flex-none';

/** The coral. Absolutely placed over the card so it can cover the mat and then lift off it. */
export const CORAL = 'absolute inset-x-0 top-0 z-10 overflow-hidden text-(--os1-ink) transition-[height,background-color,box-shadow] duration-700 ease-[cubic-bezier(0.65,0,0.35,1)] sm:rounded-[2px]';
export const CORAL_SURFACE = 'bg-(--os1) sm:shadow-[inset_0_1px_4px_rgb(60_10_0/0.25)]';
/** Covering the whole card, before anything has been asked. */
export const CORAL_CLOSED = 'h-full';
/** Lifted to the panel, the mat uncovered — and it stays there. */
export const CORAL_OPEN = PANEL_HEIGHT;

/** Centres her coil in the coral. */
export const CENTRE = 'pointer-events-none absolute inset-0 flex items-center justify-center';
