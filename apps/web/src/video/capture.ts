/**
 * The microphone and the camera as one capture where the browser insists on it.
 *
 * iOS Safari keeps one capture per page: a second getUserMedia — the mic opened after the camera,
 * or the mic opened again for another setting (another input, "I'm on speakers") — ends the first,
 * and the camera goes dark or freezes on its last frame for everyone on the stage. So on iOS every
 * opening of the mic asks for the camera in the same call and hands the new video to the Camera;
 * elsewhere the two are opened apart, and the camera is left alone when it is already on.
 */
import type { AudioEngine } from '../audio/engine.ts';
import { isIOS } from '../lib/platform.ts';
import { appSettings, audioSettings } from '../state/settings.ts';
import type { Camera } from './camera.ts';
import { cameraSize } from './enhance.ts';

/** Open (or re-open) the mic with the saved settings — and, on iOS with the camera on, the camera with it. */
export async function openMicWithCamera(engine: AudioEngine, camera: Camera): Promise<void> {
  const app = appSettings.peek();
  const audio = audioSettings.peek();
  const combined = isIOS && app.cameraOn;
  const size = cameraSize();
  if (combined) camera.close();
  const video = await engine.openMic({
    deviceId: app.audioInputId || undefined,
    echoCancellation: app.echoCancellation,
    video: combined
      ? app.cameraDeviceId
        ? { deviceId: { exact: app.cameraDeviceId }, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30, max: 30 } }
        : { facingMode: app.cameraFacing, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30, max: 30 } }
      : false,
  });
  if (video) camera.adopt(video, app.cameraFacing);
  else if (app.cameraOn && !camera.on.value) await camera.open({ facing: app.cameraFacing, deviceId: app.cameraDeviceId || undefined }).catch(() => undefined);
  engine.applyFx(audio.params);
  engine.setMonitor(audio.monitor);
  await openInstrument(engine);
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
  if (isIOS && engine?.micOpen.value && app.cameraOn) return openMicWithCamera(engine, camera);
  camera.close();
  if (app.cameraOn) await camera.open({ facing: app.cameraFacing, deviceId: app.cameraDeviceId || undefined });
}
