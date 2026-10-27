import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/server/app.js';
import { createHttp } from '../src/server/http.js';
import { languageAt, letters, loadDemo, papersBefore, parseDemo, replyDelay, stops, type DemoScript } from '../src/server/demo/script.js';
import { DemoVoice } from '../src/server/demo/voice.js';
import type { SynthesisInput, TtsProvider } from '../src/server/voice/provider.js';

const SCRIPT = {
  preset: {
    userName: '{name}', herName: 'Natasha', herNameReason: 'Soft.', replyLanguage: 'en', uiLanguage: 'en',
    onboardingAnswers: { comfort: 'listen', rhythm: 'night', onMind: 'Work, mostly.' },
  },
  timing: {},
  scenes: [
    { id: 1, name: 'meet', clock: '2026-03-01T21:00:00+08:00', onboarding: true },
    {
      id: 2, name: 'paper', beats: [
        { type: 'user', userText: 'Make me a list, {name}.' },
        { type: 'her', text: 'Here it is.', paper: { action: 'create', id: 'p1', title: 'List', blocks: [{ id: 'first', type: 'paragraph', text: 'one' }, { type: 'paragraph', text: 'two' }] } },
        { type: 'her', text: 'Two things.' },
        { type: 'user', userText: 'Drop the first.' },
        { type: 'paper', paper: { action: 'edit', id: 'p1', ops: [{ op: 'delete', blockId: 'first' }] } },
        { type: 'her', text: '换成中文吧。', setting: { replyLanguage: 'zh' } },
      ],
    },
    { id: 3, name: 'later', clock: '2026-03-02T09:00:00+08:00', beats: [{ type: 'user', userText: 'Morning.' }] },
  ],
};

const script = (name = 'Lin'): DemoScript => parseDemo(SCRIPT, name);

test('the checked-in demo script parses', () => {
  const demo = loadDemo(join(import.meta.dirname, '../scripts/demo.json'), 'Lin');
  assert.ok(demo.scenes.length > 1);
  assert.ok(demo.scenes.some(s => s.onboarding), 'one scene is the first meeting');
});

test('an opening shot before the first meeting: set at its own hour, the meeting dated by its own clock, then the meeting from nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-demo-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ voice: { provider: 'fixture' } }));
  const opened = parseDemo({
    ...SCRIPT, timing: { replyDelayMs: 0, pauseAfterBeatMs: 0 },
    scenes: [{ id: 0, name: 'open', clock: '2026-03-05T23:40:00+08:00', beats: [{ type: 'her', text: 'I wrote you something.' }] }, ...SCRIPT.scenes],
  }, 'Lin');
  const app = new App(dir, () => {}, { demo: opened });
  await app.demo!.jump(0);
  assert.ok(app.store.onboarding().completedAt, 'the opening is on the stage, not in the first meeting');
  assert.match(app.store.onboarding().completedAt!, /^2026-03-01/, 'met on the meeting\'s day, not the opening\'s');
  await app.demo!.next();
  do await new Promise(r => setTimeout(r, 50)); while (app.chat.busy);
  await app.demo!.next();
  assert.equal(app.demo!.state().scene, 2);
  assert.equal(app.store.onboarding().completedAt, null, 'into the meeting, from nothing');
  await app.close();
});

test('her goodbye with rest: she says it, then rests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-demo-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ voice: { provider: 'fixture' } }));
  const night = parseDemo({
    ...SCRIPT, timing: { replyDelayMs: 0, pauseAfterBeatMs: 0 },
    scenes: [SCRIPT.scenes[0], { id: 2, name: 'night', beats: [{ type: 'user', userText: '晚安' }, { type: 'her', text: 'Goodnight, {name}.', rest: true }] }],
  }, 'Lin');
  const app = new App(dir, () => {}, { demo: night });
  await app.demo!.jump(1);
  await app.demo!.next();
  do await new Promise(r => setTimeout(r, 50)); while (app.chat.busy);
  assert.equal(app.store.recent().at(-1)?.text, 'Goodnight, Lin.');
  assert.equal(app.chat.resting, true);
  await app.close();
});

test('a take of its own is put in the cache for its sentence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-take-'));
  const voice = new DemoVoice(dir, () => { throw new Error('no live voice'); });
  const pcm = Buffer.from([1, 0, 2, 0]);
  const wav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt '), Buffer.alloc(20), Buffer.from('data'), Buffer.from([4, 0, 0, 0]), pcm]);
  voice.putWav('I wrote you something.', wav);
  assert.ok(voice.has('I wrote you something.'));
  assert.throws(() => voice.putWav('x', Buffer.from('nothing here')), /WAV/);
});

test('{name} is filled in everywhere', () => {
  const demo = script('Lin');
  assert.equal(demo.preset.userName, 'Lin');
  assert.deepEqual(demo.scenes[1]!.beats[0], { type: 'user', userText: 'Make me a list, Lin.' });
});

test('a bad script names what is wrong', () => {
  assert.throws(() => parseDemo({ ...SCRIPT, scenes: [] }, 'Lin'), /scenes/);
});

test('her wait before answering is a range, or one fixed length', () => {
  assert.deepEqual(script().timing.replyDelayMs, [1000, 2000]);
  assert.deepEqual(parseDemo({ ...SCRIPT, timing: { replyDelayMs: 700 } }, 'Lin').timing.replyDelayMs, [700, 700]);
  for (let i = 0; i < 50; i++) {
    const ms = replyDelay([1000, 2000]);
    assert.ok(ms >= 1000 && ms <= 2000);
  }
});

test('her lines in a row are one stop', () => {
  assert.deepEqual(stops(script().scenes[1]!.beats), [0, 1, 3, 4]);
});

test('papers carry over with their edits, mapped by position', () => {
  const [paper] = papersBefore(script(), 2);
  assert.equal(paper!.id, 'p1');
  assert.deepEqual(paper!.blocks.map(b => (b as { text?: string }).text), ['two']);
  assert.equal(paper!.createdAt, '2026-03-01T21:00:00+08:00');
  assert.deepEqual(papersBefore(script(), 1), []);
});

test('a scene opens in the language the ones before it left', () => {
  assert.equal(languageAt(script(), 1), 'en');
  assert.equal(languageAt(script(), 2), 'zh');
});

function liveVoice(calls: string[]): TtsProvider {
  return {
    async synthesize(input, options = {}) {
      calls.push(input.text);
      const pcm = Buffer.alloc(48_000 * 2);
      await options.onAudioChunk?.(pcm);
      return { audio: pcm, extension: 'wav', mime: 'audio/wav', durationSeconds: 2 };
    },
  } as TtsProvider;
}

const say = (text: string) => ({ text, speechRate: 0 }) as SynthesisInput;

test('a take is played from the cache; a missing one is made once and kept', async () => {
  const calls: string[] = [];
  const voice = new DemoVoice(mkdtempSync(join(tmpdir(), 'fmv-demo-voice-')), () => liveVoice(calls));
  voice.put('Hello.', Buffer.alloc(48_000));
  let bytes = 0;
  await voice.synthesize(say('Hello.'), { onAudioChunk: async c => { bytes += c.length; } });
  assert.equal(bytes, 48_000);
  assert.deepEqual(calls, []);

  await voice.synthesize(say('New line.'));
  await voice.synthesize(say('New line.'));
  assert.deepEqual(calls, ['New line.']);
  assert.ok(voice.has('New line.'));
});

test('a line lasts as long as its takes, and a paper can start partway in', () => {
  const voice = new DemoVoice(mkdtempSync(join(tmpdir(), 'fmv-demo-voice-')), () => liveVoice([]));
  voice.put('First one here.', Buffer.alloc(48_000));
  voice.put('Second one here.', Buffer.alloc(96_000));
  const text = 'First one here. Second one here.';
  assert.equal(voice.durationMs(text), 3000);
  assert.equal(voice.offsetMs(text, 'First one'), 1000);
  assert.equal(voice.offsetMs(text, 'Second'), 3000);
  assert.equal(voice.offsetMs(text, 'not in it'), 0);
});

function demoApp() {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-demo-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ voice: { provider: 'fixture' } }));
  return new App(dir, () => {}, { demo: script() });
}

test('the first meeting hears the preset answers, whatever was said', async () => {
  const app = demoApp();
  assert.equal(app.onboarding().step, 0);
  assert.equal(await app.hear(Buffer.from([1]), 'audio/webm'), 'Work, mostly.');
  assert.deepEqual(await app.hearAlias(Buffer.from([1]), 'audio/webm'), { said: 'Lin', alias: 'Lin' });
  app.saveOnboarding(5, {}, false);
  assert.equal(await app.hear(Buffer.from([1]), 'audio/webm'), 'Natasha');
  assert.deepEqual(await app.proposeName('Lin', ''), { name: 'Natasha', reason: 'Soft.' });
  assert.equal(await app.proposeName('Lin', ''), null);
  await app.close();
});

test('a scene jumped to finds the meeting over and the earlier papers kept', async () => {
  const app = demoApp();
  await app.demo!.jump(2);
  assert.ok(app.onboarding().completedAt);
  assert.equal(app.settings.companion.name, 'Natasha');
  assert.equal(app.settings.companion.userName, 'Lin');
  assert.equal(app.settings.companion.language, 'zh');
  assert.deepEqual(app.store.papers().map(p => [p.id, p.createdAt]), [['p1', '2026-03-01T13:00:00.000Z']]);
  assert.equal(app.now().toISOString().slice(0, 16), '2026-03-02T01:00');
  assert.equal(await app.hear(Buffer.from([1]), 'audio/webm'), 'Morning.');
  assert.deepEqual(app.demo!.state(), {
    type: 'demo', scene: 3, beat: 0, clock: app.demo!.state().clock, hideCursor: false,
    meeting: { alias: 'Lin', comfort: 'listen', rhythm: 'night', notes: 'Work, mostly.', herName: 'Natasha', replyDelayMs: [1000, 2000] },
    letters: [],
  });
  await app.close();
});

test('the place in the script survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-demo-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ voice: { provider: 'fixture' } }));
  const first = new App(dir, () => {}, { demo: script() });
  await first.demo!.jump(1);
  await first.close();
  const second = new App(dir, () => {}, { demo: script() });
  assert.equal(second.demo!.state().scene, 2);
  await second.close();
});

test('→ plays the user line and her answer, paper and all, then waits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-demo-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ voice: { provider: 'fixture' } }));
  const quick = parseDemo({ ...SCRIPT, timing: { replyDelayMs: 0, pauseAfterBeatMs: 0, paperWritingCharsPerSecond: 1000 } }, 'Lin');
  const app = new App(dir, () => {}, { demo: quick });
  await app.demo!.jump(1);
  const idle = async () => { do await new Promise(r => setTimeout(r, 50)); while (app.chat.busy); };

  await app.demo!.next();
  await idle();
  assert.equal(app.demo!.state().beat, 3);
  assert.deepEqual(app.store.papers().map(p => p.title), ['List']);
  assert.deepEqual(app.store.recent().filter(m => m.text && !m.paperId).map(m => [m.role, m.text]), [
    ['user', 'Make me a list, Lin.'], ['assistant', 'Here it is.'], ['assistant', 'Two things.'],
  ]);

  await app.demo!.next();
  await idle();
  assert.equal(app.demo!.state().beat, 6);
  assert.equal(app.store.papers()[0]!.blocks.length, 1);
  assert.equal(app.settings.companion.language, 'zh');
  await app.close();
});

test('a letter with a reading can be played; one without has no button', async () => {
  const withLetter = structuredClone(SCRIPT);
  (withLetter.scenes[1]!.beats![1] as { paper: { read?: boolean } }).paper.read = true;
  const demo = parseDemo(withLetter, 'Lin');
  assert.deepEqual(letters(demo), [{ id: 'p1', paragraphs: ['one', 'two'] }]);

  const dir = mkdtempSync(join(tmpdir(), 'fmv-demo-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ voice: { provider: 'fixture' } }));
  const app = new App(dir, () => {}, { demo });
  const { http } = createHttp(app, dir);
  const get = () => http.request('/api/demo/letter/p1', { headers: { host: '127.0.0.1:3210' } });
  assert.deepEqual(app.demo!.state().letters, []);
  assert.equal((await get()).status, 404);

  app.demo!.voice.putLetter(['one', 'two'], Buffer.alloc(4800));
  assert.deepEqual(app.demo!.state().letters, ['p1']);
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal((await response.arrayBuffer()).byteLength, 44 + 4800);
  await app.close();
});
