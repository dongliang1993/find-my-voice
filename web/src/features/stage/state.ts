import type { CompanionStatus } from '@shared/protocol';

/**
 * The four states the stage can be in. The server already knows all of them
 * (`CompanionStatus` plus whether her voice is playing), so this is derived
 * rather than kept in a reducer — there is one source of truth and it is not
 * the browser.
 */
export type StageState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type MicLook = 'normal' | 'active' | 'dim';

export interface StateVisual {
  /** Her words: how far they recede while it is not her turn. Faded, never blurred: still readable. */
  lineOpacity: number;
  /** The stage's brightness, 1 = untouched. */
  herBrightness: number;
  mic: MicLook;
}

/** How much of her wave the stage keeps in silence; the first meeting settles to it on the way there. */
export const STAGE_REST = 0.12;

/**
 * She said goodbye and rests: the room goes down to a glow, her words fade
 * out, the circle stays — a word or a touch brings her straight back.
 */
export const ASLEEP: StateVisual = { lineOpacity: 0, herBrightness: 0.72, mic: 'dim' };

export const VISUALS: Record<StageState, StateVisual> = {
  idle: { lineOpacity: 0.9, herBrightness: 1, mic: 'normal' },
  listening: { lineOpacity: 0.5, herBrightness: 0.92, mic: 'active' },
  thinking: { lineOpacity: 0.5, herBrightness: 0.95, mic: 'dim' },
  speaking: { lineOpacity: 1, herBrightness: 1, mic: 'dim' },
};

/**
 * Which state the stage is in, from what the server and the recorder say.
 * Listening wins over everything: while the microphone is open she is quiet,
 * even if a slow reply is still streaming in.
 */
export function stageState({ status, playing, listening }: {
  status: CompanionStatus; playing: boolean; listening: boolean;
}): StageState {
  if (listening) return 'listening';
  if (playing) return 'speaking';
  if (status === 'thinking') return 'thinking';
  return 'idle';
}
