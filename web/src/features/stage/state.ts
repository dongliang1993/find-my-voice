import type { CompanionStatus } from '@shared/protocol';

/**
 * The four states the stage can be in. The server already knows all of them
 * (`CompanionStatus` plus whether her voice is playing), so this is derived
 * rather than kept in a reducer — there is one source of truth and it is not
 * the browser.
 */
export type StageState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type WaveDriver = 'breath' | 'pulse' | 'audio';
export type MicLook = 'normal' | 'active' | 'dim';

export interface StateVisual {
  /** What moves the waveform. */
  driver: WaveDriver;
  /** Amplitude at rest, 0..1. */
  restAmp: number;
  /** Ceiling when audio drives it, 0..1. */
  maxAmp: number;
  /** Period of breath / pulse, seconds. */
  period: number;
  /** How wide the wave spreads: full while she speaks, pinched while you do. */
  spread: number;
  /** Stroke weight in px. */
  stroke: number;
  /** Her words: how far they recede while it is not her turn. */
  lineBlur: number;
  lineOpacity: number;
  /** The stage's brightness, 1 = untouched. */
  herBrightness: number;
  mic: MicLook;
}

export const VISUALS: Record<StageState, StateVisual> = {
  idle: {
    driver: 'breath', restAmp: 0.15, maxAmp: 0.15, period: 6, spread: 1, stroke: 2.5,
    lineBlur: 0, lineOpacity: 0.9, herBrightness: 1, mic: 'normal',
  },
  listening: {
    driver: 'audio', restAmp: 0.05, maxAmp: 0.35, period: 0, spread: 0.5, stroke: 1.5,
    lineBlur: 6, lineOpacity: 0.35, herBrightness: 0.92, mic: 'active',
  },
  thinking: {
    driver: 'pulse', restAmp: 0.2, maxAmp: 0.2, period: 1.2, spread: 0.7, stroke: 2,
    lineBlur: 8, lineOpacity: 0, herBrightness: 0.95, mic: 'dim',
  },
  speaking: {
    driver: 'audio', restAmp: 0.12, maxAmp: 1, period: 0, spread: 1, stroke: 2.5,
    lineBlur: 0, lineOpacity: 1, herBrightness: 1, mic: 'dim',
  },
};

/** Everything that moves between states moves in this long. */
export const TRANSITION_MS = 600;
export const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

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
