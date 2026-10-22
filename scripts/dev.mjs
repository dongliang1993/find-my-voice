// Runs the server (auto-restarting) and Vite together for development.
import { spawn } from 'node:child_process';

const children = [
  spawn('npx', ['tsx', 'watch', '--clear-screen=false', 'src/server/index.ts', '--no-open'], { stdio: 'inherit' }),
  spawn('npx', ['vite', '--open'], { stdio: 'inherit' }),
];
const stop = () => { for (const child of children) child.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', code => { if (code) stop(); });
