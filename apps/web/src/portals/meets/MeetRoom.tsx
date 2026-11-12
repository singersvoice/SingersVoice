/**
 * Meet room (/meet/:id): lobby with stage slots + chat, the clock-synced live stage for
 * performers (GMT kickstart), the audience view, and the ended/expired summary.
 * Every take on stage is a personal session: recorded locally, kept in the singer's own Drive.
 */
import { formatMs, MAX_PERFORMERS, playbackPositionMs, SLOT_COLORS, type Meet, type Participant, type SingerSlot, type StageSlot } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getEngine, type AudioEngine } from '../../audio/engine.ts';
import { StageBackground } from '../../components/BackgroundPicker.tsx';
import { VirtualStage } from '../../components/VirtualStage.tsx';
import { PresetChips } from '../../components/FxPanel.tsx';
import { IcCamera, IcCameraOff, IcChat, IcHeadphones, IcMic, IcPause, IcPlay, IcShare, IcSkipBack, IcStop, IcUsers } from '../../components/icons.tsx';
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
import { Camera, pickVideoMime } from '../../video/camera.ts';
import { LocalFeed } from '../../video/localFeed.ts';
import { PerformerMesh, type PeerState } from '../../video/peers.ts';
import { StageCompositor, type StagePerformer } from '../../video/stage.ts';
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
  // Shared track position for everyone: negative while counting down to the kickstart, frozen while paused.
  const pos = playbackPositionMs(meet, serverNow());
  const tMs = meet.playback?.state === 'paused' ? (pos ?? 0) : meet.kickstartEpochMs !== null ? (meet.playback?.offsetMs ?? 0) + (serverNow() - meet.kickstartEpochMs) : -1;
  const countingDown = meet.kickstartEpochMs !== null && meet.playback?.state === 'playing' && serverNow() < meet.kickstartEpochMs;
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

  // Audience: listen to the backing track locally, in sync with the shared transport (no voices until the stream exists).
  const pbState = meet.playback?.state ?? 'idle';
  const pbEpoch = meet.playback?.epoch ?? 0;
  useEffect(() => {
    const e = props.engine;
    if (!listen || !e?.player || !props.track?.loaded || meet.kickstartEpochMs === null || pbState !== 'playing') return;
    const player = e.player;
    const run = async () => {
      if (!player.buffer) await player.load(props.track!.loaded!.audio);
      const localStart = meet.kickstartEpochMs! - clock.value.offsetMs;
      const startIn = (localStart - Date.now()) / 1000;
      const offset = meet.playback?.offsetMs ?? 0;
      if (startIn >= 0) player.play(e.ctx.currentTime + startIn, offset);
      else player.play(e.ctx.currentTime, offset - startIn * 1000);
    };
    void run();
    return () => player.stop();
  }, [listen, meet.kickstartEpochMs, pbState, pbEpoch]);

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
                {privileged.value && (
                  <a class="btn sm" href={href(`/publishing/show/${encodeURIComponent(meet.meetId)}`)} target="_blank" rel="noopener" title="Publishing mode: the broadcast picture (performers huge, no lyrics), in a new tab">
                    Show view
                  </a>
                )}
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
            <h2>{countingDown ? `${meet.playback?.offsetMs ? 'Resuming' : 'Starting'} in ${Math.max(0, Math.ceil(-(serverNow() - meet.kickstartEpochMs!) / 1000))}s` : pbState === 'paused' ? 'Paused by the host' : 'Live now'}</h2>
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
                      <LyricsPanel lines={props.track.loaded.track.lyrics} tMs={Math.max(0, tMs)} mySlot={0} countdown={countingDown ? Math.max(1, Math.ceil(-(serverNow() - meet.kickstartEpochMs!) / 1000)) : null} showWho={props.track.loaded.track.singerCount > 1} />
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
  const [blend, setBlend] = useState<'loading' | 'model' | 'oval' | 'off'>('off');
  const [peerStates, setPeerStates] = useState<Record<string, PeerState>>({});
  const feed = useMemo(() => new LocalFeed(), []);
  const compositor = useMemo(() => new StageCompositor(), []);
  const mesh = useMemo(() => (PerformerMesh.supported() ? new PerformerMesh(session, props.you.participantId) : null), [session, props.you.participantId]);
  const remoteVideos = useRef(new Map<string, HTMLVideoElement>());
  const mediaRec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const videoStartCtx = useRef<number | null>(null);
  const raf = useRef(0);
  const scheduledEpoch = useRef(0);
  const pausedLocally = useRef(false);
  const app = appSettings.value;
  const audio = audioSettings.value;
  const track = loaded.track;
  const mySlot = Math.max(1, Math.min(track.singerCount, props.you.slot ?? 1)) as SingerSlot;
  const host = props.you.userId === meet.hostUserId;
  const pb = meet.playback ?? { state: 'idle' as const, offsetMs: 0, pausedAtMs: 0, pauseAtEpochMs: null, epoch: 0 };
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    engine.applyFx(audio.params);
    engine.setMonitor(audio.monitor);
    engine.player?.setGain(audio.backingGain);
  }, [audio]);

  // ---- my cut-out + the performer mesh (video only; singers never hear each other) ----
  const camStream = camera.stream;
  const camOn = camera.on.value;
  useEffect(() => {
    feed.onMode = (m) => setBlend(m);
    feed.attach(camOn ? camStream : null, true);
    if (camOn && camStream) {
      camera.startAutoFrame(feed.video);
      mesh?.setLocalStream(feed.packedStream());
    } else {
      camera.stopAutoFrame();
      mesh?.setLocalStream(null);
    }
  }, [camStream, camOn]);
  useEffect(() => feed.setFraming(app.zoomPreset, app.autoZoom), [app.zoomPreset, app.autoZoom]);
  const origin = camera.origin.value;
  useEffect(() => feed.setOrigin(origin), [origin.x, origin.y]);
  // Vocal-driven auto zoom: whoever sings comes closer, and everyone sees it (the sender frames its own stream).
  useEffect(() => {
    const t = setInterval(() => feed.reportLevel(engine.recorder?.level.value ?? 0), 100);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!mesh) return;
    mesh.onRemote = (id, stream, state) => {
      let v = remoteVideos.current.get(id);
      if (stream) {
        if (!v) {
          v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          v.autoplay = true;
          v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
          document.body.appendChild(v);
          remoteVideos.current.set(id, v);
        }
        if (v.srcObject !== stream) {
          v.srcObject = stream;
          void v.play().catch(() => undefined);
        }
      } else if (v) {
        v.srcObject = null;
        v.remove();
        remoteVideos.current.delete(id);
      }
      setPeerStates((s) => ({ ...s, [id]: state }));
    };
    void mesh.start();
    (window as unknown as { __svMesh?: PerformerMesh; __svFeed?: LocalFeed }).__svMesh = mesh; // support / e2e hooks
    (window as unknown as { __svFeed?: LocalFeed }).__svFeed = feed;
    return () => {
      mesh.close();
      for (const v of remoteVideos.current.values()) {
        v.srcObject = null;
        v.remove();
      }
      remoteVideos.current.clear();
      feed.dispose();
    };
  }, [mesh]);

  const stagePerformers = meet.stage.filter((s) => s.participantId);
  const peerIds = stagePerformers.map((s) => s.participantId!).filter((id) => id !== props.you.participantId);
  const peerKey = peerIds.join(',');
  useEffect(() => {
    mesh?.setPeers(peerIds);
  }, [peerKey]);

  // Everyone on stage, left to right by slot, on one shared stage.
  const facing = camera.facing.value;
  useEffect(() => {
    const list: StagePerformer[] = stagePerformers.map((s) => {
      const me = s.participantId === props.you.participantId;
      const color = SLOT_COLORS[Math.max(1, Math.min(track.singerCount, s.slot)) as SingerSlot];
      if (me) return { id: 'me', slot: s.slot, label: `You · S${s.slot}`, color, source: feed.source, mirror: facing === 'user', isMe: true };
      const v = remoteVideos.current.get(s.participantId!);
      return { id: s.participantId!, slot: s.slot, label: `${s.displayName.split(' ')[0] || 'Singer'} · S${s.slot}`, picture: s.picture, color, source: v ? { kind: 'packed', video: v } : { kind: 'none' } };
    });
    compositor.setPerformers(list);
  }, [peerKey, stagePerformers.map((s) => `${s.slot}:${s.participantId}`).join('|'), camStream, camOn, facing, peerStates]);

  // ---- follow the shared transport: schedule playback + recording at every kickstart (start / resume / restart) ----
  useEffect(() => {
    const ks = meet.kickstartEpochMs;
    if (ks === null || !props.prepared || pb.state !== 'playing' || scheduledEpoch.current === pb.epoch) return;
    const player = engine.player;
    if (!player?.buffer) return;
    const firstCue = scheduledEpoch.current === 0;
    scheduledEpoch.current = pb.epoch;
    const localStart = ks - clock.value.offsetMs; // server instant in local epoch ms
    const startIn = (localStart - Date.now()) / 1000;
    const t0 = engine.ctx.currentTime + Math.max(0, startIn);
    const offsetMs = pb.offsetMs + (startIn < 0 ? -startIn * 1000 : 0); // late join → start mid-song
    if (firstCue) {
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
      setStarted(true);
    } else {
      // Resume / restart: the recorder keeps the take on the track timeline by dropping the pause.
      clearTimeout(pauseTimer.current);
      if (!pausedLocally.current) {
        engine.recorder?.pause(engine.ctx.currentTime);
        player.pause();
      }
      pausedLocally.current = false;
      player.play(t0, offsetMs);
      engine.recorder?.resume(t0);
      try {
        if (mediaRec.current?.state === 'paused') mediaRec.current.resume();
      } catch {
        /* ignore */
      }
    }
    player.onEnded = () => void finish();
    cancelAnimationFrame(raf.current);
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
  }, [meet.kickstartEpochMs, pb.epoch, pb.state, props.prepared]);

  // Host paused: the pause is cued at a shared server instant — stop exactly there (sample-accurate for
  // the recorder, since the instant is converted to our own audio clock). A device that only learns of
  // it after the instant stops immediately and re-aligns on resume.
  const pauseAt = pb.pauseAtEpochMs;
  useEffect(() => {
    clearTimeout(pauseTimer.current);
    if (!started) return;
    const player = engine.player;
    if (!player) return;
    const doPause = (ctxAt: number) => {
      if (pausedLocally.current) return;
      pausedLocally.current = true;
      if (player.playing) {
        player.pause();
        engine.recorder?.pause(ctxAt);
      }
      player.seek(pb.pausedAtMs);
      setTMs(pb.pausedAtMs);
      try {
        if (mediaRec.current?.state === 'recording') mediaRec.current.pause();
      } catch {
        /* ignore */
      }
    };
    if (pb.state === 'paused') {
      doPause(engine.ctx.currentTime);
      return;
    }
    if (pb.state === 'playing' && pauseAt !== null) {
      const localInstant = pauseAt - clock.value.offsetMs; // server instant → local epoch ms
      const inMs = localInstant - Date.now();
      const ctxAt = engine.ctx.currentTime + Math.max(0, inMs) / 1000;
      if (inMs <= 0) doPause(ctxAt);
      else pauseTimer.current = setTimeout(() => doPause(ctxAt), inMs);
    }
    return () => clearTimeout(pauseTimer.current);
  }, [pb.state, pauseAt, pb.pausedAtMs, started]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

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
      mesh?.close();
      engine.closeMic();
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

  const transport = async (what: 'pause' | 'resume' | 'restart') => {
    try {
      if (what === 'pause') await session.pause(3000);
      else if (what === 'resume') await session.resume(4000);
      else await session.restart(5000, 0);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const others = stagePerformers.filter((s) => s.participantId !== props.you.participantId);
  const connected = others.filter((s) => peerStates[s.participantId!] === 'connected').length;
  const level = engine.recorder?.level.value ?? 0;
  const paused = pb.state === 'paused';

  return (
    <Page title={meet.title} nav={false} full>
      <div class="sing">
        <StageBackground id={meet.backgroundId} />
        <VirtualStage compositor={compositor} extra={[feed.video]} />
        <section class="stagebar" data-blend={blend} data-mask={feed.segmenter.maskMode} data-performers={compositor.tiles.length}>
          <span class="chip">
            <IcUsers size={14} /> {stagePerformers.length} on stage{others.length ? ` · ${connected}/${others.length} video linked` : ''}
          </span>
          {camOn && blend === 'loading' && <span class="chip">blending you into the stage…</span>}
          {camOn && blend === 'oval' && app.cutout && <span class="chip warn">soft-focus mode</span>}
          {paused && <span class="chip warn">paused by the host</span>}
          {!paused && pauseAt !== null && <span class="chip warn">pausing…</span>}
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
              <>
                {host &&
                  (paused ? (
                    <button class="btn big primary" aria-label="Resume for everyone" onClick={() => void transport('resume')}>
                      <IcPlay /> Resume
                    </button>
                  ) : (
                    <button class="btn big" aria-label="Pause for everyone" disabled={countdown !== null || pauseAt !== null} onClick={() => void transport('pause')}>
                      <IcPause /> {pauseAt !== null ? 'Pausing…' : 'Pause'}
                    </button>
                  ))}
                {host && (
                  <button class="btn icon" aria-label="Restart the song for everyone" title="Restart from the top" onClick={() => void transport('restart')}>
                    <IcSkipBack />
                  </button>
                )}
                <button class="btn big accent" disabled={finishing} onClick={() => void finish()}>
                  {finishing ? <Spinner /> : <IcStop />} Finish
                </button>
              </>
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
