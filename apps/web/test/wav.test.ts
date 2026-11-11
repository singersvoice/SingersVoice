import { describe, expect, it } from 'vitest';
import { concatFloat32, encodeWav, wavInfo } from '../src/lib/wav.ts';

describe('wav', () => {
  it('writes a valid 16-bit PCM header and clamps samples', async () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1.5, -1.5]);
    const blob = encodeWav([pcm], 48000);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + pcm.length * 2);
    const buf = await blob.arrayBuffer();
    const info = wavInfo(buf);
    expect(info).toEqual({ sampleRate: 48000, channels: 1, frames: 5 });
    const v = new DataView(buf);
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(v.getInt16(50, true)).toBe(0x7fff); // clamped
    expect(v.getInt16(52, true)).toBe(-0x8000); // clamped
  });
  it('concatenates chunks', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
