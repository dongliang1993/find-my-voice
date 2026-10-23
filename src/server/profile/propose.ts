import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrainAuth } from '../brain/auth.js';
import { proposalPrompt, proposalSchema, type Proposal } from './naming.js';

/**
 * Runs one name proposal as a throwaway agent with structured output. The
 * onboarding flow is the only place the model is in the loop; this is the
 * proposal half of it. Isolated like every other one-shot (no settings, no
 * tools, no persisted session) and retried at most a few times per step.
 */
export async function proposeNameWithClaude(auth: BrainAuth, dataDir: string, userAlias: string, notes: string, onLog?: (line: string) => void): Promise<Proposal> {
  const workspace = resolve(dataDir, 'workspace');
  const configDir = resolve(dataDir, 'claude');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const session = query({
    prompt: proposalPrompt(userAlias, notes),
    options: {
      systemPrompt: '你是一个起名师。只输出结构化结果，不解释流程。',
      model: auth.model,
      env: { ...auth.env, CLAUDE_CONFIG_DIR: configDir },
      cwd: workspace,
      settingSources: [],
      tools: [],
      permissionMode: 'dontAsk',
      thinking: { type: 'disabled' },
      persistSession: false,
      maxTurns: 3,
      // The CLI validates schemas as draft-07; zod defaults to 2020-12, which it rejects.
      outputFormat: { type: 'json_schema', schema: z.toJSONSchema(proposalSchema, { target: 'draft-7' }) as Record<string, unknown> },
      stderr: line => onLog?.(line),
    },
  });
  for await (const message of session) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') throw new Error(`name proposal ended: ${message.subtype}`);
    if (message.structured_output === undefined) throw new Error('name proposal returned no structured output');
    return proposalSchema.parse(message.structured_output);
  }
  throw new Error('name proposal produced no result');
}
