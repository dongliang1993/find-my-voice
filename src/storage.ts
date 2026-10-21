import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { DomainError } from './errors.js';
import type { Identity, VoiceConfiguration, MemorySave, IdentityUpdate, MemoryEntry } from './schema.js';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type Snapshot = { role_id: string; version: number; identity: Identity | null; voice: VoiceConfiguration | null; confirmed_at: string | null; change_reason?: string; memory_ids?: string[] };
export type Pending = {
  id: string; owner_id: string; role_id: string; kind: 'memory' | 'identity'; request_id: string;
  payload_hash: string; payload: MemorySave | IdentityUpdate; state: 'pending' | 'approved' | 'rejected';
  result: Record<string, unknown> | null; created_at: string;
};
export type Speech = {
  id: string; owner_id: string; request_id: string; input_hash: string; role_id: string; identity_version: number;
  text: string; voice_id: string; voice_name: string; speech_rate: number; loudness_rate: number;
  provider: string; state: 'generating' | 'completed' | 'failed' | 'unknown' | 'expired';
  generation_mode: 'tts' | 'seed-audio'; direction: string | null; spoken_text: string | null;
  file_path: string | null; mime_type: string | null; duration_seconds: number | null;
  created_at: string; expires_at: string; error: string | null;
};

export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(directory, 'voice.sqlite'));
    chmodSync(resolve(directory, 'voice.sqlite'), 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, role_id TEXT NOT NULL, kind TEXT NOT NULL,
        request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL,
        UNIQUE(owner_id, kind, request_id)
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, role_id TEXT NOT NULL,
        entry TEXT NOT NULL, fingerprint TEXT NOT NULL, confirmed_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(owner_id, role_id, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS identities (
        owner_id TEXT NOT NULL, role_id TEXT NOT NULL, version INTEGER NOT NULL,
        snapshot TEXT NOT NULL, PRIMARY KEY(owner_id, role_id, version)
      );
      CREATE TABLE IF NOT EXISTS speeches (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
        role_id TEXT NOT NULL, identity_version INTEGER NOT NULL, text TEXT NOT NULL,
        voice_id TEXT NOT NULL, voice_name TEXT NOT NULL, speech_rate INTEGER NOT NULL, loudness_rate INTEGER NOT NULL,
        provider TEXT NOT NULL, generation_mode TEXT NOT NULL, direction TEXT, spoken_text TEXT,
        state TEXT NOT NULL, file_path TEXT, mime_type TEXT, duration_seconds REAL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, error TEXT, UNIQUE(owner_id, request_id)
      );
      PRAGMA user_version=1;
    `);
  }
  transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  snapshot(owner: string, role = 'default'): Snapshot {
    const row = this.db.prepare('SELECT snapshot FROM identities WHERE owner_id=? AND role_id=? ORDER BY version DESC LIMIT 1').get(owner, role) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as Snapshot : { role_id: role, version: 0, identity: null, voice: null, confirmed_at: null };
  }
  memories(owner: string, role = 'default') {
    return this.db.prepare('SELECT id,entry,confirmed_at FROM memories WHERE owner_id=? AND role_id=? AND active=1 ORDER BY confirmed_at,id').all(owner, role).map(row => ({
      id: String(row.id), ...JSON.parse(String(row.entry)) as MemoryEntry, confirmed_at: String(row.confirmed_at),
    }));
  }
  verifyMemoryIds(owner: string, role: string, ids: string[]) {
    const valid = new Set(this.memories(owner, role).map(m => m.id));
    if (ids.some(id => !valid.has(id))) throw new DomainError('MEMORY_NOT_FOUND', '引用的记忆不存在、已失效或不属于当前角色。');
  }
  pending(owner: string, id: string): Pending {
    const row = this.db.prepare('SELECT * FROM pending WHERE owner_id=? AND id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', '待确认变更不存在。', 404);
    return { ...row, payload: JSON.parse(String(row.payload)), result: row.result ? JSON.parse(String(row.result)) : null } as unknown as Pending;
  }
  stage(owner: string, kind: Pending['kind'], payload: MemorySave | IdentityUpdate): Pending {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT id,payload_hash FROM pending WHERE owner_id=? AND kind=? AND request_id=?').get(owner, kind, payload.request_id);
      if (row) {
        if (row.payload_hash !== digest(payload)) throw new DomainError('REQUEST_CONFLICT', '同一请求 ID 不能用于不同内容。', 409);
        return this.pending(owner, String(row.id));
      }
      if (kind === 'identity') {
        const update = payload as IdentityUpdate;
        const current = this.snapshot(owner, payload.role_id);
        if (update.base_version !== current.version) throw new DomainError('VERSION_CONFLICT', '角色版本已变化，请读取当前版本后重新生成变更。', 409, { current_version: current.version });
        if (!current.identity && !update.identity) throw new DomainError('IDENTITY_REQUIRED', '请先建立角色画像，再确认角色声音。');
        this.verifyMemoryIds(owner, payload.role_id, update.memory_ids);
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO pending(id,owner_id,role_id,kind,request_id,payload_hash,payload,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, owner, payload.role_id, kind, payload.request_id, digest(payload), JSON.stringify(payload), new Date().toISOString());
      return this.pending(owner, id);
    });
  }
  decide(owner: string, id: string, approve: boolean, selectedIndices?: number[], validateVoice?: (id: string) => void): Pending {
    return this.transaction(() => {
      const pending = this.pending(owner, id);
      if (pending.state !== 'pending') return pending;
      if (!approve) {
        this.db.prepare("UPDATE pending SET state='rejected',result=? WHERE id=?").run(JSON.stringify({ message: '用户拒绝了此次变更，有效数据未修改。' }), id);
        return this.pending(owner, id);
      }
      let result: Record<string, unknown>;
      const now = new Date().toISOString();
      if (pending.kind === 'memory') {
        const payload = pending.payload as MemorySave;
        const indices = selectedIndices ?? payload.entries.map((_, i) => i);
        if (!indices.length || new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= payload.entries.length)) {
          throw new DomainError('INVALID_SELECTION', '请选择有效且不重复的记忆条目。');
        }
        const ids: string[] = [];
        for (const i of indices) {
          const entry = payload.entries[i]!;
          const fingerprint = digest(entry);
          this.db.prepare('INSERT INTO memories(id,owner_id,role_id,entry,fingerprint,confirmed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,role_id,fingerprint) DO UPDATE SET active=1,confirmed_at=excluded.confirmed_at')
            .run(randomUUID(), owner, pending.role_id, JSON.stringify(entry), fingerprint, now);
          const row = this.db.prepare('SELECT id FROM memories WHERE owner_id=? AND role_id=? AND fingerprint=?').get(owner, pending.role_id, fingerprint)!;
          ids.push(String(row.id));
        }
        result = { memory_ids: ids, saved_count: ids.length, confirmed_at: now };
      } else {
        const payload = pending.payload as IdentityUpdate;
        const current = this.snapshot(owner, pending.role_id);
        if (current.version !== payload.base_version) throw new DomainError('VERSION_CONFLICT', '确认期间角色已更新，请重新生成 Diff。', 409, { current_version: current.version });
        this.verifyMemoryIds(owner, pending.role_id, payload.memory_ids);
        if (payload.voice) validateVoice?.(payload.voice.voice_id);
        const next: Snapshot = {
          role_id: pending.role_id, version: current.version + 1,
          identity: payload.identity ?? current.identity, voice: payload.voice ?? current.voice,
          change_reason: payload.change_reason,
          // A voice-only update must not erase the already confirmed identity's evidence.
          memory_ids: payload.memory_ids.length || payload.identity ? payload.memory_ids : (current.memory_ids ?? []), confirmed_at: now,
        };
        this.db.prepare('INSERT INTO identities(owner_id,role_id,version,snapshot) VALUES(?,?,?,?)').run(owner, pending.role_id, next.version, JSON.stringify(next));
        result = { snapshot: next };
      }
      this.db.prepare("UPDATE pending SET state='approved',result=? WHERE id=?").run(JSON.stringify(result), id);
      return this.pending(owner, id);
    });
  }
  pendingList(owner: string) {
    return this.db.prepare('SELECT id FROM pending WHERE owner_id=? ORDER BY created_at DESC LIMIT 100').all(owner).map(r => this.pending(owner, String(r.id)));
  }
  speech(owner: string, id: string): Speech {
    const row = this.db.prepare('SELECT * FROM speeches WHERE owner_id=? AND id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', '音频不存在。', 404);
    return row as unknown as Speech;
  }
  speechByRequest(owner: string, request: string) {
    const row = this.db.prepare('SELECT * FROM speeches WHERE owner_id=? AND request_id=?').get(owner, request);
    return row as unknown as Speech | undefined;
  }
  reserveSpeech(asset: Speech, maxConcurrency: number, requestsPerMinute: number): Speech {
    return this.transaction(() => {
      const existing = this.speechByRequest(asset.owner_id, asset.request_id);
      if (existing) {
        if (existing.input_hash !== asset.input_hash) throw new DomainError('REQUEST_CONFLICT', '同一请求 ID 不能用于不同语音内容。', 409);
        return existing;
      }
      const active = this.db.prepare("SELECT COUNT(*) AS n FROM speeches WHERE state='generating'").get()!;
      if (Number(active.n) >= maxConcurrency) throw new DomainError('BUSY', '当前语音生成并发已满，请稍后再试。', 429);
      const recent = this.db.prepare('SELECT COUNT(*) AS n FROM speeches WHERE owner_id=? AND created_at>?').get(asset.owner_id, new Date(Date.now() - 60000).toISOString())!;
      if (Number(recent.n) >= requestsPerMinute) throw new DomainError('RATE_LIMITED', '语音生成频率已达到本地限制，请稍后再试。', 429);
      this.db.prepare(`INSERT INTO speeches(id,owner_id,request_id,input_hash,role_id,identity_version,text,voice_id,voice_name,speech_rate,loudness_rate,provider,generation_mode,direction,state,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(asset.id, asset.owner_id, asset.request_id, asset.input_hash, asset.role_id, asset.identity_version,
        asset.text, asset.voice_id, asset.voice_name, asset.speech_rate, asset.loudness_rate, asset.provider, asset.generation_mode, asset.direction, asset.state, asset.created_at, asset.expires_at);
      return asset;
    });
  }
  completeSpeech(owner: string, id: string, path: string, mime: string, duration: number | null, spokenText: string | null) {
    this.db.prepare("UPDATE speeches SET state='completed',file_path=?,mime_type=?,duration_seconds=?,spoken_text=? WHERE owner_id=? AND id=? AND state='generating'")
      .run(path, mime, duration, spokenText, owner, id);
    return this.speech(owner, id);
  }
  failSpeech(owner: string, id: string, code: string, unknown: boolean) {
    this.db.prepare('UPDATE speeches SET state=?,error=? WHERE owner_id=? AND id=? AND state=\'generating\'').run(unknown ? 'unknown' : 'failed', code, owner, id);
  }
  recoverStaleSpeech(timeoutMs: number) {
    this.db.prepare("UPDATE speeches SET state='unknown',error='INTERRUPTED' WHERE state='generating' AND created_at<?")
      .run(new Date(Date.now() - timeoutMs - 10000).toISOString());
  }
  expiredSpeech(owner: string) {
    return this.db.prepare("SELECT * FROM speeches WHERE owner_id=? AND expires_at<=? AND state='completed'").all(owner, new Date().toISOString()) as unknown as Speech[];
  }
  markExpired(owner: string, id: string) { this.db.prepare("UPDATE speeches SET state='expired',file_path=NULL WHERE owner_id=? AND id=?").run(owner, id); }
  deactivateMemory(owner: string, id: string) {
    this.db.prepare('UPDATE memories SET active=0 WHERE owner_id=? AND id=?').run(owner, id);
  }
  export(owner: string) {
    return {
      exported_at: new Date().toISOString(), memories: this.memories(owner), identity: this.snapshot(owner),
      identity_versions: this.db.prepare('SELECT snapshot FROM identities WHERE owner_id=? ORDER BY version').all(owner).map(r => JSON.parse(String(r.snapshot))),
      decisions: this.pendingList(owner),
      speeches: this.db.prepare('SELECT id,request_id,identity_version,text,voice_id,voice_name,provider,generation_mode,direction,spoken_text,state,created_at,expires_at,error FROM speeches WHERE owner_id=? ORDER BY created_at').all(owner),
    };
  }
  close() { this.db.close(); }
}
