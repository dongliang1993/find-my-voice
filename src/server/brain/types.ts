import type { LetterBlock, Note } from '../../shared/protocol.js';

/** What the companion does during one reply. The chat layer turns these into messages. */
export type BrainEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'voice'; text: string; emotion: string | null }
  /** She has started writing a letter: the envelope can appear before a word of it is in. */
  | { type: 'letter_start'; letterId: string }
  /** What she has written so far. The last block may be cut short; it is the same letter, growing. */
  | { type: 'letter_progress'; letterId: string; title: string; blocks: LetterBlock[] }
  /** All of it, checked: blocks that were not valid are already gone. Empty means it came to nothing. */
  | { type: 'letter_done'; letterId: string; title: string; blocks: LetterBlock[] }
  /**
   * She wants to change a letter. The ops are as she wrote them; the chat layer
   * checks and applies them and must call `respond` with what happened — that
   * is the tool's answer, and her turn waits for it.
   */
  | { type: 'letter_edit'; letterId: string; ops: unknown; respond: (result: string) => void }
  /** She has started a note: the card can come up before a word of it is in. */
  | { type: 'note_start'; noteId: string }
  /** What the note says so far, growing the same way a letter does. */
  | { type: 'note_progress'; noteId: string; title: string; blocks: LetterBlock[] }
  /** The note as written. Empty blocks means it came to nothing and never happened. */
  | { type: 'note_done'; noteId: string; title: string; blocks: LetterBlock[] }
  /** She wants to change the note; the chat layer applies and answers, as with a letter. No id: there is only ever one. */
  | { type: 'note_edit'; ops: unknown; respond: (result: string) => void }
  | { type: 'error'; code: string; message: string }
  /** The session to resume no longer exists; nothing was said this turn. */
  | { type: 'session_lost' };

/** What the brain needs to know about the note already on the table, if any. */
export type BrainNote = Pick<Note, 'id' | 'title' | 'blocks'>;

export type BrainSink = (event: BrainEvent) => void;

/** `fresh` starts a new session instead of resuming the stored one. */
export type BrainFactory = (options: { fresh: boolean }) => Brain;
/** What the brain may need to know each time it is built; notes read it to append instead of replacing. */
export type BrainContext = { note: BrainNote | null };

export interface Brain {
  /** Runs one reply turn. Resolves when the companion has finished replying. */
  reply(text: string, sink: BrainSink): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  /** True once the brain can no longer reply and must be recreated. */
  readonly closed: boolean;
}
