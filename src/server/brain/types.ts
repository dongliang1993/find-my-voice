/** What the companion does during one reply. The chat layer turns these into messages. */
export type BrainEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'voice'; text: string; emotion: string | null }
  | { type: 'error'; code: string; message: string }
  /** The session to resume no longer exists; nothing was said this turn. */
  | { type: 'session_lost' };

export type BrainSink = (event: BrainEvent) => void;

/** `fresh` starts a new session instead of resuming the stored one. */
export type BrainFactory = (options: { fresh: boolean }) => Brain;

export interface Brain {
  /** Runs one reply turn. Resolves when the companion has finished replying. */
  reply(text: string, sink: BrainSink): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  /** True once the brain can no longer reply and must be recreated. */
  readonly closed: boolean;
}
