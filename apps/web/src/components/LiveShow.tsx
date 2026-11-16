/**
 * The show as the audience sees it — the publisher's broadcast (every singer on the stage
 * background, the track and the vocals blended), played from the service's HLS playlist a few
 * seconds behind the stage. hls.js (loaded only here, only when a show is on) feeds MediaSource
 * on Chrome, Edge and Firefox; Safari plays the playlist natively. Browsers start sound only on a
 * tap, so the picture waits behind a "Watch the show" button until the viewer presses it.
 */
import type { LiveStatus } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, serviceUrl } from '../lib/api.ts';
import { IcPlay } from './icons.tsx';

const POLL_MS = 4000;
/** "Tuning in" for this long with nothing playing: the viewer is told what the player sees and offered another go. */
const TUNING_PATIENCE_MS = 8000;
/** The watch page's player settings: one-second segments, three behind the live edge (≈3 s of buffer), never more than eight behind. */
export const HLS_CONFIG = { liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, maxBufferLength: 10, enableWorker: true, lowLatencyMode: false, backBufferLength: 20 };

export interface PlayerHandle {
  destroy(): void;
}

/**
 * The playlist on a <video>: hls.js where MediaSource is the way (Chrome, Edge, Firefox), the
 * browser's own HLS on Safari. `onError` gets the player's own words for anything fatal; the
 * handle tears it down.
 */
export async function attachPlaylist(video: HTMLVideoElement, url: string, onError: (message: string) => void): Promise<PlayerHandle | null> {
  const { default: Hls } = await import('hls.js');
  if (Hls.isSupported()) {
    const hls = new Hls(HLS_CONFIG);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else onError(`The show could not be played in this browser (${data.details})`);
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => undefined));
    return hls;
  }
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    await video.play().catch(() => undefined);
    return { destroy: () => video.removeAttribute('src') };
  }
  onError('This browser cannot play the show');
  return null;
}

/** What a stuck player can say for itself (the "still tuning in" line). */
export function playerState(video: HTMLVideoElement): string {
  const b = video.buffered;
  const ranges: string[] = [];
  for (let i = 0; i < b.length; i++) ranges.push(`${b.start(i).toFixed(1)}–${b.end(i).toFixed(1)}`);
  return `at ${video.currentTime.toFixed(1)} s, ready ${video.readyState}/4, buffered ${ranges.join(' ') || 'nothing'}${video.paused ? ', paused' : ''}${video.error ? `, error ${video.error.code}` : ''}`;
}

export type StreamCheckState = 'off' | 'checking' | 'ok' | 'failed';

/**
 * The publisher's own check of the stream: for half a minute after the first segments the show
 * view plays its own playlist from the service on a hidden, muted video — exactly what the watch
 * page and the platforms get — and says whether it plays (and how far behind the newest segment it
 * runs) or what the player saw when it did not. Then it stops, so the broadcasting device is not
 * decoding its own stream for the whole show.
 */
export function useStreamCheck(playlistPath: string | null, enabled: boolean): { state: StreamCheckState; note: string } {
  const [result, setResult] = useState<{ state: StreamCheckState; note: string }>({ state: 'off', note: '' });
  useEffect(() => {
    if (!enabled || !playlistPath || typeof document === 'undefined') {
      setResult({ state: 'off', note: '' }); // the next broadcast gets its own check
      return;
    }
    if (result.state === 'ok' || result.state === 'failed') return; // one check per broadcast
    setResult({ state: 'checking', note: 'playing the stream back…' });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(video);
    let handle: PlayerHandle | null = null;
    let playedFrom: number | null = null;
    let fatal: string | null = null;
    let done = false;
    const started = Date.now();
    const finish = (state: StreamCheckState, note: string) => {
      if (done) return;
      done = true;
      setResult({ state, note });
      handle?.destroy();
      video.remove();
    };
    void attachPlaylist(video, serviceUrl(playlistPath), (m) => (fatal = m)).then((h) => {
      if (done) h?.destroy();
      else handle = h;
    });
    const tick = setInterval(() => {
      if (!video.paused && video.currentTime > 0) playedFrom ??= video.currentTime;
      const played = playedFrom === null ? 0 : video.currentTime - playedFrom;
      if (played >= 5) return finish('ok', `plays (${played.toFixed(0)} s checked)`);
      if (fatal) return finish('failed', fatal);
      if (Date.now() - started > 30_000) finish('failed', `not playing after 30 s — ${playerState(video)}`);
    }, 500);
    return () => {
      clearInterval(tick);
      if (!done) {
        done = true;
        handle?.destroy();
        video.remove();
      }
    };
  }, [enabled, playlistPath]);
  return result;
}

export interface LiveShowState {
  live: boolean;
  /** The stream carries its own sound. */
  audio: boolean;
  /** The video element is playing it. */
  playing: boolean;
}

export function useLiveStatus(meetId: string): LiveStatus | null {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const r = await api.get('GET /watch/:id/live', `/watch/${encodeURIComponent(meetId)}/live`);
        if (!stopped) setStatus(r);
      } catch {
        if (!stopped) setStatus((s) => (s ? { ...s, live: false, playlistPath: null } : { live: false, jobId: null, segments: 0, lastSegmentAt: null, playlistPath: null, audio: false }));
      }
    };
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [meetId]);
  return status;
}

export function LiveShow(props: { meetId: string; status: LiveStatus | null; onState?: (s: LiveShowState) => void; children?: preact.ComponentChildren }) {
  const { status } = props;
  const live = Boolean(status?.live && status.playlistPath);
  const [wanted, setWanted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by "Try again": the player is torn down and attached afresh. */
  const [attempt, setAttempt] = useState(0);
  /** After TUNING_PATIENCE_MS of tuning in: what the player sees, for the viewer. */
  const [stuck, setStuck] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<PlayerHandle | null>(null);

  // Attach the playlist once the viewer asked for the show and it is on; tear down when it ends.
  useEffect(() => {
    const video = videoRef.current;
    if (!live || !wanted || !video || !status?.playlistPath) {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      setPlaying(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setStuck(null);
    const url = serviceUrl(status.playlistPath);
    void attachPlaylist(video, url, setError)
      .then((h) => {
        if (cancelled) h?.destroy();
        else hlsRef.current = h;
      })
      .catch((e) => setError(`The player could not load (${e instanceof Error ? e.message : String(e)})`));
    const onPlaying = () => {
      setPlaying(true);
      setStuck(null);
    };
    const onPause = () => setPlaying(false);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    // Tuning in for too long: say what the player sees, with a Try again (the stream itself keeps going; a fresh player picks it up at the live edge).
    const patience = setInterval(() => {
      if (video.paused || video.currentTime === 0 || video.readyState < 3) setStuck(playerState(video));
    }, TUNING_PATIENCE_MS);
    return () => {
      cancelled = true;
      clearInterval(patience);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onPause);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      setPlaying(false);
    };
  }, [live, wanted, status?.playlistPath, attempt]);

  useEffect(() => {
    props.onState?.({ live, audio: Boolean(status?.audio), playing });
  }, [live, status?.audio, playing]);

  return (
    <div class="liveshow" data-live={live ? '1' : '0'} data-live-playing={playing ? '1' : '0'} data-live-audio={status?.audio ? '1' : '0'}>
      {live && <video ref={videoRef} playsInline autoPlay={wanted} style={{ width: '100%', height: '100%', objectFit: 'contain', position: 'absolute', inset: 0, display: wanted ? 'block' : 'none' }} />}
      {live && !wanted && (
        <div class="watch-center">
          <button class="btn big primary" data-live-watch onClick={() => setWanted(true)}>
            <IcPlay /> Watch the show
          </button>
          <p class="muted small">The show is on — the singers on stage{status?.audio ? ', the track and their voices' : ''}, a few seconds behind.</p>
        </div>
      )}
      {live && wanted && !playing && !error && (
        <div class="watch-center small" data-tuning={stuck ? 'stuck' : 'in'}>
          <div class="muted">{stuck ? 'Still tuning in…' : 'Tuning in to the show…'}</div>
          {stuck && (
            <>
              <div class="faint" style="font-size:11px">{stuck}</div>
              <button class="btn sm" style="pointer-events:auto" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div class="watch-center danger small">
          {error}
          <button class="btn sm" style="pointer-events:auto;margin-top:8px" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      )}
      {!live && props.children}
    </div>
  );
}
