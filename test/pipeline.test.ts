import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoicePipeline } from '../src/server/voice/pipeline.js';
import { DomainError } from '../src/server/errors.js';
import type { SynthesisInput, SynthesisOptions, TtsProvider } from '../src/server/voice/provider.js';

const voice = { id: 'v', resourceId: 'r' };

class FakeTts implements TtsProvider {
  calls: string[] = [];
  constructor(private failOn?: string) {}
  async synthesize(input: SynthesisInput, options: SynthesisOptions = {}) {
    this.calls.push(input.text);
    if (input.text === this.failOn) throw new DomainError('TTS_REJECTED', '失败了');
    const pcm = Buffer.alloc(4800, 1); // 0.1 s at 24 kHz s16le
    await options.onAudioChunk?.(pcm.subarray(0, 2400));
    await options.onAudioChunk?.(pcm.subarray(2400));
    return { audio: pcm, extension: 'wav' as const, mime: 'audio/wav', durationSeconds: 0.1 };
  }
}

const setup = (tts: TtsProvider, language?: () => 'auto' | 'zh' | 'en') => {
  const dir = mkdtempSync(join(tmpdir(), 'fmv-voice-'));
  const chunks: Buffer[] = [];
  const pipeline = new VoicePipeline({ provider: tts, audioDir: dir, voice: () => voice, speechRate: () => 0, language });
  return { dir, chunks, pipeline };
};

test('synthesizes sentence by sentence and streams every chunk in order', async () => {
  const tts = new FakeTts();
  const { dir, chunks, pipeline } = setup(tts);
  const result = await pipeline.speak('a1', '你好呀，今天怎么样？', { onChunk: c => { chunks.push(c); } });
  assert.deepEqual(tts.calls, ['你好呀，今天怎么样？']);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.map(c => c.length).reduce((a, b) => a + b), 4800);
  assert.ok(Math.abs(result.durationSeconds - 0.1) < 1e-9);
  const wav = readFileSync(join(dir, 'a1.wav'));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.length, 44 + 4800);
});

test('passes a held language through and sends nothing for auto', async () => {
  const seen: (string | undefined)[] = [];
  class Recording extends FakeTts {
    override async synthesize(input: SynthesisInput, options: SynthesisOptions = {}) {
      seen.push(input.language);
      return super.synthesize(input, options);
    }
  }
  await setup(new Recording(), () => 'en').pipeline.speak('b1', 'hello there', { onChunk: () => {} });
  await setup(new Recording(), () => 'auto').pipeline.speak('b2', 'hello there', { onChunk: () => {} });
  assert.deepEqual(seen, ['en', undefined]);
});

test('reports every sentence with where it starts, so the caption can follow the voice', async () => {
  const lines: { text: string; startsAt: number }[] = [];
  const { pipeline } = setup(new FakeTts());
  await pipeline.speak('a4', '今天真的发生了好多事情呢。我早上起来发现下雨了！', { onChunk: () => {}, onLine: line => lines.push(line) });
  assert.deepEqual(lines.map(line => line.text), ['今天真的发生了好多事情呢。', '我早上起来发现下雨了！']);
  // Each call emits 0.1 s of audio, so the second sentence starts at 0.1 s.
  assert.ok(Math.abs(lines[1]!.startsAt - 0.1) < 1e-9);
});

test('splits long speech into several TTS requests', async () => {
  const tts = new FakeTts();
  const { pipeline } = setup(tts);
  await pipeline.speak('a2', '今天真的发生了好多事情呢。我早上起来发现下雨了！然后我就想到了你。你那边天气怎么样？', { onChunk: () => {} });
  assert.ok(tts.calls.length >= 2, `expected multiple calls, got ${tts.calls.length}`);
});

test('a failure stops the rest, keeps nothing on disk and surfaces the error', async () => {
  const tts = new FakeTts('我早上起来发现外面在下雨！');
  const { dir, pipeline } = setup(tts);
  await assert.rejects(pipeline.speak('a3', '今天真的发生了好多事情呢。我早上起来发现外面在下雨！然后我就想到了你呀。', { onChunk: () => {} }), /失败了/);
  assert.deepEqual(tts.calls, ['今天真的发生了好多事情呢。', '我早上起来发现外面在下雨！']);
  assert.equal(existsSync(join(dir, 'a3.wav')), false);
});

test('rejects unsafe audio ids', async () => {
  const { pipeline } = setup(new FakeTts());
  await assert.rejects(pipeline.speak('../x', '你好', { onChunk: () => {} }), /invalid/i);
});
