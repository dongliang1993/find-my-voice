import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatService } from '../src/server/chat/service.js';
import { ChatStore } from '../src/server/chat/store.js';
import type { Brain, BrainEvent, BrainSink } from '../src/server/brain/types.js';
import type { ServerEvent } from '../src/shared/protocol.js';

class ScriptedBrain implements Brain {
  closed = false;
  received: string[] = [];
  constructor(private script: BrainEvent[] | ((sink: BrainSink) => Promise<void>)) {}
  async reply(text: string, sink: BrainSink) {
    this.received.push(text);
    if (typeof this.script === 'function') return this.script(sink);
    for (const event of this.script) sink(event);
  }
  async interrupt() {}
  async close() { this.closed = true; }
}

type FakeSpeak = (id: string, text: string, opts: { onChunk: (c: Buffer) => void; signal?: AbortSignal }) => Promise<{ durationSeconds: number }>;
const okVoice: FakeSpeak = async (_id, _text, { onChunk }) => { onChunk(Buffer.from([1, 2])); return { durationSeconds: 1.2 }; };

function setup(brain: Brain, speak: FakeSpeak = okVoice) {
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-chat-')));
  const events: ServerEvent[] = [];
  const service = new ChatService({ store, createBrain: () => brain, voice: { speak } });
  service.subscribe(e => events.push(e));
  return { store, events, service };
}
const settle = () => new Promise(r => setTimeout(r, 10));

test('stores the user message, streams text and stores the reply', async () => {
  const { store, events, service } = setup(new ScriptedBrain([{ type: 'text_delta', text: '在' }, { type: 'text_delta', text: '呀' }]));
  await service.send(randomUUID(), '在吗');
  const [user, reply] = store.recent();
  assert.equal(user?.text, '在吗');
  assert.equal(reply?.text, '在呀');
  assert.deepEqual(events.filter(e => e.type === 'text_delta').map(e => e.type === 'text_delta' && e.delta), ['在', '呀']);
  assert.deepEqual(events.filter(e => e.type === 'status').map(e => e.type === 'status' && e.status), ['thinking', 'idle']);
});

test('a lost resume session is dropped and the same message is answered by a fresh brain', async () => {
  const created: boolean[] = [];
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-chat-')));
  const events: ServerEvent[] = [];
  const service = new ChatService({
    store, voice: { speak: okVoice },
    createBrain: ({ fresh }) => {
      created.push(fresh);
      if (!fresh) return new ScriptedBrain([{ type: 'session_lost' }]);
      return new ScriptedBrain([{ type: 'text_delta', text: '我在' }]);
    },
  });
  service.subscribe(e => events.push(e));
  await service.send(randomUUID(), '在吗');
  assert.deepEqual(created, [false, true]);
  assert.deepEqual(store.recent().map(m => m.text), ['在吗', '我在']);
  assert.equal(events.some(e => e.type === 'error'), false);
});

test('a lost session on a fresh brain is not retried forever', async () => {
  let count = 0;
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-chat-')));
  const events: ServerEvent[] = [];
  const service = new ChatService({ store, voice: { speak: okVoice },
    createBrain: () => { count++; return new ScriptedBrain([{ type: 'session_lost' }]); } });
  service.subscribe(e => events.push(e));
  await service.send(randomUUID(), 'hi');
  assert.equal(count, 2);
  assert.ok(events.some(e => e.type === 'error'));
});

test('the same client id is never processed twice', async () => {
  const brain = new ScriptedBrain([{ type: 'text_delta', text: 'ok' }]);
  const { store, service } = setup(brain);
  const id = randomUUID();
  await service.send(id, '你好');
  await service.send(id, '你好');
  assert.equal(brain.received.length, 1);
  assert.equal(store.recent().length, 2);
});

test('a voice event becomes a voice message that streams and then is ready', async () => {
  const { store, events, service } = setup(new ScriptedBrain([{ type: 'voice', text: '晚安呀', emotion: '温柔' }]));
  await service.send(randomUUID(), '晚安');
  await settle();
  const voice = store.recent().find(m => m.kind === 'voice')!;
  assert.equal(voice.text, '晚安呀');
  assert.equal(voice.emotion, '温柔');
  assert.equal(voice.audio?.state, 'ready');
  assert.equal(voice.audio?.durationSeconds, 1.2);
  assert.ok(events.some(e => e.type === 'audio_chunk' && e.audioId === voice.audio?.id));
});

test('text before and after a voice message lands in separate bubbles', async () => {
  const { store, service } = setup(new ScriptedBrain([
    { type: 'text_delta', text: '等下哦' }, { type: 'voice', text: '想你啦', emotion: null }, { type: 'text_delta', text: '嘿嘿' },
  ]));
  await service.send(randomUUID(), 'hi');
  await settle();
  assert.deepEqual(store.recent().slice(1).map(m => [m.kind, m.text]), [['text', '等下哦'], ['voice', '想你啦'], ['text', '嘿嘿']]);
});

test('a failed synthesis keeps the transcript and marks audio failed', async () => {
  const failing: FakeSpeak = async () => { throw new Error('TTS down'); };
  const { store, service } = setup(new ScriptedBrain([{ type: 'voice', text: '你好', emotion: null }]), failing);
  await service.send(randomUUID(), 'hi');
  await settle();
  const voice = store.recent().find(m => m.kind === 'voice')!;
  assert.equal(voice.text, '你好');
  assert.equal(voice.audio?.state, 'failed');
});

test('brain errors are reported and no empty reply is stored', async () => {
  const { store, events, service } = setup(new ScriptedBrain([{ type: 'error', code: 'BRAIN_RATE_LIMIT', message: '太频繁' }]));
  await service.send(randomUUID(), 'hi');
  assert.equal(store.recent().length, 1);
  assert.ok(events.some(e => e.type === 'error' && e.code === 'BRAIN_RATE_LIMIT'));
});

test('a message sent while replying is stored at once and answered right after', async () => {
  let release!: () => void;
  let calls = 0;
  const brain = new ScriptedBrain(async sink => {
    calls++;
    if (calls === 1) await new Promise<void>(r => { release = r; });
    sink({ type: 'text_delta', text: `回复${calls}` });
  });
  const { store, events, service } = setup(brain);
  const first = service.send(randomUUID(), 'a');
  await settle();
  void service.send(randomUUID(), 'b');
  void service.send(randomUUID(), 'c');
  assert.deepEqual(store.recent().map(m => m.text), ['a', 'b', 'c']);
  assert.equal(events.some(e => e.type === 'error'), false);
  release();
  await first;
  await settle();
  assert.deepEqual(brain.received, ['a', 'b\nc']);
  assert.deepEqual(store.recent().filter(m => m.role === 'assistant').map(m => m.text), ['回复1', '回复2']);
});

test('interrupt aborts in-flight voice and marks it stopped', async () => {
  let seen: AbortSignal | undefined;
  const hanging: FakeSpeak = (_id, _text, opts) => new Promise((_, reject) => {
    seen = opts.signal;
    opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const { store, service } = setup(new ScriptedBrain([{ type: 'voice', text: '你好', emotion: null }]), hanging);
  await service.send(randomUUID(), 'hi');
  await service.interrupt();
  await settle();
  assert.equal(seen?.aborted, true);
  assert.equal(store.recent().find(m => m.kind === 'voice')?.audio?.state, 'stopped');
});

test('close aborts voice jobs instead of waiting for them', async () => {
  const hanging: FakeSpeak = (_id, _text, opts) => new Promise((_, reject) => {
    opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const { service } = setup(new ScriptedBrain([{ type: 'voice', text: '你好', emotion: null }]), hanging);
  await service.send(randomUUID(), 'hi');
  await service.close(); // would hang forever if voice jobs were awaited without aborting
});

test('a closed brain is recreated for the next message', async () => {
  let created = 0;
  const brains: ScriptedBrain[] = [];
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-chat-')));
  const service = new ChatService({ store, voice: { speak: okVoice }, createBrain: () => {
    created++; const b = new ScriptedBrain([{ type: 'text_delta', text: 'x' }]); brains.push(b); return b;
  } });
  await service.send(randomUUID(), 'a');
  brains[0]!.closed = true;
  await service.send(randomUUID(), 'b');
  assert.equal(created, 2);
});

test('snapshot lists history and current status', async () => {
  const { service } = setup(new ScriptedBrain([{ type: 'text_delta', text: 'hi' }]));
  await service.send(randomUUID(), 'yo');
  const hello = service.snapshot();
  assert.equal(hello.type, 'hello');
  assert.equal(hello.messages.length, 2);
  assert.equal(hello.status, 'idle');
});

// ---- speaking first ----

const candidate = { kind: 'followup' as const, reason: '你之前记下要关心对方的事到时间了：「面试」。', followupId: 'f1' };

test('speaking first stores her message tagged as an initiative, and the nudge never shows', async () => {
  const brain = new ScriptedBrain([{ type: 'text_delta', text: '面试' }, { type: 'text_delta', text: '怎么样啦？' }]);
  const { store, events, service } = setup(brain);
  const { outcome } = await service.speakUp(candidate);
  assert.equal(outcome, 'spoke');
  const [msg] = store.recent();
  assert.equal(store.recent().length, 1, 'no user message for the nudge');
  assert.equal(msg?.text, '面试怎么样啦？');
  assert.equal(msg?.initiative, 'followup');
  assert.match(brain.received[0]!, /面试/);
  assert.match(brain.received[0]!, /PASS/);
  assert.ok(events.some(e => e.type === 'initiative' && e.messageIds.includes(msg!.id)));
});

test('she can choose silence: PASS stores and shows nothing', async () => {
  const { store, events, service } = setup(new ScriptedBrain([{ type: 'text_delta', text: 'PA' }, { type: 'text_delta', text: 'SS' }]));
  assert.equal((await service.speakUp(candidate)).outcome, 'passed');
  assert.equal(store.recent().length, 0);
  assert.equal(events.some(e => e.type === 'message' || e.type === 'text_delta' || e.type === 'initiative'), false);
});

test('a voice she sends unprompted is tagged too', async () => {
  const { store, service } = setup(new ScriptedBrain([{ type: 'voice', text: '早安呀', emotion: '温柔' }]));
  await service.speakUp({ kind: 'morning', reason: '早上' });
  await settle();
  const [voice] = store.recent();
  assert.equal(voice?.kind, 'voice');
  assert.equal(voice?.initiative, 'morning');
});

test('never speaks up while a reply is in progress', async () => {
  let release!: () => void;
  const { service } = setup(new ScriptedBrain(() => new Promise<void>(r => { release = r; })));
  const replying = service.send(randomUUID(), 'hi');
  await settle();
  assert.equal(service.busy, true);
  assert.equal((await service.speakUp(candidate)).outcome, 'busy');
  release();
  await replying;
  assert.equal(service.busy, false);
});

test('a user message arriving while she speaks up is answered right after', async () => {
  let release!: () => void;
  let turn = 0;
  const brain = new ScriptedBrain(async sink => {
    turn++;
    if (turn === 1) { await new Promise<void>(r => { release = r; }); sink({ type: 'text_delta', text: '在忙吗' }); }
    else sink({ type: 'text_delta', text: '收到' });
  });
  const { store, service } = setup(brain);
  const speaking = service.speakUp(candidate);
  await settle();
  void service.send(randomUUID(), '我来了');
  release();
  await speaking;
  await settle(); await settle();
  assert.deepEqual(store.recent().map(m => [m.role, m.text]), [['user', '我来了'], ['assistant', '在忙吗'], ['assistant', '收到']]);
});

test('a stale persona rebuilds the brain before the next turn', async () => {
  let built = 0;
  let version = 'v1';
  const store = new ChatStore(mkdtempSync(join(tmpdir(), 'fmv-chat-')));
  const service = new ChatService({ store, voice: { speak: okVoice }, promptVersion: () => version,
    createBrain: () => { built++; return new ScriptedBrain([{ type: 'text_delta', text: 'ok' }]); } });
  await service.send(randomUUID(), 'a');
  await service.send(randomUUID(), 'b');
  assert.equal(built, 1, 'same persona: reuse');
  version = 'v2';
  await service.send(randomUUID(), 'c');
  assert.equal(built, 2, 'persona changed: rebuild');
});

test('stopping her while she is speaking up drops what she had buffered', async () => {
  let release!: () => void;
  const { store, service } = setup(new ScriptedBrain(async sink => {
    sink({ type: 'text_delta', text: '在吗' });
    await new Promise<void>(r => { release = r; });
  }));
  const speaking = service.speakUp(candidate);
  await settle();
  await service.interrupt();
  release();
  assert.equal((await speaking).outcome, 'stopped');
  assert.equal(store.recent().length, 0);
});

test('speakUp reports the ids of what she said', async () => {
  const { service } = setup(new ScriptedBrain([{ type: 'text_delta', text: '嗨' }]));
  const ids: string[][] = [];
  service.subscribe(e => { if (e.type === 'initiative') ids.push(e.messageIds); });
  const result = await service.speakUp(candidate);
  assert.equal(result.outcome, 'spoke');
  assert.equal(ids[0]?.length, 1);
  assert.equal(result.messages[0]?.text, '嗨');
});
