import { formatMs } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { IcDownload, IcPlay, IcStop, IcTrash } from '../components/icons.tsx';
import { Page } from '../components/Shell.tsx';
import { Empty, Seg, Sheet, Spinner } from '../components/ui.tsx';
import { downloadBlob } from '../lib/download.ts';
import { href } from '../lib/nav.ts';
import type { LoadedPerformance, PerformanceSummary } from '../lib/storage/types.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isDrive, withProvider } from '../state/session.ts';

export function Performances() {
  const [list, setList] = useState<PerformanceSummary[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'kept' | 'temp'>('all');
  const [open, setOpen] = useState<PerformanceSummary | null>(null);

  const reload = () =>
    withProvider(async (p) => {
      await p.ready();
      const swept = await p.sweepTemp().catch(() => 0);
      if (swept) toast(`${swept} expired Temp take${swept > 1 ? 's' : ''} removed`, 'info');
      setList(await p.listPerformances());
    }).catch((e) => {
      setList([]);
      toast(errorText(e), 'error');
    });
  useEffect(() => void reload(), []);

  const shown = (list ?? []).filter((p) => filter === 'all' || p.state === filter);

  return (
    <Page title="Performances">
      <div class="stack">
        <Seg<'all' | 'kept' | 'temp'>
          value={filter}
          onChange={setFilter}
          options={[
            { v: 'all', label: 'All' },
            { v: 'kept', label: 'Kept' },
            { v: 'temp', label: 'Temp (7 days)' },
          ]}
        />
        {list === null && (
          <div class="row">
            <Spinner /> Loading…
          </div>
        )}
        {list && !shown.length && (
          <Empty title="Nothing here yet" body="Takes land here after you finish singing. Temp takes auto-delete after 7 days unless you keep them.">
            <a class="btn primary" href={href('/sing')}>
              Sing something
            </a>
          </Empty>
        )}
        <div class="list">
          {shown.map((p) => (
            <button class="item" key={p.performanceId} style="text-align:left;cursor:pointer" onClick={() => setOpen(p)}>
              <div class="thumb" style={{ background: p.state === 'temp' ? 'linear-gradient(135deg,#5a3a10,#8a5a1a)' : undefined }}>
                <IcPlay size={20} />
              </div>
              <div class="meta">
                <div class="t">{p.trackTitle}</div>
                <div class="s">
                  {new Date(p.createdAt).toLocaleString()} · {formatMs(p.durationMs)} · {p.mode}
                  {p.hasVideo ? ' · video' : ''}
                </div>
              </div>
              <span class={`chip ${p.state === 'temp' ? 'warn' : 'ok'}`}>{p.state === 'temp' ? `Temp · ${daysLeft(p.expiresAt)}` : 'Kept'}</span>
            </button>
          ))}
        </div>
      </div>
      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open?.trackTitle}>
        {open && <PerformanceDetail summary={open} onChanged={() => (setOpen(null), void reload())} />}
      </Sheet>
    </Page>
  );
}

function daysLeft(expiresAt: string | null): string {
  if (!expiresAt) return '';
  const d = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 86400000));
  return d === 0 ? 'expires today' : `${d}d left`;
}

function PerformanceDetail(props: { summary: PerformanceSummary; onChanged: () => void }) {
  const [loaded, setLoaded] = useState<LoadedPerformance | null>(null);
  const [backing, setBacking] = useState<Blob | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodes = useRef<AudioBufferSourceNode[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoUrl, setVideoUrl] = useState('');

  useEffect(() => {
    void withProvider(async (p) => {
      const perf = await p.getPerformance(props.summary.performanceId);
      if (!perf) throw new Error('Performance files not found');
      setLoaded(perf);
      if (perf.video) setVideoUrl(URL.createObjectURL(perf.video));
      const t = await p.getTrack(perf.manifest.trackId).catch(() => null);
      setBacking(t?.audio ?? null);
    }).catch((e) => toast(errorText(e), 'error'));
    return () => {
      stop();
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [props.summary.performanceId]);

  const stop = () => {
    for (const n of nodes.current) {
      try {
        n.stop();
      } catch {
        /* noop */
      }
    }
    nodes.current = [];
    videoRef.current?.pause();
    setPlaying(false);
  };

  const play = async () => {
    if (!loaded) return;
    stop();
    const ctx = ctxRef.current ?? new AudioContext();
    ctxRef.current = ctx;
    await ctx.resume();
    const at = ctx.currentTime + 0.2;
    const m = loaded.manifest;
    if (backing) {
      const b = ctx.createBufferSource();
      b.buffer = await ctx.decodeAudioData(await backing.arrayBuffer());
      const g = ctx.createGain();
      g.gain.value = m.playback.backingGain;
      b.connect(g).connect(ctx.destination);
      b.start(at);
      b.onended = () => setPlaying(false);
      nodes.current.push(b);
    }
    if (loaded.vocal.size) {
      const v = ctx.createBufferSource();
      v.buffer = await ctx.decodeAudioData(await loaded.vocal.arrayBuffer());
      v.connect(ctx.destination);
      const off = m.timeline.vocalOffsetMs;
      if (off >= 0) v.start(at + off / 1000);
      else v.start(at, -off / 1000);
      if (!backing) v.onended = () => setPlaying(false);
      nodes.current.push(v);
    }
    if (videoRef.current && m.timeline.videoOffsetMs !== null) {
      const vo = m.timeline.videoOffsetMs / 1000;
      videoRef.current.currentTime = Math.max(0, -vo);
      setTimeout(() => void videoRef.current?.play().catch(() => undefined), Math.max(0, vo * 1000) + 200);
    }
    setPlaying(true);
  };

  const keep = async () => {
    setBusy(true);
    try {
      await withProvider((p) => p.keepPerformance(props.summary.performanceId));
      toast('Kept', 'ok');
      props.onChanged();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!confirm('Delete this performance?')) return;
    setBusy(true);
    try {
      await withProvider((p) => p.deletePerformance(props.summary.performanceId));
      props.onChanged();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    if (!loaded) return;
    const base = `${props.summary.trackTitle} ${props.summary.createdAt.slice(0, 16).replace(/[:T]/g, '-')}`;
    downloadBlob(loaded.vocal, `${base} vocal.wav`);
    if (loaded.video) downloadBlob(loaded.video, `${base} video.${loaded.video.type.includes('mp4') ? 'mp4' : 'webm'}`);
    downloadBlob(new Blob([JSON.stringify(loaded.manifest, null, 1)], { type: 'application/json' }), `${base} manifest.json`);
  };

  const s = props.summary;
  return (
    <div class="stack">
      <div class="muted small">
        {new Date(s.createdAt).toLocaleString()} · {formatMs(s.durationMs)} · singer {loaded?.manifest.singerSlot ?? '…'}
        {s.state === 'temp' && ` · Temp, ${daysLeft(s.expiresAt)}`}
      </div>
      {!loaded && (
        <div class="row">
          <Spinner /> Loading files…
        </div>
      )}
      {videoUrl && <video ref={videoRef} src={videoUrl} muted playsInline style="width:100%;border-radius:12px;background:#000;max-height:40dvh" />}
      {loaded && !backing && <div class="callout warn">The backing track for this take isn't in your library any more — playing the vocal only.</div>}
      <div class="row">
        <button class="btn primary" disabled={!loaded} onClick={() => (playing ? stop() : void play())}>
          {playing ? <IcStop /> : <IcPlay />} {playing ? 'Stop' : 'Play'}
        </button>
        {s.state === 'temp' && (
          <button class="btn accent" disabled={busy} onClick={() => void keep()}>
            Keep
          </button>
        )}
        <button class="btn" disabled={!loaded} onClick={download}>
          <IcDownload /> Download
        </button>
        {s.link && isDrive.value && (
          <a class="btn ghost" href={s.link} target="_blank" rel="noopener">
            Drive folder
          </a>
        )}
        <button class="btn danger" disabled={busy} onClick={() => void del()}>
          <IcTrash /> Delete
        </button>
      </div>
    </div>
  );
}
