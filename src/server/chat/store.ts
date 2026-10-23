import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AudioInfo, ChatMessage, InitiativeKind } from '../../shared/protocol.js';

type Row = {
  id: string; role: ChatMessage['role']; kind: ChatMessage['kind']; text: string;
  emotion: string | null; audio: string | null; created_at: string; initiative: InitiativeKind | null;
};
export type NewMessage = Pick<ChatMessage, 'role' | 'kind' | 'text'> & {
  emotion?: string | null; audio?: AudioInfo | null; initiative?: InitiativeKind | null;
};
export type MessagePatch = Partial<Pick<ChatMessage, 'text' | 'emotion' | 'audio' | 'kind'>>;
export type Followup = { id: string; topic: string; note: string; dueAt: string };

const toMessage = (row: Row): ChatMessage => ({
  id: row.id, role: row.role, kind: row.kind, text: row.text, emotion: row.emotion,
  audio: row.audio ? JSON.parse(row.audio) as AudioInfo : null, createdAt: row.created_at,
  initiative: row.initiative ?? null,
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
      CREATE TABLE IF NOT EXISTS onboarding_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        step INTEGER NOT NULL DEFAULT 0,
        draft_json TEXT NOT NULL DEFAULT '{}',
        completed_at TEXT);
    `);
    this.migrate();
    this.skipOnboardingForExistingUsers();
    this.failInterruptedAudio();
  }

  // Databases from before proactive messages lack the column; add it in place.
  private migrate() {
    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'initiative')) this.db.exec('ALTER TABLE messages ADD COLUMN initiative TEXT');
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

  append(input: NewMessage): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(), role: input.role, kind: input.kind, text: input.text,
      emotion: input.emotion ?? null, audio: input.audio ?? null, createdAt: this.clock().toISOString(),
      initiative: input.initiative ?? null,
    };
    this.db.prepare('INSERT INTO messages (id, role, kind, text, emotion, audio, created_at, initiative) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(message.id, message.role, message.kind, message.text, message.emotion,
        message.audio ? JSON.stringify(message.audio) : null, message.createdAt, message.initiative);
    return message;
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

  lastInitiativeAt(): Date | null {
    const row = this.db.prepare('SELECT created_at FROM messages WHERE initiative IS NOT NULL ORDER BY seq DESC LIMIT 1').get() as { created_at: string } | undefined;
    return row ? new Date(row.created_at) : null;
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

  resolveFollowup(id: string) {
    this.db.prepare('UPDATE followups SET done_at = ? WHERE id = ?').run(new Date().toISOString(), id);
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
