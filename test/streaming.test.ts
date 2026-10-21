import test from 'node:test';
import assert from 'node:assert/strict';
import { VolcengineProvider, pcmToWav, type SynthesisOptions } from '../src/provider.js';
import { configuredVoice } from '../src/catalog.js';
import { VoiceService } from '../src/service.js';
import { DomainError } from '../src/errors.js';
import type { PlaybackReport, StreamingPlayback } from '../src/playback.js';
import { setup } from './helpers.js';

test('PCM chunks reach the consumer before upstream EOF, preserve ordering, and archive as one WAV', async t => {
  const x = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'test-key', VOLC_DEFAULT_VOICE: 'test-speaker', VOLC_RESOURCE_ID: 'seed-tts-2.0' }); t.after(x.cleanup);
  let release!: () => void; let upstreamEnded = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pcm = [Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0])];
  const encode = (data: Buffer) => new TextEncoder().encode(JSON.stringify({ code: 0, data: data.toString('base64') }));
  const provider = new VolcengineProvider(x.config, async (_, init) => {
    assert.equal(JSON.parse(String(init!.body)).req_params.audio_params.format, 'pcm');
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(encode(pcm[0]!)); await gate;
      controller.enqueue(encode(pcm[1]!)); upstreamEnded = true; controller.close();
    } }));
  });
  const received: Buffer[] = [];
  const result = await provider.synthesize({ text: '流式测试。', voice: configuredVoice(x.config, 'test-speaker'), speechRate: 0, loudnessRate: 0 }, {
    format: 'pcm', onAudioChunk: async bytes => {
      received.push(bytes);
      if (received.length === 1) { assert.equal(upstreamEnded, false); release(); }
    },
  });
  assert.deepEqual(Buffer.concat(received), Buffer.concat(pcm));
  assert.equal(result.extension, 'wav'); assert.equal(result.audio.toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(result.audio.subarray(44), Buffer.concat(pcm));
  assert.equal(result.audio.readUInt32LE(40), 8); assert.equal(result.durationSeconds, 8 / 48000);
  assert.throws(() => pcmToWav(Buffer.alloc(1)), /采样/);
});

function fakePlayback(id: string): StreamingPlayback & { writes: Buffer[]; finishes: number; stops: number } {
  const report: PlaybackReport = { state: 'starting', format: 'pcm_s16le', sample_rate: 24000, channels: 1, chunks: 0, pcm_bytes: 0 };
  return { audioId: id, controller: new AbortController(), report, active: true, writes: [], finishes: 0, stops: 0,
    async write(bytes) { this.writes.push(bytes); }, finish() { this.finishes++; report.state = 'playing'; },
    stop() { this.stops++; report.state = 'stopped'; this.controller.abort(new DomainError('PLAYBACK_STOPPED', '测试停止')); },
    async wait() { return report; },
  };
}
const realEnv = { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'test-key', VOLC_DEFAULT_VOICE: 'test-speaker', VOLC_RESOURCE_ID: 'seed-tts-2.0', LOCAL_AUDIO_PLAYBACK: 'stream' };

test('local delivery streams once; replay neither regenerates nor replays, and HTTP cannot activate system audio', async t => {
  const x = setup(undefined, realEnv); t.after(x.cleanup);
  let generations = 0; const players: ReturnType<typeof fakePlayback>[] = [];
  const s = new VoiceService(x.config, { async synthesize(_, options?: SynthesisOptions) {
    generations++; assert.equal(options?.format, 'pcm');
    await options!.onAudioChunk!(Buffer.from([1, 0, 2, 0]));
    assert.equal(players[0]!.finishes, 0); assert.equal(players[0]!.writes.length, 1);
    return { audio: pcmToWav(Buffer.from([1, 0, 2, 0])), extension: 'wav', mime: 'audio/wav', durationSeconds: 2 / 24000 };
  } }, async (_, id) => { const p = fakePlayback(id); players.push(p); return p; });
  t.after(() => s.close());
  const args = { request_id: 'stream-delivery-1', text: '测试流式播放。' };
  const a = await s.speak(args, true); const b = await s.speak(args, true);
  assert.equal(a.data.audio_id, b.data.audio_id); assert.equal(b.data.reused, true);
  assert.equal(generations, 1); assert.equal(players.length, 1); assert.equal(players[0]!.finishes, 1);
  await assert.rejects(s.speak({ ...args, request_id: 'stream-delivery-2', playback: 'stream' }, false), (e: unknown) => e instanceof DomainError && e.code === 'LOCAL_PLAYBACK_ONLY');
  await assert.rejects(s.speak({ ...args, request_id: 'stream-delivery-3', playback: 'stream' }, true, false), (e: unknown) => e instanceof DomainError && e.code === 'LOCAL_PLAYBACK_ONLY');
  assert.equal(generations, 1);
});

test('stop aborts an unfinished generation and the same request can never silently regenerate', async t => {
  const x = setup(undefined, realEnv); t.after(x.cleanup);
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; }); let calls = 0;
  const s = new VoiceService(x.config, { async synthesize(_, options) {
    calls++; started();
    await new Promise<never>((_, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    throw new Error('unreachable');
  } }, async (_, id) => fakePlayback(id)); t.after(() => s.close());
  const args = { request_id: 'stream-stop-1', text: '停止测试。' };
  const running = s.speak(args, true); await began;
  s.playbackControl('stop');
  await assert.rejects(running, (e: unknown) => e instanceof DomainError && e.code === 'PLAYBACK_STOPPED');
  await assert.rejects(s.speak(args, true)); assert.equal(calls, 1);
  assert.equal(s.store.speechByRequest(s.config.ownerId, args.request_id)?.state, 'failed');
});

test('an occupied playback device is detected before a paid provider request', async t => {
  const x = setup(undefined, realEnv); t.after(x.cleanup); let calls = 0;
  const s = new VoiceService(x.config, { async synthesize() { calls++; throw new Error('must not run'); } }, async () => { throw new DomainError('LOCAL_PLAYBACK_BUSY', '测试忙'); }); t.after(() => s.close());
  await assert.rejects(s.speak({ request_id: 'stream-busy-1', text: '测试。' }, true), (e: unknown) => e instanceof DomainError && e.code === 'LOCAL_PLAYBACK_BUSY');
  assert.equal(calls, 0);
});
