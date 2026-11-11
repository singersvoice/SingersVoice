export const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const isIOS = /iP(hone|ad|od)/.test(ua) || (ua.includes('Mac') && typeof document !== 'undefined' && 'ontouchend' in document);
export const isAndroid = /Android/.test(ua);
export const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|Android/.test(ua);
export const isStandalone =
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true);
export const platformName = isIOS ? 'iOS' : isAndroid ? 'Android' : 'Web';

export function hasAudioWorklet(): boolean {
  return typeof AudioWorkletNode !== 'undefined';
}

export function hasMediaRecorder(): boolean {
  return typeof MediaRecorder !== 'undefined';
}

/** Ask the browser not to evict our IndexedDB/cache under storage pressure. */
export async function persistStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e) return null;
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}

let wakeLock: { release(): Promise<void> } | null = null;
export async function keepAwake(on: boolean): Promise<void> {
  try {
    const nav = navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    if (on && !wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

export function bytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Best guess whether headphones are in use (unreliable on the web; used only for the tip). */
export async function headphonesLikely(): Promise<boolean | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((d) => d.kind === 'audiooutput');
    if (!outs.length) return null;
    return outs.some((d) => /head|ear|bud|airpod|bluetooth|bt/i.test(d.label));
  } catch {
    return null;
  }
}
