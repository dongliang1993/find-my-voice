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
  /** Her words: how far they recede while it is not her turn. */
  lineBlur: number;
  lineOpacity: number;
  /** The stage's brightness, 1 = untouched. */
  herBrightness: number;
  mic: MicLook;
}

export const VISUALS: Record<StageState, StateVisual> = {
  idle: { lineBlur: 0, lineOpacity: 0.9, herBrightness: 1, mic: 'normal' },
  listening: { lineBlur: 6, lineOpacity: 0.35, herBrightness: 0.92, mic: 'active' },
  thinking: { lineBlur: 8, lineOpacity: 0, herBrightness: 0.95, mic: 'dim' },
  speaking: { lineBlur: 0, lineOpacity: 1, herBrightness: 1, mic: 'dim' },
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
