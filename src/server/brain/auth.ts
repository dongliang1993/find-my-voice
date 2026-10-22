import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Settings } from '../config.js';

export type BrainAuthSource = 'app' | 'claude-code' | 'environment' | 'none';
export type BrainAuth = { source: BrainAuthSource; env: Record<string, string>; model: string | undefined };
type ClaudeSettings = { env?: Record<string, unknown> } | null;

const CLIENT_APP = 'find-my-voice/0.2';
// Only auth, endpoint and model routing are inherited. Anything else in the
// user's Claude Code setup (context limits, telemetry, plugins) stays out.
const INHERITED = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+_MODEL|CUSTOM_HEADERS)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|AWS_\w+|CLOUD_ML_REGION|ANTHROPIC_VERTEX_\w+|ANTHROPIC_BEDROCK_\w+|ANTHROPIC_FOUNDRY_\w+|VERTEX_REGION_\w+|GOOGLE_APPLICATION_CREDENTIALS|HTTPS?_PROXY|NO_PROXY)$/;
const CREDENTIAL = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;

const pick = (source: Record<string, unknown> | undefined) => Object.fromEntries(
  Object.entries(source ?? {}).filter(([key, value]) => INHERITED.test(key) && typeof value === 'string' && value !== ''),
) as Record<string, string>;
const hasCredential = (env: Record<string, string>) => Object.keys(env).some(key => CREDENTIAL.test(key));

/**
 * Decides which model credentials the companion uses, in order: settings made
 * in this app, the user's Claude Code settings, then the process environment.
 * A claude.ai subscription login is deliberately never used: third-party apps
 * may not offer it, so "none" sends the user to the setup screen instead.
 */
export function resolveBrainAuth(input: {
  app: Settings['brain']; claudeSettings: ClaudeSettings;
  processEnv: Record<string, string | undefined>; configDir?: string;
}): BrainAuth {
  const { app, claudeSettings, processEnv, configDir } = input;
  const baseEnv: Record<string, string> = {
    ...(processEnv.PATH ? { PATH: processEnv.PATH } : {}),
    ...(processEnv.HOME ? { HOME: processEnv.HOME } : {}),
    CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  };
  const finish = (source: BrainAuthSource, env: Record<string, string>, model?: string): BrainAuth =>
    ({ source, env: { ...baseEnv, ...env }, model: model || undefined });

  if (app.apiKey) {
    return finish('app', { ANTHROPIC_API_KEY: app.apiKey, ...(app.baseUrl ? { ANTHROPIC_BASE_URL: app.baseUrl } : {}) }, app.model);
  }
  const fromClaude = pick(claudeSettings?.env);
  if (hasCredential(fromClaude)) return finish('claude-code', fromClaude, app.model);
  const fromProcess = pick(processEnv);
  if (hasCredential(fromProcess)) return finish('environment', fromProcess, app.model);
  return finish('none', {}, app.model);
}

export function readClaudeSettings(path = resolve(homedir(), '.claude', 'settings.json')): ClaudeSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as ClaudeSettings : null;
  } catch {
    // Missing or unreadable Claude Code settings simply mean nothing to inherit.
    return null;
  }
}
