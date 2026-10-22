import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { VoiceService } from './service.js';
import { createMcpServer } from './mcp.js';
import { startHttp } from './http.js';

const service = new VoiceService(loadConfig());
// Fixed port: the owner page must stay reachable at a stable address while the
// MCP process runs, otherwise a bookmark breaks on every reconnect.
const http = await startHttp(service, service.config.port);
const server = createMcpServer(service, true);
await server.connect(new StdioServerTransport());
console.error(`Finding My Voice MCP ready; owner UI ${http.localUrl}/admin; provider=${service.config.provider}`);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await service.shutdown(); await server.close(); await http.close(); process.exit(0);
}
process.stdin.once('end', () => void stop());
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
