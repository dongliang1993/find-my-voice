import { execFileSync } from 'node:child_process';
// No .env read and no token: the service is loopback-only and needs neither.
const url = new URL(process.argv[2] || `http://127.0.0.1:3210/admin`);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
  throw new Error('Owner entry only opens a local loopback HTTP URL.');
}
const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
execFileSync(command, [url.href], { stdio: 'ignore' });
console.log(`Opened the local owner session: ${url.href}`);
