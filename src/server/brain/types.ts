import type { InitiativeSettings, PaperBlock, ReplyLanguage } from '../../shared/protocol.js';

/** The preferences she may change herself, because the user asked her to. */
export type PreferencesPatch = { language?: ReplyLanguage; initiative?: InitiativeSettings['mode'] };

/** What the companion does during one reply. The chat layer turns these into messages. */
export type BrainEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'voice'; text: string; emotion: string | null }
  /** She has started writing a paper: it can go up on the stage before a word of it is in. */
  | { type: 'paper_start'; paperId: string }
  /** What she has written so far. The last block may be cut short; it is the same paper, growing. */
  | { type: 'paper_progress'; paperId: string; title: string; blocks: PaperBlock[] }
  /** All of it, checked: blocks that were not valid are already gone. Empty means it came to nothing. */
  | { type: 'paper_done'; paperId: string; title: string; blocks: PaperBlock[] }
  /**
   * She wants to change a paper — the one named, or else the one in front of
   * the user. The ops are as she wrote them; the chat layer checks and applies
   * them and must call `respond` with what happened: that is the tool's
   * answer, and her turn waits for it.
   */
  | { type: 'paper_edit'; paperId?: string; ops: unknown; respond: (result: string) => void }
  /** The user asked her to keep the paper in front of them: it goes onto the Papers list. */
  | { type: 'paper_save'; respond: (result: string) => void }
  /** The user is leaving for now — goodnight, off to rest: she rests with them. */
  | { type: 'rest'; respond: (result: string) => void }
  /** The user asked, out loud, for a preference to change. Applied by the app; the answer is the tool's. */
  | { type: 'preferences'; patch: PreferencesPatch; respond: (result: string) => void }
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
