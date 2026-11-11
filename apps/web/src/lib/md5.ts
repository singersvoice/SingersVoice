/**
 * Streaming MD5 (RFC 1321) — used to verify Drive uploads against the `md5Checksum`
 * Google reports, so a corrupted or truncated upload is detected before the local
 * copy is released. WebCrypto has no MD5, hence this ~90-line implementation.
 */
const K = new Uint32Array(64);
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;

export class Md5 {
  private a = 0x67452301;
  private b = 0xefcdab89;
  private c = 0x98badcfe;
  private d = 0x10325476;
  private buffer = new Uint8Array(64);
  private bufferLen = 0;
  private totalLen = 0;
  private words = new Uint32Array(16);

  update(data: Uint8Array): this {
    let offset = 0;
    this.totalLen += data.length;
    if (this.bufferLen > 0) {
      const take = Math.min(64 - this.bufferLen, data.length);
      this.buffer.set(data.subarray(0, take), this.bufferLen);
      this.bufferLen += take;
      offset = take;
      if (this.bufferLen === 64) {
        this.block(this.buffer, 0);
        this.bufferLen = 0;
      }
    }
    while (offset + 64 <= data.length) {
      this.block(data, offset);
      offset += 64;
    }
    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLen = data.length - offset;
    }
    return this;
  }

  private block(data: Uint8Array, off: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (data[j]! | (data[j + 1]! << 8) | (data[j + 2]! << 16) | (data[j + 3]! << 24)) >>> 0;
    }
    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[i]! + w[g]!) >>> 0;
      b = (b + ((x << S[i]!) | (x >>> (32 - S[i]!)))) >>> 0;
      a = tmp;
    }
    this.a = (this.a + a) >>> 0;
    this.b = (this.b + b) >>> 0;
    this.c = (this.c + c) >>> 0;
    this.d = (this.d + d) >>> 0;
  }

  hex(): string {
    const bitLen = this.totalLen * 8;
    const pad = new Uint8Array(((this.bufferLen < 56 ? 56 : 120) - this.bufferLen) + 8);
    pad[0] = 0x80;
    const lo = bitLen >>> 0;
    const hi = Math.floor(bitLen / 2 ** 32) >>> 0;
    const n = pad.length - 8;
    for (let i = 0; i < 4; i++) {
      pad[n + i] = (lo >>> (8 * i)) & 0xff;
      pad[n + 4 + i] = (hi >>> (8 * i)) & 0xff;
    }
    const saved = this.totalLen;
    this.update(pad);
    this.totalLen = saved;
    const out = [this.a, this.b, this.c, this.d]
      .map((v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff].map((x) => x.toString(16).padStart(2, '0')).join(''))
      .join('');
    return out;
  }
}

export async function md5Blob(blob: Blob, chunkBytes = 4 * 1024 * 1024): Promise<string> {
  const h = new Md5();
  for (let off = 0; off < blob.size; off += chunkBytes) {
    const buf = await blob.slice(off, Math.min(blob.size, off + chunkBytes)).arrayBuffer();
    h.update(new Uint8Array(buf));
  }
  return h.hex();
}

export function md5Hex(bytes: Uint8Array): string {
  return new Md5().update(bytes).hex();
}
