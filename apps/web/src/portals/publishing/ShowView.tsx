/**
 * Publishing mode — the show view (/publishing/show/:id). This is the picture that goes out to
 * YouTube / Facebook / Instagram / Twitch and the in-house portal: the performers, cut out of their
 * cameras and standing huge on one shared stage, no lyrics, no controls in the frame — a televised
 * stage show. The publisher joins the meet as its own kind of participant ("publisher": never on
 * stage, never counted as audience), receives every performer's video over the same mesh the singers
 * use (receive-only), and runs the broadcast from a bar that hides itself while the show plays.
 * Nothing here touches the singers' rooms: they keep their lyrics and controls; the show view only
 * listens to the meet (stage, transport) and pulls video. The picture itself is `showStage.tsx`,
 * shared with the Preview tab's monitor tiles.
 */
import { DESTINATIONS, formatMs, playbackPositionMs, type Destination, type DestinationKind, type Meet, type Participant, type PublishJob } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { IcMusic, IcPlay, IcStop, IcUsers, IcX, IcZoom } from '../../components/icons.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Spinner } from '../../components/ui.tsx';
import { api, ApiError, clock, controlConfigured, refreshAccount, serverNow } from '../../lib/api.ts';
import { go, href } from '../../lib/nav.ts';
import { keepAwake } from '../../lib/platform.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { privileged } from '../../state/session.ts';
import { MeetSession } from '../meets/meetSession.ts';
import { loadMeetTrack } from '../meets/trackSource.ts';
import { ShowPicture, useCountdown, useShowFeed } from './showStage.tsx';

const IDLE_MS = 3000;
const JOB_POLL_MS = 8000;
const SYNC_TOLERANCE_MS = 300;

export const activeJob = (j: PublishJob) => j.state === 'requested' || j.state === 'starting' || j.state === 'live';

export function ShowView(props: { id: string }) {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    void refreshAccount().finally(() => setChecked(true));
  }, []);
  if (!controlConfigured.value)
    return (
      <Page title="Publishing">
        <div class="callout warn">Publishing needs the SingersVoice service (VITE_CONTROL_URL).</div>
      </Page>
    );
  if (!privileged.value)
    return (
      <Page title="Publishing">
        {!checked ? (
          <div class="row">
            <Spinner /> Checking your account…
          </div>
        ) : (
          <Empty title="Publishing mode is for privileged users" body="The show view streams a meet to YouTube, Facebook, Instagram, Twitch and the in-house portal. Ask the SingersVoice admin to enable Publishing for your Google account.">
            <a class="btn" href={href('/meets')}>
              Back to Live Meets
            </a>
          </Empty>
        )}
      </Page>
    );
  return <Show id={props.id} />;
}

function Show(props: { id: string }) {
  const session = useMemo(() => new MeetSession(props.id, 'publisher'), [props.id]);
  const snap = session.snapshot.value;
  const you = session.you.value;
  const meet = snap?.meet ?? null;

  useEffect(() => {
    void session.join('publisher').catch(() => undefined);
    void keepAwake(true);
    return () => {
      session.stop();
      void keepAwake(false);
    };
  }, [props.id]);

  if (session.error.value && !meet)
    return (
      <div class="show" data-state="error">
        <div class="show-center">
          <div class="callout danger">{session.error.value}</div>
          <a class="btn" href={href('/publishing')}>
            Back to Publishing
          </a>
        </div>
      </div>
    );
  if (!meet || !you)
    return (
      <div class="show" data-state="joining">
        <div class="show-center muted">
          <Spinner /> Joining the show…
        </div>
      </div>
    );
  return <ShowStage session={session} meet={meet} you={you} />;
}

function ShowStage(props: { session: MeetSession; meet: Meet; you: Participant }) {
  const { session, meet } = props;
  const feed = useShowFeed(session, meet, props.you);
  const countdown = useCountdown(meet);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [job, setJob] = useState<PublishJob | null>(null);
  const [dests, setDests] = useState<Destination[] | null>(null);
  const [picked, setPicked] = useState<DestinationKind[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [music, setMusic] = useState(false);
  const [trackUrl, setTrackUrl] = useState<string | null>(null);
  const [trackNote, setTrackNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = meet.state === 'live';
  const over = meet.state === 'ended' || meet.state === 'expired';
  const pb = meet.playback ?? { state: 'idle' as const, offsetMs: 0, pausedAtMs: 0, pauseAtEpochMs: null, epoch: 0 };

  useEffect(() => {
    (window as unknown as { __svMesh?: unknown; __svShow?: unknown }).__svMesh = feed.mesh; // support / e2e hooks
    (window as unknown as { __svShow?: unknown }).__svShow = feed.compositor;
  }, [feed.mesh]);

  // ---- the broadcast: destinations + the publish job for this meet ----
  useEffect(() => {
    void api
      .get('GET /publishing/destinations', '/publishing/destinations')
      .then((r) => {
        setDests(r.destinations);
        const wanted = new URLSearchParams(location.search).get('dest')?.split(',').filter(Boolean) as DestinationKind[] | undefined;
        const enabled = r.destinations.filter((d) => d.enabled).map((d) => d.kind);
        setPicked((p) => p ?? (wanted?.length ? wanted.filter((k) => enabled.includes(k)) : enabled));
      })
      .catch((e) => {
        setDests([]);
        toast(errorText(e), 'error');
      });
  }, []);
  const loadJob = async () => {
    try {
      const r = await api.get('GET /publishing/jobs', '/publishing/jobs');
      const wanted = new URLSearchParams(location.search).get('job');
      const mine = r.jobs.filter((j) => j.meetId === meet.meetId);
      setJob(mine.find((j) => j.jobId === wanted) ?? mine.find(activeJob) ?? mine[0] ?? null);
    } catch {
      /* offline: shown as "not live" */
    }
  };
  useEffect(() => {
    void loadJob();
  }, [meet.meetId]);
  useEffect(() => {
    if (!job || !activeJob(job)) return;
    const t = setInterval(() => void loadJob(), JOB_POLL_MS);
    return () => clearInterval(t);
  }, [job?.jobId, job?.state]);

  const goLive = async () => {
    if (!picked?.length) return toast('Pick at least one destination', 'warn');
    setBusy(true);
    try {
      const r = await api.post('POST /publishing/jobs', '/publishing/jobs', { meetId: meet.meetId, destinations: picked, title: meet.title, description: meet.trackTitle ? `${meet.trackTitle} — live on SingersVoice` : '' });
      setJob(r.job);
      toast('Publishing requested', 'ok');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_publishing') await loadJob();
      else toast(e instanceof ApiError ? e.message : errorText(e), 'error', 8000);
    } finally {
      setBusy(false);
    }
  };
  const stopLive = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const r = await api.post('POST /publishing/jobs/:id/stop', `/publishing/jobs/${encodeURIComponent(job.jobId)}/stop`);
      setJob(r.job);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  // ---- the backing track, in sync with the meet's transport (what the show's audience hears) ----
  const trackKey = `${meet.trackId ?? ''}|${meet.catalogTrackId ?? ''}`;
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setTrackUrl(null);
    setTrackNote(null);
    if (!meet.trackId && !meet.catalogTrackId) return;
    void loadMeetTrack(meet).then((t) => {
      if (cancelled) return;
      if (t.loaded) {
        url = URL.createObjectURL(t.loaded.audio);
        setTrackUrl(url);
      } else setTrackNote(t.reason);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [trackKey]);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!music || !trackUrl) {
      a.pause();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      clearTimeout(timer);
      const now = serverNow();
      const pos = playbackPositionMs(meet, now);
      if (pos === null) {
        a.pause();
        return;
      }
      const frozen = pb.state === 'paused' || (pb.pauseAtEpochMs !== null && now >= pb.pauseAtEpochMs);
      if (frozen) {
        a.pause();
        if (Math.abs(a.currentTime * 1000 - pos) > SYNC_TOLERANCE_MS) a.currentTime = pos / 1000;
        return;
      }
      const wait = (meet.kickstartEpochMs ?? now) - now;
      if (wait > 0) {
        a.pause();
        a.currentTime = pb.offsetMs / 1000;
        timer = setTimeout(apply, wait);
        return;
      }
      if (Math.abs(a.currentTime * 1000 - pos) > SYNC_TOLERANCE_MS) a.currentTime = pos / 1000;
      if (a.paused) void a.play().catch(() => undefined);
      if (pb.pauseAtEpochMs !== null) timer = setTimeout(apply, Math.max(0, pb.pauseAtEpochMs - now) + 20);
    };
    apply();
    const drift = setInterval(apply, 4000);
    return () => {
      clearTimeout(timer);
      clearInterval(drift);
    };
  }, [music, trackUrl, pb.state, pb.epoch, pb.pauseAtEpochMs, meet.kickstartEpochMs, clock.value.offsetMs]);

  // ---- chrome hides itself while the show plays; any movement brings it back ----
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  };
  useEffect(() => {
    wake();
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'f' || e.key === 'F') void toggleFullscreen();
      else if (e.key === 'm' || e.key === 'M') setMusic((m) => !m);
      wake();
    };
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(idleTimer.current);
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* not allowed here (iPhone): the view already fills the window */
    }
  };
  const exit = () => {
    void session.leave();
    go('/publishing');
  };

  const onAir = job?.state === 'live';
  const requested = job !== null && activeJob(job) && !onAir;
  const enabledDests = (dests ?? []).filter((d) => d.enabled);
  const canEditDests = !job || !activeJob(job);
  const hideChrome = idle && live && countdown === null;
  const position = live ? playbackPositionMs(meet, serverNow()) : null;

  return (
    <div class="show" data-state={meet.state} data-performers={feed.compositor.tiles.length} data-linked={feed.linked} data-idle={hideChrome ? '1' : '0'} onPointerMove={wake} onPointerDown={wake}>
      <ShowPicture meet={meet} compositor={feed.compositor} countdown={countdown}>
        <button class="btn" onClick={exit}>
          Back to Publishing
        </button>
      </ShowPicture>
      <audio ref={audioRef} src={trackUrl ?? undefined} preload="auto" />

      <header class="show-top">
        <div class="show-title">
          <h1>{meet.title}</h1>
          <div class="sub">
            {meet.trackTitle || 'no track'} · hosted by {meet.hostName}
            {position !== null && <span class="mono"> · {formatMs(position)}</span>}
          </div>
        </div>
        <div class="show-badges">
          {onAir && <span class="onair">LIVE</span>}
          {requested && <span class="chip warn">publishing requested</span>}
          <span class="chip">
            <IcUsers size={14} /> {feed.onStage} on stage · {feed.linked}/{feed.onStage} video
          </span>
        </div>
      </header>

      <footer class="showbar" aria-label="Broadcast controls">
        <div class="dests" role="group" aria-label="Destinations">
          {dests === null ? (
            <Spinner />
          ) : enabledDests.length ? (
            enabledDests.map((d) => {
              const on = picked?.includes(d.kind) ?? false;
              return (
                <button key={d.kind} type="button" class={`dest ${on ? 'on' : ''}`} aria-pressed={on} disabled={!canEditDests} onClick={() => setPicked((p) => (on ? (p ?? []).filter((k) => k !== d.kind) : [...(p ?? []), d.kind]))} title={DESTINATIONS.find((x) => x.kind === d.kind)?.ingestHint}>
                  {d.label}
                </button>
              );
            })
          ) : (
            <a class="chip" href={href('/publishing?tab=destinations')}>
              No destinations enabled — set up YouTube, Facebook, Instagram or Twitch
            </a>
          )}
        </div>
        <div class="actions">
          {!job || !activeJob(job) ? (
            <button class="btn big primary" disabled={busy || over || !picked?.length} onClick={() => void goLive()}>
              {busy ? <Spinner /> : <IcPlay />} Go live
            </button>
          ) : (
            <button class="btn big danger" disabled={busy} onClick={() => void stopLive()}>
              {busy ? <Spinner /> : <IcStop />} Stop publishing
            </button>
          )}
          <button class={`btn icon ${music ? 'on' : ''}`} aria-label={music ? 'Mute the backing track' : 'Play the backing track here'} aria-pressed={music} disabled={!trackUrl} title={trackNote ?? (trackUrl ? 'Backing track, in sync with the meet (M)' : 'Loading the track…')} onClick={() => setMusic((m) => !m)}>
            <IcMusic />
          </button>
          {typeof document !== 'undefined' && document.fullscreenEnabled && (
            <button class={`btn icon ${fullscreen ? 'on' : ''}`} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title="Full screen (F)" onClick={() => void toggleFullscreen()}>
              <IcZoom />
            </button>
          )}
          <button class="btn icon" aria-label="Leave the show view" title="Back to Publishing" onClick={exit}>
            <IcX />
          </button>
        </div>
        {job && (
          <div class="jobline small">
            <b>{job.state}</b> · {job.destinations.join(' · ')}
            {job.watchUrl && (
              <>
                {' '}
                ·{' '}
                <a href={href(job.watchUrl)} target="_blank" rel="noopener">
                  watch page
                </a>
              </>
            )}
            {job.error && <span class="danger"> · {job.error}</span>}
          </div>
        )}
      </footer>
    </div>
  );
}
