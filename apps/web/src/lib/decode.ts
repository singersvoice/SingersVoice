let probeCtx: AudioContext | null = null;

function ctx(): AudioContext {
  if (!probeCtx) probeCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return probeCtx;
}

/** Decode an audio Blob to an AudioBuffer (uses a shared offline-ish context). */
export async function decodeBlob(blob: Blob, into?: AudioContext): Promise<AudioBuffer> {
  const buf = await blob.arrayBuffer();
  const c = into ?? ctx();
  return new Promise((resolve, reject) => {
    // Safari still prefers the callback form for some containers.
    const p = c.decodeAudioData(buf.slice(0), resolve, (e) => reject(e ?? new Error('decode failed')));
    if (p && typeof (p as Promise<AudioBuffer>).then === 'function') (p as Promise<AudioBuffer>).then(resolve, reject);
  });
}

/** Duration via an <audio> element first (cheap), falling back to decoding. */
export async function probeDuration(blob: Blob): Promise<number> {
  const fromElement = await new Promise<number>((resolve) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    const done = (v: number) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration * 1000 : 0);
    a.onerror = () => done(0);
    a.src = url;
    setTimeout(() => done(0), 4000);
  });
  if (fromElement > 0) return Math.round(fromElement);
  try {
    const b = await decodeBlob(blob);
    return Math.round(b.duration * 1000);
  } catch {
    return 0;
  }
}

export function extFromMime(mime: string, fallback = 'bin'): string {
  const m = mime.toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('flac')) return 'flac';
  if (m.includes('json')) return 'json';
  return fallback;
}
