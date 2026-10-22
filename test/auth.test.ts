import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrainAuth } from '../src/server/brain/auth.js';

const empty = { baseUrl: '', apiKey: '', model: '' };
const base = { PATH: '/bin', HOME: '/home/me' };

test('app-level credentials win and never leak inherited ones', () => {
  const auth = resolveBrainAuth({
    app: { baseUrl: 'https://api.example.com/anthropic', apiKey: 'app-key', model: 'm1' },
    claudeSettings: { env: { ANTHROPIC_AUTH_TOKEN: 'cc-token' } },
    processEnv: { ...base, ANTHROPIC_API_KEY: 'proc-key' },
  });
  assert.equal(auth.source, 'app');
  assert.equal(auth.env.ANTHROPIC_API_KEY, 'app-key');
  assert.equal(auth.env.ANTHROPIC_BASE_URL, 'https://api.example.com/anthropic');
  assert.equal(auth.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(auth.model, 'm1');
});

test('inherits only auth/model variables from Claude Code settings', () => {
  const auth = resolveBrainAuth({
    app: empty,
    claudeSettings: { env: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_DEFAULT_SONNET_MODEL: 's', DISABLE_TELEMETRY: '1', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '9' } },
    processEnv: base,
  });
  assert.equal(auth.source, 'claude-code');
  assert.equal(auth.env.ANTHROPIC_AUTH_TOKEN, 't');
  assert.equal(auth.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 's');
  assert.equal(auth.env.DISABLE_TELEMETRY, undefined);
  assert.equal(auth.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test('recognises cloud-provider setups as credentials', () => {
  const auth = resolveBrainAuth({ app: empty, claudeSettings: { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' } }, processEnv: base });
  assert.equal(auth.source, 'claude-code');
  assert.equal(auth.env.AWS_REGION, 'us-east-1');
});

test('falls back to the process environment', () => {
  const auth = resolveBrainAuth({ app: empty, claudeSettings: null, processEnv: { ...base, ANTHROPIC_API_KEY: 'p' } });
  assert.equal(auth.source, 'environment');
  assert.equal(auth.env.ANTHROPIC_API_KEY, 'p');
});

test('reports none when only a subscription login could be used', () => {
  // A base URL alone is not a credential; the CLI would fall back to claude.ai OAuth.
  const auth = resolveBrainAuth({ app: empty, claudeSettings: { env: { ANTHROPIC_BASE_URL: 'https://gw' } }, processEnv: base });
  assert.equal(auth.source, 'none');
});

test('always passes PATH/HOME, identifies the client app and isolates config', () => {
  const auth = resolveBrainAuth({ app: { ...empty, apiKey: 'k' }, claudeSettings: null, processEnv: { ...base, SECRET_TOKEN: 'x' }, configDir: '/data/claude' });
  assert.equal(auth.env.PATH, '/bin');
  assert.equal(auth.env.HOME, '/home/me');
  assert.equal(auth.env.SECRET_TOKEN, undefined);
  assert.equal(auth.env.CLAUDE_CONFIG_DIR, '/data/claude');
  assert.match(auth.env.CLAUDE_AGENT_SDK_CLIENT_APP ?? '', /^find-my-voice\//);
});
