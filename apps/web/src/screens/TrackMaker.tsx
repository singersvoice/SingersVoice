import {
  assignSlots,
  autoSpace,
  clampSlot,
  createTrack,
  formatMsPrecise,
  importTrackV1,
  MAX_SINGER_SLOTS,
  MAX_TRACK_DURATION_MS,
  normalizeLyrics,
  parseLrc,
  SLOT_COLORS,
  singerCountOf,
  splitLyricsText,
  validateTrack,
  type LyricLine,
  type SingerSlot,
  type SlotPattern,
  type TrackMakerV1,
  type TrackPackageV2,
} from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { IcCheck, IcMusic, IcPlay, IcPause, IcSkipBack, IcUpload } from '../components/icons.tsx';
import { Page } from '../components/Shell.tsx';
import { Field, Progress, Seg, Spinner } from '../components/ui.tsx';
import { decodeBlob, probeDuration } from '../lib/decode.ts';
import { go, href } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isDrive, withProvider } from '../state/session.ts';

type Step = 1 | 2 | 3 | 4;

export function TrackMaker(props: { id?: string }) {
  const [step, setStep] = useState<Step>(1);
  const [track, setTrack] = useState<TrackPackageV2>(() => createTrack({ title: '' }));
  const [audio, setAudio] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [loading, setLoading] = useState(Boolean(props.id));
  const [saving, setSaving] = useState<{ label: string; fraction: number } | null>(null);
  const [savedRef, setSavedRef] = useState<string | null>(null);

  // Load an existing track for editing.
  useEffect(() => {
    if (!props.id) return;
    void withProvider(async (p) => {
      const loaded = await p.getTrack(decodeURIComponent(props.id!));
      if (!loaded) throw new Error('Track not found');
      setTrack(loaded.track);
      setAudio(loaded.audio);
      setStep(2);
    })
      .catch((e) => toast(errorText(e), 'error'))
      .finally(() => setLoading(false));
  }, [props.id]);

  useEffect(() => {
    if (!audio) return setAudioUrl('');
    const url = URL.createObjectURL(audio);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audio]);

  const patch = (p: Partial<TrackPackageV2>) => setTrack((t) => ({ ...t, ...p }));

  const onAudioFile = async (file: File) => {
    const durationMs = await probeDuration(file);
    if (!durationMs) return toast('Could not read that audio file', 'error');
    if (durationMs > MAX_TRACK_DURATION_MS) return toast('Tracks are limited to 15 minutes', 'error');
    setAudio(file);
    patch({
      durationMs,
      title: track.title || file.name.replace(/\.[^.]+$/, ''),
      layers: [{ id: 'L1', kind: 'backing', file: 'backing', mimeType: file.type || 'audio/mpeg', gain: 1, enabledByDefault: true }],
    });
  };

  const onTimingFile = async (file: File) => {
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.lrc')) {
        const { lines, meta } = parseLrc(text);
        patch({ lyrics: lines, singerCount: singerCountOf(lines), title: track.title || meta.ti || '', artist: track.artist || meta.ar || '' });
      } else {
        const j = JSON.parse(text) as { schema?: string };
        const imported = j.schema === 'singersvoice.trackmaker.v1' ? importTrackV1(j as TrackMakerV1) : createTrack({ ...(j as TrackPackageV2), trackId: undefined });
        patch({ lyrics: imported.lyrics, singerCount: imported.singerCount, title: track.title || imported.title, artist: track.artist || imported.artist, genre: imported.genre, language: imported.language, bpm: imported.bpm, keySignature: imported.keySignature });
      }
      toast('Lyrics & timing loaded', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const save = async () => {
    const final = createTrack({ ...track, lyrics: normalizeLyrics(track.lyrics, track.durationMs), singerCount: singerCountOf(track.lyrics) });
    const errors = validateTrack(final).filter((i) => i.level === 'error');
    if (errors.length) return toast(errors[0]!.message, 'error');
    setSaving({ label: 'Saving', fraction: 0 });
    try {
      const summary = await withProvider((p) => p.saveTrack(final, props.id ? null : audio, (pr) => setSaving(pr)));
      setTrack(final);
      setSavedRef(summary.trackId);
      toast(`Saved "${final.title}" to ${isDrive.value ? 'Google Drive › SingersVoice › Tracks' : 'this device'}`, 'ok', 5000);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setSaving(null);
    }
  };

  const issues = useMemo(() => validateTrack({ ...track, layers: audio || props.id ? track.layers.length ? track.layers : [{ id: 'L1', kind: 'backing', file: 'backing', mimeType: 'audio/mpeg', gain: 1, enabledByDefault: true }] : [] }), [track, audio]);
  const canStep2 = Boolean(audio || props.id);
  const canStep3 = canStep2 && track.lyrics.length > 0;

  if (loading)
    return (
      <Page title="Track Maker">
        <div class="row">
          <Spinner /> Loading track…
        </div>
      </Page>
    );

  return (
    <Page title={props.id ? 'Edit track' : 'Track Maker'}>
      <div class="wizard">
        <div class="wizard-steps" role="tablist">
          {(['Source', 'Lyrics', 'Timing', 'Save'] as const).map((label, i) => {
            const n = (i + 1) as Step;
            const enabled = n === 1 || (n === 2 && canStep2) || (n === 3 && canStep3) || (n === 4 && canStep3);
            return (
              <button key={label} role="tab" aria-selected={step === n} class={`${step === n ? 'on' : ''} ${n < step ? 'done' : ''}`} disabled={!enabled} onClick={() => setStep(n)}>
                {n}. {label}
              </button>
            );
          })}
        </div>

        {step === 1 && (
          <SourceStep track={track} audio={audio} isEdit={Boolean(props.id)} onPatch={patch} onAudio={onAudioFile} onTiming={onTimingFile} onNext={() => setStep(2)} canNext={canStep2} />
        )}
        {step === 2 && <LyricsStep track={track} onPatch={patch} onNext={() => setStep(3)} onBack={() => setStep(1)} />}
        {step === 3 && <TimingStep track={track} audio={audio} audioUrl={audioUrl} onPatch={patch} onNext={() => setStep(4)} onBack={() => setStep(2)} />}
        {step === 4 && (
          <div class="stack">
            <div class="card stack">
              <h2>{track.title || 'Untitled track'}</h2>
              <div class="muted small">
                {track.artist || 'Unknown artist'} · {formatMsPrecise(track.durationMs)} · {track.lyrics.length} lines · {singerCountOf(track.lyrics)} singer slot{singerCountOf(track.lyrics) > 1 ? 's' : ''}
              </div>
              {issues.map((i) => (
                <div key={i.message} class={`callout ${i.level === 'error' ? 'danger' : 'warn'}`}>
                  {i.message}
                </div>
              ))}
              {!issues.length && (
                <div class="callout">
                  <IcCheck size={16} /> Ready. Saves as <span class="kbd">track.json</span> + audio in {isDrive.value ? 'Drive › SingersVoice › Tracks › ' + (track.title || 'Untitled') : 'this device'}.
                </div>
              )}
              {saving && <Progress fraction={saving.fraction} label={saving.label} />}
              <button class="btn primary lg block" disabled={saving !== null || issues.some((i) => i.level === 'error')} onClick={() => void save()}>
                {saving ? <Spinner /> : <IcUpload />} {props.id ? 'Save changes' : 'Save track'}
              </button>
              {savedRef && (
                <div class="row">
                  <a class="btn accent" href={href(`/sing/${encodeURIComponent(savedRef)}`)}>
                    <IcPlay /> Sing it now
                  </a>
                  <a class="btn" href={href('/library')}>
                    Library
                  </a>
                </div>
              )}
            </div>
            <button class="btn ghost" onClick={() => setStep(3)}>
              ← Back to timing
            </button>
          </div>
        )}
      </div>
    </Page>
  );
}

// ---------------- Step 1 ----------------

function SourceStep(props: {
  track: TrackPackageV2;
  audio: Blob | null;
  isEdit: boolean;
  onPatch: (p: Partial<TrackPackageV2>) => void;
  onAudio: (f: File) => Promise<void>;
  onTiming: (f: File) => Promise<void>;
  onNext: () => void;
  canNext: boolean;
}) {
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = props.track;
  return (
    <div class="stack">
      {!props.isEdit && (
        <div
          class={`drop ${over ? 'over' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer?.files?.[0];
            if (f) void props.onAudio(f);
          }}
        >
          <IcMusic size={30} />
          <b>{props.audio ? 'Audio loaded — tap to replace' : 'Pick the backing track (mp3, m4a, wav)'}</b>
          <span class="small muted">{props.audio ? `${formatMsPrecise(t.durationMs)} · ${(props.audio.size / 1048576).toFixed(1)} MB` : 'Up to 15 minutes. Karaoke/instrumental versions work best.'}</span>
          <input ref={fileRef} type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm" class="hidden" onChange={(e) => {
            const f = (e.currentTarget as HTMLInputElement).files?.[0];
            if (f) void props.onAudio(f);
          }} />
        </div>
      )}
      <div class="grid-2">
        <Field label="Title">
          <input class="input" value={t.title} onInput={(e) => props.onPatch({ title: (e.currentTarget as HTMLInputElement).value })} placeholder="Song title" />
        </Field>
        <Field label="Artist">
          <input class="input" value={t.artist} onInput={(e) => props.onPatch({ artist: (e.currentTarget as HTMLInputElement).value })} placeholder="Original artist" />
        </Field>
        <Field label="Genre">
          <input class="input" value={t.genre} onInput={(e) => props.onPatch({ genre: (e.currentTarget as HTMLInputElement).value })} placeholder="Telugu film, Pop…" />
        </Field>
        <Field label="Language">
          <input class="input" value={t.language} onInput={(e) => props.onPatch({ language: (e.currentTarget as HTMLInputElement).value })} placeholder="Telugu, English…" />
        </Field>
        <Field label="BPM (optional)">
          <input class="input" type="number" inputMode="numeric" value={t.bpm ?? ''} onInput={(e) => props.onPatch({ bpm: Number((e.currentTarget as HTMLInputElement).value) || null })} />
        </Field>
        <Field label="Key (optional)">
          <input class="input" value={t.keySignature} onInput={(e) => props.onPatch({ keySignature: (e.currentTarget as HTMLInputElement).value })} placeholder="C, Am…" />
        </Field>
      </div>
      <Field label="Have lyrics with timing already? (SVOld .trackmaker.json, track.json or .lrc)">
        <input type="file" accept=".json,.lrc,application/json,text/plain" class="input" onChange={(e) => {
          const f = (e.currentTarget as HTMLInputElement).files?.[0];
          if (f) void props.onTiming(f);
        }} />
      </Field>
      <button class="btn primary lg block" disabled={!props.canNext} onClick={props.onNext}>
        Next: lyrics →
      </button>
    </div>
  );
}

// ---------------- Step 2 ----------------

function LyricsStep(props: { track: TrackPackageV2; onPatch: (p: Partial<TrackPackageV2>) => void; onNext: () => void; onBack: () => void }) {
  const t = props.track;
  const [text, setText] = useState(() => t.lyrics.map((l) => l.text).join('\n'));
  const [singers, setSingers] = useState(Math.max(1, t.singerCount));
  const [pattern, setPattern] = useState<SlotPattern>(t.singerCount > 1 ? 'alternate' : 'solo');

  const apply = () => {
    const lines = splitLyricsText(text);
    const slots = assignSlots(lines.length, singers, pattern);
    const keepTiming = lines.length === t.lyrics.length;
    const lyrics: LyricLine[] = lines.map((txt, i) => ({
      startMs: keepTiming ? t.lyrics[i]!.startMs : 0,
      endMs: keepTiming ? t.lyrics[i]!.endMs : 0,
      text: txt,
      singerSlot: keepTiming && pattern === 'solo' && singers === 1 && t.singerCount > 1 ? t.lyrics[i]!.singerSlot : slots[i]!,
    }));
    props.onPatch({ lyrics, singerCount: singerCountOf(lyrics) });
    toast(`${lines.length} lines ${keepTiming ? '(timing kept)' : '— time them in the next step'}`, 'ok');
  };

  const cycleSlot = (i: number) => {
    const lyrics = t.lyrics.map((l, j) => (j === i ? { ...l, singerSlot: ((l.singerSlot + 1) % (Math.max(singers, 1) + 1)) as SingerSlot } : l));
    props.onPatch({ lyrics, singerCount: singerCountOf(lyrics) });
  };

  return (
    <div class="stack">
      <Field label="Lyrics — one line per lyric line (blank lines are ignored)">
        <textarea class="input" rows={10} value={text} onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} placeholder={'Paste the lyrics here…\nEach line becomes one stage line.'} />
      </Field>
      <div class="row">
        <Field label={`Singers on this track (1–${MAX_SINGER_SLOTS})`}>
          <input class="input" type="number" min={1} max={MAX_SINGER_SLOTS} value={singers} style="width:110px" onInput={(e) => setSingers(clampSlot(Number((e.currentTarget as HTMLInputElement).value)) || 1)} />
        </Field>
        <Field label="Who sings what">
          <Seg<SlotPattern>
            value={pattern}
            onChange={setPattern}
            options={[
              { v: 'solo', label: 'Solo' },
              { v: 'alternate', label: 'Alternate lines' },
              { v: 'duet-verse', label: 'Verses' },
              { v: 'all', label: 'Everyone' },
            ]}
          />
        </Field>
      </div>
      <button class="btn block" onClick={apply}>
        Apply to {splitLyricsText(text).length} lines
      </button>
      {t.lyrics.length > 0 && (
        <>
          <div class="label">Tap a badge to change the singer (0 = everyone)</div>
          <div class="lyric-rows">
            {t.lyrics.map((l, i) => (
              <div class="lyric-row" key={i}>
                <button type="button" class="slot" style={{ background: SLOT_COLORS[l.singerSlot] }} onClick={() => cycleSlot(i)} aria-label={`Singer slot ${l.singerSlot}`}>
                  {l.singerSlot === 0 ? 'A' : l.singerSlot}
                </button>
                <div class="txt">{l.text}</div>
                <div class="time mono">{l.startMs || l.endMs ? formatMsPrecise(l.startMs) : '—'}</div>
              </div>
            ))}
          </div>
        </>
      )}
      <div class="row between">
        <button class="btn ghost" onClick={props.onBack}>
          ← Source
        </button>
        <button class="btn primary" disabled={!t.lyrics.length} onClick={props.onNext}>
          Next: timing →
        </button>
      </div>
    </div>
  );
}

// ---------------- Step 3 ----------------

function TimingStep(props: { track: TrackPackageV2; audio: Blob | null; audioUrl: string; onPatch: (p: Partial<TrackPackageV2>) => void; onNext: () => void; onBack: () => void }) {
  const t = props.track;
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(() => Math.max(0, t.lyrics.findIndex((l) => l.startMs === 0 && l.endMs === 0)));
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState<'0.75' | '1'>('1');
  const [peaks, setPeaks] = useState<Float32Array | null>(null);

  // Waveform peaks
  useEffect(() => {
    if (!props.audio) return;
    let cancelled = false;
    void decodeBlob(props.audio)
      .then((buf) => {
        if (cancelled) return;
        const ch = buf.getChannelData(0);
        const n = 700;
        const out = new Float32Array(n);
        const step = Math.max(1, Math.floor(ch.length / n));
        for (let i = 0; i < n; i++) {
          let m = 0;
          const s = i * step;
          for (let j = s; j < s + step && j < ch.length; j += 4) {
            const a = Math.abs(ch[j]!);
            if (a > m) m = a;
          }
          out[i] = m;
        }
        setPeaks(out);
      })
      .catch(() => setPeaks(null));
    return () => {
      cancelled = true;
    };
  }, [props.audio]);

  // Draw waveform + playhead + marks
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    if (peaks) {
      g.fillStyle = 'rgba(201,167,225,0.55)';
      const bw = w / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const ph = Math.max(1, peaks[i]! * (h - 4));
        g.fillRect(i * bw, (h - ph) / 2, Math.max(1, bw - 0.5), ph);
      }
    }
    const dur = Math.max(1, t.durationMs);
    g.fillStyle = 'rgba(255,180,84,0.9)';
    for (const l of t.lyrics) {
      if (l.startMs || l.endMs) g.fillRect((l.startMs / dur) * w, 0, 1.5, h);
    }
    g.fillStyle = '#38d39f';
    g.fillRect((pos / dur) * w - 1, 0, 2, h);
  }, [peaks, pos, t.lyrics, t.durationMs]);

  // Playback position ticker
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) setPos(a.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const el = listRef.current?.children[cur] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [cur]);

  const setLyrics = (lyrics: LyricLine[]) => props.onPatch({ lyrics });

  const mark = () => {
    const a = audioRef.current;
    if (!a || cur >= t.lyrics.length) return;
    const now = Math.round(a.currentTime * 1000);
    const lyrics = t.lyrics.map((l) => ({ ...l }));
    lyrics[cur]!.startMs = now;
    if (cur > 0 && lyrics[cur - 1]!.endMs <= lyrics[cur - 1]!.startMs) lyrics[cur - 1]!.endMs = now;
    if (cur > 0) lyrics[cur - 1]!.endMs = Math.min(lyrics[cur - 1]!.endMs || now, now);
    if (lyrics[cur]!.endMs <= now) lyrics[cur]!.endMs = Math.min(t.durationMs || now + 4000, now + 4000);
    setLyrics(lyrics);
    setCur(Math.min(t.lyrics.length, cur + 1));
    if (navigator.vibrate) navigator.vibrate(12);
  };
  const endLine = () => {
    const a = audioRef.current;
    const i = Math.min(cur, t.lyrics.length - 1);
    if (!a || i < 0) return;
    const now = Math.round(a.currentTime * 1000);
    const lyrics = t.lyrics.map((l, j) => (j === i ? { ...l, endMs: Math.max(l.startMs + 200, now) } : l));
    setLyrics(lyrics);
  };
  const undo = () => {
    if (cur === 0) return;
    const i = cur - 1;
    const lyrics = t.lyrics.map((l, j) => (j === i ? { ...l, startMs: 0, endMs: 0 } : l));
    setLyrics(lyrics);
    setCur(i);
    const a = audioRef.current;
    if (a && i > 0) a.currentTime = Math.max(0, t.lyrics[i - 1]!.startMs / 1000 - 1);
  };
  const nudge = (ms: number) => {
    const i = Math.min(cur, t.lyrics.length - 1);
    const lyrics = t.lyrics.map((l, j) => (j === i ? { ...l, startMs: Math.max(0, l.startMs + ms), endMs: Math.max(0, l.endMs + ms) } : l));
    setLyrics(lyrics);
  };
  const spaceToNext = () => {
    // Evenly spread all un-timed lines between the last mark and the next timed line (or the end).
    const first = t.lyrics.findIndex((l) => l.startMs === 0 && l.endMs === 0);
    if (first < 0) return;
    let last = first;
    while (last + 1 < t.lyrics.length && t.lyrics[last + 1]!.startMs === 0 && t.lyrics[last + 1]!.endMs === 0) last++;
    const from = first > 0 ? t.lyrics[first - 1]!.endMs || t.lyrics[first - 1]!.startMs + 2000 : 0;
    const to = last + 1 < t.lyrics.length ? t.lyrics[last + 1]!.startMs : t.durationMs;
    setLyrics(autoSpace(t.lyrics, first, last, from, to));
    setCur(t.lyrics.length);
    toast(`Spaced ${last - first + 1} lines between ${formatMsPrecise(from)} and ${formatMsPrecise(to)}`, 'ok');
  };
  const seekTo = (ms: number) => {
    const a = audioRef.current;
    if (a) a.currentTime = Math.max(0, ms / 1000);
  };
  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault();
        mark();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        undo();
      } else if (e.key === 'ArrowLeft') nudge(-100);
      else if (e.key === 'ArrowRight') nudge(100);
      else if (e.key.toLowerCase() === 'p') toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const timed = t.lyrics.filter((l) => l.startMs || l.endMs).length;
  return (
    <div class="stack">
      <div class="callout">
        Play the song and tap <b>Mark</b> the moment each line starts (desktop: <span class="kbd">Space</span> mark · <span class="kbd">⌫</span> undo · <span class="kbd">←</span>/<span class="kbd">→</span> nudge 100 ms · <span class="kbd">P</span> play/pause). Lines end when the next one starts.
      </div>
      <audio ref={audioRef} src={props.audioUrl} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <div class="lyric-rows" ref={listRef} style="max-height:38dvh;overflow:auto">
        {t.lyrics.map((l, i) => (
          <div class={`lyric-row ${i === cur ? 'active' : ''}`} key={i} onClick={() => (setCur(i), l.startMs && seekTo(l.startMs - 800))}>
            <span class="slot" style={{ background: SLOT_COLORS[l.singerSlot] }}>{l.singerSlot === 0 ? 'A' : l.singerSlot}</span>
            <div class="txt">{l.text}</div>
            <div class="time mono">{l.startMs || l.endMs ? `${formatMsPrecise(l.startMs)}–${formatMsPrecise(l.endMs)}` : 'untimed'}</div>
          </div>
        ))}
      </div>
      <div class="timing-bar">
        <canvas ref={canvasRef} class="wave" onClick={(e) => {
          const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
          seekTo(((e.clientX - r.left) / r.width) * t.durationMs);
        }} />
        <div class="row between">
          <div class="row" style="gap:6px">
            <button class="btn icon" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
              {playing ? <IcPause /> : <IcPlay />}
            </button>
            <button class="btn icon" aria-label="Restart" onClick={() => seekTo(0)}>
              <IcSkipBack />
            </button>
            <Seg<'0.75' | '1'> value={rate} onChange={(v) => (setRate(v), audioRef.current && (audioRef.current.playbackRate = Number(v)))} options={[{ v: '0.75', label: '0.75×' }, { v: '1', label: '1×' }]} />
          </div>
          <div class="mono small">
            {formatMsPrecise(pos)} / {formatMsPrecise(t.durationMs)}
          </div>
        </div>
        <button class="btn accent mark-btn block" onClick={mark} disabled={cur >= t.lyrics.length}>
          {cur < t.lyrics.length ? `Mark line ${cur + 1}: ${t.lyrics[cur]!.text.split('\n')[0]!.slice(0, 32)}` : 'All lines timed'}
        </button>
        <div class="row" style="gap:6px">
          <button class="btn sm" onClick={undo} disabled={cur === 0}>
            Undo
          </button>
          <button class="btn sm" onClick={() => nudge(-100)}>
            −100 ms
          </button>
          <button class="btn sm" onClick={() => nudge(100)}>
            +100 ms
          </button>
          <button class="btn sm" onClick={endLine}>
            End line here
          </button>
          <button class="btn sm" onClick={spaceToNext} disabled={timed === t.lyrics.length}>
            Auto-space rest
          </button>
        </div>
      </div>
      <div class="row between">
        <button class="btn ghost" onClick={props.onBack}>
          ← Lyrics
        </button>
        <span class="small muted">
          {timed}/{t.lyrics.length} timed
        </span>
        <button class="btn primary" onClick={props.onNext}>
          Review & save →
        </button>
      </div>
    </div>
  );
}

export function openTrackMaker(id?: string): void {
  go(id ? `/trackmaker/${encodeURIComponent(id)}` : '/trackmaker');
}
