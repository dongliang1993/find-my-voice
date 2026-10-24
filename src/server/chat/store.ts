import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AudioInfo, ChatMessage, InitiativeKind, Letter, LetterBlock, LetterStatus, Note, NoteStatus } from '../../shared/protocol.js';

type Row = {
  id: string; role: ChatMessage['role']; kind: ChatMessage['kind']; text: string;
  emotion: string | null; audio: string | null; created_at: string; initiative: InitiativeKind | null;
  letter_id: string | null;
};
type LetterRow = {
  id: string; title: string; status: LetterStatus; version: number; blocks_json: string; history_json: string;
  signature: string; created_at: string; opened_at: string | null; deleted_at: string | null; message_id: string | null;
};
type NoteRow = { id: string; title: string; status: NoteStatus; version: number; blocks_json: string; created_at: string };
/** An earlier version of a letter, kept when it is edited. Not shown yet; kept so it can be. */
export type LetterVersion = { version: number; blocks: LetterBlock[]; replacedAt: string };
export type NewMessage = Pick<ChatMessage, 'role' | 'kind' | 'text'> & {
  emotion?: string | null; audio?: AudioInfo | null; initiative?: InitiativeKind | null; letterId?: string | null;
};
export type MessagePatch = Partial<Pick<ChatMessage, 'text' | 'emotion' | 'audio' | 'kind'>>;
export type Followup = { id: string; topic: string; note: string; dueAt: string };
/** Something the user said that stayed with her: their own words, verbatim, and when they said them. */
export type Echo = { id: string; line: string; note: string; saidAt: string };

const toMessage = (row: Row): ChatMessage => ({
  id: row.id, role: row.role, kind: row.kind, text: row.text, emotion: row.emotion,
  audio: row.audio ? JSON.parse(row.audio) as AudioInfo : null, createdAt: row.created_at,
  initiative: row.initiative ?? null,
  ...(row.letter_id ? { letterId: row.letter_id } : {}),
});

const toLetter = (row: LetterRow): Letter => ({
  id: row.id, title: row.title, status: row.status, version: row.version,
  blocks: JSON.parse(row.blocks_json) as LetterBlock[], signature: row.signature,
  createdAt: row.created_at, openedAt: row.opened_at,
});

const toNote = (row: NoteRow): Note => ({
  id: row.id, title: row.title, status: row.status, version: row.version,
  blocks: JSON.parse(row.blocks_json) as LetterBlock[], createdAt: row.created_at,
});

/** The single conversation with the companion, things she means to follow up on, and small key/value state. */
export class ChatStore {
  private db: DatabaseSync;
  /** Injection point for tests: the timestamp on stored rows. The real clock is never faked. */
  private clock: () => Date = () => new Date();
  constructor(dataDir: string, clock?: () => Date) {
    if (clock) this.clock = clock;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(dataDir, 'chat.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, emotion TEXT, audio TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS followups (
        id TEXT PRIMARY KEY, topic TEXT NOT NULL, note TEXT NOT NULL, due_at TEXT NOT NULL,
        due_day TEXT NOT NULL, done_at TEXT, created_at TEXT NOT NULL,
        UNIQUE (topic, due_day));
      CREATE TABLE IF NOT EXISTS echoes (
        id TEXT PRIMARY KEY, line TEXT NOT NULL UNIQUE, note TEXT NOT NULL,
        said_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS letters (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
        blocks_json TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]', signature TEXT NOT NULL,
        created_at TEXT NOT NULL, opened_at TEXT, deleted_at TEXT, message_id TEXT);
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
        blocks_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS filed_notes (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
        blocks_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS onboarding_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        step INTEGER NOT NULL DEFAULT 0,
        draft_json TEXT NOT NULL DEFAULT '{}',
        completed_at TEXT);
    `);
    this.migrate();
    this.skipOnboardingForExistingUsers();
    this.failInterruptedAudio();
    this.breakInterruptedLetters();
    // A note interrupted mid-writing can never be finished by the turn that
    // started it; closed on the page it is simply gone. A leftover from a dead
    // process counts as closed: one row, wiped once.
    this.db.exec('DELETE FROM notes');
  }

  // Databases from before proactive messages lack the column; add it in place.
  private migrate() {
    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'initiative')) this.db.exec('ALTER TABLE messages ADD COLUMN initiative TEXT');
    if (!columns.some(c => c.name === 'letter_id')) this.db.exec('ALTER TABLE messages ADD COLUMN letter_id TEXT');
    // The hour-based greeting was called "morning" before it could fall at any hour.
    this.db.exec("UPDATE messages SET initiative = 'rhythm' WHERE initiative = 'morning'");
  }

  /**
   * Installs from before onboarding already have a companion they talk to;
   * walking them through setup again would answer a question nobody asked.
   * One row written once, on the first open after the upgrade — never read
   * again as a "does this user count as existing" check.
   */
  private skipOnboardingForExistingUsers() {
    const row = this.db.prepare('SELECT step, completed_at FROM onboarding_state WHERE id = 1').get() as { step: number; completed_at: string | null } | undefined;
    if (row) return;
    const existing = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    if (existing.n === 0) return;
    this.db.prepare('INSERT INTO onboarding_state (id, step, draft_json, completed_at) VALUES (1, 7, ?, ?)')
      .run('{}', this.clock().toISOString());
  }

  /** The onboarding row: step, saved draft and completion. Never null. */
  onboarding(): { step: number; draft: Record<string, unknown>; completedAt: string | null } {
    const row = this.db.prepare('SELECT step, draft_json, completed_at FROM onboarding_state WHERE id = 1').get() as { step: number; draft_json: string; completed_at: string | null } | undefined;
    const draft = (() => { try { return JSON.parse(row?.draft_json ?? '{}') as Record<string, unknown>; } catch { return {}; } })();
    return { step: row?.step ?? 0, draft, completedAt: row?.completed_at ?? null };
  }

  /** Saves onboarding progress; each step is written as it is reached. */
  saveOnboarding(step: number, draft: Record<string, unknown>, completed: boolean) {
    const completedAt = completed ? (this.onboarding().completedAt ?? this.clock().toISOString()) : null;
    this.db.prepare(`INSERT INTO onboarding_state (id, step, draft_json, completed_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET step = excluded.step, draft_json = excluded.draft_json, completed_at = excluded.completed_at`)
      .run(step, JSON.stringify(draft), completedAt);
  }

  // Audio that was still streaming when the process died can never complete.
  private failInterruptedAudio() {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE json_extract(audio, '$.state') = 'streaming'`).all() as Row[];
    for (const row of rows) {
      const audio = toMessage(row).audio!;
      this.update(row.id, { audio: { ...audio, state: 'failed', error: '语音生成被中断' } });
    }
  }

  // A letter that was being written when the process died will never be finished by that turn.
  private breakInterruptedLetters() {
    this.db.exec("UPDATE letters SET status = 'broken' WHERE status = 'writing'");
  }

  append(input: NewMessage): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(), role: input.role, kind: input.kind, text: input.text,
      emotion: input.emotion ?? null, audio: input.audio ?? null, createdAt: this.clock().toISOString(),
      initiative: input.initiative ?? null,
      ...(input.letterId ? { letterId: input.letterId } : {}),
    };
    this.db.prepare('INSERT INTO messages (id, role, kind, text, emotion, audio, created_at, initiative, letter_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(message.id, message.role, message.kind, message.text, message.emotion,
        message.audio ? JSON.stringify(message.audio) : null, message.createdAt, message.initiative, input.letterId ?? null);
    return message;
  }

  /** Only for a letter that came to nothing: the message announcing it goes with it. */
  removeMessage(id: string) {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  get(id: string): ChatMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  update(id: string, patch: MessagePatch): ChatMessage {
    const current = this.get(id);
    if (!current) throw new Error(`Message not found: ${id}`);
    const next: ChatMessage = { ...current, ...patch };
    this.db.prepare('UPDATE messages SET kind = ?, text = ?, emotion = ?, audio = ? WHERE id = ?')
      .run(next.kind, next.text, next.emotion, next.audio ? JSON.stringify(next.audio) : null, id);
    return next;
  }

  recent(limit = 200): ChatMessage[] {
    const rows = this.db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC').all(limit) as Row[];
    return rows.map(toMessage);
  }

  /** Messages after the given one (all when null), oldest first. */
  after(messageId: string | null, limit = 400): ChatMessage[] {
    if (messageId && !this.get(messageId)) messageId = null;
    const sql = messageId
      ? 'SELECT * FROM messages WHERE seq > (SELECT seq FROM messages WHERE id = ?) ORDER BY seq ASC LIMIT ?'
      : 'SELECT * FROM messages ORDER BY seq ASC LIMIT ?';
    const rows = (messageId ? this.db.prepare(sql).all(messageId, limit) : this.db.prepare(sql).all(limit)) as Row[];
    return rows.map(toMessage);
  }

  lastSpoke(): { user: Date | null; assistant: Date | null } {
    const at = (role: string) => {
      const row = this.db.prepare('SELECT created_at FROM messages WHERE role = ? ORDER BY seq DESC LIMIT 1').get(role) as { created_at: string } | undefined;
      return row ? new Date(row.created_at) : null;
    };
    return { user: at('user'), assistant: at('assistant') };
  }

  /** How many proactive turns she started since `since` (several bubbles in one turn count once). */
  initiativesSince(since: Date): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE initiative IS NOT NULL AND created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM messages prev WHERE prev.seq = messages.seq - 1 AND prev.initiative IS NOT NULL)`)
      .get(since.toISOString()) as { n: number };
    return row.n;
  }

  lastInitiativeAt(kind?: InitiativeKind): Date | null {
    const row = (kind
      ? this.db.prepare('SELECT created_at FROM messages WHERE initiative = ? ORDER BY seq DESC LIMIT 1').get(kind)
      : this.db.prepare('SELECT created_at FROM messages WHERE initiative IS NOT NULL ORDER BY seq DESC LIMIT 1').get()
    ) as { created_at: string } | undefined;
    return row ? new Date(row.created_at) : null;
  }

  /**
   * On how many different days the user has said anything at all. The only
   * measure of how well you know each other that cannot be faked by one long
   * night: it takes days.
   */
  daysTalked(): number {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT date(created_at, 'localtime')) AS n FROM messages WHERE role = 'user'`)
      .get() as { n: number };
    return row.n;
  }

  /** The same, counting only messages after `since`. */
  daysTalkedSince(since: Date): number {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT date(created_at, 'localtime')) AS n FROM messages WHERE role = 'user' AND created_at > ?`)
      .get(since.toISOString()) as { n: number };
    return row.n;
  }

  /**
   * How many times she has opened since the user last said anything. Each
   * opening is one message (the nudge forbids doubling up), so counting
   * messages is counting openings.
   */
  unansweredInitiatives(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE initiative IS NOT NULL
        AND seq > (SELECT COALESCE(MAX(seq), 0) FROM messages WHERE role = 'user')`)
      .get() as { n: number };
    return row.n;
  }

  /** Returns false when the same topic is already planned for that day. */
  addFollowup({ topic, note, dueAt }: { topic: string; note: string; dueAt: Date }): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO followups (id, topic, note, due_at, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), topic, note, dueAt.toISOString(), dueAt.toLocaleDateString('sv-SE'), new Date().toISOString());
    return result.changes > 0;
  }

  dueFollowups(now: Date): Followup[] {
    const rows = this.db.prepare('SELECT id, topic, note, due_at FROM followups WHERE done_at IS NULL AND due_at <= ? ORDER BY due_at ASC')
      .all(now.toISOString()) as { id: string; topic: string; note: string; due_at: string }[];
    return rows.map(r => ({ id: r.id, topic: r.topic, note: r.note, dueAt: r.due_at }));
  }

  /** Everything still open, due or not — what the extractor compares the new chat against. */
  openFollowups(): Followup[] {
    const rows = this.db.prepare('SELECT id, topic, note, due_at FROM followups WHERE done_at IS NULL ORDER BY due_at ASC')
      .all() as { id: string; topic: string; note: string; due_at: string }[];
    return rows.map(r => ({ id: r.id, topic: r.topic, note: r.note, dueAt: r.due_at }));
  }

  /**
   * Closes the open follow-ups whose topic the model recognised in the chat, so
   * she does not ask about something the user has already told her. Matched on
   * the topic text: the model is asked to copy it verbatim.
   */
  resolveFollowupTopics(topics: string[]): number {
    if (!topics.length) return 0;
    const now = new Date().toISOString();
    const close = this.db.prepare('UPDATE followups SET done_at = ? WHERE done_at IS NULL AND topic = ?');
    let n = 0;
    for (const topic of topics) n += close.run(now, topic).changes as number;
    return n;
  }

  resolveFollowup(id: string) {
    this.db.prepare('UPDATE followups SET done_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  /**
   * Closes follow-ups that came due before `before`, without her ever asking.
   * Their moment has passed; asking now would be worse than silence, so they
   * are retired rather than left to pile up.
   */
  expireFollowups(before: Date): number {
    return this.db.prepare('UPDATE followups SET done_at = ? WHERE done_at IS NULL AND due_at < ?')
      .run(new Date().toISOString(), before.toISOString()).changes as number;
  }

  /** Returns false when she already holds on to this exact line. */
  addEcho({ line, note, saidAt }: { line: string; note: string; saidAt: Date }): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO echoes (id, line, note, said_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), line, note, saidAt.toISOString(), this.clock().toISOString());
    return result.changes > 0;
  }

  /**
   * Lines she has not brought up yet, said between `from` and `to`, newest
   * first. Anything older has faded on its own; nothing to retire.
   */
  echoes(from: Date, to: Date): Echo[] {
    const rows = this.db.prepare('SELECT id, line, note, said_at FROM echoes WHERE used_at IS NULL AND said_at >= ? AND said_at <= ? ORDER BY said_at DESC')
      .all(from.toISOString(), to.toISOString()) as { id: string; line: string; note: string; said_at: string }[];
    return rows.map(r => ({ id: r.id, line: r.line, note: r.note, saidAt: r.said_at }));
  }

  /** Each line is offered once; whether she spoke or let it go, it does not come back. */
  useEcho(id: string) {
    this.db.prepare('UPDATE echoes SET used_at = ? WHERE id = ?').run(this.clock().toISOString(), id);
  }

  // ---- letters ----

  /** A new letter, still being written: no title, no blocks yet. */
  createLetter({ id = randomUUID(), signature }: { id?: string; signature: string }): Letter {
    this.db.prepare(`INSERT INTO letters (id, title, status, version, blocks_json, signature, created_at)
      VALUES (?, '', 'writing', 1, '[]', ?, ?)`).run(id, signature, this.clock().toISOString());
    return this.letter(id)!;
  }

  /** Ties the letter to the chat message that hands it over. */
  linkLetter(id: string, messageId: string) {
    this.db.prepare('UPDATE letters SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  letterMessageId(id: string): string | null {
    const row = this.db.prepare('SELECT message_id FROM letters WHERE id = ?').get(id) as { message_id: string | null } | undefined;
    return row?.message_id ?? null;
  }

  /** What has been written so far, or all of it with a new status. Not a new version: it is still the first writing. */
  writeLetter(id: string, { title, blocks, status }: { title: string; blocks: LetterBlock[]; status?: LetterStatus }): Letter {
    this.db.prepare('UPDATE letters SET title = ?, blocks_json = ?, status = COALESCE(?, status) WHERE id = ?')
      .run(title, JSON.stringify(blocks), status ?? null, id);
    return this.letter(id)!;
  }

  setLetterStatus(id: string, status: LetterStatus): Letter | null {
    this.db.prepare('UPDATE letters SET status = ? WHERE id = ?').run(status, id);
    return this.letter(id);
  }

  /**
   * An edit: the blocks as they are now become history, the new ones the
   * letter, one version up. History is kept but not sent — v1 has no way to
   * show it, and the data should not be lost before it does.
   */
  reviseLetter(id: string, blocks: LetterBlock[]): Letter {
    const row = this.letterRow(id);
    if (!row) throw new Error(`Letter not found: ${id}`);
    const history = JSON.parse(row.history_json) as LetterVersion[];
    history.push({ version: row.version, blocks: JSON.parse(row.blocks_json) as LetterBlock[], replacedAt: this.clock().toISOString() });
    this.db.prepare('UPDATE letters SET blocks_json = ?, history_json = ?, version = version + 1 WHERE id = ?')
      .run(JSON.stringify(blocks), JSON.stringify(history), id);
    return this.letter(id)!;
  }

  letterHistory(id: string): LetterVersion[] {
    const row = this.letterRow(id);
    return row ? JSON.parse(row.history_json) as LetterVersion[] : [];
  }

  /** The first time it is opened is kept; opening it again changes nothing. */
  openLetter(id: string): Letter | null {
    this.db.prepare('UPDATE letters SET opened_at = COALESCE(opened_at, ?) WHERE id = ? AND deleted_at IS NULL').run(this.clock().toISOString(), id);
    return this.letter(id);
  }

  /** Out of the inbox. Kept in the database, so the history card can still say what it was. */
  deleteLetter(id: string): boolean {
    return (this.db.prepare('UPDATE letters SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(this.clock().toISOString(), id).changes as number) > 0;
  }

  /** A letter that never had a line worth keeping: gone entirely. */
  removeLetter(id: string) {
    this.db.prepare('DELETE FROM letters WHERE id = ?').run(id);
  }

  private letterRow(id: string): LetterRow | null {
    return (this.db.prepare('SELECT * FROM letters WHERE id = ?').get(id) as LetterRow | undefined) ?? null;
  }

  /** A letter still in the inbox; null once deleted. */
  letter(id: string): Letter | null {
    const row = this.letterRow(id);
    return row && !row.deleted_at ? toLetter(row) : null;
  }

  /** The inbox, newest first. */
  letters(limit = 200): Letter[] {
    return (this.db.prepare('SELECT * FROM letters WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as LetterRow[]).map(toLetter);
  }

  // ---- notes ----

  /**
   * The one note. Only one exists at a time: a new one replaces whatever was
   * there — what was on it was only wanted on the spot, and is not kept.
   */
  putNote({ id = randomUUID(), title, blocks, status = 'writing' }: { id?: string; title: string; blocks: LetterBlock[]; status?: NoteStatus }): Note {
    this.db.exec('DELETE FROM notes');
    this.db.prepare('INSERT INTO notes (id, title, status, version, blocks_json, created_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(id, title, status, JSON.stringify(blocks), this.clock().toISOString());
    return this.note(id)!;
  }

  /** What has been written so far, or all of it with a new status. */
  writeNote(id: string, { title, blocks, status }: { title: string; blocks: LetterBlock[]; status?: NoteStatus }): Note | null {
    this.db.prepare('UPDATE notes SET title = ?, blocks_json = ?, status = COALESCE(?, status) WHERE id = ?')
      .run(title, JSON.stringify(blocks), status ?? null, id);
    return this.note(id);
  }

  /** An edit: no history, no version kept beyond the number itself. */
  reviseNote(id: string, blocks: LetterBlock[]): Note | null {
    this.db.prepare('UPDATE notes SET blocks_json = ?, version = version + 1 WHERE id = ?').run(JSON.stringify(blocks), id);
    return this.note(id);
  }

  /** Closed on the page: gone at once, nothing kept. */
  removeNote(id: string): boolean {
    return (this.db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes as number) > 0;
  }

  /** The one note, if any. */
  note(id?: string): Note | null {
    const row = (id
      ? this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
      : this.db.prepare('SELECT * FROM notes LIMIT 1').get()) as NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  // ---- filed notes ----
  // The notes taken off the table and kept: what the dock holds. They live
  // apart from the one on the table — that one is only wanted on the spot —
  // so nothing that happens to it touches these.

  /** A note off the table and into the dock. It keeps its own id and version. */
  fileNote(note: Note): void {
    this.db.prepare('INSERT OR REPLACE INTO filed_notes (id, title, status, version, blocks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(note.id, note.title, note.status, note.version, JSON.stringify(note.blocks), note.createdAt);
  }

  /** Every note the dock holds, newest first. */
  filedNotes(): Note[] {
    return (this.db.prepare('SELECT * FROM filed_notes ORDER BY created_at DESC, rowid DESC').all() as NoteRow[]).map(toNote);
  }

  /** One of them, back on the table: it leaves the dock. */
  unfileNote(id: string): Note | null {
    const row = this.db.prepare('SELECT * FROM filed_notes WHERE id = ?').get(id) as NoteRow | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM filed_notes WHERE id = ?').run(id);
    this.db.exec('DELETE FROM notes');
    this.db.prepare('INSERT INTO notes (id, title, status, version, blocks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.title, 'done', row.version, row.blocks_json, row.created_at);
    return this.note(id);
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM state WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close() { this.db.close(); }
}
