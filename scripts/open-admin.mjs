import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
loadEnvFile(`${root}.env`);
const url = new URL(process.argv[2] || `http://127.0.0.1:${process.env.PORT || 3210}/admin`);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
  throw new Error('Owner entry only opens a local loopback HTTP URL.');
}
if (!process.env.ADMIN_TOKEN) throw new Error('Run npm run init first.');
url.hash = new URLSearchParams({ token: process.env.ADMIN_TOKEN }).toString();
const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
execFileSync(command, [url.href], { stdio: 'ignore' });
console.log('Opened the local owner session. Credentials were not printed.');
