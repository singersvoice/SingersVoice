import type { TrackPackageV2 } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { trackVideoUrl } from '../lib/trackVideo.ts';
import { ms, type Clocked } from './clocked.ts';
import { Spinner } from './ui.tsx';

/**
 * The karaoke video of a YouTube song track, where the lyrics would be: muted, following the track —
 * the sound the singers hear and sing to is the track's own backing layer in the audio engine, on the
 * shared clock of a meet, and the picture is kept on it: steered onto the song's clock by its playback
 * rate (a touch faster or slower, never more than `STEER_MAX` of the tempo — a video element runs on
 * a clock of its own and drifts from the audio's; it used to be jumped back every time it had drifted a
 * fifth of a second, a stutter in the words every few seconds on a slow device), and jumped only when
 * it is far off (a seek, a pause, the first frame: past `JUMP_S`); play and pause with the song; the
 * tempo as its base rate. The video comes in whole from Drive (lib/trackVideo.ts); until it does, and
 * if it cannot, the song still runs — the words are then only on the sound.
 */
/** The picture may run this much faster or slower than the tempo to get back onto the song's clock. */
const STEER_MAX = 0.04;
/** A picture this far off the song's clock (s) is jumped, not steered. */
const JUMP_S = 0.5;
/** How long the steering takes to bring an offset back (s): the rate correction is the offset over this. */
const STEER_OVER_S = 2;
export function KaraokeVideo(props: { track: Pick<TrackPackageV2, 'trackId' | 'video' | 'title'>; catalogTrackId?: string | null; tMs: Clocked; playing: boolean; rate?: number; countdown: number | null }) {
  const tMs = ms(props.tMs);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const fileId = props.track.video?.fileId ?? '';

  useEffect(() => {
    setUrl(null);
    setError(null);
    const p = trackVideoUrl(props.track, props.catalogTrackId);
    if (!p) return;
    let gone = false;
    p.then((u) => !gone && setUrl(u)).catch((e) => !gone && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
    };
  }, [fileId]);

  // Play and pause with the song.
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    v.muted = true;
    if (props.playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [url, props.playing]);

  // On the song's clock, every frame: steered by its rate while it is near (never a jump the eye can see), jumped when
  // it is far off (a seek, a pause, the first frame); paused, it is set to the song's position.
  useEffect(() => {
    const v = ref.current;
    if (!v || !url || v.readyState < 1) return;
    const want = Math.max(0, tMs) / 1000;
    const base = props.rate && props.rate > 0 ? props.rate : 1;
    const off = v.currentTime - want; // > 0: the picture is ahead of the song
    if (!props.playing) {
      if (Math.abs(off) > 0.04) v.currentTime = want;
      if (Math.abs(v.playbackRate - base) > 0.002) v.playbackRate = base;
      return;
    }
    if (Math.abs(off) > JUMP_S) {
      v.currentTime = want;
      if (Math.abs(v.playbackRate - base) > 0.002) v.playbackRate = base;
      return;
    }
    const rate = base * (1 + Math.max(-STEER_MAX, Math.min(STEER_MAX, -off / STEER_OVER_S)));
    if (Math.abs(v.playbackRate - rate) > 0.002) v.playbackRate = rate;
  }, [url, tMs, props.playing, props.rate]);

  return (
    <section class="lyrics karaoke" aria-live="off" data-karaoke={url ? 'ready' : error ? 'error' : 'loading'}>
      {url && <video ref={ref} src={url} muted playsInline preload="auto" disablePictureInPicture controls={false} aria-label={`Song video: ${props.track.title}`} />}
      {!url && !error && (
        <div class="muted small row" style="justify-content:center">
          <Spinner /> loading the song's video…
        </div>
      )}
      {error && (
        <div class="stack" style="gap:4px">
          <div class="lyric upcoming">{props.track.title}</div>
          <div class="muted small">{error}</div>
        </div>
      )}
      {props.countdown !== null && props.countdown > 0 && <div class="countdown over">{props.countdown}</div>}
    </section>
  );
}
