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
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<{ destroy(): void } | null>(null);

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
    const url = serviceUrl(status.playlistPath);
    void (async () => {
      try {
        const { default: Hls } = await import('hls.js');
        if (cancelled) return;
        if (Hls.isSupported()) {
          const hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
          hlsRef.current = hls;
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
              else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
              else setError('The show could not be played in this browser');
            }
          });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => undefined));
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          await video.play().catch(() => undefined);
        } else setError('This browser cannot play the show');
      } catch (e) {
        setError(`The player could not load (${e instanceof Error ? e.message : String(e)})`);
      }
    })();
    const onPlaying = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    return () => {
      cancelled = true;
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onPause);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      setPlaying(false);
    };
  }, [live, wanted, status?.playlistPath]);

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
      {live && wanted && !playing && !error && <div class="watch-center muted small">Tuning in to the show…</div>}
      {error && <div class="watch-center danger small">{error}</div>}
      {!live && props.children}
    </div>
  );
}
