import {
  formatMs,
  newId,
  SLOT_COLORS,
  tempExpiry,
  type FileEntry,
  type PerformanceManifest,
  type SingerSlot,
  type TrackPackageV2,
} from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getEngine, noteName, type AudioEngine } from '../audio/engine.ts';
import { StageBackground, BackgroundPicker } from '../components/BackgroundPicker.tsx';
import { CameraTile } from '../components/CameraTile.tsx';
import { FxPanel, PresetChips } from '../components/FxPanel.tsx';
import { IcCamera, IcCameraOff, IcFlip, IcHeadphones, IcImage, IcPlay, IcSliders, IcStop, IcZoom } from '../components/icons.tsx';
import { CueDeck, LyricsPanel } from '../components/LyricsPanel.tsx';
import { Page } from '../components/Shell.tsx';
import { Empty, Field, Progress, Seg, Sheet, Spinner, Switch } from '../components/ui.tsx';
import { sha256Blob } from '../lib/hash.ts';
import { go, href } from '../lib/nav.ts';
import { headphonesLikely, isIOS, keepAwake, platformName } from '../lib/platform.ts';
import type { LoadedTrack, TrackSummary } from '../lib/storage/types.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isDrive, withProvider } from '../state/session.ts';
import { appSettings, audioSettings, updateApp, updateAudio } from '../state/settings.ts';
import { Camera, pickVideoMime, ZOOM_LEVELS, type ZoomPreset } from '../video/camera.ts';

type Phase = 'loading' | 'ready' | 'starting' | 'countdown' | 'playing' | 'finishing' | 'review';

export interface TakeResult {
  vocal: Blob;
  video: Blob | null;
  durationMs: number;
  vocalOffsetMs: number;
  videoOffsetMs: number | null;
  latencyCompMs: number;
  sampleRate: number;
  startedAtEpochMs: number;
}

/** Track picker (/sing). */
export function SingPicker() {
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  useEffect(() => {
    void withProvider(async (p) => {
      await p.ready();
      setTracks(await p.listTracks());
    }).catch(() => setTracks([]));
  }, []);
  return (
    <Page title="Pick a track">
      {tracks === null && (
        <div class="row">
          <Spinner /> Loading…
        </div>
      )}
      {tracks && !tracks.length && (
        <Empty title="No tracks yet" body="Make one in Track Maker first — it takes a song file and your lyrics.">
          <a class="btn primary" href={href('/trackmaker')}>
            Open Track Maker
          </a>
        </Empty>
      )}
      <div class="list">
        {tracks?.map((t) => (
          <a class="item" key={t.trackId} href={href(`/sing/${encodeURIComponent(t.trackId)}`)}>
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
    </Page>
  );
}

/** The lyrics-first stage (/sing/:id). */
export function Sing(props: { id: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [loaded, setLoaded] = useState<LoadedTrack | null>(null);
  const [tMs, setTMs] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [fxOpen, setFxOpen] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [take, setTake] = useState<TakeResult | null>(null);
  const [headphones, setHeadphones] = useState<boolean | null>(null);
  const engineRef = useRef<AudioEngine | null>(null);
  const camera = useMemo(() => new Camera(), []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRec = useRef<MediaRecorder | null>(null);
  const videoChunks = useRef<Blob[]>([]);
  const videoStartCtx = useRef<number | null>(null);
  const startedEpoch = useRef(0);
  const raf = useRef(0);

  const app = appSettings.value;
  const audio = audioSettings.value;
  const track: TrackPackageV2 | null = loaded?.track ?? null;
  const mySlot = Math.min(app.singerSlot, track?.singerCount ?? 1) as SingerSlot;

  // Load the track.
  useEffect(() => {
    setPhase('loading');
    void withProvider(async (p) => {
      const t = await p.getTrack(decodeURIComponent(props.id));
      if (!t) throw new Error('Track not found (was it deleted?)');
      setLoaded(t);
      setPhase('ready');
    }).catch((e) => {
      toast(errorText(e), 'error', 7000);
      go('/sing', true);
    });
    void headphonesLikely().then(setHeadphones);
    return () => {
      cancelAnimationFrame(raf.current);
      camera.close();
      void engineRef.current?.close();
      engineRef.current = null;
      void keepAwake(false);
    };
  }, [props.id]);

  // Apply FX whenever settings change.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.applyFx(audio.params);
    e.setMonitor(audio.monitor);
    e.player?.setGain(audio.backingGain);
    e.player?.setTempo(audio.tempo);
    e.player?.setKeyShift(audio.keyShift);
  }, [audio]);

  // Camera on/off follows settings while on stage.
  useEffect(() => {
    if (phase === 'loading' || phase === 'review') return;
    if (app.cameraOn && !camera.on.value) {
      camera.open({ facing: app.cameraFacing, deviceId: app.cameraDeviceId || undefined }).then(() => camera.setPreset(app.zoomPreset)).catch(() => toast('Camera unavailable — singing without video', 'warn'));
    } else if (!app.cameraOn && camera.on.value) camera.close();
  }, [app.cameraOn, app.cameraFacing, app.cameraDeviceId, phase]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (phase === 'playing' || phase === 'countdown') {
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
      await engine.openMic({ deviceId: app.audioInputId || undefined, echoCancellation: app.echoCancellation });
      engine.applyFx(audio.params);
      engine.setMonitor(audio.monitor);
      const player = engine.player!;
      if (!player.buffer) await player.load(loaded.audio);
      player.setGain(audio.backingGain);
      player.setTempo(audio.tempo);
      player.setKeyShift(audio.keyShift);
      await keepAwake(true);

      const lead = app.countIn ? 3 : 0.6;
      const t0 = engine.ctx.currentTime + lead + 0.15;
      // Recorder runs from before the song starts; its first-frame clock gives the exact offset.
      const recStart = engine.recorder ? engine.recorder.start() : Promise.resolve(engine.ctx.currentTime);
      player.play(t0, 0);
      startedEpoch.current = Date.now() + Math.round((t0 - engine.ctx.currentTime) * 1000);
      void recStart;

      // Camera video via MediaRecorder (video only).
      videoChunks.current = [];
      videoStartCtx.current = null;
      if (camera.stream && pickVideoMime()) {
        try {
          const mr = new MediaRecorder(camera.stream, { mimeType: pickVideoMime(), videoBitsPerSecond: 1_800_000 });
          mr.ondataavailable = (e) => e.data.size && videoChunks.current.push(e.data);
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
      setPhase(app.countIn ? 'countdown' : 'playing');
      const tick = () => {
        const ctxNow = engine.ctx.currentTime;
        if (ctxNow < t0) {
          setCountdown(Math.ceil(t0 - ctxNow));
        } else {
          setCountdown(null);
          setPhase((p) => (p === 'countdown' ? 'playing' : p));
          setTMs(Math.max(0, player.positionMs() - engine.outputLatencyMs));
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (e) {
      setPhase('ready');
      toast(errorText(e), 'error', 8000);
    }
  };

  const finish = async () => {
    const engine = engineRef.current;
    if (!engine || !loaded) return;
    cancelAnimationFrame(raf.current);
    setPhase('finishing');
    setCountdown(null);
    try {
      const player = engine.player!;
      const origin = player.originCtxTime();
      const durationMs = Math.round(player.positionMs());
      player.onEnded = null;
      player.stop();
      let vocal: Blob;
      let vocalOffsetMs = 0;
      let sampleRate = engine.ctx.sampleRate;
      if (engine.recorder?.recording) {
        const rec = await engine.recorder.stop();
        vocal = rec.wav;
        sampleRate = rec.sampleRate;
        vocalOffsetMs = (rec.startCtxTime - origin) * 1000;
      } else {
        vocal = new Blob([], { type: 'audio/wav' });
      }
      let video: Blob | null = null;
      let videoOffsetMs: number | null = null;
      const mr = mediaRec.current;
      if (mr && mr.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          mr.onstop = () => resolve();
          mr.stop();
        });
        video = new Blob(videoChunks.current, { type: mr.mimeType });
        videoOffsetMs = videoStartCtx.current !== null ? (videoStartCtx.current - origin) * 1000 : null;
      }
      mediaRec.current = null;
      engine.closeMic();
      camera.cancelAutoZoom();
      await keepAwake(false);
      const latencyCompMs = Math.round(engine.outputLatencyMs * 2);
      setTake({ vocal, video, durationMs, vocalOffsetMs: Math.round(vocalOffsetMs), videoOffsetMs: videoOffsetMs === null ? null : Math.round(videoOffsetMs), latencyCompMs, sampleRate, startedAtEpochMs: startedEpoch.current });
      setPhase('review');
    } catch (e) {
      toast(errorText(e), 'error', 8000);
      setPhase('ready');
    }
  };

  if (phase === 'loading' || !track)
    return (
      <Page title="Sing">
        <div class="row">
          <Spinner /> Loading track…
        </div>
      </Page>
    );

  if (phase === 'review' && take && loaded)
    return (
      <Review
        take={take}
        loaded={loaded}
        slot={mySlot}
        onAgain={() => {
          setTake(null);
          setTMs(0);
          setPhase('ready');
        }}
      />
    );

  const stageSolo = true; // live "others" tiles arrive with meets (sv-control)
  const busy = phase === 'starting' || phase === 'finishing';
  const live = phase === 'playing' || phase === 'countdown';
  const engine = engineRef.current;
  const pitch = engine?.pitch.value ?? null;
  const level = engine?.recorder?.level.value ?? 0;

  return (
    <Page title={track.title} nav={false} full>
      <div class="sing">
        <StageBackground id={app.backgroundId} />
        <section class={`stage ${stageSolo ? 'solo' : ''}`}>
          {!stageSolo && <div class="others" />}
          <CameraTile camera={camera} cutout={app.cutout} label={`You · S${mySlot}`} videoRef={videoRef} onCutoutError={() => toast('Cutout unavailable here — showing plain video', 'warn')} />
        </section>
        <LyricsPanel lines={track.lyrics} tMs={tMs} mySlot={mySlot} countdown={phase === 'countdown' ? countdown : null} showWho={track.singerCount > 1} title={track.title} />
        {app.showCueDeck && track.singerCount > 1 && phase === 'playing' && <CueDeck lines={track.lyrics} tMs={tMs} mySlot={mySlot} />}
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
            <button class={`btn icon ${app.cameraOn ? 'on' : ''}`} aria-label="Camera" onClick={() => updateApp({ cameraOn: !app.cameraOn })} disabled={busy}>
              {app.cameraOn ? <IcCamera /> : <IcCameraOff />}
            </button>
            <button class={`btn icon ${audio.monitor ? 'on' : ''}`} aria-label="Hear myself" title="Hear myself (use headphones)" onClick={() => updateAudio({ monitor: !audio.monitor })}>
              <IcHeadphones />
            </button>
            {live ? (
              <button class="btn big accent" onClick={() => void finish()}>
                <IcStop /> Finish take
              </button>
            ) : (
              <button class="btn big primary" onClick={() => void start()} disabled={busy}>
                {busy ? <Spinner /> : <IcPlay />} {busy ? (phase === 'finishing' ? 'Wrapping up…' : 'Starting…') : 'Start singing'}
              </button>
            )}
            <button class="btn icon" aria-label="Voice FX" onClick={() => setFxOpen(true)}>
              <IcSliders />
            </button>
            <button class="btn icon" aria-label="Stage setup" onClick={() => setSetupOpen(true)} disabled={live}>
              <IcZoom />
            </button>
          </div>
          <div class="row between small">
            <div class="row" style="gap:8px">
              {engine?.micOpen.value && (
                <span class="pitch-pill">
                  <span class="dot" style={{ background: level > 0.9 ? 'var(--danger)' : 'var(--ok)', opacity: 0.4 + level * 0.6 }} />
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

      <Sheet open={fxOpen} onClose={() => setFxOpen(false)} title="VoxForge voice">
        <div class="stack">
          <div class="grid-2">
            <Field label={`Backing level ${Math.round(audio.backingGain * 100)}%`}>
              <input type="range" min={0} max={1} step={0.01} value={audio.backingGain} onInput={(e) => updateAudio({ backingGain: Number((e.currentTarget as HTMLInputElement).value) })} />
            </Field>
            <Field label={`Tempo ${audio.tempo.toFixed(2)}× (key kept)`}>
              <input type="range" min={0.5} max={1.5} step={0.01} value={audio.tempo} onInput={(e) => updateAudio({ tempo: Number((e.currentTarget as HTMLInputElement).value) })} />
            </Field>
            <Field label={`Key shift ${audio.keyShift > 0 ? '+' : ''}${audio.keyShift} st`}>
              <input type="range" min={-6} max={6} step={1} value={audio.keyShift} onInput={(e) => updateAudio({ keyShift: Number((e.currentTarget as HTMLInputElement).value) })} />
            </Field>
            <Switch checked={audio.monitor} onChange={(v) => updateAudio({ monitor: v })} label="Hear myself" hint="Only with headphones — speakers will feed back." />
          </div>
          <FxPanel value={audio} onChange={updateAudio} />
        </div>
      </Sheet>

      <Sheet open={setupOpen} onClose={() => setSetupOpen(false)} title="Stage setup">
        <div class="stack">
          <Field label="I'm singing as">
            <div class="row" style="gap:6px">
              {Array.from({ length: track.singerCount }, (_, i) => (i + 1) as SingerSlot).map((s) => (
                <button key={s} class={`btn sm ${mySlot === s ? 'accent' : ''}`} onClick={() => updateApp({ singerSlot: s })}>
                  <span class="dot" style={{ background: SLOT_COLORS[s] }} /> Singer {s}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Camera framing">
            <div class="row">
              <Seg<ZoomPreset>
                value={app.zoomPreset}
                onChange={(v) => {
                  updateApp({ zoomPreset: v });
                  camera.setPreset(v);
                }}
                options={[
                  { v: 'wide', label: 'Wide' },
                  { v: 'mid', label: 'Mid' },
                  { v: 'close', label: 'Close' },
                ]}
              />
              <button class="btn sm" onClick={() => void camera.flip().then(() => updateApp({ cameraFacing: camera.facing.value })).catch(() => toast('Only one camera here', 'warn'))}>
                <IcFlip size={18} /> Flip
              </button>
            </div>
          </Field>
          <Switch checked={app.autoZoom} onChange={(v) => updateApp({ autoZoom: v })} label="AutoZoom" hint="Eases from wide to your framing during the intro." />
          <Switch checked={app.cutout} onChange={(v) => updateApp({ cutout: v })} label="Person cut-out (no rectangle)" hint="Loads a small segmentation model; uses more battery." />
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

function Review(props: { take: TakeResult; loaded: LoadedTrack; slot: SingerSlot; onAgain: () => void }) {
  const { take, loaded } = props;
  const [nudge, setNudge] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState<{ label: string; fraction: number } | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedState, setSavedState] = useState<'temp' | 'kept' | null>(null);
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

  async function buildManifest(state: 'temp' | 'kept'): Promise<PerformanceManifest> {
    const files: FileEntry[] = [{ name: 'vocal.wav', mimeType: 'audio/wav', size: take.vocal.size, sha256: await sha256Blob(take.vocal) }];
    if (take.video && take.video.size) {
      const ext = take.video.type.includes('mp4') ? 'mp4' : 'webm';
      files.push({ name: `video.${ext}`, mimeType: take.video.type, size: take.video.size, sha256: await sha256Blob(take.video) });
    }
    const createdAt = new Date(take.startedAtEpochMs || Date.now()).toISOString();
    return {
      schema: 'singersvoice.performance.v2',
      performanceId: savedId ?? newId('perf-'),
      mode: 'offline',
      state,
      createdAt,
      expiresAt: state === 'temp' ? tempExpiry(new Date(createdAt)) : null,
      trackId: loaded.track.trackId,
      trackTitle: loaded.track.title,
      trackArtist: loaded.track.artist,
      singerSlot: props.slot,
      meetId: null,
      durationMs: take.durationMs,
      timeline: {
        startedAtEpochMs: take.startedAtEpochMs,
        vocalOffsetMs: take.vocalOffsetMs - take.latencyCompMs + nudge,
        videoOffsetMs: take.videoOffsetMs,
        latencyCompMs: take.latencyCompMs,
        sampleRate: take.sampleRate,
      },
      playback: { tempo: audioSettings.peek().tempo, keyShift: audioSettings.peek().keyShift, backingGain: audioSettings.peek().backingGain },
      fx: audioSettings.peek().params,
      device: { userAgent: navigator.userAgent, platform: platformName, headphones: null },
      files,
      notes: '',
    };
  }

  async function saveTake(state: 'temp' | 'kept'): Promise<void> {
    if (!take.vocal.size && !take.video) return;
    setSaving({ label: state === 'temp' ? 'Securing take in Temp' : 'Keeping performance', fraction: 0.02 });
    try {
      const manifest = await buildManifest(state);
      if (savedId && state === 'kept') {
        await withProvider((p) => p.keepPerformance(savedId));
      } else {
        const s = await withProvider((p) => p.savePerformance(manifest, { vocal: take.vocal, video: take.video && take.video.size ? take.video : null }, (pr) => setSaving(pr)));
        setSavedId(s.performanceId);
      }
      setSavedState(state);
      if (state === 'kept') toast(`Kept in ${isDrive.value ? 'Drive › SingersVoice › Performances › Offline' : 'Performances'}`, 'ok', 5000);
    } catch (e) {
      toast(`Could not save the take: ${errorText(e)}`, 'error', 10000, { label: 'Retry', onClick: () => void saveTake(state) });
    } finally {
      setSaving(null);
    }
  }

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
      <div class="stack">
        <div class="review-hero">
          <h2>{loaded.track.title}</h2>
          <div class="muted small">
            {formatMs(take.durationMs)} · vocal {take.vocal.size ? `${(take.vocal.size / 1048576).toFixed(1)} MB WAV` : 'not captured'}
            {take.video && take.video.size ? ` · video ${(take.video.size / 1048576).toFixed(1)} MB` : ''}
          </div>
          {savedState === 'temp' && <span class="chip warn">In Temp — auto-deletes in 7 days unless kept</span>}
          {savedState === 'kept' && <span class="chip ok">Kept</span>}
          {saving && <Progress fraction={saving.fraction} label={saving.label} />}
        </div>
        <div class="perf-player">
          {videoUrl && <video ref={videoRef} src={videoUrl} muted playsInline />}
          <div class="row">
            <button class="btn primary" onClick={() => (playing ? stop() : void play())}>
              {playing ? <IcStop /> : <IcPlay />} {playing ? 'Stop' : 'Play mix'}
            </button>
            <div style="flex:1">
              <div class="label">Vocal alignment {nudge >= 0 ? '+' : ''}{nudge} ms</div>
              <input type="range" min={-300} max={300} step={10} value={nudge} onInput={(e) => setNudge(Number((e.currentTarget as HTMLInputElement).value))} />
            </div>
          </div>
          <div class="small faint">Auto-aligned by the audio clock (offset {take.vocalOffsetMs} ms, latency comp {take.latencyCompMs} ms). Nudge if your voice lands early/late.</div>
        </div>
        <div class="grid-2">
          <button class="btn accent lg" disabled={saving !== null || savedState === 'kept'} onClick={() => void saveTake('kept')}>
            Keep
          </button>
          <button class="btn danger lg" disabled={saving !== null} onClick={() => void discard()}>
            Discard
          </button>
        </div>
        <div class="row">
          <button class="btn" onClick={() => (stop(), props.onAgain())}>
            Sing again
          </button>
          <a class="btn ghost" href={href('/performances')}>
            All performances
          </a>
        </div>
      </div>
    </Page>
  );
}
