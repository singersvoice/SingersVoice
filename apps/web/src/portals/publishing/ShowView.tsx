/**
 * Publishing mode — the show view (/publishing/show/:id). This is the picture that goes out to
 * YouTube and the in-house portal: the performers, cut out of their cameras and standing huge on
 * one shared stage, no lyrics, no controls in the frame — a televised stage show — with the backing
 * track and every singer's vocal (after their own FX) blended as the sound. The publisher joins the
 * meet as its own kind of participant ("publisher": never on stage, never counted as audience),
 * receives every performer's video and vocal over the same mesh the singers use (receive-only), and
 * runs the broadcast from a bar that hides itself while the show plays. **Go live** makes this
 * browser the encoder (`broadcast.ts`): H.264 + AAC, one-second segments, delivered to the service,
 * which keeps them for the watch page and forwards them to YouTube's HLS ingestion. Nothing here
 * touches the singers' rooms: they keep their lyrics and controls; the show view only listens to
 * the meet (stage, transport) and pulls media. The picture itself is `showStage.tsx`, shared with
 * the Preview tab's monitor tiles.
 */
import { DESTINATIONS, fedDestinations, formatMs, playbackPositionMs, type Destination, type DestinationKind, type Meet, type Participant, type PerformanceSinger, type PublishJob } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { IcMic, IcMusic, IcPlay, IcStop, IcUsers, IcVideo, IcX, IcZoom } from '../../components/icons.tsx';
import { BrandWatermark, Page } from '../../components/Shell.tsx';
import { Empty, Spinner } from '../../components/ui.tsx';
import { api, ApiError, clock, controlConfigured, refreshAccount, serverNow } from '../../lib/api.ts';
import { go, href } from '../../lib/nav.ts';
import { keepAwake } from '../../lib/platform.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { canPublish, needsReconnect, profile } from '../../state/session.ts';
import { MeetSession } from '../meets/meetSession.ts';
import { loadMeetTrack } from '../meets/trackSource.ts';
import { backgroundById, backgroundSrc, backgrounds, loadBackgrounds } from '../../components/BackgroundPicker.tsx';
import { MixBalance } from '../../components/MixBalance.tsx';
import { appSettings } from '../../state/settings.ts';
import { blobLoudness } from '../../audio/loudness.ts';
import { VOCAL_LAG_MS } from '../../video/showRecorder.ts';
import { Broadcast } from './broadcast.ts';
import { LiveLinks } from './LiveLinks.tsx';
import { ShowPicture, useCountdown, useShowFeed, Vocals } from './showStage.tsx';

const IDLE_MS = 3000;
const JOB_POLL_MS = 8000;
const SYNC_TOLERANCE_MS = 300;

export const activeJob = (j: PublishJob) => j.state === 'requested' || j.state === 'starting' || j.state === 'live';
const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.round(bytes / 1024)} KB`);

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
  if (!canPublish.value)
    return (
      <Page title="Publishing">
        {!checked ? (
          <div class="row">
            <Spinner /> Checking your account…
          </div>
        ) : (
          <Empty title="Publishing mode is part of the Publisher plan" body="The show view streams a meet to YouTube and the in-house watch page. Subscribe to the Publisher plan to open it.">
            <a class="btn primary" href={href('/plans')}>
              See the Publisher plan
            </a>
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
  /** The RTMP relay is deployed: Facebook, Instagram and Twitch go out live, YouTube at low latency. */
  const [relayOn, setRelayOn] = useState(false);
  const [picked, setPicked] = useState<DestinationKind[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [music, setMusic] = useState(false);
  /** The broadcast sound: every singer's vocal (after their FX) — on by default; the backing track joins with the music toggle. */
  const [vocalsOn, setVocalsOn] = useState(true);
  const [trackUrl, setTrackUrl] = useState<string | null>(null);
  const [trackNote, setTrackNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // The broadcast: sound bus + picture + encoder + sender, one per show view.
  const broadcast = useMemo(() => new Broadcast(), []);
  const sending = broadcast.status.value;
  const support = broadcast.support.value;
  const broadcasting = sending !== null && (sending.state === 'sending' || sending.state === 'live');
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = meet.state === 'live';
  const over = meet.state === 'ended' || meet.state === 'expired';
  const pb = meet.playback ?? { state: 'idle' as const, offsetMs: 0, pausedAtMs: 0, pauseAtEpochMs: null, epoch: 0 };

  useEffect(() => {
    (window as unknown as { __svMesh?: unknown; __svShow?: unknown }).__svMesh = feed.mesh; // support / e2e hooks
    (window as unknown as { __svShow?: unknown }).__svShow = feed.compositor;
    (window as unknown as { __svBroadcast?: unknown }).__svBroadcast = broadcast;
  }, [feed.mesh]);
  // The bus hears what the picture shows: the track element and every vocal; the monitor switches are the publisher's own.
  useEffect(() => {
    broadcast.bus.setBacking(audioRef.current);
  }, [trackUrl]);
  useEffect(() => {
    broadcast.bus.setVocals(feed.vocals);
  }, [feed.vocals]);
  useEffect(() => {
    broadcast.bus.setMonitor({ vocals: vocalsOn, music });
  }, [vocalsOn, music]);
  const app = appSettings.value;
  useEffect(() => broadcast.setBalance(app.trackDb, app.vocalDb), [app.trackDb, app.vocalDb]);
  // The publisher who is also singing on stage (same account): their own vocal stays out of this monitor —
  // they hear themselves on stage; hearing it again here, a few hundred ms late, is the "echo" nobody wants.
  const ownOnStage = (session.snapshot.value?.participants ?? []).filter((p) => p.userId === props.you.userId && p.participantId !== props.you.participantId && meet.stage.some((s) => s.participantId === p.participantId)).map((p) => p.participantId);
  const ownKey = ownOnStage.join(',');
  useEffect(() => broadcast.bus.setMonitorMuted(ownOnStage), [ownKey]);
  // The broadcast's own canvas draws the same background and performers the picture shows.
  const bgItems = backgrounds.value;
  useEffect(() => {
    void loadBackgrounds();
    const item = backgroundById(meet.backgroundId);
    broadcast.setBackground(item ?? null, backgroundSrc(item));
  }, [meet.backgroundId, bgItems.length]);
  useEffect(() => {
    broadcast.setPerformers(feed.performers);
  }, [feed.performers]);
  useEffect(
    () => () => {
      broadcast.dispose();
    },
    [],
  );

  // ---- the broadcast: destinations + the publish job for this meet ----
  useEffect(() => {
    void api
      .get('GET /publishing/destinations', '/publishing/destinations')
      .then((r) => {
        setDests(r.destinations);
        setRelayOn(Boolean(r.relay));
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

  // ---- the footage: the whole broadcast into this publisher's Drive, from Go live to Stop publishing ----
  const film = broadcast.film.state.value;
  /** Everyone who stood on stage while the footage ran (its manifest names them). */
  const filmSingers = useRef(new Map<number, PerformanceSinger>());
  const stageKey = meet.stage.map((s) => `${s.slot}:${s.participantId ?? ''}`).join('|');
  useEffect(() => {
    for (const s of meet.stage) if (s.participantId) filmSingers.current.set(s.slot, { slot: s.slot, displayName: s.displayName });
  }, [stageKey]);
  const filmSpec = () => {
    filmSingers.current = new Map(meet.stage.filter((s) => s.participantId).map((s) => [s.slot, { slot: s.slot, displayName: s.displayName }]));
    return { meetId: meet.meetId, title: meet.title, hostName: meet.hostName, singers: () => [...filmSingers.current.values()].sort((a, b) => a.slot - b.slot) };
  };
  /** The footage goes to this publisher's Drive (signed in with Google; a lapsed session has to reconnect first) — on the device itself in the developer preview. */
  const driveReady = !needsReconnect.value;
  const onDrive = profile.value?.mode === 'drive';

  /** This browser starts encoding and sending the show for the job: the watch page, YouTube, and every RTMP destination the relay carries. */
  const startSending = async (j: PublishJob) => {
    const viaRelay = relayOn || (j.live?.relay !== undefined && j.live.relay !== 'off'); // the service said so when it made the job
    if (!fedDestinations(j.destinations, viaRelay).length) return;
    const s = await broadcast.start(j, (m) => toast(`Broadcast stopped: ${m}`, 'error', 10000), driveReady ? filmSpec() : undefined);
    if (!s.ok) toast(s.reason, 'error', 12000);
    else if (s.reason) toast(s.reason, 'warn', 12000);
    if (s.ok && !driveReady) toast('The footage is not being saved: reconnect Drive first', 'warn', 8000);
    else if (s.ok && !onDrive) toast('The footage stays on this device — sign in with Google to keep it in your Drive', 'warn', 8000);
  };
  const goLive = async () => {
    if (!picked?.length) return toast('Pick at least one destination', 'warn');
    setBusy(true);
    try {
      await broadcast.bus.resume(); // inside the click: the browser lets the sound run
      const r = await api.post('POST /publishing/jobs', '/publishing/jobs', { meetId: meet.meetId, destinations: picked, title: meet.title, description: meet.trackTitle ? `${meet.trackTitle} — live on SingersVoice` : '' });
      setJob(r.job);
      await startSending(r.job);
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
    broadcast.stop();
    try {
      const r = await api.post('POST /publishing/jobs/:id/stop', `/publishing/jobs/${encodeURIComponent(job.jobId)}/stop`);
      setJob(r.job);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  // A job found running when the view opens (a reload): this browser picks the sending up again.
  useEffect(() => {
    if (job && activeJob(job) && !broadcast.running && job.live && !busy) void startSending(job);
  }, [job?.jobId]);
  // Leaving the show view ends the broadcast: nothing else is encoding it.
  const jobRef = useRef<PublishJob | null>(null);
  jobRef.current = job;
  useEffect(
    () => () => {
      const j = jobRef.current;
      broadcast.stop();
      if (j && activeJob(j)) void api.post('POST /publishing/jobs/:id/stop', `/publishing/jobs/${encodeURIComponent(j.jobId)}/stop`).catch(() => undefined);
    },
    [],
  );

  // ---- the backing track, in sync with the meet's transport (what the show's audience hears) ----
  const trackKey = `${meet.trackId ?? ''}|${meet.catalogTrackId ?? ''}`;
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setTrackUrl(null);
    setTrackNote(null);
    if (!meet.trackId && !meet.catalogTrackId) return;
    broadcast.bus.setBackingLoudness(null);
    void loadMeetTrack(meet).then((t) => {
      if (cancelled) return;
      if (t.loaded) {
        url = URL.createObjectURL(t.loaded.audio);
        setTrackUrl(url);
        // The track's loudness (measured once per device): the bus moves it to the mix target.
        void blobLoudness(broadcast.bus.ctx, t.loaded.audio, t.loaded.track.trackId).then((l) => {
          if (!cancelled) broadcast.bus.setBackingLoudness(l);
        });
      } else setTrackNote(t.reason);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [trackKey]);
  const needTrack = music || broadcasting;
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!needTrack || !trackUrl) {
      a.pause();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      clearTimeout(timer);
      const now = serverNow() - VOCAL_LAG_MS; // play the track where the singers' vocals are right now
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
  }, [needTrack, trackUrl, pb.state, pb.epoch, pb.pauseAtEpochMs, meet.kickstartEpochMs, clock.value.offsetMs]);

  // ---- chrome hides itself while the show plays; any movement brings it back ----
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
    void broadcast.bus.resume();
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
      <ShowPicture meet={meet} compositor={feed.compositor} countdown={countdown} mirror={broadcast.mirror.value}>
        <button class="btn" onClick={exit}>
          Back to Publishing
        </button>
      </ShowPicture>
      <audio ref={audioRef} src={trackUrl ?? undefined} preload="auto" crossOrigin="anonymous" />
      <Vocals vocals={feed.vocals} on={false} />

      <BrandWatermark />
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
          <span class="chip" data-vocals={Object.keys(feed.vocals).length}>
            <IcUsers size={14} /> {feed.onStage} on stage · {feed.linked}/{feed.onStage} video · {Object.keys(feed.vocals).length} vocal{Object.keys(feed.vocals).length === 1 ? '' : 's'}
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
          <button class={`btn icon ${vocalsOn ? 'on' : ''}`} aria-label={vocalsOn ? 'Mute the singers in your monitor' : 'Hear the singers in your monitor'} aria-pressed={vocalsOn} title={`Your monitor: the singers' vocals (${Object.keys(feed.vocals).length} arriving)${ownOnStage.length ? ' — your own voice is left out, you hear it on stage' : ''}. The broadcast always carries every voice.`} onClick={() => setVocalsOn((v) => !v)}>
            <IcMic />
          </button>
          <button class={`btn icon ${music ? 'on' : ''}`} aria-label={music ? 'Mute the backing track' : 'Play the backing track here'} aria-pressed={music} disabled={!trackUrl} title={trackNote ?? (trackUrl ? 'Backing track, in sync with the singers (M)' : 'Loading the track…')} onClick={() => setMusic((m) => !m)}>
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
        <div class="row between" style="gap:12px;flex-wrap:wrap">
          <MixBalance compact />
          <span class="small faint">{ownOnStage.length ? 'Your own voice stays out of this monitor (you hear it on stage); the broadcast carries it.' : 'The monitor buttons change what you hear here, never the broadcast.'}</span>
        </div>
        {job && (
          <div class="jobline small" data-live-state={sending?.state ?? ''} data-live-segments={sending?.segments ?? 0} data-live-youtube={sending?.youtube ?? ''} data-live-relay={sending?.relay ?? ''}>
            <b>{sending?.state === 'live' ? 'LIVE' : job.state}</b> · {job.destinations.join(' · ')}
            {sending && sending.state === 'live' && (
              <>
                {' '}
                · {formatMs(Date.now() - sending.startedAt)} · {sending.kbps} kbps · {sending.segments} segment{sending.segments === 1 ? '' : 's'}
                {!sending.audio && <span class="warn"> · video only (no AAC in this browser)</span>}
                {sending.relay !== 'off' ? (
                  <span class={sending.relay === 'ok' ? '' : sending.relay === 'starting' ? 'muted' : 'danger'} title="The RTMP relay: YouTube at ultra-low latency, Facebook, Instagram, Twitch">
                    {' '}
                    · relay: {sending.relay === 'ok' ? sending.relayNote || 'streaming' : sending.relay === 'starting' ? 'starting…' : sending.relayNote || 'error'}
                  </span>
                ) : (
                  sending.youtube !== 'off' && <span class={sending.youtube === 'ok' ? '' : sending.youtube === 'waiting' ? 'muted' : 'danger'}> · YouTube: {sending.youtubeNote || (sending.youtube === 'waiting' ? 'sending…' : sending.youtube)}</span>
                )}
              </>
            )}
            {sending?.state === 'sending' && <span class="muted"> · starting the encoder…</span>}
            {(film.recording || film.saved || film.note) && (
              <span class={`footage ${film.note ? 'warn' : ''}`} data-footage={film.recording ? 'recording' : film.saved ? 'saved' : 'off'} data-footage-bytes={film.bytes} title={film.recording ? 'The whole broadcast, as it goes out, into your Drive (Performances → Broadcast)' : film.saved ? 'The footage is in your Drive (Performances → Broadcast)' : film.note ?? ''}>
                {' '}
                · <IcVideo size={14} />{' '}
                {film.recording ? `footage to ${onDrive ? 'your Drive' : 'this device'} · ${formatMs(film.seconds * 1000)} · ${mb(film.stored || film.bytes)}` : film.saved ? `footage saved to ${onDrive ? 'your Drive' : 'this device'} · ${formatMs(film.saved.durationMs)}` : film.note}
              </span>
            )}
            {job.watchUrl && (
              <>
                {' '}
                ·{' '}
                <a href={href(job.watchUrl)} target="_blank" rel="noopener">
                  watch page
                </a>
              </>
            )}
            {(sending?.error ?? job.error) && <span class="danger"> · {sending?.error ?? job.error}</span>}
            {support && !support.ok && <span class="danger"> · {support.reason}</span>}
          </div>
        )}
        {job && activeJob(job) && <LiveLinks title={job.title || meet.title} destinations={job.destinations} dests={dests ?? []} watchPage={job.watchUrl} />}
      </footer>
    </div>
  );
}
