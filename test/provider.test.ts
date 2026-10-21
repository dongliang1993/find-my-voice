import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonStreamParser, VolcengineProvider, SeedAudioProvider } from '../src/provider.js';
import { DomainError } from '../src/errors.js';
import { configuredVoice } from '../src/catalog.js';
import { setup } from './helpers.js';

function streaming(records: unknown[], split = 7) {
  const bytes = new TextEncoder().encode(records.map(r => JSON.stringify(r)).join('\n'));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.slice(i, i + split)); c.close(); } }), { status: 200 });
}
test('JSON framing handles fragmented UTF-8, braces in strings and adjacent objects', () => {
  const parser = new JsonStreamParser(); const payload = '{"text":"你好{\\\"}世界","nested":[{}]}\n{"code":0}'; const records = [];
  for (const character of payload) records.push(...parser.write(character)); parser.finish();
  assert.equal(records.length, 2); assert.equal(records[0]?.text, '你好{\"}世界');
  assert.throws(() => { const p = new JsonStreamParser(); p.write('{"code":'); p.finish(); });
});
test('V3 adapter sends documented credentials and concatenates complete legacy chunks', async t => {
  const { config, cleanup } = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'test-provider-key', VOLC_DEFAULT_VOICE: 'zh_female_vv_uranus_bigtts', VOLC_RESOURCE_ID: 'seed-tts-2.0' }); t.after(cleanup);
  let sent: RequestInit | undefined;
  const provider = new VolcengineProvider(config, async (url, init) => { assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'); sent = init; return streaming([
    { code: 1000, data: Buffer.from('part-one').toString('base64'), message: '你好' },
    { code: 1000, data: Buffer.from('part-two').toString('base64') }, { code: 20000000 },
  ], 1); });
  const audio = await provider.synthesize({ text: '你好。', voice: configuredVoice(config, config.bootstrapVoice), speechRate: 5, loudnessRate: 0 });
  assert.equal(audio.audio.toString(), 'part-onepart-two');
  assert.equal((sent!.headers as Record<string, string>)['X-Api-Key'], 'test-provider-key');
  const body = JSON.parse(String(sent!.body)); assert.equal(body.req_params.audio_params.speech_rate, 5); assert.equal(body.req_params.speaker, config.bootstrapVoice);
});
test('new V3 code-zero response and old-console authentication are supported', async t => {
  const { config, cleanup } = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_APP_ID: 'test-app', VOLC_ACCESS_KEY: 'test-access', VOLC_DEFAULT_VOICE: 'zh_female_vv_uranus_bigtts', VOLC_RESOURCE_ID: 'seed-tts-2.0' }); t.after(cleanup);
  const provider = new VolcengineProvider(config, async (_, init) => {
    const headers = init!.headers as Record<string, string>; assert.equal(headers['X-Api-App-Id'], 'test-app'); assert.equal(headers['X-Api-Access-Key'], 'test-access');
    return streaming([{ code: 0, data: Buffer.from('new-audio').toString('base64') }]);
  });
  const output = await provider.synthesize({ text: '测试。', voice: configuredVoice(config, config.bootstrapVoice), speechRate: 0, loudnessRate: 0 }); assert.equal(output.audio.toString(), 'new-audio');
});
test('truncated legacy stream and provider errors never become playable results', async t => {
  const { config, cleanup } = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'test', VOLC_DEFAULT_VOICE: 'zh_female_vv_uranus_bigtts', VOLC_RESOURCE_ID: 'seed-tts-2.0' }); t.after(cleanup);
  const input = { text: '测试。', voice: configuredVoice(config, config.bootstrapVoice), speechRate: 0, loudnessRate: 0 };
  const truncated = new VolcengineProvider(config, async () => streaming([{ code: 1000, data: Buffer.from('partial').toString('base64') }]));
  await assert.rejects(truncated.synthesize(input), (e: unknown) => e instanceof DomainError && e.code === 'TTS_INCOMPLETE');
  const denied = new VolcengineProvider(config, async () => streaming([{ code: 45000000, message: 'speaker permission denied: private credentials should not leak' }]));
  await assert.rejects(denied.synthesize(input), (e: unknown) => e instanceof DomainError && e.code === 'TTS_PERMISSION_DENIED' && !e.message.includes('private credentials'));
});
test('Seed Audio uses create with model/prompt/references and preserves duration/subtitle without fetching returned URL', async t => {
  const { config, cleanup } = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'test', VOLC_DEFAULT_VOICE: 'zh_female_vv_uranus_bigtts' }); t.after(cleanup);
  let calls = 0;
  const provider = new SeedAudioProvider(config, async (url, init) => {
    calls++; assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/create');
    const body = JSON.parse(String(init!.body)); assert.equal(body.model, 'seed-audio-1.0'); assert.equal(body.references[0].speaker, config.bootstrapVoice); assert.ok(body.text_prompt.includes('安静、自然')); assert.ok(!('X-Api-Resource-Id' in (init!.headers as object)));
    return Response.json({ audio: Buffer.from('seed-audio').toString('base64'), duration: 3.4, subtitle: { text: '测试台词。' }, url: 'https://not-fetched.example/audio' });
  });
  const output = await provider.synthesize({ text: '测试台词。', voice: configuredVoice(config, config.bootstrapVoice), speechRate: 0, loudnessRate: 0, direction: '安静、自然' });
  assert.equal(calls, 1); assert.equal(output.durationSeconds, 3.4); assert.equal(output.spokenText, '测试台词。');
});

test('HTTP resource entitlement errors retain actionable codes without leaking provider text', async t => {
  const { config, cleanup } = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'test', VOLC_DEFAULT_VOICE: 'test-speaker', VOLC_RESOURCE_ID: 'seed-tts-2.0' }); t.after(cleanup);
  const input = { text: '测试。', voice: configuredVoice(config, config.bootstrapVoice), speechRate: 0, loudnessRate: 0 };
  for (const Provider of [SeedAudioProvider, VolcengineProvider]) {
    const provider = new Provider(config, async () => Response.json({ code: 45000030, message: '[resource_id=volc.service_type.10074] requested resource not granted; secret-value' }, { status: 403 }));
    await assert.rejects(provider.synthesize(input), (e: unknown) => e instanceof DomainError && e.code === 'TTS_RESOURCE_NOT_GRANTED' && e.details?.resource_id === 'volc.service_type.10074' && !JSON.stringify(e).includes('secret-value'));
    const oversized = new Provider(config, async () => new Response('x'.repeat(20000), { status: 403 }));
    await assert.rejects(oversized.synthesize(input), (e: unknown) => e instanceof DomainError && e.code === 'TTS_PERMISSION_DENIED');
  }
});
