/**
 * The audience's sound, end to end, in one page (tools/ci/mix-lab.mjs): a song is encoded exactly as
 * the host's device encodes the stage mix (Opus, 48 kHz mono, 64 kbps, 20 ms packets, one batch a
 * second with the track position of its first frame), the batches are handed to a `MixPlayer` as a
 * polling listener would get them (three there at once, then one a second), and what the player
 * puts out — on an AudioContext at the rate asked for, 48 or 44.1 kHz — is recorded through the
 * `sv-tap` worklet and handed back as PCM, with the player's own reading of the track position
 * along the way. Not part of the app: bundled by the lab alone.
 */
import type { MixBatch } from '@singersvoice/protocol';
import { MixPlayer } from './mixPlayer.ts';

const toB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
};

/** Encode `pcm` (mono, 48 kHz) the way the host does: Opus 64 kbps, 20 ms packets, one batch per second. */
async function makeBatches(pcm: Float32Array, startMs: number): Promise<MixBatch[]> {
  const rate = 48000;
  const packets: { ts: number; b64: string }[] = [];
  const enc = new AudioEncoder({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      packets.push({ ts: chunk.timestamp, b64: toB64(b) });
    },
    error: (e) => console.error('mix lab encoder', e),
  });
  enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: 64000 });
  const block = Math.round(rate * 0.02);
  for (let i = 0; i + block <= pcm.length; i += block) {
    const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: block, numberOfChannels: 1, timestamp: Math.round((i / rate) * 1e6), data: pcm.slice(i, i + block) });
    enc.encode(data);
    data.close();
  }
  await enc.flush();
  enc.close();
  const batches: MixBatch[] = [];
  for (let b = 0; b * 50 < packets.length; b++) batches.push({ seq: b + 1, atMs: startMs + b * 1000, sampleRate: rate, channels: 1, packets: packets.slice(b * 50, b * 50 + 50) } as MixBatch);
  return batches;
}

export interface MixLabRun {
  rate: number;
  /** The player's output, float32 PCM at `rate`, base64. */
  b64: string;
  /** The player's reading every half second: ms since the start, the track position it reports (ms), how far behind it says it is. */
  positions: { t: number; pos: number | null; behind: number; hearing: boolean }[];
  /** How many batches each poll returned. */
  fetched: number[];
  batches: number;
}

declare global {
  interface Window {
    svMixLab: (o: { ctxRate: number; seconds: number; songUrl: string; startMs: number; arrivalMs: number; workletBase: string }) => Promise<MixLabRun>;
  }
}

window.svMixLab = async (o) => {
  const ctx = new AudioContext({ sampleRate: o.ctxRate });
  await ctx.resume();
  const song = await (await fetch(o.songUrl)).arrayBuffer();
  const dec = new OfflineAudioContext(1, 48000 * 240, 48000);
  const buf = await dec.decodeAudioData(song);
  const batches = await makeBatches(buf.getChannelData(0), o.startMs);
  const t0 = performance.now();
  // the host sends one batch a second; three are already there when the listener arrives
  const available = () => batches.filter((_b, i) => i < 3 || (i - 3) * o.arrivalMs <= performance.now() - t0);
  const fetched: number[] = [];
  const mp = new MixPlayer(ctx, ctx.destination, async (since) => {
    const av = available().filter((b) => b.seq > since);
    fetched.push(av.length);
    return { batches: av, latest: available().length };
  });
  const want = Math.round(ctx.sampleRate * o.seconds);
  await ctx.audioWorklet.addModule(`${o.workletBase}tap.js`);
  const tap = new AudioWorkletNode(ctx, 'sv-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { frames: want } });
  const positions: MixLabRun['positions'] = [];
  mp.start();
  const poll = setInterval(() => positions.push({ t: Math.round(performance.now() - t0), pos: mp.positionMs(), behind: mp.behindS(), hearing: mp.state.value.hearing }), 500);
  const data = await new Promise<Float32Array>((resolve) => {
    tap.port.onmessage = (e: MessageEvent<{ type: string; data: Float32Array }>) => e.data.type === 'done' && resolve(e.data.data);
    mp.out.connect(tap);
    tap.connect(ctx.destination);
  });
  clearInterval(poll);
  mp.out.disconnect(tap);
  tap.disconnect();
  mp.stop();
  const b64 = toB64(new Uint8Array(data.buffer));
  await ctx.close();
  return { rate: ctx.sampleRate, b64, positions, fetched, batches: batches.length };
};
