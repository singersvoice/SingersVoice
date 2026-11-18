/**
 * Timing the live mix (the audience's, the saved show's, the broadcast's) so every voice lands on the
 * beat it was sung to. On this device the track in the mix is held back by the lag plus this singer's
 * round trip (speakers out, microphone in, the chain), and their own voice by the lag — so their voice
 * meets the beat. Every OTHER singer's voice arrives behind the shared clock by their own round trip
 * plus the way here (encode, the network, the jitter buffer, decode): `arrivalMs`. To land on the beat
 * too, each of them is held back by what they are early by — in the browser's own jitter buffer
 * (`jitterBufferTarget`, which holds their picture back with their voice) — and when one of them
 * arrives later than the lag allows, the lag grows for this song (never past LAG_MAX_MS, never shrinking
 * under LAG_MIN_MS). The plan is made at the count-in and kept for the song: a delay that moves mid-song
 * would bend the sound.
 */

/** The lag every device holds its own sources back by at least (ms): what a typical link needs. */
export const LAG_MIN_MS = 250;
/** The most the lag grows to for a slow link (ms): beyond this the singer's own picture lags their screen too much. */
export const LAG_MAX_MS = 1500;
/** Headroom over the latest arrival (ms): the network's jitter. */
export const ALIGN_MARGIN_MS = 40;

export interface PeerArrival {
  id: string;
  /** How far behind the shared clock their voice reaches this device, before any hold applied here; null until measured. */
  arrivalMs: number | null;
}

export interface AlignPlan {
  /** The lag this device's own sources are held back by for the song. */
  lagMs: number;
  /** What the track in the mix is held back by: the lag plus this singer's round trip. */
  trackDelayMs: number;
  /** Per other singer: how long the browser holds their voice and picture back (ms, ≥ 0; 0 for one not measured yet). */
  delays: Record<string, number>;
}

export function alignPlan(roundTripMs: number, peers: PeerArrival[], lagMinMs = LAG_MIN_MS): AlignPlan {
  const rt = Math.max(0, roundTripMs || 0);
  const latest = peers.reduce((m, p) => (p.arrivalMs === null ? m : Math.max(m, p.arrivalMs)), 0);
  const lagMs = Math.round(Math.min(LAG_MAX_MS, Math.max(lagMinMs, latest - rt + ALIGN_MARGIN_MS)));
  const trackDelayMs = lagMs + rt;
  const delays: Record<string, number> = {};
  for (const p of peers) delays[p.id] = p.arrivalMs === null ? 0 : Math.max(0, Math.round(trackDelayMs - p.arrivalMs));
  return { lagMs, trackDelayMs, delays };
}

/** The hold for one singer who linked up after the plan was made (the lag stays; they are fitted to it). */
export const delayFor = (plan: Pick<AlignPlan, 'trackDelayMs'>, arrivalMs: number): number => Math.max(0, Math.round(plan.trackDelayMs - arrivalMs));

/** "bob +120 ms · carol +40 ms (lag 250 ms)" — for the stage bar and the logs. */
export function alignLine(plan: AlignPlan, names: (id: string) => string): string {
  const parts = Object.entries(plan.delays).map(([id, ms]) => `${names(id)} +${ms} ms`);
  return `${parts.join(' · ')}${parts.length ? ' ' : ''}(lag ${plan.lagMs} ms)`;
}
