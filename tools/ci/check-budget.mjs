// First-load budget: gzipped bytes of index.html + the JS/CSS it references must stay under the limit.
//   node tools/ci/check-budget.mjs apps/web/dist 400   (KB)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const dist = process.argv[2] ?? 'apps/web/dist';
const limitKb = Number(process.argv[3] ?? 400);
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
let total = gzipSync(html).length;
const rows = [['index.html', total]];
for (const ref of refs) {
  const file = path.join(dist, ref.replace(/^\/SingersVoice\//, '').replace(/^\//, ''));
  try {
    const gz = gzipSync(readFileSync(file)).length;
    total += gz;
    rows.push([ref, gz]);
  } catch {
    console.warn('missing', file);
  }
}
// Preact chunk is loaded via modulepreload; vendor chunk is referenced from index.js, count it too.
for (const f of readdirSync(path.join(dist, 'assets'))) {
  if (/^vendor-.*\.js$/.test(f) && !refs.some((r) => r.endsWith(f))) {
    const gz = gzipSync(readFileSync(path.join(dist, 'assets', f))).length;
    total += gz;
    rows.push([`assets/${f}`, gz]);
  }
}
for (const [name, gz] of rows) console.log(`${String(gz).padStart(8)} gz  ${name}`);
console.log(`${String(total).padStart(8)} gz  TOTAL first load (${(total / 1024).toFixed(1)} KB, limit ${limitKb} KB)`);
if (total > limitKb * 1024) {
  console.error(`Budget exceeded by ${((total - limitKb * 1024) / 1024).toFixed(1)} KB`);
  process.exit(1);
}
void statSync;
