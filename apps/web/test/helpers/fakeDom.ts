/**
 * The little of the DOM the camera pipeline touches, for Node tests: canvases with a 2D context that
 * records nothing but answers every call, a <video> whose readiness the test sets, a document with a
 * body and a visibility state, and media tracks that fire mute / unmute / ended on demand.
 */
import { afterEach, beforeEach } from 'vitest';

const g = globalThis as Record<string, unknown>;
const saved: Record<string, PropertyDescriptor | undefined> = {};
const keys = ['document', 'window', 'navigator', 'HTMLCanvasElement', 'MediaStream', 'performance'];
/** Set a global even where Node defines it with a getter only (navigator). */
const set = (k: string, v: unknown) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true, enumerable: true });
const restore = () => {
  for (const k of keys) {
    const d = saved[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete g[k];
  }
};

export interface FakeCtx {
  calls: string[];
  /** What getImageData answers (the test sets it). */
  pixels: Uint8ClampedArray;
}

export function fakeContext(size = 24 * 24 * 4): FakeCtx & Record<string, unknown> {
  const ctx: FakeCtx & Record<string, unknown> = { calls: [], pixels: new Uint8ClampedArray(size), fillStyle: '', globalCompositeOperation: 'source-over', filter: 'none' };
  for (const m of ['clearRect', 'fillRect', 'drawImage', 'save', 'restore', 'putImageData']) ctx[m] = (...a: unknown[]) => void ctx.calls.push(`${m}(${a.length})`);
  ctx.getImageData = () => ({ data: ctx.pixels });
  ctx.createImageData = (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  ctx.createLinearGradient = () => ({ addColorStop: () => undefined });
  return ctx;
}

export class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  kind = 'video';
  label = 'Fake camera';
  stop(): void {
    this.readyState = 'ended';
  }
  fire(name: 'mute' | 'unmute' | 'ended'): void {
    if (name === 'mute') this.muted = true;
    if (name === 'unmute') this.muted = false;
    if (name === 'ended') this.readyState = 'ended';
    this.dispatchEvent(new Event(name));
  }
}

export class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

export interface FakeDom {
  contexts: (FakeCtx & Record<string, unknown>)[];
  video: { readyState: number; videoWidth: number; videoHeight: number; srcObject: unknown; isConnected: boolean; play: () => Promise<void>; remove: () => void; onpause: unknown; muted: boolean; playsInline: boolean; autoplay: boolean; style: { cssText: string }; setAttribute: () => void; currentTime: number; requestVideoFrameCallback?: (cb: () => void) => number; frame: () => void };
  document: { visibilityState: string; dispatchEvent: (e: Event) => boolean };
}

/** Fresh fakes before every test of the file, the real globals back after each; `current` is the set in use. */
export function fakeDom(): { current: FakeDom } {
  const holder = { current: null as unknown as FakeDom };
  beforeEach(() => {
    holder.current = installFakeDom();
  });
  afterEach(restore);
  return holder;
}

function installFakeDom(): FakeDom {
  for (const k of keys) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const contexts: (FakeCtx & Record<string, unknown>)[] = [];
  // The video's frame callbacks: `frame()` presents one frame (the pending callback runs, and re-arms itself).
  let pending: (() => void) | null = null;
  const video: FakeDom['video'] = {
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    srcObject: null,
    isConnected: false,
    play: () => Promise.resolve(),
    remove: () => undefined,
    onpause: null,
    muted: false,
    playsInline: false,
    autoplay: false,
    style: { cssText: '' },
    setAttribute: () => undefined,
    currentTime: 0,
    requestVideoFrameCallback: (cb) => {
      pending = cb;
      return 1;
    },
    frame: () => {
      const cb = pending;
      pending = null;
      cb?.();
    },
  };
  const events = new EventTarget();
  const document = {
    visibilityState: 'visible',
    body: { appendChild: () => undefined },
    head: { appendChild: () => undefined },
    addEventListener: (n: string, cb: EventListener) => events.addEventListener(n, cb),
    removeEventListener: (n: string, cb: EventListener) => events.removeEventListener(n, cb),
    dispatchEvent: (e: Event) => events.dispatchEvent(e),
    createElement: (tag: string) => {
      if (tag === 'video') return video;
      const ctx = fakeContext();
      contexts.push(ctx);
      return { width: 0, height: 0, getContext: () => ctx };
    },
  };
  set('document', document);
  set('window', g.window ?? {});
  set('navigator', { userAgent: 'FakeBrowser', hardwareConcurrency: 8 });
  set('HTMLCanvasElement', class {});
  set('MediaStream', FakeStream);
  return { contexts, video, document };
}
