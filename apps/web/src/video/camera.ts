/**
 * Camera for the "you" tile: device selection, front/back flip, zoom presets, AutoZoom and
 * auto-framing. Zoom is applied as a CSS transform on the rendered tile (capture stays 720p,
 * render ~360p) so it is free on every platform; face-centred framing uses the FaceDetector
 * API where available (Chrome/Android) and falls back to the upper-centre of the frame.
 */
import { signal } from '@preact/signals';

export type ZoomPreset = 'wide' | 'mid' | 'close';
export const ZOOM_LEVELS: Record<ZoomPreset, number> = { wide: 1, mid: 1.25, close: 1.5 };

interface FaceDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ boundingBox: { x: number; y: number; width: number; height: number } }[]>;
}

export class Camera {
  stream: MediaStream | null = null;
  readonly on = signal(false);
  readonly facing = signal<'user' | 'environment'>('user');
  readonly zoom = signal(1.25);
  readonly origin = signal<{ x: number; y: number }>({ x: 50, y: 40 });
  readonly deviceLabel = signal('');
  private detector: FaceDetectorLike | null = null;
  private frameTimer: ReturnType<typeof setInterval> | undefined;
  private autoZoomRaf = 0;

  async open(opts: { deviceId?: string; facing?: 'user' | 'environment' } = {}): Promise<MediaStream> {
    this.close();
    const facing = opts.facing ?? this.facing.value;
    const constraints: MediaStreamConstraints = {
      video: opts.deviceId
        ? { deviceId: { exact: opts.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
        : { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;
    this.facing.value = facing;
    this.deviceLabel.value = stream.getVideoTracks()[0]?.label ?? 'Camera';
    this.on.value = true;
    return stream;
  }

  async flip(): Promise<void> {
    await this.open({ facing: this.facing.value === 'user' ? 'environment' : 'user' });
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  setPreset(p: ZoomPreset): void {
    this.cancelAutoZoom();
    this.zoom.value = ZOOM_LEVELS[p];
  }

  /** Ease from wide to a close framing over `ms` (used during the intro of a song). */
  autoZoom(target = 1.4, ms = 6000): void {
    this.cancelAutoZoom();
    const from = this.zoom.value;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      this.zoom.value = from + (target - from) * eased;
      if (k < 1) this.autoZoomRaf = requestAnimationFrame(step);
    };
    this.autoZoomRaf = requestAnimationFrame(step);
  }

  cancelAutoZoom(): void {
    if (this.autoZoomRaf) cancelAnimationFrame(this.autoZoomRaf);
    this.autoZoomRaf = 0;
  }

  /** Keep the face near the centre of the zoomed tile. Cheap: one detection every 700 ms. */
  startAutoFrame(video: HTMLVideoElement): void {
    this.stopAutoFrame();
    const FD = (window as unknown as { FaceDetector?: new (o: { fastMode: boolean; maxDetectedFaces: number }) => FaceDetectorLike }).FaceDetector;
    if (!FD) return;
    try {
      this.detector = new FD({ fastMode: true, maxDetectedFaces: 1 });
    } catch {
      this.detector = null;
      return;
    }
    this.frameTimer = setInterval(async () => {
      if (!this.detector || video.readyState < 2 || !video.videoWidth) return;
      try {
        const faces = await this.detector.detect(video);
        const f = faces[0];
        if (!f) return;
        const cx = ((f.boundingBox.x + f.boundingBox.width / 2) / video.videoWidth) * 100;
        const cy = ((f.boundingBox.y + f.boundingBox.height / 2) / video.videoHeight) * 100;
        const cur = this.origin.value;
        this.origin.value = { x: cur.x + (cx - cur.x) * 0.35, y: cur.y + (cy - cur.y) * 0.35 };
      } catch {
        /* detector unavailable mid-run */
      }
    }, 700);
  }

  stopAutoFrame(): void {
    clearInterval(this.frameTimer);
    this.frameTimer = undefined;
    this.detector = null;
  }

  close(): void {
    this.stopAutoFrame();
    this.cancelAutoZoom();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.on.value = false;
  }
}

/** Pick the best MediaRecorder mime for camera video on this browser. */
export function pickVideoMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? '';
}
