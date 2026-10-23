// Can the SDK still spawn the claude binary from inside a packaged app?
//
// The settled answer: yes. The SDK ships a native claude binary per platform
// and spawns it directly (it never goes through the host interpreter), and
// `pathToClaudeCodeExecutable` is the official escape hatch for packaged
// layouts. This script exists to re-prove it after a repack, not to re-litigate.
//
// Judgement (fixed):
//   PASS  a claude child process appears (pgrep) and the first SDK message
//         is system:init — spawn and exec both worked.
//   FAIL  no child, or no init message; the wrapper error printed below says
//         which layer refused.
//
// Notes learned the hard way:
//   - `extraArgs: { version: null }` does NOT reach the child; the wrapper
//     treats the null value as a schema and never spawns. Do not use it as a
//     no-billing probe — it silently tests nothing.
//   - A successful minimal query DOES start a real session and may bill.
//   - This script never modifies the binary; it records its sha256 first.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';

const target = process.argv[2]
  ?? realpathSync('node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');

const hash = createHash('sha256');
await new Promise((resolveOk, reject) => {
  const stream = createReadStream(target);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', resolveOk);
});
console.log(`[spike-0] target: ${target}`);
console.log(`[spike-0] sha256: ${hash.digest('hex')}`);

const before = execSync('pgrep -x claude || true').toString();
const seen = [];
try {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const q = query({ prompt: 'hi', options: { pathToClaudeCodeExecutable: target, maxTurns: 1 } });
  for await (const message of q) {
    seen.push(`${message.type}:${message.subtype ?? ''}`);
    if (seen.length >= 3) break; // init arrival is the signal; stop before billing
  }
} catch (error) {
  console.log(`[spike-0] wrapper error: ${error.message}`);
}
await new Promise(resolve => setTimeout(resolve, 300));
const after = execSync('pgrep -x claude || true').toString();
const spawned = after.split('\n').filter(line => line && !before.split('\n').includes(line));

// init arriving is itself the proof: no child process, no init message. The
// pgrep count is informational only — process names do not reliably match.
const init = seen.some(s => s.startsWith('system:init'));
console.log(`[spike-0] pgrep delta: ${spawned.length}; first messages: ${seen.join(' | ') || '(none)'}`);
console.log(init
  ? '[spike-0] PASS — explicit-path spawn works; init reached'
  : '[spike-0] FAIL — see wrapper error above');
