/**
 * A clip of a saved performance: the section the singer picked (from–to) of the show video, made into a
 * file of its own — the picture redrawn frame by frame and the sound taken from the same playback, so the
 * clip plays as the performance did. The browser has no cutter for its own video files, so the section is
 * played once, silently, at its own speed, and recorded (MediaRecorder): a minute of clip takes a minute.
 * MP4 (H.264 + AAC) where the browser can write it — what the networks take —, WebM otherwise.
 */

export interface ClipProgress {
  fraction: number;
  label: string;
}

export interface Clip {
  blob: Blob;
  mime: string;
  durationMs: number;
  width: number;
  height: number;
}

/** The formats, best first: MP4 for the networks and the phone's apps; WebM when the browser writes nothing else. */
const CLIP_MIMES = ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs="avc1.4D401F,mp4a.40.2"', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs="vp9,opus"', 'video/webm;codecs="vp8,opus"', 'video/webm'];

export function clipMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of CLIP_MIMES) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

/** The clip's picture: the source's size, no wider than 1280 (a phone's share sheet and the networks like 720p–1080p). */
export function clipSize(w: number, h: number, maxWidth = 1280): { width: number; height: number } {
  if (!w || !h) return { width: 1280, height: 720 };
  const scale = Math.min(1, maxWidth / w);
  const width = Math.round((w * scale) / 2) * 2;
  const height = Math.round((h * scale) / 2) * 2;
  return { width, height };
}

/** The file's extension for a clip's type. */
export const clipExt = (mime: string): string => (mime.includes('mp4') ? 'mp4' : 'webm');

const once = <K extends keyof HTMLMediaElementEventMap>(el: HTMLMediaElement, ev: K, timeoutMs: number, what: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      el.removeEventListener(ev, ok);
      el.removeEventListener('error', bad);
      reject(new Error(`${what}: the video did not answer`));
    }, timeoutMs);
    const ok = () => {
      clearTimeout(t);
      el.removeEventListener('error', bad);
      resolve();
    };
    const bad = () => {
      clearTimeout(t);
      el.removeEventListener(ev, ok);
      reject(new Error(`${what}: the video could not be read`));
    };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });

/**
 * The section `fromMs`–`toMs` of `source` as a clip. Plays the section through once (silently: the sound goes
 * into the recording, not the speakers) and records it; `onProgress` follows the playhead.
 */
export async function makeClip(source: Blob, fromMs: number, toMs: number, opts: { onProgress?: (p: ClipProgress) => void; maxWidth?: number; videoBps?: number } = {}): Promise<Clip> {
  const mime = clipMime();
  if (!mime) throw new Error('This browser cannot write video files — try Chrome, Edge or Safari');
  const url = URL.createObjectURL(source);
  const video = document.createElement('video');
  video.src = url;
  video.playsInline = true;
  video.preload = 'auto';
  video.muted = false;
  video.volume = 1;
  // Out of sight but in the document: some browsers draw no frames of a detached video.
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:16px;height:9px;opacity:0.01;pointer-events:none';
  document.body.appendChild(video);
  const ctx = new AudioContext();
  let recorder: MediaRecorder | null = null;
  let raf = 0;
  const cleanup = () => {
    cancelAnimationFrame(raf);
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
    void ctx.close().catch(() => undefined);
  };
  try {
    await once(video, 'loadedmetadata', 20_000, 'Reading the performance');
    const total = Number.isFinite(video.duration) ? video.duration * 1000 : toMs;
    const from = Math.max(0, Math.min(fromMs, total));
    const to = Math.max(from + 500, Math.min(toMs, total));
    const { width, height } = clipSize(video.videoWidth, video.videoHeight, opts.maxWidth);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d', { alpha: false })!;
    g.imageSmoothingQuality = 'high';
    // The sound: the element's output goes into the recording and nowhere else.
    await ctx.resume();
    const src = ctx.createMediaElementSource(video);
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    const fps = 30;
    const picture = canvas.captureStream(fps);
    const stream = new MediaStream([...picture.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.videoBps ?? (width >= 1280 ? 3_500_000 : 2_200_000), audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((resolve) => {
      recorder!.onstop = () => resolve();
    });
    video.currentTime = from / 1000;
    await once(video, 'seeked', 20_000, 'Finding the start');
    g.drawImage(video, 0, 0, width, height);
    opts.onProgress?.({ fraction: 0, label: 'Making the clip…' });
    recorder.start(1000);
    await video.play();
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        try {
          g.drawImage(video, 0, 0, width, height);
        } catch {
          /* a frame not ready */
        }
        const at = video.currentTime * 1000;
        const fraction = Math.max(0, Math.min(1, (at - from) / (to - from)));
        opts.onProgress?.({ fraction, label: `Making the clip… ${Math.round(fraction * 100)}%` });
        if (at >= to || video.ended) return resolve();
        // The whole section took far longer than itself: something stalled (the tab in the background on a phone).
        if (performance.now() - started > (to - from) * 2 + 15_000) return reject(new Error('The clip stalled — keep this page in front while it is made'));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    video.pause();
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: recorder.mimeType || mime.split(';')[0] });
    if (!blob.size) throw new Error('Nothing was recorded — try again');
    opts.onProgress?.({ fraction: 1, label: 'Clip ready' });
    return { blob, mime: blob.type, durationMs: to - from, width, height };
  } finally {
    cleanup();
  }
}

/** Whether this device can hand a file to another app (the phone's share sheet: every app installed). */
export function canShareFile(file: File): boolean {
  const n = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  try {
    return typeof n.share === 'function' && typeof n.canShare === 'function' && n.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** The clip to the share sheet; 'dismissed' when the singer closed it, 'unsupported' when the device has none for files. */
export async function shareClip(file: File, title: string, text: string): Promise<'shared' | 'dismissed' | 'unsupported'> {
  if (!canShareFile(file)) return 'unsupported';
  try {
    await navigator.share({ files: [file], title, text });
    return 'shared';
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return 'dismissed';
    return 'unsupported';
  }
}
