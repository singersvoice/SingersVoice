/**
 * The stage mix for the audience: while a song runs, the host's device encodes the blend it already
 * has for the recording — the backing track and every singer's vocal after their FX — as Opus,
 * in one-second batches tagged with the track position of their first frame, and posts them to
 * the service; audience devices (and the public watch page) fetch the batches a second at a time
 * and play them a couple of seconds behind the stage, their lyrics following what they hear.
 * Singers on stage never hear it (Solo foldback): it is for everyone else.
 */
export interface MixPacket {
  /** Microseconds since the batch stream started (the encoder's clock). */
  ts: number;
  /** The Opus packet, base64. */
  b64: string;
}

export interface MixBatch {
  seq: number;
  /** Track position (ms) of the batch's first frame — the audience's lyrics follow it. */
  atMs: number;
  codec: 'opus';
  sampleRate: number;
  channels: number;
  packets: MixPacket[];
  /** Set by the service. */
  serverEpochMs?: number;
}

/** Batches kept per meet (a rolling window: late joiners catch the last few seconds). */
export const MIX_KEEP = 40;
/** Audio bitrate of the relayed mix. */
export const MIX_BITRATE = 64_000;
