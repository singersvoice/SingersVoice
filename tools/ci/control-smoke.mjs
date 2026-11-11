// Boot sv-control exactly as production does (Node type stripping, node:sqlite) and hit a few routes.
// Catches TypeScript syntax Node can't strip (parameter properties, enums) that vitest would accept.
import { spawn } from 'node:child_process';
import path from 'node:path';

const port = 8799;
const child = spawn('node', ['--no-warnings=ExperimentalWarning', 'src/index.ts'], {
  cwd: path.resolve('services/control'),
  env: { ...process.env, PORT: String(port), DEV_AUTH: '1', SV_DB: ':memory:' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
for (let i = 0; i < 40 && !ok; i++) {
  await wait(250);
  try {
    const r = await fetch(`http://localhost:${port}/health`);
    ok = r.ok;
  } catch {
    /* not up yet */
  }
  if (child.exitCode !== null) break;
}
if (!ok) {
  child.kill();
  console.error('sv-control did not start:\n' + log);
  process.exit(1);
}
const h = { 'X-Dev-User': 'smoke', 'Content-Type': 'application/json' };
const meet = await (await fetch(`http://localhost:${port}/meets`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'smoke' }) })).json();
const join = await (await fetch(`http://localhost:${port}/meets/${meet.meet.meetId}/join`, { method: 'POST', headers: h, body: JSON.stringify({ role: 'performer' }) })).json();
const watch = await (await fetch(`http://localhost:${port}/watch/${meet.meet.meetId}`)).json();
child.kill();
if (!join.resumeToken || join.you.slot !== 1 || watch.meet.state !== 'lobby') {
  console.error('unexpected responses', { join, watch });
  process.exit(1);
}
console.log(`sv-control smoke ok: meet ${meet.meet.meetId} code ${meet.meet.joinCode}`);
