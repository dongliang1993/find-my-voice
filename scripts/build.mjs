import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await build({
  entryPoints: ['src/server.ts', 'src/stdio.ts', 'src/cli-api.ts'],
  bundle: true, packages: 'external', platform: 'node', format: 'esm',
  target: 'node22', outdir: 'dist', sourcemap: true,
});
await mkdir('dist/public', { recursive: true });
for (const file of ['player.html', 'admin.html']) await copyFile(`public/${file}`, `dist/public/${file}`);
// npm never includes package-lock.json; publish the same pinned dependency graph as a shrinkwrap.
await copyFile('package-lock.json', 'npm-shrinkwrap.json');
if (process.platform === 'darwin') await import('./build-player.mjs');
