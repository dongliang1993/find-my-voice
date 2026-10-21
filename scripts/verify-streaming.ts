import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import type { PlaybackReport } from '../src/playback.js';

// Opt-in live verification: one paid synthesis, system playback, and a same-ID replay.
// No credentials or signed media URLs are included in the saved verification report.
const config = loadConfig();
const client = new Client({ name: 'streaming-live-verifier', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(config.root, 'dist/stdio.js')],
  cwd: config.root, env: { PATH: process.env.PATH || '', VOICE_REPLY_MODE: 'adaptive', LOCAL_AUDIO_PLAYBACK: 'stream' }, stderr: 'pipe' });
const requestId = randomUUID();
const text = '这是一次流式语音验证。我会在音频还没有接收完的时候开始说话。你不需要点击播放按钮，这段声音也会同时保存，方便之后回听。';
const directory = resolve(config.dataDir, 'verification');
mkdirSync(directory, { recursive: true, mode: 0o700 });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.find(tool => tool.name === 'voice.speak')?.inputSchema.properties?.playback);
  assert.ok(tools.some(tool => tool.name === 'voice.control'));
  const context = await client.readResource({ uri: 'finding-my-voice://context/default' });
  assert.ok('text' in context.contents[0]!);
  const state = JSON.parse(context.contents[0]!.text);
  assert.equal(state.interaction.voice_reply_mode, 'adaptive');
  const args = { request_id: requestId, text, generation_mode: 'tts', playback: 'stream' };
  const result = await client.callTool({ name: 'voice.speak', arguments: args });
  if (result.isError) throw new Error(String((result.content as { text?: string }[])[0]?.text || 'TTS failed'));
  const audio = (result.structuredContent as { data: { audio_id: string; local_audio_path: string; duration_seconds: number; voice_name: string } }).data;
  const deadline = Date.now() + audio.duration_seconds * 2000 + 10000;
  let delivery: PlaybackReport | undefined;
  while (Date.now() < deadline) {
    const status = await client.callTool({ name: 'voice.control', arguments: { action: 'status' } });
    const current = (status.structuredContent as { data: { active: boolean; delivery: PlaybackReport } }).data;
    delivery = current.delivery;
    if (!current.active) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(delivery);
  const report = { checked_at: new Date().toISOString(), request_id: requestId, transport: 'stdio MCP',
    text, voice_name: audio.voice_name, audio_id: audio.audio_id, audio_path: audio.local_audio_path,
    duration_seconds: audio.duration_seconds, delivery, checks: {
      native_playback_completed: delivery.state === 'completed',
      non_silent_system_output: (delivery.non_silent_output_frames ?? 0) > 0,
      rendered_before_upstream_eof: delivery.rendered_before_synthesis_completed === true,
      multiple_audio_chunks: delivery.chunks > 1,
      archived_wav: readFileSync(audio.local_audio_path).toString('ascii', 0, 4) === 'RIFF',
      same_request_did_not_replay: false,
    } };
  const replay = await client.callTool({ name: 'voice.speak', arguments: args });
  const reused = (replay.structuredContent as { data: { reused: boolean; audio_id: string } }).data;
  const afterReplay = await client.callTool({ name: 'voice.control', arguments: { action: 'status' } });
  report.checks.same_request_did_not_replay = reused.reused && reused.audio_id === audio.audio_id &&
    !(afterReplay.structuredContent as { data: { active: boolean } }).data.active;
  writeFileSync(resolve(directory, 'streaming-latest.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  assert.ok(Object.values(report.checks).every(Boolean), 'Live verification did not pass every check; inspect the saved report.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Streaming verification failed.'); process.exitCode = 1;
} finally { await client.close(); }
