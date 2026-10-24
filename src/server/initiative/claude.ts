import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrainAuth } from '../brain/auth.js';
import { judgementSchema, type Judgement } from './judge.js';

/**
 * Runs one judgement as a throwaway agent with structured output. Isolated the
 * same way memory extraction is: no tools, no user settings, no persisted
 * session. It never sees the persona, and the persona never sees its prompt.
 */
export async function judgeWithClaude(auth: BrainAuth, dataDir: string, prompt: string, onLog?: (line: string) => void): Promise<Judgement> {
  const workspace = resolve(dataDir, 'workspace');
  const configDir = resolve(dataDir, 'claude');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const session = query({
    prompt,
    options: {
      systemPrompt: '你判断现在是否值得主动开口。默认是不说；只有具体、依然有意义的事才值得。',
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
      outputFormat: { type: 'json_schema', schema: z.toJSONSchema(judgementSchema, { target: 'draft-7' }) as Record<string, unknown> },
      stderr: line => onLog?.(line),
    },
  });

  for await (const message of session) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') throw new Error(`judgement ended: ${message.subtype}`);
    if (message.structured_output === undefined) throw new Error('judgement returned no structured output');
    return judgementSchema.parse(message.structured_output);
  }

  throw new Error('judgement produced no result');
}
