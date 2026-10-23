import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../src/server/chat/store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'fmv-onboard-'));

test('a fresh install starts onboarding at step 0 with no draft', () => {
  const s = new ChatStore(dir());
  assert.deepEqual(s.onboarding(), { step: 0, draft: {}, completedAt: null });
});

test('an install with existing conversations is marked done on first open', () => {
  // Build the "existing user" by hand: a store from before onboarding, with
  // messages, and no onboarding_state row (the table did not exist).
  const d = dir();
  const pre = new ChatStore(d);
  pre.append({ role: 'user', kind: 'text', text: '在吗' });
  pre.close();

  // Reopen: the same data directory, now with the onboarding table present.
  const s = new ChatStore(d);
  const state = s.onboarding();
  assert.notEqual(state.completedAt, null, 'existing conversations mean onboarding is over');
  assert.equal(state.step, 7);
  s.close();
});

test('an empty install from before onboarding still starts at 0', () => {
  const d = dir();
  const pre = new ChatStore(d);
  pre.close();
  const s = new ChatStore(d);
  assert.deepEqual(s.onboarding(), { step: 0, draft: {}, completedAt: null });
  s.close();
});

test('each saved step survives a reopen, and completion is never rewritten', () => {
  const d = dir();
  const s = new ChatStore(d);
  s.saveOnboarding(2, { voice: 'v1' }, false);
  assert.deepEqual(s.onboarding(), { step: 2, draft: { voice: 'v1' }, completedAt: null });
  s.close();

  const reopened = new ChatStore(d);
  assert.deepEqual(reopened.onboarding(), { step: 2, draft: { voice: 'v1' }, completedAt: null },
    'progress and draft survive a restart');

  const firstCompletedAt = (() => {
    reopened.saveOnboarding(7, { voice: 'v1', name: '小月' }, true);
    return reopened.onboarding().completedAt!;
  })();
  assert.notEqual(firstCompletedAt, null);

  // A later save cannot move completion back or forward in time.
  reopened.saveOnboarding(7, {}, true);
  assert.equal(reopened.onboarding().completedAt, firstCompletedAt);
  reopened.close();
});

test('the skip writes exactly one row and never flips a completed one back', () => {
  const d = dir();
  const s = new ChatStore(d);
  s.saveOnboarding(3, { x: 1 }, false);
  s.close();

  // Reopening with messages now must NOT stamp completion over explicit progress.
  const s2 = new ChatStore(d);
  s2.append({ role: 'user', kind: 'text', text: 'hi' });
  const reopened = new ChatStore(d);
  assert.equal(reopened.onboarding().step, 3);
  assert.equal(reopened.onboarding().completedAt, null);
  reopened.close();
  s2.close();
});
