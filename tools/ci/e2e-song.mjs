// The song the automated tests sing: the 20 s sample (a chord loop, nothing above 1.5 kHz) on a loop
// for `seconds`, with a slow sine sweep under it — `SWEEP.from` → `SWEEP.to` Hz across the whole song,
// at −10 dBFS, above a voice's harmonics — so every few seconds of the song are unlike any other few:
// a capture taken anywhere in a meet can be told exactly where in the song it was (audio-measure.mjs,
// `locate`, which listens in the sweep's band), whatever voices are mixed over it.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const SWEEP = { from: 4500, to: 7500, level: 0.3 };
const SAMPLE = path.resolve(new URL('../../apps/web/test/fixtures/sample.mp3', import.meta.url).pathname);

/** Write the song (mp3, 128 kbps) to `out`; returns `out`. */
export function makeSong(out, seconds = 200) {
  const rate = (SWEEP.to - SWEEP.from) / (2 * seconds); // the sweep's phase: 2π(f0·t + rate·t²)
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-stream_loop', String(Math.ceil(seconds / 20)), '-i', SAMPLE,
    '-f', 'lavfi', '-i', `aevalsrc='${SWEEP.level}*sin(2*PI*(${SWEEP.from}*t+${rate}*t*t))':s=48000:d=${seconds}`,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0[a]',
    '-map', '[a]', '-t', String(seconds), '-c:a', 'libmp3lame', '-b:a', '128k', out,
  ]);
  return out;
}

/** The sweep's frequency at `positionS` into the song (Hz). */
export const sweepHzAt = (positionS, seconds = 200) => SWEEP.from + ((SWEEP.to - SWEEP.from) * positionS) / seconds;
