import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { VoiceService } from '../src/service.js';
import { errorPayload } from '../src/errors.js';

const args = process.argv.slice(2);
const text = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--direction' && args[args.indexOf(arg) - 1] !== '--voice');
if (!text) throw new Error('Usage: npm run speak -- "要说的话" [--stream-play | --no-play] [--seed-audio] [--direction "声音描述"] [--voice speaker_id]');
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
