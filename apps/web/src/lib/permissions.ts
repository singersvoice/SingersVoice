/**
 * The camera and the microphone: asked for once, together, at the setup (one prompt where the browser allows
 * it), and never asked for again while the browser remembers the answer — which is the browser's to decide: a
 * page cannot grant itself a permission, and nothing saved here stands in for the browser's own record. What
 * the app does is (1) ask for both in ONE getUserMedia call wherever it can, (2) keep one capture per Studio
 * visit on iPhone and iPad (Safari asks on every new capture: capture.ts, engine.ts), (3) read the browser's own
 * permission state where it offers one (the Permissions API — Chrome, Edge, Firefox, Safari 16.4+), so a device
 * the browser already allows is opened without a word, and a device the browser blocks is said so, with the
 * way back (`permissionHelp`), instead of a prompt that never comes.
 */
import { signal } from '@preact/signals';
import { isAndroid, isIOS, isSafari, isStandalone } from './platform.ts';

export type MediaPermission = 'granted' | 'prompt' | 'denied' | 'unknown';
export interface MediaPermissions {
  camera: MediaPermission;
  microphone: MediaPermission;
  /** When the browser last told (ISO), '' until it has. */
  at: string;
}

/** The browser's word on the two, as last read (`checkMediaPermissions`); 'unknown' where the browser offers no word. */
export const mediaPermissions = signal<MediaPermissions>({ camera: 'unknown', microphone: 'unknown', at: '' });

let watching = false;

async function queryOne(name: 'camera' | 'microphone'): Promise<MediaPermission> {
  try {
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    if (!perms?.query) return 'unknown';
    const status = await perms.query({ name: name as PermissionName });
    if (!watching) {
      status.addEventListener('change', () => void checkMediaPermissions());
    }
    return status.state;
  } catch {
    return 'unknown'; // a browser that does not know these names
  }
}

/** Read the browser's permission state for the camera and the microphone (where it offers one), and keep it fresh. */
export async function checkMediaPermissions(): Promise<MediaPermissions> {
  const [camera, microphone] = await Promise.all([queryOne('camera'), queryOne('microphone')]);
  watching = true;
  const next = { camera, microphone, at: new Date().toISOString() };
  mediaPermissions.value = next;
  return next;
}

/** Whether a getUserMedia failure was the user (or the browser's settings) saying no. */
export function isPermissionDenied(e: unknown): boolean {
  const name = e instanceof Error ? e.name : '';
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
}

/** Whether a getUserMedia failure was a device that is not there (no camera, no microphone). */
export function isNoDevice(e: unknown): boolean {
  const name = e instanceof Error ? e.name : '';
  return name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError';
}

export interface MediaAccessResult {
  camera: 'granted' | 'denied' | 'none' | 'skipped';
  microphone: 'granted' | 'denied' | 'none';
  /** What the browser gave, by label (the saved device choices are kept apart; this is for the setup's word). */
  cameraLabel: string;
  microphoneLabel: string;
}

/**
 * Ask for the microphone and the camera in ONE call (one prompt), let the devices go at once (nothing is
 * captured here), and say what the browser decided. A camera that is not there, or refused, never costs the
 * microphone: the call is made again for the microphone alone.
 */
export async function requestMediaAccess(opts: { camera: boolean }): Promise<MediaAccessResult> {
  const stopAll = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());
  const labelOf = (s: MediaStream, kind: 'audio' | 'video') => (kind === 'audio' ? s.getAudioTracks() : s.getVideoTracks())[0]?.label ?? '';
  if (opts.camera) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } });
      const r: MediaAccessResult = { camera: 'granted', microphone: 'granted', cameraLabel: labelOf(s, 'video'), microphoneLabel: labelOf(s, 'audio') };
      stopAll(s);
      void checkMediaPermissions();
      return r;
    } catch (e) {
      // Both refused at once, or no camera: the microphone alone is asked for below; the camera's answer is kept.
      const camera: MediaAccessResult['camera'] = isNoDevice(e) ? 'none' : 'denied';
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        const r: MediaAccessResult = { camera, microphone: 'granted', cameraLabel: '', microphoneLabel: labelOf(s, 'audio') };
        stopAll(s);
        void checkMediaPermissions();
        return r;
      } catch (e2) {
        void checkMediaPermissions();
        return { camera, microphone: isNoDevice(e2) ? 'none' : 'denied', cameraLabel: '', microphoneLabel: '' };
      }
    }
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const r: MediaAccessResult = { camera: 'skipped', microphone: 'granted', cameraLabel: '', microphoneLabel: labelOf(s, 'audio') };
    stopAll(s);
    void checkMediaPermissions();
    return r;
  } catch (e) {
    void checkMediaPermissions();
    return { camera: 'skipped', microphone: isNoDevice(e) ? 'none' : 'denied', cameraLabel: '', microphoneLabel: '' };
  }
}

/**
 * The way back once a device is blocked, in this browser's own words: where its switch is. (The app cannot flip it;
 * only the person can, where the browser keeps it.)
 */
export function permissionHelp(what: 'camera' | 'microphone' | 'both' = 'both'): string {
  const which = what === 'both' ? 'Camera and Microphone' : what === 'camera' ? 'Camera' : 'Microphone';
  if (isIOS) {
    if (isStandalone) return `On the iPhone's Settings → SingersVoice (or Settings → Safari → ${which}) set ${which} to Allow, then open SingersVoice again.`;
    return `In Safari tap the “aA” (or the page icon) at the left of the address bar → Website Settings → ${which} → Allow; or on the iPhone's Settings → Safari → ${which} → Allow. Then reload SingersVoice. Added to the Home Screen, SingersVoice is asked once and remembers.`;
  }
  if (isAndroid) return `Tap the lock (or the tune) icon beside the address bar → Permissions → ${which} → Allow, then reload. Installed from the browser's menu (Add to Home screen), the answer is kept with the app.`;
  if (isSafari) return `In Safari's menu: Settings for This Website… → ${which} → Allow (or Safari → Settings → Websites → ${which}), then reload.`;
  return `Click the lock (or the camera) icon at the left of the address bar, set ${which} to Allow, then reload the page.`;
}
