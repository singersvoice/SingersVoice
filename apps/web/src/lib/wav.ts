/** Encode mono/stereo Float32 PCM as a 16-bit PCM WAV Blob. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const numCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let s = channels[ch]![i] ?? 0;
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Concatenate Float32 chunks into one array. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Parse the header of a 16-bit PCM WAV produced by encodeWav (for playback without decodeAudioData). */
export function wavInfo(buf: ArrayBuffer): { sampleRate: number; channels: number; frames: number } | null {
  if (buf.byteLength < 44) return null;
  const v = new DataView(buf);
  if (v.getUint32(0, false) !== 0x52494646) return null; // RIFF
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const dataBytes = v.getUint32(40, true);
  return { sampleRate, channels, frames: dataBytes / (channels * 2) };
}
