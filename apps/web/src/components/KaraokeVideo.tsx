import type { TrackPackageV2 } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { trackVideoUrl } from '../lib/trackVideo.ts';
import { ms, type Clocked } from './clocked.ts';
import { Spinner } from './ui.tsx';

/**
 * The karaoke video of a YouTube song track, where the lyrics would be: muted, following the track —
 * the sound the singers hear and sing to is the track's own backing layer in the audio engine, on the
 * shared clock of a meet, and the picture is kept on it (a jump whenever it drifts past a fifth of a
 * second; play and pause with the song; the tempo as a playback rate). The video comes in whole from
 * Drive (lib/trackVideo.ts); until it does, and if it cannot, the song still runs — the words are then
 * only on the sound.
 */
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

  // The tempo.
  useEffect(() => {
    const v = ref.current;
    if (v && props.rate && Math.abs(v.playbackRate - props.rate) > 0.005) v.playbackRate = props.rate;
  }, [url, props.rate]);

  // On the song's clock: a jump whenever the picture is off it (a seek, a pause, drift, the first frame).
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    const want = Math.max(0, tMs) / 1000;
    const slack = props.playing ? 0.2 : 0.04;
    if (v.readyState >= 1 && Math.abs(v.currentTime - want) > slack) v.currentTime = want;
  }, [url, tMs, props.playing]);

  return (
    <section class="lyrics karaoke" aria-live="off" data-karaoke={url ? 'ready' : error ? 'error' : 'loading'}>
      {url && <video ref={ref} src={url} muted playsInline preload="auto" disablePictureInPicture controls={false} aria-label={`Karaoke video: ${props.track.title}`} />}
      {!url && !error && (
        <div class="muted small row" style="justify-content:center">
          <Spinner /> loading the karaoke video…
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
