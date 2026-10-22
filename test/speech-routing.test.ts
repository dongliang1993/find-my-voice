import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { VoiceService } from '../src/service.js';
import { DomainError } from '../src/errors.js';
import { pcmToWav } from '../src/provider.js';
import type { StreamingPlayback } from '../src/playback.js';
import { setup, testEnv } from './helpers.js';
import { projectRoot } from '../src/config.js';

test('one minimal MCP call lets the service synthesize, stream before archiving, and return a no-client-processing receipt', async t => {
  const x = setup(undefined, { TTS_PROVIDER: 'volcengine', VOLC_API_KEY: 'routing-test-key',
    VOLC_DEFAULT_VOICE: 'test-speaker', VOLC_RESOURCE_ID: 'seed-tts-2.0', LOCAL_AUDIO_PLAYBACK: 'stream' });
  const pcm = Buffer.from([1, 0, 2, 0]); let calls = 0; let playerStarts = 0; let chunks = 0; let upstreamEnded = false;
  let player!: StreamingPlayback;
  const service = new VoiceService(x.config, { async synthesize(input, options) {
    calls++; assert.equal(input.text, '服务直接说话。'); assert.equal(input.voice.id, 'test-speaker');
    assert.equal(options?.format, 'pcm'); await options!.onAudioChunk!(pcm);
    assert.equal(chunks, 1); assert.equal(upstreamEnded, false);
    assert.equal(existsSync(resolve(x.dir, 'audio', `${player.audioId}.wav`)), false);
    upstreamEnded = true;
    return { audio: pcmToWav(pcm), extension: 'wav', mime: 'audio/wav', durationSeconds: 2 / 24000 };
  } }, async (_, id) => {
    playerStarts++;
    player = { audioId: id, controller: new AbortController(), active: true,
      report: { state: 'starting', format: 'pcm_s16le', sample_rate: 24000, channels: 1, chunks: 0, pcm_bytes: 0 },
      async write() { chunks++; this.report.state = 'playing'; }, finish() { this.report.state = 'completed'; },
      stop() { this.controller.abort(); }, async wait() { return this.report; } };
    return player;
  });
  service.assets.baseUrl = x.service.assets.baseUrl;
  const server = createMcpServer(service, true); const client = new Client({ name: 'ordinary-speech-host', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); service.close(); x.cleanup(); });
  await server.connect(st); await client.connect(ct);
  const context = await client.readResource({ uri: 'finding-my-voice://context/default' });
  assert.ok('text' in context.contents[0]!);
  const api = JSON.parse(String(context.contents[0]!.text)).voice_api;
  assert.equal(api.speak_tool, 'voice.speak'); assert.equal(api.execution_owner, 'service');
  assert.equal(api.control_tool, 'voice.control'); assert.equal(api.automatic_code_or_cli_fallback, false);
  assert.deepEqual(api.required_arguments, ['request_id', 'text']);
  const args = { request_id: 'minimal-service-call', text: '服务直接说话。' };
  const first = await client.callTool({ name: 'voice.speak', arguments: args });
  assert.equal(first.isError, undefined);
  assert.equal(JSON.stringify(first).includes('routing-test-key'), false);
  const audio = (first.structuredContent as { data: { local_audio_path: string; service_execution: {
    synthesis_owner: string; archive_owner: string; client_audio_processing_required: boolean; client_action: string;
    playback: { owner: string; started_for_this_call: boolean };
  }; delivery: { state: string } } }).data;
  assert.equal(audio.service_execution.synthesis_owner, 'service');
  assert.equal(audio.service_execution.archive_owner, 'service');
  assert.equal(audio.service_execution.client_audio_processing_required, false);
  assert.equal(audio.service_execution.client_action, 'none');
  assert.equal(audio.service_execution.playback.owner, 'service');
  assert.equal(audio.service_execution.playback.started_for_this_call, true);
  assert.equal(audio.delivery.state, 'completed');
  assert.deepEqual(readFileSync(audio.local_audio_path).subarray(44), pcm);
  const repeated = await client.callTool({ name: 'voice.speak', arguments: args });
  const replay = (repeated.structuredContent as { data: { reused: boolean; service_execution: { playback: { started_for_this_call: boolean } } } }).data;
  assert.equal(replay.reused, true); assert.equal(replay.service_execution.playback.started_for_this_call, false);
  assert.equal(calls, 1); assert.equal(playerStarts, 1);
});

test('service errors return text-only recovery without vendor or shell fallback or a second synthesis', async t => {
  let calls = 0;
  const x = setup({ async synthesize() { calls++; throw new DomainError('TTS_PERMISSION_DENIED', '模拟服务拒绝。'); } });
  const server = createMcpServer(x.service, true); const client = new Client({ name: 'failure-host', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); x.cleanup(); });
  await server.connect(st); await client.connect(ct);
  const args = { request_id: 'service-failure-call', text: '不要绕过服务。' };
  for (let i = 0; i < 2; i++) {
    const result = await client.callTool({ name: 'voice.speak', arguments: args });
    assert.equal(result.isError, true);
    const error = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.equal(error.speech_recovery.fallback, 'text_only');
    assert.equal(error.speech_recovery.automatic_provider_retry, false);
    assert.equal(error.speech_recovery.ad_hoc_code_allowed, false);
  }
  assert.equal(calls, 1);
});

test('ordinary speech API refuses credential, vendor-protocol and player-command inputs', async t => {
  let calls = 0;
  const x = setup({ async synthesize() { calls++; throw new Error('must not synthesize invalid client input'); } }); t.after(x.cleanup);
  for (const extra of [{ api_key: 'not-a-real-secret' }, { provider_url: 'https://not-a-real-vendor.example' },
    { audio_base64: 'fake' }, { output_path: '/fake/file.wav' }, { player_command: 'afplay' }]) {
    await assert.rejects(x.service.speak({ request_id: 'invalid-client-field', text: '仅文本和业务参数。', ...extra }, true));
  }
  assert.equal(calls, 0); assert.equal(x.service.store.export(x.config.ownerId).speeches.length, 0);
});

test('CLI cannot become an automatic fallback: no diagnostic flag means no configuration, storage or synthesis', t => {
  const x = setup(); t.after(x.cleanup);
  const unusedData = resolve(x.dir, 'must-not-be-created');
  const cli = resolve(projectRoot, 'scripts/speak.ts');
  const env = { ...process.env, ...testEnv, PLUGIN_DATA: unusedData };
  const rejected = spawnSync(process.execPath, ['--import', 'tsx', cli, '普通回复不运行脚本。'], { env, encoding: 'utf8' });
  assert.equal(rejected.status, 2);
  const errorLine = rejected.stderr.split('\n').find(line => line.startsWith('{'))!;
  assert.equal(JSON.parse(errorLine).code, 'SERVICE_CALL_REQUIRED');
  assert.equal(existsSync(unusedData), false);
  const help = spawnSync(process.execPath, ['--import', 'tsx', cli, '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.equal(existsSync(unusedData), false);
});

test('explicit developer diagnostic remains usable without becoming the normal Agent route', t => {
  const x = setup(); t.after(x.cleanup);
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(projectRoot, 'scripts/speak.ts'),
    '--diagnostic', '这是开发诊断测试音。', '--no-play'], {
    env: { ...process.env, ...testEnv, PLUGIN_DATA: x.dir }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const audio = JSON.parse(result.stdout).data;
  assert.equal(audio.is_test_audio, true); assert.equal(audio.service_execution.client_audio_processing_required, false);
  assert.equal(audio.service_execution.playback.started_for_this_call, false);
  assert.equal(existsSync(audio.local_audio_path), true);
});
