/**
 * The camera: device selection, front/back flip, a stream captured elsewhere adopted (iOS captures
 * the microphone and the camera in one call). The framing (the stage frame: the head the same size
 * at the same place for every singer, set once and held) is `video/framing.ts`, applied by the local
 * feed to the cut-out it sends; nothing here steers the picture.
 */
import { signal } from '@preact/signals';
import { cameraSize } from './enhance.ts';

export class Camera {
  stream: MediaStream | null = null;
  readonly on = signal(false);
  readonly facing = signal<'user' | 'environment'>('user');
  readonly deviceLabel = signal('');
  /** Bumped when the video track is replaced in place (`replaceVideo`): whoever reads `stream` in a render follows the new one. */
  readonly gen = signal(0);
  /** The microphone this camera was captured with (iOS: one capture per page — capture.ts), for the engine to adopt. */
  private audio: MediaTrackConstraints | null = null;

  /**
   * Open the camera — and, with `audio`, the microphone in the same call (one prompt, one capture: what iPhone
   * and iPad need, where a second capture ends the first and every capture asks). The audio track rides in
   * `stream` for the engine to adopt (`engine.openMic({ adopt })`); a camera refused or missing never costs it.
   */
  async open(opts: { deviceId?: string; facing?: 'user' | 'environment'; audio?: MediaTrackConstraints | null } = {}): Promise<MediaStream> {
    this.close();
    const facing = opts.facing ?? this.facing.value;
    const size = cameraSize(); // 1080p on a computer, 720p on a phone (enhance.ts)
    const video: MediaTrackConstraints = opts.deviceId
      ? { deviceId: { exact: opts.deviceId }, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30, max: 30 } }
      : { facingMode: facing, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30, max: 30 } };
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: opts.audio ?? false });
    this.stream = stream;
    this.audio = opts.audio ?? null;
    this.facing.value = facing;
    this.deviceLabel.value = stream.getVideoTracks()[0]?.label ?? 'Camera';
    this.on.value = true;
    return stream;
  }

  /** The microphone captured with the camera, live (the engine adopts it instead of capturing again); null when there is none. */
  get micStream(): MediaStream | null {
    return this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live') ? this.stream : null;
  }

  /** How the microphone was captured with the camera (the engine checks it is the one wanted). */
  get micConstraints(): MediaTrackConstraints | null {
    return this.audio;
  }

  /**
   * A fresh video track in place of the one running, the microphone captured with the camera (iOS) left exactly as it
   * is: the old video tracks stop, the new one joins the same stream (the engine's adopted audio track is untouched).
   */
  replaceVideo(fresh: MediaStream): void {
    const current = this.stream;
    if (!current) {
      this.adopt(fresh);
      return;
    }
    for (const t of current.getVideoTracks()) {
      t.stop();
      current.removeTrack(t);
    }
    for (const t of fresh.getVideoTracks()) current.addTrack(t);
    this.deviceLabel.value = fresh.getVideoTracks()[0]?.label ?? 'Camera';
    this.stream = new MediaStream(current.getTracks()); // a new object: whoever watches the stream sees a new camera
    this.on.value = true;
    this.gen.value++;
  }

  /** Use a stream captured elsewhere (combined audio+video getUserMedia on iOS). */
  adopt(stream: MediaStream, facing: 'user' | 'environment' = this.facing.value): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.facing.value = facing;
    this.deviceLabel.value = stream.getVideoTracks()[0]?.label ?? 'Camera';
    this.on.value = true;
  }

  /**
   * The camera off while the microphone captured with it stays (iOS: the two came in one capture; the engine holds the
   * audio track): the video tracks alone are stopped, the stream keeps the audio track for a later `replaceVideo`.
   */
  closeVideo(): void {
    const current = this.stream;
    if (!current) return;
    for (const t of current.getVideoTracks()) {
      t.stop();
      current.removeTrack(t);
    }
    if (!current.getAudioTracks().some((t) => t.readyState === 'live')) {
      this.close();
      return;
    }
    this.on.value = false;
    this.gen.value++;
  }

  async flip(): Promise<void> {
    await this.open({ facing: this.facing.value === 'user' ? 'environment' : 'user', audio: this.audio }); // the microphone along, where it came along
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.audio = null;
    this.on.value = false;
  }
}

/** Pick the best MediaRecorder mime for camera video on this browser. */
export function pickVideoMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? '';
}
