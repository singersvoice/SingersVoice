/**
 * Joining a performance, from the singer's side (join.ts in the protocol has the rules and the clock
 * arithmetic; the Studio's Sing screen does the singing):
 *
 *   invite = open one of my performances for others to sing over: kept (a Temp take would vanish),
 *            its show and my cut-out shared anyone-with-the-link, the song registered with the track
 *            database, and the whole of it put on record with the service — the link is the app's own
 *            page for it, and every singer so far goes with it as a layer
 *   load   = what a joiner's device needs: the invite, the show as a blob and every singer's cut-out
 *            (through the service — another account's token cannot read the owner's Drive), and the
 *            song from the track database (my copy of it, made now if I have none)
 *   layers = the earlier singers on my stage while I sing: a <video> per cut-out, kept on the show's
 *            clock (`layerTimeS`) and unpacked into a stage performer the compositor draws like any
 *            singer who is somewhere else
 */
import { inheritLayers, inheritOffsetMs, joinPath, layerTimeS, nextSlot, ownLayerAt, type JoinInvite, type JoinLayer, type PerformanceJoin, type PerformanceManifest } from '@singersvoice/protocol';
import { UnpackedFrame } from '../video/alphaPack.ts';
import type { StagePerformer } from '../video/stage.ts';
import { api, controlConfigured } from './api.ts';
import { href } from './nav.ts';
import { ensureRegistered, getTrackRecord, singRecord } from './registry.ts';
import type { PerformanceSummary, Progress } from './storage/types.ts';
import { accountUserId, isDrive, profile, withProvider } from '../state/session.ts';

/** The link a joiner opens, on this deployment. */
export const joinUrl = (performanceId: string): string => new URL(href(joinPath(performanceId)), location.origin).toString();

/** The singers on a performance as its invite lists them: the ones it inherited (already on its clock) and its own singer, in stage order. */
export function layersOf(manifest: PerformanceManifest, summary: PerformanceSummary, me: { userId: string; displayName: string }): JoinLayer[] {
  const inherited = manifest.join?.layers ?? [];
  const own: JoinLayer = {
    slot: manifest.singerSlot,
    displayName: me.displayName,
    userId: me.userId,
    cutout: summary.cutout?.driveId ? { driveId: summary.cutout.driveId, mimeType: summary.cutout.mimeType, bytes: summary.cutout.bytes } : null,
    atShowMs: Math.round(ownLayerAt(manifest.timeline)),
  };
  return [...inherited.filter((l) => l.slot !== own.slot), own].sort((a, b) => a.slot - b.slot);
}

/**
 * Open one of my performances for joining. Needs Drive (the files are shared from there) and the
 * service (the record). Returns the invite and the link to hand out.
 */
export async function invitePerformance(performanceId: string, onProgress?: Progress): Promise<{ invite: JoinInvite; url: string }> {
  if (!isDrive.value) throw new Error('Opening a performance for others needs Google Drive — it is shared from there.');
  if (!controlConfigured.value) throw new Error('The SingersVoice service is not configured for this build.');
  onProgress?.({ label: 'Reading the performance', fraction: 0.1 });
  const found = await withProvider((p) => p.describePerformance(performanceId));
  if (!found) throw new Error('Performance not found in your Drive');
  const { manifest } = found;
  if ((manifest.kind ?? 'take') !== 'show' || !found.summary.hasVideo) throw new Error('Only a take with its show video can be joined — this one has none.');
  if (manifest.state === 'temp') {
    onProgress?.({ label: 'Keeping the take (an open performance never expires)', fraction: 0.25 });
    await withProvider((p) => p.keepPerformance(performanceId));
  }
  onProgress?.({ label: 'Sharing the show', fraction: 0.4 });
  const shared = await withProvider((p) => p.sharePerformance(performanceId, { type: 'anyone' }));
  const after = (await withProvider((p) => p.describePerformance(performanceId))) ?? found;
  // The song in the track database: my library's copy knows its id (set on the first Sing of a track of mine, or by the
  // pull that made the copy); a track never registered is registered now; a joined take falls back to the invite it sang over.
  onProgress?.({ label: 'The song in the track database', fraction: 0.6 });
  const track = await withProvider((p) => p.getTrack(manifest.trackId)).catch(() => null);
  let registryId = track?.track.registryId ?? '';
  if (!registryId && track) registryId = (await ensureRegistered(manifest.trackId, { loaded: track }).catch(() => null)) ?? '';
  if (!registryId && manifest.join) registryId = (await inviteOf(manifest.join.fromPerformanceId))?.registryId ?? '';
  const me = { userId: accountUserId.value, displayName: profile.value?.name || 'A singer' };
  const layers = layersOf(after.manifest, after.summary, me);
  const videoFile = after.manifest.files.find((f) => f.name.startsWith('video.'));
  const show = { driveId: after.summary.ref, mimeType: videoFile?.mimeType || 'video/mp4', bytes: videoFile?.size ?? 0, link: shared.videoLink ?? shared.link };
  onProgress?.({ label: 'Opening it for joining', fraction: 0.85 });
  const r = await api.put('PUT /performances/:id/invite', `/performances/${encodeURIComponent(performanceId)}/invite`, {
    performanceId,
    registryId,
    trackTitle: manifest.trackTitle,
    trackArtist: manifest.trackArtist,
    durationMs: manifest.durationMs,
    show,
    offsetMs: Math.round(manifest.join ? manifest.join.offsetMs : (manifest.timeline.videoOffsetMs ?? 0)),
    tempo: manifest.join ? manifest.join.tempo : manifest.playback.tempo || 1,
    layers,
    joinedFrom: manifest.join?.fromPerformanceId ?? null,
  });
  onProgress?.({ label: 'Open for joining', fraction: 1 });
  return { invite: r.invite, url: joinUrl(performanceId) };
}

/** The invite on record for a performance, or null when it is not open. */
export async function inviteOf(performanceId: string): Promise<JoinInvite | null> {
  try {
    return (await api.get('GET /performances/:id/invite', `/performances/${encodeURIComponent(performanceId)}/invite`)).invite;
  } catch {
    return null;
  }
}

/** Close one of my performances to joining (the files stay shared with whoever has their links). */
export async function closeInvite(performanceId: string): Promise<void> {
  await api.del('DELETE /performances/:id/invite', `/performances/${encodeURIComponent(performanceId)}/invite`);
}

/** What a joiner's device sings with. */
export interface JoinMaterial {
  invite: JoinInvite;
  /** The show to sing over (its sound is the joiner's backing track). */
  show: Blob;
  /** Every earlier singer's cut-out video, by slot (a singer without one is a slot with a name alone). */
  cutouts: Map<number, Blob>;
  /** The id of the song in my own library (pulled from the track database when I had none). */
  trackId: string | null;
  /** The slot I take on the stage; 0 when the stage is full. */
  slot: number;
}

const inviteFile = (performanceId: string, which: string): Promise<Blob> => api.getBlob('GET /performances/:id/invite/file/:which', `/performances/${encodeURIComponent(performanceId)}/invite/file/${which}`);

/** The show of an open performance, to watch (the same file the stage sings over). */
export const inviteShow = (performanceId: string): Promise<Blob> => inviteFile(performanceId, 'show');

/** Everything a joiner needs, fetched: the invite, the show (or the one already fetched to watch), the cut-outs, the song. */
export async function loadInvite(performanceId: string, onProgress?: Progress, have: { show?: Blob } = {}): Promise<JoinMaterial> {
  if (!controlConfigured.value) throw new Error('The SingersVoice service is not configured for this build.');
  onProgress?.({ label: 'Reading the invitation', fraction: 0.05 });
  const { invite } = await api.get('GET /performances/:id/invite', `/performances/${encodeURIComponent(performanceId)}/invite`);
  onProgress?.({ label: `Fetching the show from ${invite.ownerName}'s Drive`, fraction: 0.15 });
  const show = have.show ?? (await inviteFile(performanceId, 'show'));
  const cutouts = new Map<number, Blob>();
  const withCutout = invite.layers.filter((l) => l.cutout);
  for (const [i, l] of withCutout.entries()) {
    onProgress?.({ label: `Fetching ${l.displayName.split(' ')[0] || 'a singer'}'s picture`, fraction: 0.45 + (0.35 * i) / withCutout.length });
    try {
      cutouts.set(l.slot, await inviteFile(performanceId, `cutout-${l.slot}`));
    } catch {
      /* their picture is gone (unshared, deleted): the slot keeps their name; the voice is in the show all the same */
    }
  }
  let trackId: string | null = null;
  if (invite.registryId) {
    onProgress?.({ label: 'The song, from the track database', fraction: 0.85 });
    try {
      trackId = await singRecord(await getTrackRecord(invite.registryId), onProgress);
    } catch {
      trackId = null; // no lyrics then: the show carries the song
    }
  }
  onProgress?.({ label: 'Ready', fraction: 1 });
  return { invite, show, cutouts, trackId, slot: nextSlot(invite.layers) };
}

/** The join a saved take records (its manifest's `join`): the performance sung over, and every earlier singer moved onto this take's clock. */
export function joinOfTake(invite: JoinInvite, take: { videoOffsetMs: number | null; latencyCompMs: number }): PerformanceJoin {
  const t = { videoOffsetMs: take.videoOffsetMs, roundTripMs: take.latencyCompMs };
  return { fromPerformanceId: invite.performanceId, fromOwnerName: invite.ownerName, layers: inheritLayers(invite.layers, t), offsetMs: Math.round(inheritOffsetMs(invite, t)), tempo: invite.tempo || 1 };
}

/**
 * The earlier singers on my stage: one <video> per cut-out, unpacked into a stage performer, held on the
 * show's clock by `sync` (called from the stage's own tick) — playing while the song plays, still while
 * it is paused, seeked back into step whenever it has drifted.
 */
export class JoinLayers {
  private readonly players = new Map<number, { video: HTMLVideoElement; frame: UnpackedFrame; url: string; layer: JoinLayer }>();
  readonly performers: StagePerformer[];

  constructor(
    readonly layers: JoinLayer[],
    cutouts: Map<number, Blob>,
  ) {
    for (const layer of layers) {
      const blob = cutouts.get(layer.slot);
      if (!blob) continue;
      const video = document.createElement('video');
      const url = URL.createObjectURL(blob);
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.load();
      this.players.set(layer.slot, { video, frame: new UnpackedFrame(video), url, layer });
    }
    this.performers = layers.map((l) => {
      const p = this.players.get(l.slot);
      return { id: `layer-${l.slot}`, slot: l.slot, label: l.displayName.split(' ')[0] || 'Singer', source: p ? { kind: 'frame', frame: p.frame, recorded: true } : { kind: 'none' } };
    });
  }

  /**
   * Every cut-out decoded to its first frame, so the stage shows the singers before the song starts, and made
   * seekable: a video a MediaRecorder wrote has no duration in its header, and a browser will not seek in it
   * (a layer that starts late never found its place) until it has been sent past the end once — the usual
   * remedy — after which the duration is known and seeks land. Best effort, a few seconds at most.
   */
  async ready(timeoutMs = 8000): Promise<void> {
    const once = (video: HTMLVideoElement, events: string[], ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          for (const e of events) video.removeEventListener(e, done);
          resolve();
        };
        for (const e of events) video.addEventListener(e, done);
        setTimeout(done, ms);
      });
    await Promise.all(
      [...this.players.values()].map(async ({ video }) => {
        if (video.readyState < 1) await once(video, ['loadedmetadata', 'error'], timeoutMs);
        if (!Number.isFinite(video.duration) && video.readyState >= 1) {
          try {
            const past = once(video, ['durationchange', 'seeked', 'error'], timeoutMs);
            video.currentTime = 1e101;
            await past;
            if (video.readyState >= 1) {
              const back = once(video, ['seeked', 'error'], timeoutMs);
              video.currentTime = 0;
              await back;
            }
          } catch {
            /* a browser that refuses the seek: the layer plays from its start all the same */
          }
        }
        if (video.readyState < 2) await once(video, ['loadeddata', 'seeked', 'error'], timeoutMs);
      }),
    );
  }

  /** Hold every cut-out at its place for the show at `showMs` (held back by `leadMs` like the show's sound in the mix), playing or still. */
  sync(showMs: number, leadMs: number, playing: boolean): void {
    for (const { video, layer } of this.players.values()) {
      const raw = layerTimeS(showMs, leadMs, layer.atShowMs);
      const want = Math.max(0, raw);
      const ended = Number.isFinite(video.duration) && video.duration > 0 && want >= video.duration;
      const off = Math.abs(video.currentTime - want);
      if (playing && raw >= 0 && !ended) {
        if (off > 0.15 && !video.seeking) video.currentTime = want; // drifted (or just started): back into step — one seek at a time
        if (video.paused) void video.play().catch(() => undefined);
      } else {
        if (!video.paused) video.pause(); // before its first frame is due, with the song paused, or past its end: still
        if (off > 0.05 && !ended && !video.seeking) video.currentTime = want;
      }
    }
  }

  /** The cut-outs' players, for support and tests. */
  state(): { slot: number; readyState: number; currentTime: number; duration: number; seeking: boolean; paused: boolean; error: string | null }[] {
    return [...this.players.values()].map(({ video, layer }) => ({ slot: layer.slot, readyState: video.readyState, currentTime: video.currentTime, duration: video.duration, seeking: video.seeking, paused: video.paused, error: video.error ? `${video.error.code} ${video.error.message}` : null }));
  }

  dispose(): void {
    for (const { video, frame, url } of this.players.values()) {
      video.pause();
      frame.dispose();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
    this.players.clear();
  }
}
