/**
 * The loudness measurement off the main thread: a decoded track's channels come in (transferred),
 * its BS.1770 loudness goes back. A four-minute track takes a second of arithmetic — not on the
 * thread that draws the stage and answers the mesh.
 */
import { measureLoudness } from './loudness.ts';

interface Request {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage: (m: unknown) => void };
scope.onmessage = (e: MessageEvent<Request>) => {
  const { id, channels, sampleRate } = e.data;
  const l = measureLoudness(channels, sampleRate);
  scope.postMessage({ id, lufs: l.lufs, peakDb: l.peakDb });
};
