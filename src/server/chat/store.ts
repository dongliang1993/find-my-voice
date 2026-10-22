import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AudioInfo, ChatMessage } from '../../shared/protocol.js';

type Row = {
  id: string; role: ChatMessage['role']; kind: ChatMessage['kind']; text: string;
  emotion: string | null; audio: string | null; created_at: string;
};
export type NewMessage = Pick<ChatMessage, 'role' | 'kind' | 'text'> & { emotion?: string | null; audio?: AudioInfo | null };
export type MessagePatch = Partial<Pick<ChatMessage, 'text' | 'emotion' | 'audio' | 'kind'>>;

const toMessage = (row: Row): ChatMessage => ({
  id: row.id, role: row.role, kind: row.kind, text: row.text, emotion: row.emotion,
  audio: row.audio ? JSON.parse(row.audio) as AudioInfo : null, createdAt: row.created_at,
});

/** The single conversation with the companion, plus small key/value state. */
export class ChatStore {
  private db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(dataDir, 'chat.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, emotion TEXT, audio TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.failInterruptedAudio();
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
      emotion: input.emotion ?? null, audio: input.audio ?? null, createdAt: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO messages (id, role, kind, text, emotion, audio, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(message.id, message.role, message.kind, message.text, message.emotion, message.audio ? JSON.stringify(message.audio) : null, message.createdAt);
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
