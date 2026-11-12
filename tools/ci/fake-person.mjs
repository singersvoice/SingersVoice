// Writes a short Y4M clip of a synthetic "person" (skin-tone head, dark torso, bright wall) that
// Chromium can play as a fake camera (--use-file-for-fake-video-capture), so the browser tests
// exercise the real segmentation model and the real cut-out instead of a colour test pattern.
//   node tools/ci/fake-person.mjs out.y4m
import { writeFileSync } from 'node:fs';

const W = 480;
const H = 640;
const FRAMES = 30;
const out = process.argv[2] ?? 'fake-person.y4m';

function rgb(x, y, t) {
  // gentle sway so motion-based pipelines see change
  const cx = W * 0.5 + Math.sin(t * 0.6) * 12;
  const head = ((x - cx) / 80) ** 2 + ((y - 230) / 105) ** 2 <= 1;
  const torso = ((x - cx) / 175) ** 2 + ((y - 540) / 190) ** 2 <= 1;
  const neck = Math.abs(x - cx) < 34 && y > 300 && y < 380;
  if (head) return [0x8d, 0x55, 0x24];
  if (neck) return [0x8d, 0x55, 0x24];
  if (torso) return [0x1e, 0x22, 0x35];
  return [0xf2, 0xf2, 0xf2];
}

const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg\n`)];
for (let f = 0; f < FRAMES; f++) {
  const t = f / 15;
  const Y = Buffer.alloc(W * H);
  const U = Buffer.alloc((W / 2) * (H / 2));
  const V = Buffer.alloc((W / 2) * (H / 2));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = rgb(x, y, t);
      Y[y * W + x] = Math.round(0.257 * r + 0.504 * g + 0.098 * b + 16);
      if (x % 2 === 0 && y % 2 === 0) {
        const i = (y / 2) * (W / 2) + x / 2;
        U[i] = Math.round(-0.148 * r - 0.291 * g + 0.439 * b + 128);
        V[i] = Math.round(0.439 * r - 0.368 * g - 0.071 * b + 128);
      }
    }
  parts.push(Buffer.from('FRAME\n'), Y, U, V);
}
writeFileSync(out, Buffer.concat(parts));
console.log(`fake-person: ${FRAMES} frames ${W}x${H} → ${out}`);
