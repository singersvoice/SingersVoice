// After `vite build`: what each host needs beside the app, and a version stamp.
//   SV_HOST=github (default): 404.html (GitHub Pages' only way to a single-page app) and .nojekyll.
//   SV_HOST=cloudflare: no 404.html — Cloudflare Pages serves index.html for every route when there is none — and a _headers
//   file (the hardening headers GitHub Pages cannot send, long caching for the hashed assets). docs/HOSTING.md.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, '..', 'dist');
const host = process.env.SV_HOST === 'cloudflare' ? 'cloudflare' : 'github';
if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

if (host === 'github') {
  copyFileSync(path.join(dist, 'index.html'), path.join(dist, '404.html'));
  // Opt out of Jekyll processing on GitHub Pages (keeps files that start with _ ).
  writeFileSync(path.join(dist, '.nojekyll'), '');
} else {
  rmSync(path.join(dist, '404.html'), { force: true });
  writeFileSync(
    path.join(dist, '_headers'),
    [
      '/*',
      '  X-Content-Type-Options: nosniff',
      '  Referrer-Policy: strict-origin-when-cross-origin',
      '  X-Frame-Options: DENY',
      '  Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
      '/assets/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '/mediapipe/*',
      '  Cache-Control: public, max-age=604800',
      '/sw.js',
      '  Cache-Control: no-cache',
      '',
    ].join('\n'),
  );
}

let commit = process.env.GITHUB_SHA ?? '';
try {
  if (!commit) commit = execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  /* not a git checkout */
}
const pkg = JSON.parse(readFileSync(path.join(root, '..', 'package.json'), 'utf8'));
writeFileSync(
  path.join(dist, 'version.json'),
  JSON.stringify({ version: pkg.version, commit: commit.slice(0, 12), builtAt: new Date().toISOString(), host }, null, 2),
);
console.log(`postbuild (${host}): ${host === 'github' ? '404.html, .nojekyll' : '_headers'}, version.json (${pkg.version} ${commit.slice(0, 12)})`);
