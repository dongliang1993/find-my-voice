import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { projectRoot } from '../src/config.js';
import { createMcpServer, PLAYER_URI } from '../src/mcp.js';
import { createHttpApp, startHttp } from '../src/http.js';
import { setup, entries, persona, testEnv, memoryMarkdown, identityMarkdown } from './helpers.js';

test('owner decision API requires its own session; MCP token cannot commit and cross-origin writes are rejected', async t => {
  const { service: s, cleanup } = setup(); t.after(cleanup); const app = createHttpApp(s);
  const p = s.memorySave({ request_id: 'http-memory-1', entries });
  const payload = JSON.stringify({ id: p.data.pending_id, approve: true, selected_indices: [1] });
  const unauthorized = await app.request('http://127.0.0.1/api/decision', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.config.mcpToken}` }, body: payload });
  assert.equal(unauthorized.status, 401); assert.equal(s.context().memories.length, 0);
  const login = await app.request('http://127.0.0.1/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: s.config.adminToken }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const cross = await app.request('http://127.0.0.1/api/decision', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: payload }); assert.equal(cross.status, 403);
  const accepted = await app.request('http://127.0.0.1/api/decision', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' }, body: payload });
  assert.equal(accepted.status, 200); assert.equal(s.context().memories[0]?.content, entries[1].content);
  const badHost = await app.request('http://evil.example/health'); assert.equal(badHost.status, 403);
});
test('signed audio supports full/HEAD/range/suffix requests and refuses missing or tampered signatures', async t => {
  const { service: s, cleanup } = setup(); t.after(cleanup); const app = createHttpApp(s);
  const result = await s.speak({ request_id: 'http-speech-1', text: '测试。' }); const url = result.data.audio_url;
  const full = await app.request(url); assert.equal(full.status, 200); const bytes = Buffer.from(await full.arrayBuffer()); assert.equal(bytes.toString('utf8', 0, 4), 'RIFF');
  const head = await app.request(url, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await app.request(url, { headers: { Range: 'bytes=0-43' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 44);
  const suffix = await app.request(url, { headers: { Range: 'bytes=-10' } }); assert.equal(suffix.status, 206); assert.equal((await suffix.arrayBuffer()).byteLength, 10);
  const invalid = await app.request(url, { headers: { Range: 'bytes=99999999-' } }); assert.equal(invalid.status, 416);
  const unsigned = await app.request(url.split('?')[0]!); assert.equal(unsigned.status, 403);
  const tamperedUrl = new URL(url); tamperedUrl.searchParams.set('signature', '0'.repeat(64)); assert.equal((await app.request(tamperedUrl.href)).status, 403);
  assert.equal((await app.request(result.data.player_url)).status, 200);
});
test('HTTP MCP can initialize, expose setup plus four business tools, read resources, synthesize and fetch media', async t => {
  const { service: s, cleanup } = setup(); const http = await startHttp(s, 0);
  const client = new Client({ name: 'integration-client', version: '1' });
  t.after(async () => { await client.close(); await http.close(); cleanup(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${http.localUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${s.config.mcpToken}` } } }));
  const tools = await client.listTools(); assert.deepEqual(tools.tools.map(t => t.name).sort(), ['identity.update', 'memory.save', 'profile.write', 'setup.start', 'voice.list', 'voice.speak']);
  const setupResult = await client.callTool({ name: 'setup.start', arguments: {} });
  assert.equal((setupResult.structuredContent as { data: { next_step: string } }).data.next_step, 'memory');
  const context = await client.readResource({ uri: 'finding-my-voice://context/default' }); assert.ok('text' in context.contents[0]!); assert.equal(JSON.parse(String(context.contents[0]!.text)).identity.version, 0);
  const widget = await client.readResource({ uri: PLAYER_URI }); assert.equal(widget.contents[0]!.mimeType, 'text/html;profile=mcp-app');
  const result = await client.callTool({ name: 'voice.speak', arguments: { request_id: 'mcp-speech-1', text: 'HTTP MCP 测试。' } }); assert.equal(result.isError, undefined);
  const data = result.structuredContent as { status: string; data: { audio_url: string; is_test_audio: boolean; local_audio_path?: string } };
  assert.equal(data.status, 'completed'); assert.equal(data.data.is_test_audio, true); assert.equal(data.data.local_audio_path, undefined); assert.equal((await fetch(data.data.audio_url)).status, 200);
  assert.equal((await fetch(`${http.localUrl}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});
test('stdio MCP returns local audio paths and serves the optional player through a loopback sidecar', async t => {
  const x = setup(); const client = new Client({ name: 'stdio-client', version: '1' });
  t.after(async () => { await client.close(); x.cleanup(); });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve(projectRoot, 'src/stdio.ts')], cwd: projectRoot,
    env: { ...testEnv, DATA_DIR: x.dir, PATH: process.env.PATH || '' }, stderr: 'pipe' });
  await client.connect(transport);
  for (const [document, content] of [['memory', memoryMarkdown], ['identity', identityMarkdown]]) {
    const result = await client.callTool({ name: 'profile.write', arguments: { document, content, base_sha256: null } });
    assert.equal((result.structuredContent as { status: string }).status, 'completed');
  }
  const profile = await client.readResource({ uri: 'finding-my-voice://profile/identity' });
  assert.ok('text' in profile.contents[0]!); assert.equal(profile.contents[0]!.text, identityMarkdown);
  const result = await client.callTool({ name: 'voice.speak', arguments: { request_id: 'stdio-speech-1', text: '本地测试。' } });
  const output = result.structuredContent as { data: { local_audio_path: string; player_url: string } }; assert.ok(existsSync(output.data.local_audio_path)); assert.equal((await fetch(output.data.player_url)).status, 200);
});
test('trusted MCP elicitation accepts the displayed proposal and commits without an owner API call', async t => {
  const { service: s, cleanup } = setup(); const server = createMcpServer(s, true);
  const client = new Client({ name: 'form-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let shown = '';
  client.setRequestHandler(ElicitRequestSchema, async request => {
    shown = request.params.message;
    assert.ok('requestedSchema' in request.params);
    const schema = request.params.requestedSchema;
    assert.ok(!('default' in schema.properties.decision!));
    return { action: 'accept', content: { decision: '确认保存' } };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const result = await client.callTool({ name: 'memory.save', arguments: { request_id: 'elicitation-memory-1', entries: [entries[0]] } });
  assert.ok(shown.includes(entries[0].content)); assert.equal((result.structuredContent as { status: string }).status, 'approved'); assert.equal(s.context().memories.length, 1);
});

for (const outcome of ['decline', 'cancel', 'later', 'missing', 'unchecked', 'error'] as const) {
  test(`host form ${outcome} keeps the draft pending and repeated status checks never reprompt`, async t => {
    const { service: s, cleanup } = setup(); const server = createMcpServer(s, true);
    const client = new Client({ name: 'form-fallback-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
    let shown = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      shown++;
      if (outcome === 'error') throw new Error('host-form-failure-private-details');
      if (outcome === 'later') return { action: 'accept', content: { decision: '暂不决定' } };
      if (outcome === 'missing') return { action: 'accept', content: {} };
      if (outcome === 'unchecked') return { action: 'accept', content: { approve: false } };
      return { action: outcome };
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); cleanup(); });
    await server.connect(st); await client.connect(ct);
    const args = { name: 'memory.save', arguments: { request_id: `form-${outcome}-memory`, entries: [entries[0]] } };
    const result = await client.callTool(args);
    assert.notEqual(result.isError, true);
    const output = result.structuredContent as { status: string; data: { pending_id: string; review_url: string; review_command: string; confirmation: { reason: string } } };
    assert.equal(output.status, 'awaiting_confirmation');
    assert.ok(output.data.review_command.includes(resolve(projectRoot, 'scripts/open-admin.mjs')));
    assert.ok(output.data.review_command.includes(output.data.review_url));
    assert.ok(!JSON.stringify(result).includes(s.config.adminToken));
    assert.ok(!JSON.stringify(result).includes('host-form-failure-private-details'));
    assert.equal(s.store.pending(s.config.ownerId, output.data.pending_id).state, 'pending');
    assert.equal(s.context().memories.length, 0);
    const repeated = await client.callTool(args);
    assert.equal((repeated.structuredContent as { status: string }).status, 'awaiting_confirmation');
    assert.equal(shown, 1);
    // Independent owner review still works after the host form was unavailable or dismissed.
    s.decide(output.data.pending_id, true);
    const approved = await client.callTool(args);
    assert.equal((approved.structuredContent as { status: string }).status, 'approved');
    assert.equal(s.context().memories.length, 1); assert.equal(shown, 1);
  });
}

test('explicit draft rejection remains final; a user-requested new submission uses a new ID', async t => {
  const { service: s, cleanup } = setup(); const server = createMcpServer(s, true);
  const client = new Client({ name: 'reject-then-retry-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let shown = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { decision: ++shown === 1 ? '拒绝这份草稿' : '确认保存' } }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  await server.connect(st); await client.connect(ct);
  const args = { name: 'memory.save', arguments: { request_id: 'explicit-reject-memory', entries: [entries[0]] } };
  const result = await client.callTool(args);
  const rejected = result.structuredContent as { status: string; data: { pending_id: string; new_submission_requires_new_request_id: boolean } };
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.data.new_submission_requires_new_request_id, true);
  assert.equal(((await client.callTool(args)).structuredContent as { status: string }).status, 'rejected');
  assert.equal(shown, 1); assert.equal(s.context().memories.length, 0);
  const retry = await client.callTool({ ...args, arguments: { ...args.arguments, request_id: 'explicit-new-memory' } });
  assert.equal((retry.structuredContent as { status: string }).status, 'approved'); assert.equal(shown, 2);
  assert.equal(s.store.pending(s.config.ownerId, rejected.data.pending_id).state, 'rejected');
  assert.equal(s.context().memories.length, 1);
});

test('declining an identity form does not reject the persona or advance setup', async t => {
  const { service: s, cleanup } = setup();
  const memory = s.memorySave({ request_id: 'persona-form-memory', entries: [entries[0]] }); s.decide(memory.data.pending_id, true);
  const server = createMcpServer(s, true);
  const client = new Client({ name: 'identity-form-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  await server.connect(st); await client.connect(ct);
  const result = await client.callTool({ name: 'identity.update', arguments: { request_id: 'deferred-persona', base_version: 0,
    identity: persona, memory_ids: s.context().memories.map(m => m.id), change_reason: '依据有效记忆建立表达画像。' } });
  assert.equal((result.structuredContent as { status: string }).status, 'awaiting_confirmation');
  assert.equal(s.context().identity.version, 0);
  assert.equal(s.setup(true).data.next_step, 'memory'); // Legacy approval does not block Markdown initialization.
});

test('a local host without forms gets a pending draft and a full user-operated review command', async t => {
  const { service: s, cleanup } = setup(); const server = createMcpServer(s, true);
  const client = new Client({ name: 'no-form-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  await server.connect(st); await client.connect(ct);
  const result = await client.callTool({ name: 'memory.save', arguments: { request_id: 'no-form-memory', entries: [entries[0]] } });
  const output = result.structuredContent as { status: string; data: { review_command: string; review_command_run_by: string; confirmation: { reason: string } } };
  assert.equal(output.status, 'awaiting_confirmation');
  assert.equal(output.data.confirmation.reason, 'form_not_supported');
  assert.equal(output.data.review_command_run_by, 'user');
  assert.ok(output.data.review_command.startsWith(`'${process.execPath}' `));
  assert.ok(output.data.review_command.includes(resolve(projectRoot, 'scripts/open-admin.mjs')));
  assert.ok(!output.data.review_command.includes(s.config.adminToken));
  assert.equal(s.context().memories.length, 0);
});
