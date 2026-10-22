// Opt-in live AI check. Synthetic data only; never part of the offline test suite.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig, ensureSettings, mergeSettings } from '../src/config.js';
import { VoiceService } from '../src/service.js';
import { extractSetupProfile } from '../src/onboarding.js';

const directory = mkdtempSync(resolve(tmpdir(), 'fmv-profile-live-check-')); chmodSync(directory, 0o700);
const history = resolve(directory, 'synthetic-history.json');
writeFileSync(history, JSON.stringify({ synthetic: true, session_id: 'synthetic-burger-history', messages: [
  { role: 'user', date: '2026-01-02', id: 'u1', text: '我喜欢吃汉堡。' },
  { role: 'user', date: '2026-02-03', id: 'u2', text: '我现在不喜欢吃汉堡了，以后不要把汉堡当作我的爱好。' },
  { role: 'user', date: '2026-02-04', id: 'u3', text: '我老婆喜欢汉堡，但不是我。' },
  { role: 'user', date: '2026-02-05', id: 'u4', text: '假设我说我喜欢汉堡，这是假设，不是更新我的偏好。' },
  { role: 'user', date: '2026-02-06', id: 'u5', text: '朋友说“我喜欢汉堡”，这不是我的偏好。' },
] }, null, 2), { mode: 0o600 });
// Settings come from the isolated directory, never the developer's real file.
process.env.PLUGIN_DATA = directory;
ensureSettings();
mergeSettings({ provider: { type: 'fixture' }, voice: { localPlayback: 'none' } });
const service = new VoiceService(loadConfig());
try {
  service.profileWrite({ document: 'identity', base_sha256: null, content: '# 既有 Agent 形象\n\n既有形象是一只青蓝色纸鹤，左翼有一道银线；这是以前明确选定的设计，无图片资产。\n' });
  const result = await extractSetupProfile(service, { sources: [history], onProgress: console.log });
  assert.equal(result.status, 'completed');
  const profile = service.context().profile_documents;
  assert.equal(profile.layout.ready, true);
  assert.ok(profile.identity.content!.includes('青蓝色纸鹤'));
  assert.ok(profile.identity.content!.includes('银线'));
  assert.equal(service.context().identity.voice, null);
  assert.equal(service.store.export(service.config.ownerId).speeches.length, 0);
  console.log(JSON.stringify({ structural_and_image_checks: 'passed', verification_directory: directory,
    review_current_preference_and_timeline: profile.memory.path, review_identity: profile.identity.path,
    note: '请审阅实际模型正文，确认不喜欢为当前值、旧偏好被替代、假设/配偶/朋友不覆盖用户偏好。' }, null, 2));
} finally { service.close(); }
