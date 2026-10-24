import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/shared/protocol.js';
import { buildJudgePrompt, judgementSchema } from '../src/server/initiative/judge.js';

const now = new Date(2026, 9, 22, 15, 0);
const recent: ChatMessage[] = [{
  id: 'm1', role: 'user', kind: 'text', text: '周五有个面试', emotion: null, audio: null,
  createdAt: new Date(2026, 9, 21, 22, 0).toISOString(), initiative: null,
}];

const prompt = (kind: 'followup' | 'echo' | 'rhythm', reason = '你之前记下要关心对方的事到时间了：「周五的面试」') =>
  buildJudgePrompt({ candidate: { kind, reason }, recent, companionName: 'Vivi', now });

test('the judge is told what it is judging, and that silence is the default', () => {
  const text = prompt('followup');
  assert.match(text, /周五的面试/);
  assert.match(text, /默认是不说/);
  assert.match(text, /沉默本身不是理由/);
});

test('the judge sees the conversation it is judging against', () => {
  assert.match(prompt('followup'), /周五有个面试/);
});

test('an hour-based opening is described as one, not as something remembered', () => {
  const text = prompt('rhythm', '现在是周四下午15点，是对方平时愿意聊天的时候，对方今天还没有和你说过话。');
  assert.match(text, /平时愿意聊天的时段/);
  assert.match(text, /下午15点/);
  assert.doesNotMatch(text, /你之前记下要关心的一件事/);
  assert.match(text, /一句轻轻的问候也可以/, 'a plain greeting is allowed for this kind');
});

test('each kind is judged by its own test', () => {
  const echo = prompt('echo', '对方昨天说过一句话，你到现在还会想起：「那片橙色的天」。');
  assert.match(echo, /一直留在你心里/);
  assert.match(echo, /痛苦、隐私/);
  assert.doesNotMatch(prompt('followup'), /痛苦、隐私/);
});

test('the persona-only guide never reaches the judge', () => {
  const text = buildJudgePrompt({
    candidate: { kind: 'echo', reason: '对方昨天说过：「那片橙色的天」。', guide: '提到对方的原话或那个画面' },
    recent, companionName: 'Vivi', now,
  });
  assert.doesNotMatch(text, /提到对方的原话/);
});

test('a judgement with no subject is still valid: not every yes needs one', () => {
  assert.deepEqual(judgementSchema.parse({ speak: true }), { speak: true, subject: '', reason: '' });
});
