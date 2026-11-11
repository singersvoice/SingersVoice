import { describe, expect, it } from 'vitest';
import { Md5, md5Hex } from '../src/lib/md5.ts';

const enc = (s: string) => new TextEncoder().encode(s);

describe('md5 (RFC 1321 vectors)', () => {
  it('matches the reference digests', () => {
    expect(md5Hex(enc(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(enc('a'))).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5Hex(enc('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(enc('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5Hex(enc('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
  it('streams across chunk boundaries identically', () => {
    const data = new Uint8Array(100_003);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
    const whole = md5Hex(data);
    const h = new Md5();
    for (let o = 0; o < data.length; o += 777) h.update(data.subarray(o, Math.min(data.length, o + 777)));
    expect(h.hex()).toBe(whole);
  });
});
