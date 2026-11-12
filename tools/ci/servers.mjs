// Local sv-control (DEV_AUTH) + `vite preview` for the browser tests, on free ports, killed as a
// process group so nothing survives the test (a leftover server would make the next run talk to
// a stale SVT DB where somebody else is already the privileged first account).
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not come up`);
}

export async function startServers({ base = '/SingersVoice/', logDir = process.env.SV_SERVER_LOGS } = {}) {
  const controlPort = await freePort();
  const port = await freePort();
  const procs = [];
  const run = (cmd, args, opts) => {
    // SV_SERVER_LOGS=<dir> keeps each server's output (control.log, web.log) for a failing run.
    const stdio = logDir ? ['ignore', openSync(path.join(logDir, `${opts.name}.log`), 'a'), openSync(path.join(logDir, `${opts.name}.log`), 'a')] : 'ignore';
    const p = spawn(cmd, args, { stdio, detached: process.platform !== 'win32', ...opts });
    procs.push(p);
    return p;
  };
  run('node', ['--no-warnings=ExperimentalWarning', 'src/index.ts'], {
    name: 'control',
    cwd: path.resolve('services/control'),
    // The first account seen (alice) is privileged by bootstrap; carol is the Publishing-mode tester.
    env: { ...process.env, PORT: String(controlPort), DEV_AUTH: '1', SV_DB: ':memory:', ALLOWED_ORIGINS: `http://localhost:${port}`, PRIVILEGED_EMAILS: 'carol@dev.local' },
  });
  run('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { name: 'web', cwd: path.resolve('apps/web'), env: { ...process.env, BASE_PATH: base } });
  const stop = () => {
    for (const p of procs) {
      try {
        if (p.pid && process.platform !== 'win32') process.kill(-p.pid, 'SIGTERM');
        else p.kill();
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', stop);
  await Promise.all([waitFor(`http://localhost:${controlPort}/health`), waitFor(`http://localhost:${port}${base}`)]);
  return { port, controlPort, base, appUrl: `http://localhost:${port}${base}`, controlUrl: `http://localhost:${controlPort}`, stop };
}
