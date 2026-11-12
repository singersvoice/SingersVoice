// Copy the MediaPipe Selfie Segmentation runtime (wasm + models) into public/mediapipe so the
// person cut-out works offline and without a third-party CDN. Runs before `vite dev` / `vite build`.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'mediapipe');
let src;
try {
  src = path.dirname(require.resolve('@mediapipe/selfie_segmentation/package.json'));
} catch {
  console.warn('mediapipe-assets: @mediapipe/selfie_segmentation is not installed — the cut-out will use the CDN fallback');
  process.exit(0);
}
mkdirSync(out, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (!/\.(js|wasm|data|tflite|binarypb)$/.test(f) || f === 'index.js') continue;
  const from = path.join(src, f);
  const to = path.join(out, f);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  n++;
}
console.log(`mediapipe-assets: ${n} file(s) refreshed in public/mediapipe`);
