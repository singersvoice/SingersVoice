import { createTrack, formatMs, nextSlot, planParts, singersLine, songTimeMs, SLOT_COLORS, type CatalogTrack, type JoinInvite, type SingerSlot, type TrackPackageV2 } from '@singersvoice/protocol';
import { effect, useSignal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getEngine, noteName, type AudioEngine } from '../../audio/engine.ts';
import { bleedOffset, lagIsStrong, monoOf } from '../../audio/sync.ts';
import { backgroundById, backgroundSrc, backgrounds, loadBackgrounds, StageBackground, BackgroundPicker } from '../../components/BackgroundPicker.tsx';
import { VirtualStage } from '../../components/VirtualStage.tsx';
import { FxPanel, PresetChips } from '../../components/FxPanel.tsx';
import { IcCamera, IcCameraOff, IcDownload, IcFlip, IcHeadphones, IcImage, IcPause, IcPlay, IcShare, IcSkipBack, IcSliders, IcStop, IcTv, IcZoom } from '../../components/icons.tsx';
import { KaraokeVideo } from '../../components/KaraokeVideo.tsx';
import { CueDeck, LyricsPanel } from '../../components/LyricsPanel.tsx';
import { LevelDot, MicStatus } from '../../components/MicStatus.tsx';
import { MixBalance } from '../../components/MixBalance.tsx';
import { SeekBar } from '../../components/SeekBar.tsx';
import { PictureChoices } from '../../components/PictureChoices.tsx';
import { TvPanel } from '../../components/TvPanel.tsx';
import { tvLink } from '../../lib/tv.ts';
import { Page } from '../../components/Shell.tsx';
import { Empty, Field, Progress, Sheet, Spinner, Switch } from '../../components/ui.tsx';
import { catalogAvailable, isSameTrack, myCatalogUserId, pullCatalogTrack, searchCatalog } from '../../lib/catalog.ts';
import { ensureRegistered, recordAccess } from '../../lib/registry.ts';
import { go, href } from '../../lib/nav.ts';
import { headphonesLikely, isIOS, keepAwake } from '../../lib/platform.ts';
import { inviteOf, invitePerformance, inviteShow, JoinLayers, joinOfTake, loadInvite, type JoinMaterial } from '../../lib/joins.ts';
import { shareOrCopy } from '../../lib/download.ts';
import { buildManifest, saveTake as persistTake, type TakeResult } from '../../lib/takes.ts';
import type { LoadedTrack, TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { accountUserId, isDrive, profile, role, withProvider } from '../../state/session.ts';
import { appSettings, audioSettings, updateApp, updateAudio } from '../../state/settings.ts';
import { Camera } from '../../video/camera.ts';
import { openMicWithCamera, restartCamera } from '../../video/capture.ts';
import { LocalFeed, type FeedHealth } from '../../video/localFeed.ts';
import { ShowRecorder } from '../../video/showRecorder.ts';
import { StageCompositor } from '../../video/stage.ts';

type Phase = 'loading' | 'ready' | 'starting' | 'countdown' | 'playing' | 'paused' | 'finishing' | 'review';
export type { TakeResult };

/** Track picker (/sing): my library first, then anything in the public catalog (pulled on demand). */
export function SingPicker() {
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogTrack[]>([]);
  const [q, setQ] = useState('');
  const [pulling, setPulling] = useState<{ id: string; label: string; fraction: number } | null>(null);
  const reload = () =>
    withProvider(async (p) => {
      await p.ready();
      setTracks(await p.listTracks());
    }).catch(() => setTracks([]));
  useEffect(() => void reload(), []);
  useEffect(() => {
    if (!catalogAvailable()) return;
    const t = setTimeout(() => void searchCatalog(q, { limit: 24 }).then((r) => setCatalog(r.items)).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [q]);

  const me = myCatalogUserId();
  const mine = (tracks ?? []).filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q.toLowerCase()));
  const publicOnly = catalog.filter((c) => c.ownerUserId !== me && !(tracks ?? []).some((t) => isSameTrack(t.trackId, c.trackId)));

  const pullAndSing = async (c: CatalogTrack) => {
    setPulling({ id: c.trackId, label: 'Fetching', fraction: 0.05 });
    try {
      const saved = await pullCatalogTrack(c, (pr) => setPulling({ id: c.trackId, ...pr }));
      toast(`"${saved.title}" added to ${isDrive.value ? 'your Drive' : 'this device'}`, 'ok', 4000);
      go(`/studio/sing/${encodeURIComponent(saved.trackId)}`);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setPulling(null);
    }
  };

  return (
    <Page title="Pick a track">
      <div class="stack">
        <input class="input" placeholder="Search my tracks and the public catalog" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
        {tracks === null && (
          <div class="row">
            <Spinner /> Loading…
          </div>
        )}
        {tracks && !tracks.length && !publicOnly.length && (
          <Empty title="No tracks yet" body="Make one in Track Maker first — it takes a song file and your lyrics — or pull a public one below.">
            <a class="btn primary" href={href('/studio/trackmaker')}>
              Open Track Maker
            </a>
          </Empty>
        )}
        {mine.length > 0 && <h3 class="small muted" style="margin:0">My tracks</h3>}
        <div class="list">
          {mine.map((t) => (
            <a class="item" key={t.trackId} href={href(`/studio/sing/${encodeURIComponent(t.trackId)}`)}>
              <div class="thumb">{t.title.charAt(0).toUpperCase()}</div>
              <div class="meta">
                <div class="t">{t.title}</div>
                <div class="s">
                  {t.artist || 'Unknown artist'} · {formatMs(t.durationMs)} · {t.singerCount} singer{t.singerCount > 1 ? 's' : ''}
                </div>
              </div>
              <span class="btn sm primary">Sing</span>
            </a>
          ))}
        </div>
        {publicOnly.length > 0 && (
          <>
            <h3 class="small muted" style="margin:0">Public catalog — pulled into {isDrive.value ? 'your Drive' : 'this device'} when you pick one</h3>
            <div class="list">
              {publicOnly.map((c) => (
                <div class="item" key={c.trackId}>
                  <div class="thumb">{c.title.charAt(0).toUpperCase()}</div>
                  <div class="meta">
                    <div class="t">{c.title}</div>
                    <div class="s">
                      {c.artist || 'Unknown artist'} · {formatMs(c.durationMs)} · {c.singerCount} singer{c.singerCount > 1 ? 's' : ''}
                    </div>
                    {pulling?.id === c.trackId && <Progress fraction={pulling.fraction} label={pulling.label} />}
                  </div>
                  <button class="btn sm accent" disabled={pulling !== null} onClick={() => void pullAndSing(c)}>
                    <IcDownload size={16} /> Add & sing
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Page>
  );
}

/** The part a joiner sings by default: the first part of the song nobody on the stage sang, else the parts round again by stage slot. */
function partFor(join: JoinMaterial, singerCount: number): number {
  const taken = new Set(join.invite.layers.map((l) => l.slot));
  for (let part = 1; part <= singerCount; part++) if (!taken.has(part)) return part;
  return ((join.slot - 1) % Math.max(1, singerCount)) + 1;
}

/**
 * The lyrics-first stage (/sing/:id) — and, with `joinId`, the same stage sung over another singer's
 * performance (/studio/join/:id, lib/joins.ts): the show so far is the backing track, every earlier
 * singer stands on the stage from their cut-out video, and the take saved has everyone on it. A
 * joiner's camera is as free as any Studio singer's: a plan gates the picture in live meets alone.
 */
export function Sing(props: { id?: string; joinId?: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [loaded, setLoaded] = useState<LoadedTrack | null>(null);
  const [join, setJoin] = useState<JoinMaterial | null>(null);
  const [loading, setLoading] = useState<{ label: string; fraction: number } | null>(null);
  /** A join's landing: the invitation as it stands (watch the performance first), until Join is tapped. */
  const [preview, setPreview] = useState<JoinInvite | null>(null);
  const [previewUrl, setPreviewUrl] = useState<{ url: string; blob: Blob } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [joinGo, setJoinGo] = useState(false);
  /** The earlier singers' cut-outs on my stage (a join), on the show's clock. */
  const layers = useMemo(() => (join ? new JoinLayers(join.invite.layers, join.cutouts) : null), [join]);
  // The song's position, written every frame: a signal, read by the lyrics and the seek bar alone (the stage never re-renders for it).
  const tMs = useSignal(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [fxOpen, setFxOpen] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [take, setTake] = useState<TakeResult | null>(null);
  const [headphones, setHeadphones] = useState<boolean | null>(null);
  const engineRef = useRef<AudioEngine | null>(null);
  /** What the microphone heard of the track on the last take: the lag found beyond the device's figures (ms), or null. */
  const [heardShift, setHeardShift] = useState<number | null>(null);
  const camera = useMemo(() => new Camera(), []);
  const feed = useMemo(() => new LocalFeed(), []);
  const compositor = useMemo(() => new StageCompositor('show'), []); // the singers fill their strip under the lyrics
  /** The take's video is the show: my cut-out on the stage background, as Publisher mode would show it, with the mix. */
  const show = useMemo(() => new ShowRecorder(), []);
  useEffect(() => {
    (window as unknown as { __svFeed?: LocalFeed; __svShow?: ShowRecorder }).__svFeed = feed; // support / e2e hooks
    (window as unknown as { __svShow?: ShowRecorder }).__svShow = show;
  }, [feed, show]);
  const [blend, setBlend] = useState<'loading' | 'model' | 'oval' | 'off'>('off');
  const startedEpoch = useRef(0);
  const raf = useRef(0);

  const app = appSettings.value;
  const audio = audioSettings.value;
  const track: TrackPackageV2 | null = loaded?.track ?? null;
  /** The part a joiner sings, chosen on the stage setup (null: the first part nobody on the stage has, else round the parts). */
  const [joinPart, setJoinPart] = useState<SingerSlot | null>(null);
  const mySlot = (join ? (joinPart ?? partFor(join, track?.singerCount ?? 1)) : Math.min(app.singerSlot, track?.singerCount ?? 1)) as SingerSlot;

  // The TV in the room (lib/tv.ts): this stage's show picture while the Studio is open, the song's words and its clock while it runs.
  const [tvOpen, setTvOpen] = useState(false);
  useEffect(() => {
    tvLink.attach(show);
    void tvLink.autoConnect();
    return () => tvLink.detach(show);
  }, [show]);
  useEffect(() => tvLink.setLook(app.tvLook, profile.value?.name || 'You'), [app.tvLook]);
  useEffect(() => {
    if (!track) return;
    tvLink.setSong({ title: track.title, lines: track.lyrics, singerCount: track.singerCount, mySlot, plan: planParts(track.singerCount, []) });
    return () => tvLink.setSong(null);
  }, [track, mySlot]);
  const tvPlaying = phase === 'playing';
  const tvCountdown = phase === 'countdown' ? countdown : null;
  useEffect(() => effect(() => tvLink.clock(tMs.value, tvPlaying, tvCountdown)), [tvPlaying, tvCountdown]);

  // Load the track — or, for a join, the performance to sing over: its show (the backing track from here on), the
  // singers' cut-outs and the song from the track database (its lyrics; the show carries the song without them).
  useEffect(() => {
    setPhase('loading');
    if (props.joinId && !joinGo) {
      // The landing first: who sang it, how long it is, a way to watch it — then Join.
      void inviteOf(decodeURIComponent(props.joinId)).then((inv) => {
        if (inv) setPreview(inv);
        else {
          toast('This performance is not open for joining (or was closed)', 'error', 9000);
          go('/studio/performances', true);
        }
      });
      return;
    }
    void withProvider(async (p) => {
      if (props.joinId) {
        const m = await loadInvite(decodeURIComponent(props.joinId), setLoading, { show: previewUrl?.blob });
        if (!m.slot) throw new Error('This stage is full — ten singers are on it already');
        const song = m.trackId ? await p.getTrack(m.trackId).catch(() => null) : null;
        const track = song?.track ?? createTrack({ trackId: `join-${m.invite.performanceId}`, title: m.invite.trackTitle, artist: m.invite.trackArtist, durationMs: m.invite.durationMs, lyrics: [], singerCount: 1 });
        setJoin(m);
        setLoaded({ track, audio: m.show, audioMime: m.show.type || m.invite.show.mimeType });
        setPhase('ready');
        if (song?.track.registryId) void recordAccess(song.track.registryId, 'sing');
        return;
      }
      const id = decodeURIComponent(props.id ?? '');
      const t = await p.getTrack(id);
      if (!t) throw new Error('Track not found (was it deleted?)');
      setLoaded(t);
      setPhase('ready');
      // Opened for performance: the song is known to the SingersVoice track database (registered and shared on the
      // first Sing of a track of my own; not for a failed load) and this access is on record — never a search.
      void (t.track.registryId ? Promise.resolve(t.track.registryId) : ensureRegistered(id, { loaded: t }).catch(() => null)).then((rid) => recordAccess(rid, 'sing'));
    }).catch((e) => {
      toast(errorText(e), 'error', 9000);
      go(props.joinId ? '/studio/performances' : '/studio/sing', true);
    });
    void headphonesLikely().then(setHeadphones);
    return () => {
      cancelAnimationFrame(raf.current);
      camera.close();
      feed.dispose();
      show.dispose();
      void engineRef.current?.close();
      engineRef.current = null;
      void keepAwake(false);
    };
  }, [props.id, props.joinId, joinGo]);
  useEffect(() => () => previewUrl && URL.revokeObjectURL(previewUrl.url), [previewUrl]);
  /** Watch the performance on the landing: the show, fetched once (and handed to the stage when Join follows). */
  const watch = async () => {
    if (!props.joinId || previewUrl) return;
    setPreviewBusy(true);
    try {
      const blob = await inviteShow(decodeURIComponent(props.joinId));
      setPreviewUrl({ url: URL.createObjectURL(blob), blob });
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setPreviewBusy(false);
    }
  };
  useEffect(() => {
    (window as unknown as { __svJoin?: unknown }).__svJoin = layers ? { layers } : undefined; // support / e2e: the earlier singers' players
    return () => layers?.dispose();
  }, [layers]);

  // My cut-out on the virtual stage follows the camera stream, framing and slot.
  const camStream = camera.stream;
  const camOn = camera.on.value;
  // The camera's health: a camera the browser muted or ended, or one frozen on a picture, is restarted — once by itself, then from a tap.
  const [camHealth, setCamHealth] = useState<FeedHealth>('ok');
  const autoRestartAt = useRef(0);
  const restartCam = () => restartCamera(engineRef.current, camera).catch((e) => toast(errorText(e), 'warn'));
  useEffect(() => {
    feed.onHealth = (h) => {
      setCamHealth(h);
      if (h === 'ok' || !camera.on.value || Date.now() - autoRestartAt.current < 60_000) return;
      autoRestartAt.current = Date.now();
      void restartCam();
    };
    return () => {
      feed.onHealth = null;
    };
  }, []);
  useEffect(() => {
    feed.onMode = (m) => setBlend(m);
    feed.attach(camOn ? camStream : null, true);
  }, [camStream, camOn]);
  // My picture and framing choices reach the feed live; the voice's push-in follows my meter once the take runs.
  useEffect(() => feed.setLook(app.picture, app.framing), [app.picture, app.framing]);
  useEffect(() => {
    const level = engineRef.current?.recorder?.level;
    if (app.framing !== 'voice' || !level || !(phase === 'playing' || phase === 'countdown' || phase === 'paused')) return;
    return effect(() => feed.voice(level.value));
  }, [app.framing, phase]);
  // The Track / Vocal volume of the recorded mix (the same controls as the live stage; kept on the device).
  useEffect(() => show.setBalance(app.trackDb, app.vocalDb), [app.trackDb, app.vocalDb]);
  const facing = camera.facing.value;
  /** My place in the row: a join takes the next slot after everyone on the stage so far; a solo take stands alone at its part's slot. */
  const stageSlot = join ? join.slot : mySlot;
  useEffect(() => {
    const me = { id: 'me', slot: stageSlot, label: `You · S${mySlot}`, color: SLOT_COLORS[mySlot], source: feed.source, mirror: facing === 'user', isMe: true } as const;
    const others = layers?.performers ?? [];
    compositor.setPerformers([...others, me]);
    show.setPerformers([...others, { ...me, label: 'You' }]);
    // My cut-out beside the show (join.ts): what the next singer's stage will draw me from.
    show.setCutoutSource(camOn && feed.source.kind === 'person' ? { person: feed.canvas, mask: feed.maskCanvas } : null);
  }, [camStream, camOn, mySlot, stageSlot, facing, layers]);
  // The recording draws the same background the stage shows.
  const bgItems = backgrounds.value;
  useEffect(() => {
    void loadBackgrounds();
    const item = backgroundById(app.backgroundId);
    show.setBackground(item ?? null, backgroundSrc(item));
  }, [app.backgroundId, bgItems.length]);

  // Apply FX whenever settings change.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.applyFx(audio.params);
    e.setMonitor(audio.monitor);
    e.player?.setGain(audio.backingGain);
    e.player?.setTempo(join ? 1 : audio.tempo); // a join sings the show as it was sung: no tempo, no key shift
    e.player?.setKeyShift(join ? 0 : audio.keyShift);
  }, [audio, join]);

  // Camera on/off follows settings while on stage — never for an audio-only account (roles.ts): its takes carry the voice alone.
  const videoAllowed = role.value !== 'audio'; // a solo take with a picture is everyone's; only an audio-only role has none
  useEffect(() => {
    if (phase === 'loading' || phase === 'review') return;
    if (app.cameraOn && videoAllowed && !camera.on.value) {
      camera.open({ facing: app.cameraFacing, deviceId: app.cameraDeviceId || undefined }).catch(() => toast('Camera unavailable — singing without video', 'warn'));
    } else if ((!app.cameraOn || !videoAllowed) && camera.on.value) camera.close();
  }, [app.cameraOn, app.cameraFacing, app.cameraDeviceId, phase, videoAllowed]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (phase === 'playing' || phase === 'countdown' || phase === 'paused') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const start = async () => {
    if (!loaded) return;
    setPhase('starting');
    try {
      const engine = engineRef.current ?? getEngine();
      engineRef.current = engine;
      await engine.resume(); // inside the tap gesture
      await openMicWithCamera(engine, camera); // on iOS the camera comes with it: one capture per page there
      const player = engine.player!;
      if (!player.buffer) await player.load(loaded.audio, join ? `join-${join.invite.performanceId}` : loaded.track.trackId);
      player.setGain(audio.backingGain);
      player.setTempo(join ? 1 : audio.tempo);
      player.setKeyShift(join ? 0 : audio.keyShift);
      await layers?.ready();
      await keepAwake(true);

      const lead = app.countIn ? 3 : 0.6;
      const t0 = engine.ctx.currentTime + lead + 0.15;
      // Recorder runs from before the song starts; its first-frame clock gives the exact offset.
      const recStart = engine.recorder ? engine.recorder.start() : Promise.resolve(engine.ctx.currentTime);
      player.play(t0, 0);
      takeOrigin.current = player.originCtxTime();
      startedEpoch.current = Date.now() + Math.round((t0 - engine.ctx.currentTime) * 1000);
      void recStart;

      // The show (my cut-out on the stage, with the mix) records from now, ahead of the kickstart: nothing of the first beat is lost to the recorder starting.
      show.start(engine, t0);
      player.onEnded = () => void finishRef.current(); // the latest finish, whatever render set it
      setPhase(app.countIn ? 'countdown' : 'playing');
      const tick = () => {
        const ctxNow = engine.ctx.currentTime;
        if (ctxNow < t0) {
          setCountdown(Math.ceil(t0 - ctxNow));
          layers?.sync(0, 0, false); // the earlier singers wait at their first frame
        } else {
          setCountdown(null);
          setPhase((p) => (p === 'countdown' ? 'playing' : p));
          const heardMs = Math.max(0, player.positionMs() - engine.outputLatencyMs);
          tMs.value = join ? songTimeMs(heardMs, join.invite) : heardMs;
          // The earlier singers' pictures keep step with their voices in the mix, which holds the show back by the lag and my round trip.
          layers?.sync(player.positionMs(), show.lagMs + engine.roundTripMs, player.playing);
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (e) {
      setPhase('ready');
      toast(errorText(e), 'error', 8000);
    }
  };

  /** While paused: the track position the vocal recording's end corresponds to (a seek while paused moves the take on resume). */
  const recPos = useRef(0);
  /**
   * The take's timeline origin: the context time of track position 0 at the first start. Pauses
   * (frames dropped) and jumps (silence inserted / re-sung parts replaced) keep the take on that one
   * timeline, so this never moves — unlike the player's own origin, which shifts with every cue.
   */
  const takeOrigin = useRef(0);
  /**
   * Move back or forth in the song. Playing: a cued jump a few frames ahead (seamless), the take
   * following on the track timeline; paused: the paused position moves, the take catches up on resume.
   */
  const seek = (ms: number) => {
    const engine = engineRef.current;
    const player = engine?.player;
    if (!engine || !player?.buffer || !(phase === 'playing' || phase === 'paused')) return;
    const to = Math.max(0, Math.min(player.durationMs, ms));
    if (player.playing) {
      const at = engine.ctx.currentTime + 0.08;
      const delta = to - player.positionAt(at);
      player.cue(at, to);
      if (Math.abs(delta) > 30) engine.recorder?.seek(at, delta / audio.tempo);
    } else player.seek(to);
    tMs.value = to;
  };

  /** Pause the song, the vocal recorder and the show recorder together: the take stays on the track timeline. */
  const pause = () => {
    const engine = engineRef.current;
    const player = engine?.player;
    if (!engine || !player?.playing) return;
    const at = engine.ctx.currentTime;
    recPos.current = player.positionAt(at);
    player.pause();
    engine.recorder?.pause(at);
    show.pause();
    setPhase('paused');
  };

  const resume = () => {
    const engine = engineRef.current;
    const player = engine?.player;
    if (!engine || !player || player.playing) return;
    const t0 = engine.ctx.currentTime + 0.12;
    const from = player.positionMs();
    player.play(t0, from);
    engine.recorder?.resume(t0);
    const delta = from - recPos.current; // a seek made while paused
    if (Math.abs(delta) > 30) engine.recorder?.seek(t0, delta / audio.tempo);
    show.resume();
    player.onEnded = () => void finishRef.current();
    setPhase('playing');
  };

  /** Throw the current take away and start the song again from the top. */
  const restart = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    cancelAnimationFrame(raf.current);
    engine.player?.stop();
    if (engine.recorder?.recording) await engine.recorder.stop().catch(() => undefined);
    await show.stop();
    tMs.value = 0;
    setPhase('ready');
    await start();
  };

  const finishRef = useRef<() => Promise<void>>(async () => undefined);
  const finish = async () => {
    const engine = engineRef.current;
    if (!engine || !loaded) return;
    cancelAnimationFrame(raf.current);
    setPhase('finishing');
    setCountdown(null);
    try {
      const player = engine.player!;
      const origin = takeOrigin.current || player.originCtxTime();
      const durationMs = Math.round(player.positionMs());
      player.onEnded = null;
      player.stop();
      let vocal: Blob;
      let vocalOffsetMs = 0;
      let sampleRate = engine.ctx.sampleRate;
      let pcm: Float32Array | null = null;
      if (engine.recorder?.recording) {
        const rec = await engine.recorder.stop();
        vocal = rec.wav;
        sampleRate = rec.sampleRate;
        vocalOffsetMs = (rec.startCtxTime - origin) * 1000;
        pcm = rec.pcm;
      } else {
        vocal = new Blob([], { type: 'audio/wav' });
      }
      // The show's first frame shows the stage as it was a lag earlier (its sources are held back): frame 0 ↔ that track position.
      const rec = await show.stop();
      const video = rec?.video ?? null;
      const videoOffsetMs = rec ? (rec.startCtxTime - origin) * 1000 - rec.lagMs : null;
      // My cut-out beside the show: its frames are live (not held back like the show's own picture), so its offset carries no lag.
      const cutout = rec?.cutout?.video ?? null;
      const cutoutOffsetMs = rec?.cutout ? Math.round((rec.cutout.startCtxTime - origin) * 1000) : null;
      layers?.sync(0, 0, false);
      engine.closeMic();
      await keepAwake(false);
      let latencyCompMs = Math.round(engine.roundTripMs);
      // What the microphone heard of the track (speakers), and the singer's own phrasing, laid against the track: a clear
      // lag beyond the figures corrects this take and is remembered for this device and microphone (audio/sync.ts).
      let heard: number | null = null;
      if (pcm && player.buffer && !join && audio.tempo === 1 && audio.keyShift === 0) {
        const found = bleedOffset(pcm, sampleRate, monoOf(player.buffer, 50), player.buffer.sampleRate, vocalOffsetMs - latencyCompMs);
        if (found) {
          heard = found.shiftMs;
          latencyCompMs += found.shiftMs;
          if (lagIsStrong(found.result)) engine.rememberDeviceLatency(Math.max(0, latencyCompMs - engine.chainLatencyMs), 'take');
        }
      }
      setHeardShift(heard);
      setTake({ vocal, video, cutout, durationMs, vocalOffsetMs: Math.round(vocalOffsetMs), videoOffsetMs: videoOffsetMs === null ? null : Math.round(videoOffsetMs), cutoutOffsetMs, latencyCompMs, sampleRate, startedAtEpochMs: startedEpoch.current });
      setPhase('review');
    } catch (e) {
      toast(errorText(e), 'error', 8000);
      setPhase('ready');
    }
  };
  finishRef.current = finish;

  if (props.joinId && !joinGo)
    return (
      <Page title="Join a performance">
        {!preview ? (
          <div class="row">
            <Spinner /> Reading the invitation…
          </div>
        ) : (
          <div class="stack" data-join-landing={preview.performanceId}>
            <section class="card stack">
              <h2 style="margin:0">
                {preview.trackTitle}
                {preview.trackArtist ? <span class="muted"> · {preview.trackArtist}</span> : null}
              </h2>
              <div class="muted small">
                Sung by {singersLine(preview.layers)} · {formatMs(preview.durationMs)} · opened for joining by {preview.ownerName} on {new Date(preview.createdAt).toLocaleDateString()}
                {preview.joins ? ` · ${preview.joins} joined already` : ''}
              </div>
              <div class="row wrap" style="gap:8px">
                {preview.layers.map((l) => (
                  <span class="chip" key={l.slot} style={{ borderColor: SLOT_COLORS[Math.min(10, l.slot) as SingerSlot] }}>
                    <span class="dot" style={{ background: SLOT_COLORS[Math.min(10, l.slot) as SingerSlot] }} /> {l.displayName} · singer {l.slot}
                    {l.cutout ? '' : ' · voice only'}
                  </span>
                ))}
              </div>
              {previewUrl ? <video src={previewUrl.url} controls playsInline style="width:100%;border-radius:12px;background:#000;max-height:50dvh" data-join-watch /> : null}
              <div class="row wrap" style="gap:8px">
                {!previewUrl && (
                  <button class="btn" disabled={previewBusy} onClick={() => void watch()} data-join-watch-open>
                    {previewBusy ? <Spinner /> : <IcPlay />} Watch it first
                  </button>
                )}
                <button class="btn primary lg" disabled={nextSlot(preview.layers) === 0} onClick={() => setJoinGo(true)} data-join-go>
                  <IcCamera /> Join — sing your part
                </button>
              </div>
              {nextSlot(preview.layers) === 0 ? (
                <div class="callout warn">This stage is full — ten singers are on it already.</div>
              ) : (
                <div class="small faint">
                  You will be singer {nextSlot(preview.layers)}: the performance so far plays as your backing track, the singers stand on your stage, and your voice and picture go in beside them — the camera is every Studio singer's here. The result is a performance of your own, in your Drive, that others can join in turn.
                </div>
              )}
            </section>
          </div>
        )}
      </Page>
    );

  if (phase === 'loading' || !track)
    return (
      <Page title={props.joinId ? 'Join a performance' : 'Sing'}>
        <div class="stack" data-join-loading={props.joinId ? '1' : undefined}>
          <div class="row">
            <Spinner /> {props.joinId ? (loading?.label ?? 'Reading the invitation…') : 'Loading track…'}
          </div>
          {props.joinId && loading && <Progress fraction={loading.fraction} label={loading.label} />}
        </div>
      </Page>
    );

  if (phase === 'review' && take && loaded)
    return (
      <Review
        take={take}
        loaded={loaded}
        slot={stageSlot}
        join={join?.invite ?? null}
        heardShift={heardShift}
        onAgain={() => {
          setTake(null);
          tMs.value = 0;
          setPhase('ready');
        }}
      />
    );

  const busy = phase === 'starting' || phase === 'finishing';
  const live = phase === 'playing' || phase === 'countdown' || phase === 'paused';
  const engine = engineRef.current;
  const pitch = engine?.pitch.value ?? null;

  return (
    <Page title={join ? `${track.title} · with ${singersLine(join.invite.layers)}` : track.title} nav={false} full>
      <div class="sing" data-layout="strip" data-join={join ? join.invite.performanceId : undefined} data-stage-slot={stageSlot}>
        <StageBackground id={app.backgroundId} />
        <VirtualStage compositor={compositor} />
        <section class="stagebar" data-blend={blend} data-mask={feed.segmenter.maskMode} data-performers={compositor.tiles.length}>
          {join && (
            <span class="chip ok" data-join-with>
              joining {singersLine(join.invite.layers)} · you are singer {stageSlot}
            </span>
          )}
          {camOn && blend === 'loading' && <span class="chip">blending you into the stage…</span>}
          {camOn && blend === 'oval' && app.cutout && <span class="chip warn">soft-focus mode (cut-out model unavailable)</span>}
          {camOn && camHealth !== 'ok' && (
            <button class="btn sm accent" data-cam-health={camHealth} onClick={() => void restartCam()}>
              {camHealth === 'frozen' ? 'Your camera froze — restart it' : camHealth === 'muted' ? 'Your camera was muted — restart it' : 'Your camera stopped — restart it'}
            </button>
          )}
          {!camOn && <span class="chip">{videoAllowed ? 'camera off' : 'audio only · no camera'}</span>}
        </section>
        {track.video ? (
          <KaraokeVideo track={track} tMs={tMs} playing={phase === 'playing'} rate={audio.tempo} countdown={phase === 'countdown' ? countdown : null} />
        ) : (
          <LyricsPanel lines={track.lyrics} tMs={tMs} mySlot={mySlot} plan={planParts(track.singerCount, [])} countdown={phase === 'countdown' ? countdown : null} showWho={track.singerCount > 1} title={track.title} />
        )}
        {app.showCueDeck && track.singerCount > 1 && phase === 'playing' && <CueDeck lines={track.lyrics} tMs={tMs} mySlot={mySlot} plan={planParts(track.singerCount, [])} />}
        <section class="controls compact">
          <SeekBar tMs={tMs} durationMs={track.durationMs} onSeek={!join && (phase === 'playing' || phase === 'paused') ? seek : undefined} />
          <div class="main">
            <button class={`btn icon ${app.cameraOn && videoAllowed ? 'on' : ''}`} aria-label="Camera" title={videoAllowed ? 'Camera' : 'Your account is audio only — no camera'} onClick={() => updateApp({ cameraOn: !app.cameraOn })} disabled={busy || !videoAllowed}>
              {app.cameraOn && videoAllowed ? <IcCamera /> : <IcCameraOff />}
            </button>
            <button class={`btn icon ${audio.monitor ? 'on' : ''}`} aria-label="Hear myself" title="Hear myself (use headphones)" onClick={() => updateAudio({ monitor: !audio.monitor })}>
              <IcHeadphones />
            </button>
            <button class="btn icon" aria-label="Sound" title="Sound: the voice preset and its tweaks, the microphone, the track and vocal volumes" onClick={() => setFxOpen(true)}>
              <IcSliders />
            </button>
            <button class="btn icon" aria-label="Stage setup" title="Stage setup: my part, my picture and framing, the count-in" onClick={() => setSetupOpen(true)} disabled={live}>
              <IcZoom />
            </button>
            <button class="btn icon" aria-label="Stage background" title="Stage background" onClick={() => setBgOpen(true)}>
              <IcImage />
            </button>
            <button class={`btn icon ${tvLink.state.value === 'on' ? 'on' : ''}`} aria-label="TV" title="TV: your stage on the TV in the room — type the code the TV shows" data-tv-button onClick={() => setTvOpen(true)}>
              <IcTv />
            </button>
            {live ? (
              <>
                {phase === 'paused' ? (
                  <button class="btn big primary" aria-label="Resume" onClick={resume}>
                    <IcPlay /> Resume
                  </button>
                ) : (
                  <button class="btn big" aria-label="Pause" disabled={phase !== 'playing'} onClick={pause}>
                    <IcPause /> Pause
                  </button>
                )}
                <button class="btn icon" aria-label="Restart from the top" title="Restart from the top" onClick={() => void restart()} disabled={phase === 'countdown'}>
                  <IcSkipBack />
                </button>
                <button class="btn big accent" onClick={() => void finish()}>
                  <IcStop /> Finish
                </button>
              </>
            ) : (
              <button class="btn big primary" onClick={() => void start()} disabled={busy}>
                {busy ? <Spinner /> : <IcPlay />} {busy ? (phase === 'finishing' ? 'Wrapping up…' : 'Starting…') : 'Start singing'}
              </button>
            )}
          </div>
          <div class="row between small">
            <div class="row" style="gap:8px">
              {engine?.micOpen.value && (
                <span class="pitch-pill">
                  <LevelDot engine={engine} />
                  {pitch && pitch.clarity > 0.7 ? `${noteName(pitch.midi)} ${pitch.cents >= 0 ? '+' : ''}${pitch.cents}¢` : 'mic on'}
                </span>
              )}
              {!live && headphones === false && (
                <span class="chip warn">
                  <IcHeadphones size={14} /> headphones recommended
                </span>
              )}
            </div>
            <span class="chip" style={{ borderColor: SLOT_COLORS[mySlot] }}>
              <span class="dot" style={{ background: SLOT_COLORS[mySlot] }} /> Singer {mySlot}
            </span>
          </div>
        </section>
      </div>

      <Sheet open={fxOpen} onClose={() => setFxOpen(false)} title="Sound">
        <div class="stack">
          <PresetChips value={audio} onChange={updateAudio} />
          <MicStatus
            engine={engineRef.current}
            onChange={() => {
              const engine = engineRef.current;
              if (!engine?.micOpen.value) return;
              void openMicWithCamera(engine, camera).catch((e) => toast(errorText(e), 'error'));
            }}
          />
          <MixBalance />
          <div class="grid-2">
            <Field label={`Backing level in your ears ${Math.round(audio.backingGain * 100)}%`}>
              <input type="range" min={0} max={1} step={0.01} value={audio.backingGain} onInput={(e) => updateAudio({ backingGain: Number((e.currentTarget as HTMLInputElement).value) })} />
            </Field>
            <Field label={join ? 'Tempo 1.00× (a join sings the show as it was sung)' : `Tempo ${audio.tempo.toFixed(2)}× (key kept)`}>
              <input type="range" min={0.5} max={1.5} step={0.01} value={join ? 1 : audio.tempo} disabled={join !== null} data-tempo onInput={(e) => updateAudio({ tempo: Number((e.currentTarget as HTMLInputElement).value) })} />
            </Field>
            <Field label={join ? 'Key shift 0 st (as it was sung)' : `Key shift ${audio.keyShift > 0 ? '+' : ''}${audio.keyShift} st`}>
              <input type="range" min={-6} max={6} step={1} value={join ? 0 : audio.keyShift} disabled={join !== null} data-key-shift onInput={(e) => updateAudio({ keyShift: Number((e.currentTarget as HTMLInputElement).value) })} />
            </Field>
            <Switch checked={audio.monitor} onChange={(v) => updateAudio({ monitor: v })} label="Hear myself" hint="Only with headphones — speakers will feed back." />
          </div>
          <FxPanel value={audio} onChange={updateAudio} />
        </div>
      </Sheet>

      <Sheet open={tvOpen} onClose={() => setTvOpen(false)} title="TV — your stage on the big screen">
        <TvPanel />
      </Sheet>

      <Sheet open={setupOpen} onClose={() => setSetupOpen(false)} title="Stage setup">
        <div class="stack">
          <Field label="I'm singing as">
            <div class="row" style="gap:6px">
              {Array.from({ length: track.singerCount }, (_, i) => (i + 1) as SingerSlot).map((s) => (
                <button key={s} class={`btn sm ${mySlot === s ? 'accent' : ''}`} onClick={() => (join ? setJoinPart(s) : updateApp({ singerSlot: s }))}>
                  <span class="dot" style={{ background: SLOT_COLORS[s] }} /> Singer {s}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Camera" hint="You are framed the same way as every singer on every stage — head the same size, at the same place — however near or far you sit.">
            <div class="row">
              <button class="btn sm" onClick={() => void camera.flip().then(() => updateApp({ cameraFacing: camera.facing.value })).catch(() => toast('Only one camera here', 'warn'))}>
                <IcFlip size={18} /> Flip
              </button>
            </div>
          </Field>
          <PictureChoices compact />
          <Switch checked={app.countIn} onChange={(v) => updateApp({ countIn: v })} label="3-2-1 count-in" />
          <Switch checked={app.showCueDeck} onChange={(v) => updateApp({ showCueDeck: v })} label="Cue deck (my next lines)" />
          <Field label="Stage background">
            <button class="btn" onClick={() => (setSetupOpen(false), setBgOpen(true))}>
              <IcImage /> Choose background
            </button>
          </Field>
          {isIOS && <div class="callout">On iOS, keep SingersVoice in the foreground while singing — Safari pauses the microphone in the background.</div>}
        </div>
      </Sheet>

      <Sheet open={bgOpen} onClose={() => setBgOpen(false)} title="Stage background">
        <BackgroundPicker value={app.backgroundId} onChange={(id) => updateApp({ backgroundId: id })} />
      </Sheet>
    </Page>
  );
}

// ---------------- Review / keep ----------------

export function Review(props: {
  take: TakeResult;
  loaded: LoadedTrack;
  /** The slot sung: the part, or — for a join — the place taken on the stage. */
  slot: number;
  onAgain: () => void;
  /** 'live' takes are filed under Performances/Live (a live stage saves its takes by itself; this review is the Studio's). */
  mode?: 'offline' | 'live';
  meetId?: string | null;
  /** The performance this take was sung over (lib/joins.ts): the take is saved with everyone on it. */
  join?: JoinInvite | null;
  onSaved?: (summary: { performanceId: string; link?: string; videoLink?: string; state: 'temp' | 'kept' }) => void;
  againLabel?: string;
  /** What the microphone heard of the track: the lag found beyond the device's figures (ms), when it was (audio/sync.ts). */
  heardShift?: number | null;
}) {
  const { take, loaded } = props;
  const heardShift = props.heardShift ?? null;
  const [nudge, setNudge] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState<{ label: string; fraction: number } | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedState, setSavedState] = useState<'temp' | 'kept' | null>(null);
  const [inviting, setInviting] = useState<{ label: string; fraction: number } | null>(null);
  const [joinLink, setJoinLink] = useState<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodes = useRef<AudioBufferSourceNode[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoUrl = useMemo(() => (take.video && take.video.size > 0 ? URL.createObjectURL(take.video) : ''), [take.video]);
  useEffect(() => () => videoUrl && URL.revokeObjectURL(videoUrl), [videoUrl]);

  const alignMs = take.vocalOffsetMs - take.latencyCompMs + nudge; // vocal sample 0 sits here on the track timeline

  // Auto-save to Temp as soon as the take exists (nothing is lost if the tab closes).
  useEffect(() => {
    void saveTake('temp');
    return () => stop();
  }, []);

  const stop = () => {
    for (const n of nodes.current) {
      try {
        n.stop();
      } catch {
        /* not started */
      }
    }
    nodes.current = [];
    setPlaying(false);
    videoRef.current?.pause();
  };

  const play = async () => {
    stop();
    const ctx = ctxRef.current ?? new AudioContext();
    ctxRef.current = ctx;
    await ctx.resume();
    const [backing, vocal] = await Promise.all([
      loaded.audio.arrayBuffer().then((b) => ctx.decodeAudioData(b)),
      take.vocal.size ? take.vocal.arrayBuffer().then((b) => ctx.decodeAudioData(b)) : Promise.resolve(null),
    ]);
    const at = ctx.currentTime + 0.2;
    const b = ctx.createBufferSource();
    b.buffer = backing;
    const bg = ctx.createGain();
    bg.gain.value = audioSettings.peek().backingGain;
    b.connect(bg).connect(ctx.destination);
    b.start(at);
    nodes.current.push(b);
    if (vocal) {
      const v = ctx.createBufferSource();
      v.buffer = vocal;
      v.connect(ctx.destination);
      if (alignMs >= 0) v.start(at + alignMs / 1000);
      else v.start(at, -alignMs / 1000);
      nodes.current.push(v);
    }
    b.onended = () => setPlaying(false);
    if (videoRef.current && take.videoOffsetMs !== null) {
      const vo = take.videoOffsetMs / 1000;
      videoRef.current.currentTime = Math.max(0, -vo);
      setTimeout(() => void videoRef.current?.play().catch(() => undefined), Math.max(0, vo * 1000) + 200);
    }
    setPlaying(true);
  };

  async function saveTake(state: 'temp' | 'kept'): Promise<void> {
    if (!take.vocal.size && !take.video) return;
    setSaving({ label: state === 'temp' ? 'Securing take in Temp' : 'Keeping performance', fraction: 0.02 });
    try {
      if (savedId && state === 'kept') {
        await withProvider((p) => p.keepPerformance(savedId));
      } else {
        const j = props.join;
        const me = { slot: props.slot, displayName: profile.value?.name || 'You', ...(accountUserId.value ? { userId: accountUserId.value } : {}) };
        const manifest = await buildManifest(take, loaded.track, {
          state,
          mode: props.mode ?? 'offline',
          slot: props.slot,
          meetId: props.meetId ?? null,
          performanceId: savedId ?? undefined,
          nudgeMs: nudge,
          // A join: the take has everyone on it — the singers it inherited and me — and remembers what it sang over.
          ...(j ? { kind: 'show' as const, singers: [...j.layers.map((l) => ({ slot: l.slot, displayName: l.displayName, ...(l.userId ? { userId: l.userId } : {}) })), me], join: joinOfTake(j, take) } : {}),
        });
        const s = await persistTake(manifest, take, (pr) => setSaving(pr));
        setSavedId(s.performanceId);
        props.onSaved?.({ performanceId: s.performanceId, link: s.link, videoLink: s.videoLink, state });
      }
      setSavedState(state);
      if (state === 'kept') toast(`Kept in ${isDrive.value ? `Drive › SingersVoice › Performances › ${props.mode === 'live' ? 'Live' : 'Offline'}` : 'Performances'}`, 'ok', 5000);
    } catch (e) {
      toast(`Could not save the take: ${errorText(e)}`, 'error', 10000, { label: 'Retry', onClick: () => void saveTake(state) });
    } finally {
      setSaving(null);
    }
  }

  /** Open this take for others to sing over (kept, shared, on record) and hand out the link. */
  const invite = async () => {
    if (!savedId) return;
    setInviting({ label: 'Opening for joining', fraction: 0.05 });
    try {
      const { url } = await invitePerformance(savedId, setInviting);
      setSavedState('kept');
      setJoinLink(url);
      const r = await shareOrCopy(`Join me on "${loaded.track.title}"`, 'Sing this with me on SingersVoice', url);
      toast(r === 'copied' ? 'Join link copied — send it to whoever sings next' : r === 'shared' ? 'Join link shared' : 'Open for joining — the link is below', r === 'failed' ? 'warn' : 'ok', 7000);
    } catch (e) {
      toast(errorText(e), 'error', 9000);
    } finally {
      setInviting(null);
    }
  };

  const discard = async () => {
    if (!confirm('Discard this take?')) return;
    stop();
    try {
      if (savedId) await withProvider((p) => p.deletePerformance(savedId));
    } catch (e) {
      toast(errorText(e), 'warn');
    }
    props.onAgain();
  };

  return (
    <Page title="Your take">
      <div class="stack" data-review data-saved-id={savedId ?? undefined} data-saved-state={savedState ?? undefined}>
        <div class="review-hero">
          <h2>
            {loaded.track.title}
            {props.join ? <span class="muted"> · with {singersLine(props.join.layers)}</span> : null}
          </h2>
          <div class="muted small">
            {formatMs(take.durationMs)} · vocal {take.vocal.size ? `${(take.vocal.size / 1048576).toFixed(1)} MB WAV` : 'not captured'}
            {take.video && take.video.size ? ` · show video ${(take.video.size / 1048576).toFixed(1)} MB` : ''}
            {take.cutout && take.cutout.size ? ` · your cut-out ${(take.cutout.size / 1048576).toFixed(1)} MB` : ''}
          </div>
          {savedState === 'temp' && <span class="chip warn">In Temp — auto-deletes in 7 days unless kept</span>}
          {savedState === 'kept' && <span class="chip ok">Kept</span>}
          {saving && <Progress fraction={saving.fraction} label={saving.label} />}
        </div>
        <div class="perf-player">
          {videoUrl && <video ref={videoRef} src={videoUrl} muted playsInline />}
          {videoUrl && <div class="small faint">The video is the show itself — your cut-out on the stage, as Publisher mode shows it, with the mix as its sound.</div>}
          <div class="row">
            <button class="btn primary" onClick={() => (playing ? stop() : void play())}>
              {playing ? <IcStop /> : <IcPlay />} {playing ? 'Stop' : 'Play mix'}
            </button>
            <div style="flex:1">
              <div class="label">Vocal alignment {nudge >= 0 ? '+' : ''}{nudge} ms</div>
              <input type="range" min={-300} max={300} step={10} value={nudge} onInput={(e) => setNudge(Number((e.currentTarget as HTMLInputElement).value))} />
            </div>
          </div>
          <div class="small faint">
            {heardShift !== null ? `Aligned by what the microphone heard of the track (${heardShift >= 0 ? '+' : ''}${heardShift} ms beyond the device's figures; remembered for this device). ` : 'Auto-aligned by the audio clock. '}
            (offset {take.vocalOffsetMs} ms, latency comp {take.latencyCompMs} ms). Nudge if your voice still lands early or late.
          </div>
        </div>
        <div class="grid-2">
          <button class="btn accent lg" disabled={saving !== null || savedState === 'kept'} onClick={() => void saveTake('kept')}>
            Keep
          </button>
          <button class="btn danger lg" disabled={saving !== null} onClick={() => void discard()}>
            Discard
          </button>
        </div>
        {take.video && take.video.size > 0 && isDrive.value && (props.mode ?? 'offline') === 'offline' && (
          <section class="card stack pad-sm" data-invite>
            <h3 style="margin:0">Sing it with others</h3>
            <div class="small muted">Open this take for others to join: whoever has the link sings their part over it — their voice and picture go on the stage beside {props.join ? 'everyone' : 'you'}, and the result is a performance of its own. The take is kept and shared for that; the camera is every singer's here.</div>
            {!joinLink ? (
              <button class="btn primary" disabled={saving !== null || inviting !== null || !savedId} onClick={() => void invite()} data-invite-open>
                {inviting ? <Spinner /> : <IcShare />} {inviting ? inviting.label : 'Invite others to join'}
              </button>
            ) : (
              <div class="row wrap" style="gap:8px">
                <input class="input mono" readOnly value={joinLink} style="flex:1;min-width:16em" data-join-link onFocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
                <button class="btn" onClick={() => void shareOrCopy(`Join me on "${loaded.track.title}"`, 'Sing this with me on SingersVoice', joinLink).then((r) => toast(r === 'copied' ? 'Join link copied' : r === 'shared' ? 'Shared' : joinLink, r === 'failed' ? 'warn' : 'ok'))} data-join-copy>
                  <IcShare /> Copy link
                </button>
              </div>
            )}
            {inviting && <Progress fraction={inviting.fraction} label={inviting.label} />}
          </section>
        )}
        <div class="row">
          <button class="btn" onClick={() => (stop(), props.onAgain())}>
            {props.againLabel ?? (props.join ? 'Sing it again' : 'Sing again')}
          </button>
          <a class="btn ghost" href={href('/studio/performances')}>
            All performances
          </a>
        </div>
      </div>
    </Page>
  );
}
