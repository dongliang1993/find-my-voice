import { build } from 'esbuild';

// Bundle our own code; dependencies stay in node_modules (the Agent SDK ships a native binary).
await build({
  entryPoints: ['src/server/index.ts'],
  bundle: true, packages: 'external', platform: 'node', format: 'esm',
  target: 'node22', outdir: 'dist/server', sourcemap: true,
});
