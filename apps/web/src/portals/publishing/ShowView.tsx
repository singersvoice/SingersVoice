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
import { IcHeadphones, IcMicOff, IcMusic, IcPlay, IcStop, IcUsers, IcVideo, IcX, IcZoom } from '../../components/icons.tsx';
import { BrandWatermark, Page } from '../../components/Shell.tsx';
import { Empty, Spinner } from '../../components/ui.tsx';
import { api, ApiError, clock, controlConfigured, refreshAccount, serverNow } from '../../lib/api.ts';
import { go, href } from '../../lib/nav.ts';
import { keepAwake } from '../../lib/platform.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { canPublish, needsReconnect, profile, publishingNote } from '../../state/session.ts';
import { MeetSession } from '../meets/meetSession.ts';
import { loadMeetTrack } from '../meets/trackSource.ts';
import { backgroundById, backgroundSrc, backgrounds, loadBackgrounds } from '../../components/BackgroundPicker.tsx';
import { MixBalance } from '../../components/MixBalance.tsx';
import { useStreamCheck } from '../../components/LiveShow.tsx';
import { appSettings } from '../../state/settings.ts';
import { blobLoudness } from '../../audio/loudness.ts';
import { VOCAL_LAG_MS } from '../../video/showRecorder.ts';
import { Broadcast } from './broadcast.ts';
import { LiveLinks } from './LiveLinks.tsx';
import { ShowPicture, useCountdown, useShowFeed, Vocals } from './showStage.tsx';
import { filmSound } from '../../video/meetRecorder.ts';
import { chapterCue } from '../../video/chapters.ts';
import { endBroadcast, ensureHlsStream, startBroadcast, youtubeStatus, youtubeToken, youtubeWord } from '../../lib/youtube.ts';

const IDLE_MS = 3000;
const JOB_POLL_MS = 8000;
/** How often YouTube's own word on the show (the broadcast's state, the stream coming in or not) is read while the app runs the broadcast. */
const YOUTUBE_POLL_MS = 15000;
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
          <Empty title="Publishing mode is for club owners" body={publishingNote.value || 'The show view streams a meet to YouTube and the in-house watch page — for club owners with an active subscription, and the SingersVoice admins.'}>
            <a class="btn primary" href={href('/club-owner')}>
              Become a club owner
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
  /**
   * The publisher's own monitor: silent by default — the show view is run beside the stage, often in the same room,
   * and a second copy of every voice a few hundred ms late is the echo nobody wants. The headset button turns the
   * singers on here; the music button adds the track. The broadcast carries every voice and the track regardless.
   */
  const [vocalsOn, setVocalsOn] = useState(false);
  const [trackUrl, setTrackUrl] = useState<string | null>(null);
  const [trackNote, setTrackNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // The broadcast: sound bus + picture + encoder + sender, one per show view.
  const broadcast = useMemo(() => new Broadcast(), []);
  const sending = broadcast.status.value;
  // The publisher's own check of the stream: half a minute after the first segments, the playlist played back here, hidden.
  const streamCheck = useStreamCheck(`/watch/${encodeURIComponent(meet.meetId)}/live.m3u8`, sending?.state === 'live' && sending.segments >= 4);
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
    return { meetId: meet.meetId, title: meet.title, hostName: meet.hostName, singers: () => [...filmSingers.current.values()].sort((a, b) => a.slot - b.slot), first: chapterCue(meet, serverNow()) };
  };
  // The footage is cut where the stage goes — a song's start, a pause, a stop, the next song — into chapters, each a file of its own (video/chapters.ts).
  useEffect(() => {
    broadcast.film.cue(chapterCue(meet, serverNow()));
  }, [pb.state, pb.epoch, pb.pauseAtEpochMs, meet.kickstartEpochMs, meet.trackTitle, meet.songCount]);
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
  // YouTube run by the app (Destinations → Connect YouTube): a broadcast of its own for this show, made at Go live.
  const ytAuto = dests?.find((d) => d.kind === 'youtube')?.auto === true;
  const [yt, setYt] = useState<{ text: string; ok: boolean } | null>(null);
  const goLive = async () => {
    if (!picked?.length) return toast('Pick at least one destination', 'warn');
    setBusy(true);
    try {
      await broadcast.bus.resume(); // inside the click: the browser lets the sound run
      const description = meet.trackTitle ? `${meet.trackTitle} — live on SingersVoice` : '';
      let links: Partial<Record<DestinationKind, string>> | undefined;
      let youtube: { broadcastId: string; streamId: string } | undefined;
      if (picked.includes('youtube') && ytAuto) {
        try {
          const token = await youtubeToken(profile.value?.email);
          const stream = await ensureHlsStream(token);
          const b = await startBroadcast(token, { title: meet.title, streamId: stream.streamId, privacy: app.youtubePrivacy, description: description || 'Live on SingersVoice' });
          links = { youtube: b.watchUrl };
          youtube = { broadcastId: b.broadcastId, streamId: stream.streamId };
          setYt({ text: 'YouTube: broadcast made · waiting for the stream', ok: true });
        } catch (e) {
          toast(`YouTube: ${errorText(e)} — going live to the saved stream key without a broadcast of its own`, 'warn', 14000);
        }
      }
      const r = await api.post('POST /publishing/jobs', '/publishing/jobs', { meetId: meet.meetId, destinations: picked, title: meet.title, description, ...(links ? { links } : {}), ...(youtube ? { youtube } : {}) });
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
    // The YouTube broadcast the app made is ended with the show (a viewer finds a finished video, not a stream that never ends).
    if (job.youtube) {
      try {
        await endBroadcast(await youtubeToken(profile.value?.email), job.youtube.broadcastId);
        setYt({ text: 'YouTube: the broadcast is over', ok: true });
      } catch (e) {
        toast(`YouTube: ${errorText(e)} — end the broadcast in YouTube Studio`, 'warn', 10000);
      }
    }
  };
  // YouTube's own word on the show while the app's broadcast runs: the broadcast's state and whether the stream is coming in.
  useEffect(() => {
    const y = job?.youtube;
    if (!y || !job || !activeJob(job)) return;
    let stopped = false;
    const read = async () => {
      try {
        const st = await youtubeStatus(await youtubeToken(profile.value?.email), y.broadcastId, y.streamId);
        if (!stopped) setYt(youtubeWord(st));
      } catch (e) {
        if (!stopped) setYt({ text: `YouTube: ${errorText(e)}`, ok: false });
      }
    };
    const first = setTimeout(() => void read(), 5000);
    const t = setInterval(() => void read(), YOUTUBE_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [job?.jobId, job?.youtube?.broadcastId, job?.state]);
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
          {feed.still.length > 0 && (
            <span class="chip warn" data-still={feed.still.length} title="Their picture arrives but nothing in it moves: their camera froze on their device (it restarts there by itself, or they tap Restart on their stage strip).">
              {feed.still.join(', ')}: picture not moving — camera frozen on their device
            </span>
          )}
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
          <button class={`btn icon ${vocalsOn ? 'on' : ''}`} aria-label={vocalsOn ? 'Stop hearing the singers here' : 'Hear the singers here'} aria-pressed={vocalsOn} title={`Your monitor: the singers' voices (${Object.keys(feed.vocals).length} arriving)${ownOnStage.length ? ' — your own voice is left out, you hear it on stage' : ''}. The broadcast always carries every voice.`} onClick={() => setVocalsOn((v) => !v)}>
            <IcHeadphones />
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
          <span class="chip" data-mic="off" title="The show view never opens your microphone: it only plays the stage to you and sends it out.">
            <IcMicOff size={14} /> Mic off
          </span>
          <span class="small faint" data-monitor={vocalsOn || music ? 'on' : 'silent'}>
            {!vocalsOn && !music ? 'Silent here by default — tap the headset to hear the singers, the note for the track. ' : ''}
            {ownOnStage.length ? 'Your own voice stays out of this monitor (you hear it on stage); the broadcast carries it.' : 'The headphone and music buttons change what you hear here, never the broadcast. No microphone is used here.'}
          </span>
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
                  sending.youtube !== 'off' && (
                    <span class={yt ? (yt.ok ? 'ok' : 'danger') : sending.youtube === 'ok' ? '' : sending.youtube === 'waiting' ? 'muted' : 'danger'} data-youtube-word={yt ? (yt.ok ? 'ok' : 'off') : ''}>
                      {' '}
                      · {yt ? yt.text : `YouTube: ${sending.youtubeNote || (sending.youtube === 'waiting' ? 'sending…' : sending.youtube)}`}
                    </span>
                  )
                )}
              </>
            )}
            {sending?.state === 'sending' && <span class="muted"> · starting the encoder…</span>}
            {streamCheck.state !== 'off' && (
              <span class={streamCheck.state === 'failed' ? 'danger' : streamCheck.state === 'ok' ? 'ok' : 'muted'} data-stream-check={streamCheck.state} title="The stream as the watch page and the platforms get it, played back here for half a minute">
                {' '}
                · stream check: {streamCheck.state === 'ok' ? '✓ ' : ''}
                {streamCheck.note}
              </span>
            )}
            {(film.recording || film.saved || film.note) && (
              <span class={`footage ${film.note ? 'warn' : ''}`} data-footage={film.recording ? 'recording' : film.saved ? 'saved' : 'off'} data-footage-bytes={film.bytes} data-footage-seconds={film.seconds} data-footage-chapter={film.chapter?.index ?? 0} data-footage-chapters={film.chapters} title={film.recording ? 'The whole broadcast, as it goes out, into your Drive (Performances → Broadcast)' : film.saved ? 'The footage is in your Drive (Performances → Broadcast)' : film.note ?? ''}>
                {' '}
                · <IcVideo size={14} />{' '}
                {film.recording ? `footage to ${onDrive ? 'your Drive' : 'this device'} · ${formatMs(film.seconds * 1000)} · ${mb(film.stored || film.bytes)} · ${filmSound(film)}${film.chapter ? ` · chapter ${film.chapter.index} ${film.chapter.title}` : ''}` : film.saved ? `footage saved to ${onDrive ? 'your Drive' : 'this device'} · ${film.chapters} chapter${film.chapters === 1 ? '' : 's'}` : film.note}
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
        {job && activeJob(job) && <LiveLinks title={job.title || meet.title} destinations={job.destinations} dests={dests ?? []} watchPage={job.watchUrl} links={job.links} />}
      </footer>
    </div>
  );
}
