/**
 * Meet room (/meet/:id): lobby with stage slots + chat, the clock-synced live stage for
 * performers (GMT kickstart), the audience view, and the ended/expired summary.
 * Every take on stage is a personal session: recorded locally, kept in the singer's own Drive.
 */
import { formatMs, MAX_PERFORMERS, SLOT_COLORS, type Meet, type Participant, type SingerSlot, type StageSlot } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getEngine, type AudioEngine } from '../../audio/engine.ts';
import { StageBackground } from '../../components/BackgroundPicker.tsx';
import { CameraTile } from '../../components/CameraTile.tsx';
import { PresetChips } from '../../components/FxPanel.tsx';
import { IcCamera, IcCameraOff, IcChat, IcHeadphones, IcMic, IcPlay, IcShare, IcStop, IcUsers } from '../../components/icons.tsx';
import { CueDeck, LyricsPanel } from '../../components/LyricsPanel.tsx';
import { Page } from '../../components/Shell.tsx';
import { Progress, Seg, Spinner } from '../../components/ui.tsx';
import { clock, controlConfigured, serverNow } from '../../lib/api.ts';
import { shareOrCopy } from '../../lib/download.ts';
import { href } from '../../lib/nav.ts';
import { isIOS, keepAwake } from '../../lib/platform.ts';
import type { TakeResult } from '../../lib/takes.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { privileged } from '../../state/session.ts';
import { appSettings, audioSettings, updateApp, updateAudio } from '../../state/settings.ts';
import { Camera, pickVideoMime, ZOOM_LEVELS } from '../../video/camera.ts';
import { Review } from '../studio/Sing.tsx';
import { MeetSession } from './meetSession.ts';
import { loadMeetTrack, type MeetTrack } from './trackSource.ts';

const LEAD_MS = 8000;

export function MeetRoom(props: { id: string }) {
  const session = useMemo(() => new MeetSession(props.id), [props.id]);
  const [track, setTrack] = useState<MeetTrack | null>(null);
  const [prepared, setPrepared] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const engineRef = useRef<AudioEngine | null>(null);
  const camera = useMemo(() => new Camera(), []);
  const [take, setTake] = useState<TakeResult | null>(null);
  const snap = session.snapshot.value;
  const you = session.you.value;
  const meet = snap?.meet ?? null;

  useEffect(() => {
    if (!controlConfigured.value) return;
    void session.join('audience').catch(() => undefined);
    return () => {
      session.stop();
      camera.close();
      void engineRef.current?.close();
      engineRef.current = null;
      void keepAwake(false);
    };
  }, [props.id]);

  // Load the track once we know which one the meet uses.
  const trackKey = `${meet?.trackId ?? ''}|${meet?.catalogTrackId ?? ''}`;
  useEffect(() => {
    if (!meet) return;
    let cancelled = false;
    setTrack(null);
    void loadMeetTrack(meet).then((t) => !cancelled && setTrack(t));
    return () => {
      cancelled = true;
    };
  }, [trackKey]);

  /** User-gesture pre-flight: audio context, mic (+camera on iOS), decode the track. Then "ready". */
  const prepare = async () => {
    if (!track?.loaded) return toast('The track is not available on this device yet', 'warn');
    setPreparing(true);
    try {
      const app = appSettings.peek();
      const audio = audioSettings.peek();
      const engine = engineRef.current ?? getEngine();
      engineRef.current = engine;
      await engine.resume();
      const wantCombined = isIOS && app.cameraOn;
      if (wantCombined) camera.close();
      const video = await engine.openMic({
        deviceId: app.audioInputId || undefined,
        echoCancellation: app.echoCancellation,
        video: wantCombined ? { facingMode: app.cameraFacing, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
      if (video) camera.adopt(video, app.cameraFacing);
      else if (app.cameraOn && !camera.on.value) await camera.open({ facing: app.cameraFacing, deviceId: app.cameraDeviceId || undefined }).catch(() => undefined);
      camera.setPreset(app.zoomPreset);
      engine.applyFx(audio.params);
      engine.setMonitor(audio.monitor);
      const player = engine.player!;
      if (!player.buffer) await player.load(track.loaded.audio);
      player.setGain(audio.backingGain);
      await keepAwake(true);
      setPrepared(true);
      await session.setReady(true);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setPreparing(false);
    }
  };

  if (!controlConfigured.value)
    return (
      <Page title="Meet">
        <div class="callout warn">Live meets need the SingersVoice service — this build has no VITE_CONTROL_URL.</div>
      </Page>
    );
  if (session.error.value && !meet)
    return (
      <Page title="Meet">
        <div class="stack">
          <div class="callout danger">{session.error.value}</div>
          <a class="btn" href={href('/meets')}>
            Back to meets
          </a>
        </div>
      </Page>
    );
  if (!meet || !you)
    return (
      <Page title="Meet">
        <div class="row">
          <Spinner /> Joining the meet…
        </div>
      </Page>
    );

  const onStage = you.slot !== null;
  const live = meet.state === 'countdown' || meet.state === 'live';

  if (take && track?.loaded)
    return (
      <Review
        take={take}
        loaded={track.loaded}
        slot={(you.slot ?? 1) as SingerSlot}
        mode="live"
        meetId={meet.meetId}
        againLabel="Back to the meet"
        onSaved={(s) => void session.registerRecording(s.performanceId, s.link ?? null, take.durationMs).catch(() => undefined)}
        onAgain={() => {
          setTake(null);
          setPrepared(false);
          void session.claimSlot(null).catch(() => undefined);
        }}
      />
    );

  if (live && onStage && track?.loaded && engineRef.current)
    return <LiveStage session={session} meet={meet} you={you} loaded={track.loaded} engine={engineRef.current} camera={camera} prepared={prepared} onPrepare={prepare} onTake={setTake} />;

  if (meet.state === 'ended' || meet.state === 'expired') return <Ended session={session} meet={meet} you={you} />;

  return <Lobby session={session} meet={meet} you={you} track={track} prepared={prepared} preparing={preparing} onPrepare={prepare} participants={snap?.participants ?? []} engine={engineRef.current} />;
}

// ---------------- Lobby + audience ----------------

function Lobby(props: {
  session: MeetSession;
  meet: Meet;
  you: Participant;
  track: MeetTrack | null;
  prepared: boolean;
  preparing: boolean;
  onPrepare: () => Promise<void>;
  participants: Participant[];
  engine: AudioEngine | null;
}) {
  const { session, meet, you } = props;
  const [tab, setTab] = useState<'stage' | 'chat'>('stage');
  const [now, setNow] = useState(Date.now());
  const [listen, setListen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const host = you.userId === meet.hostUserId;
  const onStage = you.slot !== null;
  const msLeft = session.msToExpiry();
  const live = meet.state === 'countdown' || meet.state === 'live';
  const link = `${location.origin}${href(`/meet/${encodeURIComponent(meet.meetId)}`)}`;
  const tMs = meet.kickstartEpochMs !== null ? serverNow() - meet.kickstartEpochMs : -1;
  void now;

  const share = async () => {
    const r = await shareOrCopy(`Join "${meet.title}" on SingersVoice`, `Code ${meet.joinCode}`, link);
    toast(r === 'copied' ? 'Meet link copied' : r === 'shared' ? 'Shared' : link, r === 'failed' ? 'warn' : 'ok');
  };
  const claim = async (slot: number | null) => {
    try {
      await session.claimSlot(slot);
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  const start = async () => {
    try {
      await session.start(LEAD_MS);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const end = async () => {
    if (!confirm('End this meet for everyone?')) return;
    try {
      await session.stopMeet();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  // Audience: listen to the backing track locally, in sync (no voices until the stream exists).
  useEffect(() => {
    const e = props.engine;
    if (!listen || !e?.player || !props.track?.loaded || meet.kickstartEpochMs === null) return;
    const player = e.player;
    const run = async () => {
      if (!player.buffer) await player.load(props.track!.loaded!.audio);
      const localStart = meet.kickstartEpochMs! - clock.value.offsetMs;
      const startIn = (localStart - Date.now()) / 1000;
      if (startIn >= 0) player.play(e.ctx.currentTime + startIn, 0);
      else player.play(e.ctx.currentTime, -startIn * 1000);
    };
    void run();
    return () => player.stop();
  }, [listen, meet.kickstartEpochMs]);

  return (
    <Page title={meet.title} right={<span class={`chip ${live ? 'ok' : ''}`}>{meet.state}</span>}>
      <div class="stack">
        <section class="card stack pad-sm">
          <div class="row between">
            <div>
              <div class="small muted">Host {meet.hostName} · {meet.trackTitle || 'no track yet'}</div>
              <div class="row" style="gap:8px">
                <span class="mono" style="font-size:1.3em;letter-spacing:.2em">{meet.joinCode}</span>
                <button class="btn sm" onClick={() => void share()}>
                  <IcShare size={16} /> Share link
                </button>
              </div>
            </div>
            <div class="small muted" style="text-align:right">
              <div>
                <IcUsers size={14} /> {meet.performerCount} on stage · {meet.audienceCount} watching
              </div>
              <div class={msLeft < 60_000 ? 'chip warn' : ''}>closes in {formatMs(msLeft)} without activity</div>
            </div>
          </div>
          <TrackStatus track={props.track} host={host} />
        </section>

        {live && (
          <section class="card accent stack">
            <h2>{meet.state === 'countdown' ? `Starting in ${Math.max(0, Math.ceil(-tMs / 1000))}s` : 'Live now'}</h2>
            {onStage ? (
              <button class="btn primary lg" disabled={props.preparing || !props.track?.loaded} onClick={() => void props.onPrepare()}>
                {props.preparing ? <Spinner /> : <IcMic />} Join the song on stage
              </button>
            ) : (
              <>
                {props.track?.loaded ? (
                  <>
                    <div style="height:220px;position:relative;border-radius:12px;overflow:hidden">
                      <StageBackground id={meet.backgroundId} />
                      <LyricsPanel lines={props.track.loaded.track.lyrics} tMs={Math.max(0, tMs)} mySlot={0} countdown={meet.state === 'countdown' ? Math.max(1, Math.ceil(-tMs / 1000)) : null} showWho={props.track.loaded.track.singerCount > 1} />
                    </div>
                    <label class="switch">
                      <input type="checkbox" checked={listen} onChange={(e) => setListen((e.currentTarget as HTMLInputElement).checked)} />
                      <span>Play the backing track here, in sync (voices arrive with the published stream)</span>
                    </label>
                  </>
                ) : (
                  <div class="muted small">Lyrics follow along here when the host's track is in the public catalog.</div>
                )}
                {meet.streamUrl && <div class="callout">Live stream: {meet.streamUrl}</div>}
              </>
            )}
          </section>
        )}

        <Seg<'stage' | 'chat'>
          value={tab}
          onChange={setTab}
          options={[
            { v: 'stage', label: 'Stage' },
            { v: 'chat', label: `Chat (${session.chat.value.length})` },
          ]}
        />

        {tab === 'stage' && (
          <section class="stack">
            <div class="stage-grid">
              {meet.stage.map((s) => (
                <SlotCard key={s.slot} slot={s} mine={s.participantId === you.participantId} canClaim={!s.participantId && !live} onClaim={() => void claim(s.slot)} />
              ))}
            </div>
            <div class="row">
              {onStage ? (
                <>
                  {!props.prepared ? (
                    <button class="btn accent" disabled={props.preparing || !props.track?.loaded} onClick={() => void props.onPrepare()}>
                      {props.preparing ? <Spinner /> : <IcMic />} I'm ready (mic & camera check)
                    </button>
                  ) : (
                    <span class="chip ok">Ready — stage will start automatically</span>
                  )}
                  {!live && (
                    <button class="btn" onClick={() => void claim(null)}>
                      Leave stage
                    </button>
                  )}
                </>
              ) : (
                !live && (
                  <button class="btn primary" disabled={meet.performerCount >= MAX_PERFORMERS} onClick={() => void claim(meet.stage.find((s) => !s.participantId)?.slot ?? null)}>
                    <IcMic /> Take a stage slot
                  </button>
                )
              )}
              {host && !live && (
                <button class="btn accent" disabled={meet.performerCount === 0} onClick={() => void start()}>
                  <IcPlay /> Start the song (8 s count-in)
                </button>
              )}
              {host && (
                <button class="btn danger" onClick={() => void end()}>
                  <IcStop /> End meet
                </button>
              )}
            </div>
            <div class="small muted">
              Audience: {props.participants.filter((p) => p.slot === null).map((p) => p.displayName).join(', ') || 'nobody yet'}
            </div>
            {meet.stage.some((s) => s.participantId && s.rttMs !== null) && (
              <div class="small faint">
                Sync: {meet.stage.filter((s) => s.participantId && s.rttMs !== null).map((s) => `${s.displayName} ±${Math.round((s.rttMs ?? 0) / 2)} ms`).join(' · ')} — every device starts the track at the same server instant.
              </div>
            )}
          </section>
        )}
        {tab === 'chat' && <Chat session={session} />}
      </div>
    </Page>
  );
}

function TrackStatus(props: { track: MeetTrack | null; host: boolean }) {
  const t = props.track;
  if (!t) return <div class="small muted">Checking the track on this device…</div>;
  if (t.loaded) return <div class="small muted">Track ready on this device ({t.source === 'library' ? 'your library' : 'public catalog'}): {t.loaded.track.title} · {formatMs(t.loaded.track.durationMs)}</div>;
  return (
    <div class="callout warn">
      {t.reason}
      {props.host && (
        <>
          {' '}
          Publish it from <a href={href('/tracks')}>Tracks</a> so everyone can load it.
        </>
      )}
    </div>
  );
}

function SlotCard(props: { slot: StageSlot; mine: boolean; canClaim: boolean; onClaim: () => void }) {
  const s = props.slot;
  return (
    <button type="button" class={`slot-card ${s.participantId ? 'taken' : ''} ${props.mine ? 'mine' : ''}`} disabled={!props.canClaim} onClick={props.onClaim} style={{ borderColor: SLOT_COLORS[s.slot as SingerSlot] }}>
      <span class="slot-badge" style={{ background: SLOT_COLORS[s.slot as SingerSlot] }}>S{s.slot}</span>
      <span class="name">{s.participantId ? s.displayName : 'open'}</span>
      {s.participantId && <span class={`chip ${s.ready ? 'ok' : ''}`}>{s.ready ? 'ready' : 'joined'}</span>}
    </button>
  );
}

function Chat(props: { session: MeetSession }) {
  const [text, setText] = useState('');
  const list = props.session.chat.value;
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [list.length]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try {
      await props.session.say(t);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <section class="stack">
      <div class="chat-log">
        {!list.length && <div class="muted small">No messages yet — say hi.</div>}
        {list.map((m) => (
          <div key={m.seq} class="chat-msg">
            <b>{m.displayName}</b> <span class="faint small">{new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <div>{m.text}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div class="row">
        <input class="input" style="flex:1" value={text} maxLength={500} placeholder="Message everyone" onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
        <button class="btn primary" onClick={() => void send()}>
          <IcChat /> Send
        </button>
      </div>
    </section>
  );
}

// ---------------- Live stage (performer) ----------------

function LiveStage(props: {
  session: MeetSession;
  meet: Meet;
  you: Participant;
  loaded: NonNullable<MeetTrack['loaded']>;
  engine: AudioEngine;
  camera: Camera;
  prepared: boolean;
  onPrepare: () => Promise<void>;
  onTake: (t: TakeResult) => void;
}) {
  const { session, meet, engine, camera, loaded } = props;
  const [tMs, setTMs] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [started, setStarted] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const videoStartCtx = useRef<number | null>(null);
  const raf = useRef(0);
  const scheduledFor = useRef<number | null>(null);
  const app = appSettings.value;
  const audio = audioSettings.value;
  const track = loaded.track;
  const mySlot = Math.max(1, Math.min(track.singerCount, props.you.slot ?? 1)) as SingerSlot;

  useEffect(() => {
    engine.applyFx(audio.params);
    engine.setMonitor(audio.monitor);
    engine.player?.setGain(audio.backingGain);
  }, [audio]);

  // Schedule playback + recording at the shared instant (once per kickstart).
  useEffect(() => {
    const ks = meet.kickstartEpochMs;
    if (ks === null || !props.prepared || scheduledFor.current === ks) return;
    const player = engine.player;
    if (!player?.buffer) return;
    scheduledFor.current = ks;
    const localStart = ks - clock.value.offsetMs; // server instant in local epoch ms
    const startIn = (localStart - Date.now()) / 1000;
    const t0 = engine.ctx.currentTime + Math.max(0, startIn);
    const offsetMs = startIn < 0 ? -startIn * 1000 : 0; // late join → start mid-song
    void engine.recorder?.start();
    player.play(t0, offsetMs);
    if (camera.stream && pickVideoMime()) {
      try {
        const mr = new MediaRecorder(camera.stream, { mimeType: pickVideoMime(), videoBitsPerSecond: 1_800_000 });
        chunks.current = [];
        mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
        mr.onstart = () => {
          videoStartCtx.current = engine.ctx.currentTime;
        };
        mr.start(1000);
        mediaRec.current = mr;
      } catch {
        mediaRec.current = null;
      }
    }
    if (app.autoZoom && camera.on.value) {
      camera.zoom.value = ZOOM_LEVELS.wide;
      camera.autoZoom(ZOOM_LEVELS[app.zoomPreset] + 0.1, 8000);
    }
    player.onEnded = () => void finish();
    setStarted(true);
    const tick = () => {
      const nowCtx = engine.ctx.currentTime;
      if (nowCtx < t0) setCountdown(Math.ceil(t0 - nowCtx));
      else {
        setCountdown(null);
        setTMs(Math.max(0, player.positionMs() - engine.outputLatencyMs));
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [meet.kickstartEpochMs, props.prepared]);

  // Host ended the meet while we sing → wrap up the personal take.
  useEffect(() => {
    if (started && (meet.state === 'ended' || meet.state === 'expired')) void finish();
  }, [meet.state]);

  const finish = async () => {
    if (finishing || !started) return;
    setFinishing(true);
    cancelAnimationFrame(raf.current);
    try {
      const player = engine.player!;
      const origin = player.originCtxTime();
      const durationMs = Math.round(player.positionMs());
      player.onEnded = null;
      player.stop();
      let vocal = new Blob([], { type: 'audio/wav' });
      let vocalOffsetMs = 0;
      let sampleRate = engine.ctx.sampleRate;
      if (engine.recorder?.recording) {
        const rec = await engine.recorder.stop();
        vocal = rec.wav;
        sampleRate = rec.sampleRate;
        vocalOffsetMs = (rec.startCtxTime - origin) * 1000;
      }
      let video: Blob | null = null;
      let videoOffsetMs: number | null = null;
      const mr = mediaRec.current;
      if (mr && mr.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          mr.onstop = () => resolve();
          mr.stop();
        });
        video = new Blob(chunks.current, { type: mr.mimeType });
        videoOffsetMs = videoStartCtx.current !== null ? (videoStartCtx.current - origin) * 1000 : null;
      }
      mediaRec.current = null;
      engine.closeMic();
      camera.cancelAutoZoom();
      await keepAwake(false);
      props.onTake({
        vocal,
        video,
        durationMs,
        vocalOffsetMs: Math.round(vocalOffsetMs),
        videoOffsetMs: videoOffsetMs === null ? null : Math.round(videoOffsetMs),
        latencyCompMs: Math.round(engine.outputLatencyMs * 2),
        sampleRate,
        startedAtEpochMs: meet.kickstartEpochMs ?? Date.now(),
      });
    } catch (e) {
      toast(errorText(e), 'error', 8000);
      setFinishing(false);
    }
  };

  const others = meet.stage.filter((s) => s.participantId && s.participantId !== props.you.participantId);
  const level = engine.recorder?.level.value ?? 0;

  return (
    <Page title={meet.title} nav={false} full>
      <div class="sing">
        <StageBackground id={meet.backgroundId} />
        <section class={`stage ${others.length ? '' : 'solo'}`}>
          {others.length > 0 && (
            <div class="others">
              {others.map((s) => (
                <div class="tile" key={s.slot} title={s.displayName} style={{ borderColor: SLOT_COLORS[s.slot as SingerSlot] }}>
                  {s.picture ? <img src={s.picture} alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover" /> : <div class="silhouette">{s.displayName.charAt(0)}</div>}
                  <span class="tag">S{s.slot}</span>
                </div>
              ))}
            </div>
          )}
          <CameraTile camera={camera} cutout={app.cutout} label={`You · S${mySlot}`} videoRef={videoRef} />
        </section>
        <LyricsPanel lines={track.lyrics} tMs={tMs} mySlot={mySlot} countdown={countdown} showWho={track.singerCount > 1} title={track.title} />
        {app.showCueDeck && track.singerCount > 1 && started && countdown === null && <CueDeck lines={track.lyrics} tMs={tMs} mySlot={mySlot} />}
        <section class="controls">
          <PresetChips value={audio} onChange={updateAudio} />
          <div class="timeline">
            <span class="mono">{formatMs(tMs)}</span>
            <div class="track">
              <i style={{ width: `${track.durationMs ? Math.min(100, (tMs / track.durationMs) * 100) : 0}%` }} />
            </div>
            <span class="mono">{formatMs(track.durationMs)}</span>
          </div>
          <div class="main">
            <button class={`btn icon ${app.cameraOn ? 'on' : ''}`} aria-label="Camera" onClick={() => updateApp({ cameraOn: !app.cameraOn })}>
              {app.cameraOn ? <IcCamera /> : <IcCameraOff />}
            </button>
            <button class={`btn icon ${audio.monitor ? 'on' : ''}`} aria-label="Hear myself" onClick={() => updateAudio({ monitor: !audio.monitor })}>
              <IcHeadphones />
            </button>
            {!props.prepared ? (
              <button class="btn big primary" onClick={() => void props.onPrepare()}>
                <IcMic /> Join the song
              </button>
            ) : started ? (
              <button class="btn big accent" disabled={finishing} onClick={() => void finish()}>
                {finishing ? <Spinner /> : <IcStop />} Finish
              </button>
            ) : (
              <button class="btn big primary" disabled>
                <Spinner /> Waiting for the kickstart…
              </button>
            )}
            <span class="pitch-pill">
              <span class="dot" style={{ background: level > 0.9 ? 'var(--danger)' : 'var(--ok)', opacity: 0.4 + level * 0.6 }} /> ±{Math.round(clock.value.rttMs / 2)} ms
            </span>
            <span class="chip" style={{ borderColor: SLOT_COLORS[mySlot] }}>S{mySlot}</span>
          </div>
        </section>
      </div>
    </Page>
  );
}

// ---------------- Ended ----------------

function Ended(props: { session: MeetSession; meet: Meet; you: Participant }) {
  const { meet } = props;
  const snap = props.session.snapshot.value;
  const recs = snap?.recordings ?? [];
  const host = props.you.userId === meet.hostUserId;
  const canPublish = privileged.value;
  return (
    <Page title={meet.title}>
      <div class="stack">
        <div class="review-hero">
          <h2>{meet.state === 'expired' ? 'This meet closed after 5 idle minutes' : 'Meet ended'}</h2>
          <div class="muted small">
            {meet.trackTitle || 'no track'} · host {meet.hostName} · {new Date(meet.createdAt).toLocaleString()}
          </div>
        </div>
        <section class="card stack">
          <h3>Personal takes from this meet</h3>
          {!recs.length && <div class="muted small">No takes were registered. Each singer's take stays in their own Drive (Performances › Live).</div>}
          <div class="list">
            {recs.map((r) => (
              <div class="item" key={r.performanceId}>
                <div class="thumb">
                  <IcMic size={18} />
                </div>
                <div class="meta">
                  <div class="t">
                    {r.displayName} {r.slot ? <span class="slot-badge" style={{ background: SLOT_COLORS[r.slot as SingerSlot] }}>S{r.slot}</span> : null}
                  </div>
                  <div class="s">{formatMs(r.durationMs)} · {new Date(r.createdAt).toLocaleTimeString()}</div>
                </div>
                {r.driveFolderLink ? (
                  <a class="btn sm" href={r.driveFolderLink} target="_blank" rel="noopener">
                    Drive
                  </a>
                ) : (
                  <span class="chip">private</span>
                )}
              </div>
            ))}
          </div>
        </section>
        <div class="row">
          <a class="btn primary" href={href('/meets')}>
            Create another meet
          </a>
          <a class="btn" href={href('/studio/performances')}>
            My performances
          </a>
          {host && canPublish && (
            <a class="btn" href={href(`/publishing?meet=${encodeURIComponent(meet.meetId)}`)}>
              Publish this meet
            </a>
          )}
        </div>
      </div>
    </Page>
  );
}
