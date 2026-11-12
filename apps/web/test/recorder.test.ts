import { describe, expect, it } from 'vitest';
import { capturedFrames, truncateCaptured } from '../src/audio/recorder.ts';

const audio = (n: number, v = 1) => new Float32Array(n).fill(v);

describe('the take on the track timeline across seeks', () => {
  it('a jump forward is a run of silent frames; a jump backward keeps only what comes before the new position', () => {
    const parts: (Float32Array | number)[] = [audio(100), 50, audio(100, 2)]; // 100 sung, 50 skipped, 100 sung
    expect(capturedFrames(parts)).toBe(250);
    const cut = truncateCaptured(parts, 120); // back to frame 120: into the silent run
    expect(capturedFrames(cut)).toBe(120);
    expect(cut).toEqual([parts[0], 20]);
    const deeper = truncateCaptured(parts, 60); // back into the first sung part
    expect(capturedFrames(deeper)).toBe(60);
    expect(deeper[0]).toBeInstanceOf(Float32Array);
    expect((deeper[0] as Float32Array).length).toBe(60);
    expect(truncateCaptured(parts, 0)).toEqual([]);
    expect(truncateCaptured(parts, 999)).toEqual(parts); // nothing to cut
  });
});
