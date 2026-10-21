import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') throw new Error('Native streaming playback currently requires macOS.');
mkdirSync(resolve(root, 'dist/swift-cache'), { recursive: true });
execFileSync('/usr/bin/swiftc', ['-O', '-module-cache-path', resolve(root, 'dist/swift-cache'),
  resolve(root, 'native/pcm-player.swift'), '-o', resolve(root, 'dist/pcm-player')], { stdio: 'inherit' });
