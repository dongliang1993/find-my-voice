import { loadConfig } from './config.js';
import { VoiceService } from './service.js';
import { startHttp } from './http.js';

const service = new VoiceService(loadConfig());
const http = await startHttp(service);
console.log(`Finding My Voice: ${http.localUrl}/admin (provider: ${service.config.provider})`);
console.log('Open the owner session with npm run admin. MCP HTTP requires the private MCP_TOKEN.');
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await service.shutdown(); await http.close(); process.exit(0);
}
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
