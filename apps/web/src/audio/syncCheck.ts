/**
 * The sync check (Settings → Audio): four clicks out of the speakers, the microphone recorded meanwhile,
 * the clicks found in the recording — the time from a click sent to the click heard is the device's round
 * trip (speakers out, the room, microphone in), the one figure the browser cannot tell (audio/sync.ts).
 * Remembered for this device and microphone; every take and live mix on it uses it from then on.
 */
import type { AudioEngine } from './engine.ts';
import { PcmRecorder } from './recorder.ts';
import { clicksHeard } from './sync.ts';

export interface SyncCheckResult {
  /** The device's round trip (ms), or null when the microphone heard no clicks (headphones on; the room too loud). */
  roundTripMs: number | null;
  /** Each click's lag as heard (ms). */
  lags: number[];
}

/** One click: 15 ms of a 1 kHz tone with a soft edge, at `at` on the context's clock. */
function click(ctx: BaseAudioContext, out: AudioNode, at: number): void {
  const osc = ctx.createOscillator();
  osc.frequency.value = 1000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.5, at + 0.001);
  g.gain.setValueAtTime(0.5, at + 0.012);
  g.gain.linearRampToValueAtTime(0, at + 0.015);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + 0.03);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
  };
}

/** The clicks sent at these times after the start (s). */
export const SYNC_CLICKS_AT = [0.4, 0.9, 1.4, 1.9];

/**
 * Run the check on an engine whose microphone is open. Resolves after about three seconds with the
 * round trip heard — remembered on the engine when there is one.
 */
export async function runSyncCheck(engine: AudioEngine): Promise<SyncCheckResult> {
  await engine.resume();
  if (!engine.workletAvailable) throw new Error('This browser cannot record the check');
  if (!engine.micOpen.value) throw new Error('The microphone is not open');
  const ctx = engine.ctx;
  const rec = new PcmRecorder(ctx);
  engine.tapRaw(rec.node);
  try {
    const start = await rec.start();
    const t0 = ctx.currentTime + 0.1;
    const sent = SYNC_CLICKS_AT.map((a) => {
      click(ctx, engine.master, t0 + a);
      return (t0 + a - start) * 1000;
    });
    const until = t0 + SYNC_CLICKS_AT[SYNC_CLICKS_AT.length - 1]! + 1.1;
    await new Promise((r) => setTimeout(r, Math.max(0, (until - ctx.currentTime) * 1000)));
    const take = await rec.stop();
    const heard = clicksHeard(take.pcm, take.sampleRate, sent);
    if (heard) engine.rememberDeviceLatency(heard.roundTripMs, 'sync-check');
    return { roundTripMs: heard?.roundTripMs ?? null, lags: heard?.lags ?? [] };
  } finally {
    engine.untapRaw(rec.node);
    rec.dispose();
  }
}
