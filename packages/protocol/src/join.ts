/**
 * Joining a performance (the Studio, offline): a singer keeps a take and opens it for others to join;
 * anyone with the link sings their part over it — the show so far (the stage with everyone on it, with
 * the whole mix) is the joiner's backing track, every earlier singer stands on the joiner's stage from
 * their cut-out video, and the joiner's own picture and voice go in beside them. The joined take is a
 * performance of its own, in the joiner's Drive, with everyone on its stage — and can be joined in turn.
 * Nothing here needs a plan: a solo singer's camera is everyone's (roles.ts); a plan gates the picture
 * in LIVE meets only.
 *
 * Time: a show is a file whose frame 0 sits `offsetMs` (real ms) after the song's start, sung at `tempo`
 * — so a song time for the lyrics is `(showMs + offsetMs) × tempo`. A layer's cut-out video has its
 * frame 0 at `atShowMs` on the show's own clock. A joiner's device plays the show as its track from 0
 * (at 1×). In its mix the show is held back by the stage lag plus the singer's round trip (what they
 * sing against), their own voice and picture by the lag alone — so while the take runs, a layer is
 * drawn at `showMs − (lag + roundTrip) − atShowMs` (`layerTimeS`), in step with the voice on it. The
 * saved joined show's frame 0 then falls `videoOffsetMs − roundTrip` after the show it joined (the
 * recorder's offset already carries the lag), so every inherited layer moves by that much
 * (`inheritLayers`, `inheritOffsetMs`), while the joiner's own layer is at `cutoutOffsetMs −
 * videoOffsetMs` (`ownLayerAt`), the two recorders having run on one clock.
 */

/** One singer on an open performance's stage. */
export interface JoinLayer {
  /** 1..10 — the left-to-right order on stage. */
  slot: number;
  displayName: string;
  userId: string;
  /** The alpha-packed cut-out video in the singer's Drive (shared anyone-with-the-link); null for a part sung without a camera — the voice is in the show's sound all the same. */
  cutout: { driveId: string; mimeType: string; bytes: number } | null;
  /** The show's time (ms) at which the cut-out's frame 0 falls (negative when the cut-out started first). */
  atShowMs: number;
}

/** A performance open for others to join, as the SingersVoice service lists it. */
export interface JoinInvite {
  performanceId: string;
  ownerUserId: string;
  ownerName: string;
  /** The song in the SingersVoice track database (the registry id the joiner sings from), '' when the owner's track was never registered. */
  registryId: string;
  trackTitle: string;
  trackArtist: string;
  durationMs: number;
  /** The show to sing over, in the owner's Drive, shared anyone-with-the-link. */
  show: { driveId: string; mimeType: string; bytes: number; link: string };
  /** The show's frame 0 on the song's timeline (real ms) and the pace it was sung at. */
  offsetMs: number;
  tempo: number;
  layers: JoinLayer[];
  /** The performance this one joined; null for a first take. */
  joinedFrom: string | null;
  createdAt: string;
  /** How many performances joined this one so far. */
  joins: number;
}

/** What a device sends to open a performance for joining (the service fills in who and when). */
export interface InviteRequest {
  performanceId: string;
  registryId: string;
  trackTitle: string;
  trackArtist: string;
  durationMs: number;
  show: { driveId: string; mimeType: string; bytes: number; link: string };
  offsetMs: number;
  tempo: number;
  layers: JoinLayer[];
  joinedFrom: string | null;
}

/** The link a joiner opens: the app's own page for the performance. */
export const joinPath = (performanceId: string): string => `/studio/join/${encodeURIComponent(performanceId)}`;

export const MAX_LAYERS = 10;

/** The slot the next singer takes: after the last one on stage; 0 when the stage is full. */
export function nextSlot(layers: Pick<JoinLayer, 'slot'>[]): number {
  const last = layers.reduce((m, l) => Math.max(m, l.slot), 0);
  return last >= MAX_LAYERS ? 0 : last + 1;
}

/** The song's time (ms) for the lyrics, from the show's own clock. */
export const songTimeMs = (showMs: number, invite: Pick<JoinInvite, 'offsetMs' | 'tempo'>): number => (showMs + invite.offsetMs) * (invite.tempo || 1);

/** Where a layer's cut-out video should be (seconds) when the show it joins is at `showMs`, held back by `leadMs` like the show's sound in the mix. */
export const layerTimeS = (showMs: number, leadMs: number, atShowMs: number): number => (showMs - leadMs - atShowMs) / 1000;

/** The joiner's own layer on their saved show: the cut-out's frame 0 against the show's. */
export const ownLayerAt = (t: { cutoutOffsetMs?: number | null; videoOffsetMs: number | null }): number => (t.cutoutOffsetMs ?? 0) - (t.videoOffsetMs ?? 0);

/** The layers a joined show inherits: every earlier singer, their cut-outs moved onto the new show's clock (`roundTripMs`: the manifest's latencyCompMs). */
export function inheritLayers(layers: JoinLayer[], t: { videoOffsetMs: number | null; roundTripMs: number }): JoinLayer[] {
  const shift = (t.videoOffsetMs ?? 0) - t.roundTripMs;
  return layers.map((l) => ({ ...l, atShowMs: l.atShowMs - shift }));
}

/** The joined show's frame 0 on the song's timeline: the show it joined, plus where this one's frame 0 fell on it. */
export const inheritOffsetMs = (invite: Pick<JoinInvite, 'offsetMs'>, t: { videoOffsetMs: number | null; roundTripMs: number }): number => invite.offsetMs + (t.videoOffsetMs ?? 0) - t.roundTripMs;

/** "alice, bob & carol" — the singers on a show, for a title. */
export function singersLine(layers: Pick<JoinLayer, 'displayName'>[]): string {
  const names = layers.map((l) => l.displayName.split(' ')[0] || 'a singer');
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}
