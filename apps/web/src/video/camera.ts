/**
 * Camera for the "you" tile: device selection, front/back flip and face-centred auto-framing
 * (the FaceDetector API where available — Chrome/Android — else the upper-centre of the frame).
 * The framing itself (chest / wide / mid / close, Auto) is `video/framing.ts`, applied by the
 * local feed to the cut-out it sends.
 */
import { signal } from '@preact/signals';

interface FaceDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ boundingBox: { x: number; y: number; width: number; height: number } }[]>;
}

export class Camera {
  stream: MediaStream | null = null;
  readonly on = signal(false);
  readonly facing = signal<'user' | 'environment'>('user');
  readonly origin = signal<{ x: number; y: number }>({ x: 50, y: 40 });
  readonly deviceLabel = signal('');
  private detector: FaceDetectorLike | null = null;
  private frameTimer: ReturnType<typeof setInterval> | undefined;

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

  /** Use a stream captured elsewhere (combined audio+video getUserMedia on iOS). */
  adopt(stream: MediaStream, facing: 'user' | 'environment' = this.facing.value): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.facing.value = facing;
    this.deviceLabel.value = stream.getVideoTracks()[0]?.label ?? 'Camera';
    this.on.value = true;
  }

  async flip(): Promise<void> {
    await this.open({ facing: this.facing.value === 'user' ? 'environment' : 'user' });
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
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
