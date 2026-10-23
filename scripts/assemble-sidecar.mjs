// Assembles the server sidecar payload for the desktop bundle, in the layout
// the server itself expects (npm layout), so tauri build produces a complete
// .app without any hand-copying:
//
//   <out>/
//     dist/server/index.js      the backend entry (its ../../ packageRoot works)
//     dist/web/                 the frontend, served by the same backend
//     node_modules/@anthropic-ai/claude-agent-sdk[-darwin-arm64]/...
//                               just enough node_modules for the SDK to spawn
//                               claude; the rest resolves from the system.
//
// Only the SDK packages are copied, not the whole node_modules: the server
// bundle is already self-contained (esbuild), and a full copy would add
// hundreds of MB of dev dependencies.
//
// Usage: node scripts/assemble-sidecar.mjs [out-dir]
// Default out-dir: src-tauri/target/release/bundle/macos/Find My Voice.app/Contents/MacOS/server
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = process.argv[2]
  ?? resolve(repo, 'src-tauri/target/release/bundle/macos/Find My Voice.app/Contents/MacOS/server');

// Inputs must exist; a missing one is a build error, never a silent skip.
const inputs = {
  serverDist: resolve(repo, 'dist/server'),
  webDist: resolve(repo, 'dist/web'),
  sdk: resolve(repo, 'node_modules/@anthropic-ai/claude-agent-sdk'),
  platformBinary: resolve(repo, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
};
for (const [name, path] of Object.entries(inputs)) {
  if (!existsSync(path)) {
    console.error(`[sidecar] missing ${name}: ${path} — run npm run build first`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'dist'), { recursive: true });
mkdirSync(resolve(out, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64'), { recursive: true });

cpSync(inputs.serverDist, resolve(out, 'dist/server'), { recursive: true });
cpSync(inputs.webDist, resolve(out, 'dist/web'), { recursive: true });
cpSync(inputs.sdk, resolve(out, 'node_modules/@anthropic-ai/claude-agent-sdk'), { recursive: true });
// Byte-identical, never re-signed: Anthropic's Developer ID signature must
// survive into the bundle untouched.
cpSync(inputs.platformBinary, resolve(out, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'));

// Verify the two load-bearing facts instead of trusting the copy.
const entry = resolve(out, 'dist/server/index.js');
const web = resolve(out, 'dist/web/index.html');
const claude = resolve(out, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
for (const [what, path] of [['entry', entry], ['web', web], ['claude', claude]]) {
  if (!existsSync(path)) { console.error(`[sidecar] ${what} missing after copy: ${path}`); process.exit(1); }
}
const onboarding = readdirSync(resolve(out, 'dist/web/onboarding')).filter(f => f.endsWith('.wav'));
if (onboarding.length < 8) {
  console.error(`[sidecar] only ${onboarding.length}/8 onboarding wavs — run scripts/pregen-onboarding.mjs`);
  process.exit(1);
}

console.log(`[sidecar] assembled → ${out}`);
console.log(`[sidecar] onboarding wavs: ${onboarding.length}`);
