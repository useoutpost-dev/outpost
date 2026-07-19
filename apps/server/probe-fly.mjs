// Throwaway diagnostic: verifies the configured Fly token/app by hitting the
// Machines API. Prints ONLY status + body (never the token). Delete after use.
import { readFileSync } from 'node:fs';

const env = {};
try {
  for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) {
  console.log('no apps/server/.env found:', e.code);
}

const token = env.FLY_API_TOKEN?.trim();
const app = env.FLY_SANDBOX_APP?.trim();
const region = env.FLY_REGION?.trim();
const image = env.OUTPOST_SANDBOX_IMAGE?.trim();
console.log('config presence:', {
  token: token ? `set(len ${token.length})` : 'MISSING',
  app: app || 'MISSING',
  region: region || 'MISSING',
  image: image || 'MISSING',
});
if (!token || !app) process.exit(0);

const res = await fetch(`https://api.machines.dev/v1/apps/${app}/machines`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log('GET /apps/%s/machines ->', app, res.status);
console.log('body:', (await res.text()).slice(0, 500));
