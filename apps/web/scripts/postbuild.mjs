// After `vite build`: SPA fallback for GitHub Pages (404.html) and a version stamp.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, '..', 'dist');
if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
copyFileSync(path.join(dist, 'index.html'), path.join(dist, '404.html'));
// Opt out of Jekyll processing on GitHub Pages (keeps files that start with _ ).
writeFileSync(path.join(dist, '.nojekyll'), '');

let commit = process.env.GITHUB_SHA ?? '';
try {
  if (!commit) commit = execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  /* not a git checkout */
}
const pkg = JSON.parse(readFileSync(path.join(root, '..', 'package.json'), 'utf8'));
writeFileSync(
  path.join(dist, 'version.json'),
  JSON.stringify({ version: pkg.version, commit: commit.slice(0, 12), builtAt: new Date().toISOString() }, null, 2),
);
console.log(`postbuild: 404.html, .nojekyll, version.json (${pkg.version} ${commit.slice(0, 12)})`);
