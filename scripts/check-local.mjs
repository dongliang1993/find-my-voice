import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const client = new Client({ name: 'finding-my-voice-install-check', version: '1' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'dist/stdio.js')], cwd: root,
    env: { PATH: process.env.PATH || '', LOCAL_AUDIO_PLAYBACK: 'none' }, stderr: 'pipe' }));
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  const expected = ['setup.start', 'profile.write', 'memory.save', 'identity.update', 'voice.list', 'voice.speak', 'voice.control'];
  if (!expected.every(name => tools.includes(name))) throw new Error('Installed MCP is missing required tools.');
  const result = await client.callTool({ name: 'setup.start', arguments: {} });
  if (result.isError || !result.structuredContent?.data) throw new Error('The setup entry did not return progress.');
  const setup = result.structuredContent.data;
  if (setup.voice_api?.speak_tool !== 'voice.speak' || setup.voice_api?.execution_owner !== 'service' || setup.voice_api?.automatic_code_or_cli_fallback !== false) {
    throw new Error('Installed MCP does not expose the service-owned speech contract. Rebuild and reconnect.');
  }
  console.log(JSON.stringify({ connection: 'passed', tools, setup_next_step: setup.next_step,
    speech_api: setup.voice_api.speak_tool, speech_execution_owner: setup.voice_api.execution_owner, automatic_code_or_cli_fallback: false,
    provider_configured: setup.provider_configured, paid_audio_generated: false }, null, 2));
} finally { await client.close(); }
