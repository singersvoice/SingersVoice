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

/**
 * The camera again, after it froze or went dark (a track the browser muted or ended, a picture that
 * stopped moving): with the mic open on iOS the two are re-captured together, elsewhere the camera
 * alone is closed and opened.
 */
export async function restartCamera(engine: AudioEngine | null, camera: Camera): Promise<void> {
  const app = appSettings.peek();
  if (isIOS && engine?.micOpen.value && app.cameraOn) {
    camera.close(); // the capture that froze goes, microphone and all: a fresh one for both
    return openMicWithCamera(engine, camera);
  }
  camera.close();
  if (app.cameraOn) await openCamera(camera);
}
