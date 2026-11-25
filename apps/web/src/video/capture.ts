/**
 * The microphone and the camera as one capture where the browser insists on it.
 *
 * iOS Safari keeps one capture per page: a second getUserMedia — the mic opened after the camera,
 * or the mic opened again for another setting (another input, "I'm on speakers") — ends the first,
 * and the camera goes dark or freezes on its last frame for everyone on the stage. And it asks on
 * every capture. So on iOS the camera is opened WITH the microphone the moment a stage wants it
 * (`openCamera`: one prompt, "Microphone and Camera"), the engine adopts that microphone when the
 * song starts (no capture, no prompt), and between songs the microphone is parked, not closed
 * (`engine.parkMic`): one capture per visit to the stage. Elsewhere the two are opened apart, the
 * camera is left alone when it is already on, and the browser remembers the answer by itself.
 */
import { micConstraints, type AudioEngine } from '../audio/engine.ts';
import { isIOS } from '../lib/platform.ts';
import { appSettings, audioSettings } from '../state/settings.ts';
import type { Camera } from './camera.ts';
import { cameraSize } from './enhance.ts';

/** The microphone the saved settings ask for. */
const wantedMic = () => {
  const app = appSettings.peek();
  return micConstraints(app.audioInputId || undefined, app.echoCancellation);
};

/**
 * Open the camera for a stage with the saved settings: on iOS with the microphone in the same call (one prompt
 * for both, one capture for the whole visit); elsewhere the camera alone.
 */
export async function openCamera(camera: Camera): Promise<MediaStream> {
  const app = appSettings.peek();
  return camera.open({ facing: app.cameraFacing, deviceId: app.cameraDeviceId || undefined, audio: isIOS ? wantedMic() : null });
}

/** Open (or re-open) the mic with the saved settings — and, on iOS with the camera on, the camera with it (or its microphone taken over). */
export async function openMicWithCamera(engine: AudioEngine, camera: Camera): Promise<void> {
  const app = appSettings.peek();
  const audio = audioSettings.peek();
  const combined = isIOS && app.cameraOn;
  const size = cameraSize();
  // iOS: the camera already captured with this microphone (openCamera) — the engine takes that microphone, nothing is captured again.
  const adopt = combined && camera.on.value && camera.micStream && JSON.stringify(camera.micConstraints) === JSON.stringify(wantedMic()) ? camera.micStream : null;
  if (combined && !adopt) camera.close();
  const video = await engine.openMic({
    deviceId: app.audioInputId || undefined,
    echoCancellation: app.echoCancellation,
    adopt,
    video:
      combined && !adopt
        ? app.cameraDeviceId
          ? { deviceId: { exact: app.cameraDeviceId }, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30, max: 30 } }
          : { facingMode: app.cameraFacing, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30, max: 30 } }
        : false,
  });
  if (video) camera.adopt(video, app.cameraFacing);
  else if (app.cameraOn && !camera.on.value) await openCamera(camera).catch(() => undefined);
  engine.applyFx(audio.params);
  engine.setMonitor(audio.monitor);
  await openInstrument(engine);
}

/**
 * The microphone let go at the end of a song: parked on iOS (the capture stays, muted, for the next song — no
 * second prompt, and the camera it was captured with stays alive), closed elsewhere (the browser remembers the
 * answer; the next song opens it again without a word).
 */
export function releaseMicAfterSong(engine: AudioEngine): void {
  if (isIOS) engine.parkMic();
  else engine.closeMic();
}

/**
 * The instrument input, with the mic: a second capture (a guitar, keys… on a USB interface) summed into this singer's
 * sound. Not on iOS, which keeps one capture per page (a second would end the microphone). A failure (the interface
 * unplugged) is told on the mic status, never in the way of the singing.
 */
export async function openInstrument(engine: AudioEngine): Promise<void> {
  const app = appSettings.peek();
  if (!app.instrumentOn || !app.instrumentDeviceId || isIOS) {
    engine.closeInstrument();
    engine.instrumentError.value = app.instrumentOn && isIOS ? 'An instrument input is not available on iPhone or iPad: the browser keeps one capture per page.' : null;
    return;
  }
  await engine.openInstrument({ deviceId: app.instrumentDeviceId, gainDb: app.instrumentDb }).catch(() => undefined);
}

/** The camera's constraints from the saved settings (the device chosen, or the facing). */
function videoConstraints(): MediaTrackConstraints {
  const app = appSettings.peek();
  const size = cameraSize();
  return app.cameraDeviceId ? { deviceId: { exact: app.cameraDeviceId }, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30, max: 30 } } : { facingMode: app.cameraFacing, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30, max: 30 } };
}

/**
 * The camera off while the microphone stays open (24 Nov: the camera button and the camera's health never touch the
 * voice): on iOS, where the two came in one capture, the video tracks alone are stopped and the engine's audio track
 * lives on; elsewhere the camera's own capture is closed.
 */
export function closeCamera(engine: AudioEngine | null, camera: Camera): void {
  if (isIOS && engine?.micOpen.value && camera.stream?.getAudioTracks().some((t) => t.readyState === 'live')) camera.closeVideo();
  else camera.close();
}

/**
 * The camera on (or on again) while the microphone stays open — the camera button turned on mid-song, a frozen camera
 * restarted. Elsewhere than iOS that is the camera's own capture. On iOS with the microphone open (captured with
 * the camera) the camera alone is asked for and the microphone watched for a moment: where the browser keeps the
 * first capture (recent iOS does), the fresh video track joins the stream the microphone is in and the voice never
 * stops; where the browser ends the microphone with the second capture (older iOS), the two are captured together
 * again, as before — a short gap in the voice rather than no camera.
 */
export async function openCameraKeepingMic(engine: AudioEngine | null, camera: Camera): Promise<void> {
  if (!(isIOS && engine?.micOpen.value)) {
    await openCamera(camera);
    return;
  }
  const mic = engine.micTrack;
  if (mic) {
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: false });
      await new Promise((r) => setTimeout(r, 400));
      if (mic.readyState === 'live' && !mic.muted) {
        camera.replaceVideo(fresh);
        return;
      }
      fresh.getTracks().forEach((t) => t.stop()); // the microphone did not survive the second capture: the old way
    } catch {
      /* the camera alone was refused: the old way */
    }
  }
  camera.close(); // microphone and all: a fresh capture for both
  await openMicWithCamera(engine, camera);
}

/**
 * The camera again, after it froze or went dark (a track the browser muted or ended, a picture that stopped
 * moving): the camera alone — the microphone, the recorder and the song are never touched (24 Nov): closed
 * (`closeCamera`) and opened (`openCameraKeepingMic`).
 */
export async function restartCamera(engine: AudioEngine | null, camera: Camera): Promise<void> {
  closeCamera(engine, camera);
  if (appSettings.peek().cameraOn) await openCameraKeepingMic(engine, camera);
}
