import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { VoiceService } from '../src/service.js';
import { errorPayload } from '../src/errors.js';

const args = process.argv.slice(2);
const usage = 'Developer diagnostic only: npm run speak -- --diagnostic "要说的话" [--stream-play | --no-play] [--seed-audio] [--direction "声音描述"] [--voice speaker_id]';
if (args.includes('--help')) { console.log(usage); process.exit(0); }
// Do not initialize config, credentials, media storage or a provider when an
// ordinary Agent tries to fall back to launching this executable.
if (!args.includes('--diagnostic')) {
  console.error(JSON.stringify({ code: 'SERVICE_CALL_REQUIRED', message: '日常语音请直接调用 MCP voice.speak，由服务完成合成、播放和归档。工具不可用时重连 MCP，不自动运行脚本。开发诊断须由用户明确选择 --diagnostic。' }));
  process.exit(2);
}
const text = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--direction' && args[args.indexOf(arg) - 1] !== '--voice');
if (!text) throw new Error(usage);
const option = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
const service = new VoiceService(loadConfig());
service.assets.baseUrl = service.config.publicBaseUrl || `http://127.0.0.1:${service.config.port}`;
try {
  const result = await service.speak({ request_id: randomUUID(), text, voice_id: option('--voice'),
    playback: args.includes('--stream-play') ? 'stream' : args.includes('--no-play') || args.includes('--seed-audio') ? 'none' : undefined,
    generation_mode: args.includes('--seed-audio') ? 'seed-audio' : undefined, speech_direction: option('--direction') }, true);
  console.log(JSON.stringify(result, null, 2));
  const delivery = await service.waitForPlayback();
  if (delivery) console.log(JSON.stringify({ delivery }, null, 2));
} catch (e) { console.error(JSON.stringify(errorPayload(e))); process.exitCode = 1; }
finally { service.close(); }
