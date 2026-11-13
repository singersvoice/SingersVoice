/**
 * Performances (/studio/performances): everything you ever sang, by date and name.
 *
 * - Meet performances: one saved show per song of every meet you hosted or were in — the stage
 *   with everyone on it over the stage background, with the whole mix, exactly as Publisher mode
 *   showed it. The host's device recorded it; it lives in the host's Drive, shared with everyone
 *   who was in the meet, and anyone with its link can watch it.
 * - Your takes: your own takes (Studio, or your personal take of a meet song), Temp or kept.
 */
import { formatMs, type MeetPerformance } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { IcDownload, IcPlay, IcShare, IcStop, IcTrash, IcUsers } from '../../components/icons.tsx';
import { SaveStatus } from '../../components/SaveStatus.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Seg, Sheet, Spinner } from '../../components/ui.tsx';
import { api, controlConfigured } from '../../lib/api.ts';
import { downloadBlob, shareOrCopy } from '../../lib/download.ts';
import { href } from '../../lib/nav.ts';
import type { LoadedPerformance, PerformanceSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { saveJobs } from '../../lib/saveQueue.ts';
import { accountUserId, isDrive, withProvider } from '../../state/session.ts';

export function Performances() {
  const [list, setList] = useState<PerformanceSummary[] | null>(null);
  const [shows, setShows] = useState<MeetPerformance[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'kept' | 'temp'>('all');
  const [open, setOpen] = useState<PerformanceSummary | null>(null);
  const [openShow, setOpenShow] = useState<MeetPerformance | null>(null);

  const reload = () => {
    void withProvider(async (p) => {
      await p.ready();
      const swept = await p.sweepTemp().catch(() => 0);
      if (swept) toast(`${swept} expired Temp take${swept > 1 ? 's' : ''} removed`, 'info');
      setList(await p.listPerformances());
    }).catch((e) => {
      setList([]);
      toast(errorText(e), 'error');
    });
    if (controlConfigured.value)
      api
        .get('GET /performances', '/performances')
        .then((r) => setShows(r.performances))
        .catch(() => setShows([]));
    else setShows([]);
  };
  useEffect(() => void reload(), []);

  const mine = useMemo(() => new Map((list ?? []).map((p) => [p.performanceId, p])), [list]);
  const showIds = useMemo(() => new Set((shows ?? []).map((s) => s.performanceId)), [shows]);
  const takes = (list ?? []).filter((p) => !showIds.has(p.performanceId)).filter((p) => filter === 'all' || p.state === filter);
  const me = accountUserId.value;

  const share = async (title: string, url: string | null) => {
    if (!url) return toast('No link yet — the host saved this performance without Drive', 'warn');
    const r = await shareOrCopy(title, 'A SingersVoice performance', url);
    toast(r === 'copied' ? 'Link copied' : r === 'shared' ? 'Shared' : url, r === 'failed' ? 'warn' : 'ok');
  };

  const saving = saveJobs.value;
  // A save that just finished changes the lists: refresh when the saver goes quiet.
  const doneCount = saving.filter((j) => j.state === 'done').length;
  useEffect(() => {
    if (doneCount) reload();
  }, [doneCount]);

  return (
    <Page title="Performances">
      <div class="stack">
        {saving.length > 0 && (
          <section class="card stack pad-sm">
            <h3 style="margin:0">Saving now</h3>
            <div class="muted small">Takes save themselves after every song — you never have to wait for them.</div>
            <SaveStatus />
          </section>
        )}
        <section class="card stack pad-sm">
          <div class="row between">
            <h3 style="margin:0">Meet performances</h3>
            <span class="chip">{shows?.length ?? '…'}</span>
          </div>
          <div class="muted small">One saved show per song of every meet you hosted or were in: everyone on stage over the stage background, with the whole mix — what Publisher mode showed. One file each, straight under Performances in the host's Drive, shared with everyone who was in the meet; anyone with the link can watch. Delete removes the file for good.</div>
          {shows === null && (
            <div class="row">
              <Spinner /> Loading…
            </div>
          )}
          {shows && !shows.length && <div class="muted small">Nothing yet — sing a song in a live meet and the host's device saves the show here for everyone in it.</div>}
          <div class="list">
            {(shows ?? []).map((s) => {
              const own = mine.get(s.performanceId);
              const hosted = s.hostUserId === me;
              const url = s.videoLink ?? own?.videoLink ?? s.link ?? own?.link ?? null;
              return (
                <div class="item wide-actions" key={s.performanceId} data-show={s.performanceId}>
                  <div class="thumb" style="background:linear-gradient(135deg,#3a1a6a,#7a3aa8)">
                    <IcUsers size={20} />
                  </div>
                  <div class="meta">
                    <div class="t">
                      {s.meetTitle} · {s.songTitle || 'Untitled song'}
                    </div>
                    <div class="s">
                      {new Date(s.createdAt).toLocaleString()} · {formatMs(s.durationMs)} · {s.singers.map((x) => x.displayName.split(' ')[0]).join(', ') || s.hostName}
                      {hosted ? ' · you hosted' : ` · host ${s.hostName}`}
                    </div>
                  </div>
                  <div class="actions">
                    {own ? (
                      <button class="btn sm primary" onClick={() => setOpen(own)}>
                        <IcPlay size={14} /> Play
                      </button>
                    ) : url ? (
                      <a class="btn sm primary" href={url} target="_blank" rel="noopener">
                        <IcPlay size={14} /> Watch
                      </a>
                    ) : (
                      <span class="chip">no link</span>
                    )}
                    <button class="btn sm" aria-label={`Share ${s.songTitle}`} onClick={() => void share(`${s.meetTitle} — ${s.songTitle}`, url)}>
                      <IcShare size={14} /> Share
                    </button>
                    {hosted && (
                      <button class="btn sm" onClick={() => setOpenShow(s)}>
                        …
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section class="card stack pad-sm">
          <div class="row between">
            <h3 style="margin:0">Your takes</h3>
            <Seg<'all' | 'kept' | 'temp'>
              value={filter}
              onChange={setFilter}
              options={[
                { v: 'all', label: 'All' },
                { v: 'kept', label: 'Kept' },
                { v: 'temp', label: 'Temp (7 days)' },
              ]}
            />
          </div>
          {list === null && (
            <div class="row">
              <Spinner /> Loading…
            </div>
          )}
          {list && !takes.length && (
            <Empty title="No takes here" body="Takes land here after you finish singing — the video is the show (the stage with everyone, with the mix). Temp takes auto-delete after 7 days unless you keep them.">
              <a class="btn primary" href={href('/studio/sing')}>
                Sing something
              </a>
            </Empty>
          )}
          <div class="list">
            {takes.map((p) => (
              <button class="item" key={p.performanceId} style="text-align:left;cursor:pointer" onClick={() => setOpen(p)}>
                <div class="thumb" style={{ background: p.state === 'temp' ? 'linear-gradient(135deg,#5a3a10,#8a5a1a)' : undefined }}>
                  <IcPlay size={20} />
                </div>
                <div class="meta">
                  <div class="t">
                    {p.meetTitle ? `${p.meetTitle} · ` : ''}
                    {p.trackTitle}
                  </div>
                  <div class="s">
                    {new Date(p.createdAt).toLocaleString()} · {formatMs(p.durationMs)} · {p.mode}
                    {p.hasVideo ? (p.kind === 'show' ? ' · show video' : ' · video') : ''}
                  </div>
                </div>
                <span class={`chip ${p.state === 'temp' ? 'warn' : 'ok'}`}>{p.state === 'temp' ? `Temp · ${daysLeft(p.expiresAt)}` : 'Kept'}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open ? `${open.meetTitle ? `${open.meetTitle} · ` : ''}${open.trackTitle}` : ''}>
        {open && <PerformanceDetail summary={open} show={(shows ?? []).find((s) => s.performanceId === open.performanceId) ?? null} onChanged={() => (setOpen(null), void reload())} />}
      </Sheet>
      <Sheet open={openShow !== null} onClose={() => setOpenShow(null)} title={openShow ? `${openShow.meetTitle} · ${openShow.songTitle}` : ''}>
        {openShow && (
          <ShowActions
            show={openShow}
            onChanged={() => {
              setOpenShow(null);
              reload();
            }}
          />
        )}
      </Sheet>
    </Page>
  );
}

function daysLeft(expiresAt: string | null): string {
  if (!expiresAt) return '';
  const d = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 86400000));
  return d === 0 ? 'expires today' : `${d}d left`;
}

/** A meet performance that lives in someone else's Drive: it opens there, and that is all (its owner deletes it). */
function ShowActions(props: { show: MeetPerformance; onChanged: () => void }) {
  const s = props.show;
  const url = s.videoLink ?? s.link;
  return (
    <div class="stack">
      <div class="muted small">
        {new Date(s.createdAt).toLocaleString()} · {formatMs(s.durationMs)} · {s.singers.map((x) => `S${x.slot} ${x.displayName}`).join(' · ')} · in {s.hostName}'s Drive
      </div>
      <div class="row">
        {url && (
          <a class="btn" href={url} target="_blank" rel="noopener">
            <IcPlay /> Open
          </a>
        )}
      </div>
    </div>
  );
}

function PerformanceDetail(props: { summary: PerformanceSummary; show: MeetPerformance | null; onChanged: () => void }) {
  const [loaded, setLoaded] = useState<LoadedPerformance | null>(null);
  const [backing, setBacking] = useState<Blob | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState<{ link: string; videoLink: string | null } | null>(props.summary.shared && props.summary.link ? { link: props.summary.link, videoLink: props.summary.videoLink ?? null } : null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodes = useRef<AudioBufferSourceNode[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const isShow = (props.summary.kind ?? loaded?.manifest.kind) === 'show';

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

  /** A show plays itself (its sound is the mix); a take plays the vocal over the backing track, with the camera video muted beside it. */
  const play = async () => {
    if (!loaded) return;
    stop();
    if (isShow && videoRef.current) {
      videoRef.current.muted = false;
      videoRef.current.currentTime = 0;
      await videoRef.current.play().catch(() => undefined);
      videoRef.current.onended = () => setPlaying(false);
      setPlaying(true);
      return;
    }
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
      videoRef.current.muted = true;
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
    if (!confirm(props.show ? 'Delete this performance permanently? The file is removed from your Drive and everyone in the meet loses it.' : 'Delete this performance permanently? The file is removed from your Drive.')) return;
    setBusy(true);
    try {
      await withProvider((p) => p.deletePerformance(props.summary.performanceId));
      if (props.show && controlConfigured.value) await api.del('DELETE /performances/:id', `/performances/${encodeURIComponent(props.summary.performanceId)}`).catch(() => undefined);
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
    if (loaded.vocal.size) downloadBlob(loaded.vocal, `${base} vocal.wav`);
    if (loaded.video) downloadBlob(loaded.video, `${base} ${isShow ? 'show' : 'video'}.${loaded.video.type.includes('mp4') ? 'mp4' : 'webm'}`);
    downloadBlob(new Blob([JSON.stringify(loaded.manifest, null, 1)], { type: 'application/json' }), `${base} manifest.json`);
  };
  /** A link anyone can open: the file is shared anyone-with-the-link on first use. */
  const shareLink = async () => {
    try {
      let s = shared;
      if (!s) {
        s = await withProvider((p) => p.sharePerformance(props.summary.performanceId, { type: 'anyone' }));
        setShared(s);
      }
      const url = s.videoLink ?? s.link;
      const r = await shareOrCopy(props.summary.trackTitle, 'A SingersVoice performance', url);
      toast(r === 'copied' ? 'Link copied — anyone with it can watch' : r === 'shared' ? 'Shared' : url, r === 'failed' ? 'warn' : 'ok', 6000);
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    }
  };

  const s = props.summary;
  const m = loaded?.manifest;
  return (
    <div class="stack">
      <div class="muted small">
        {new Date(s.createdAt).toLocaleString()} · {formatMs(s.durationMs)}
        {m?.singers?.length ? ` · ${m.singers.map((x) => `S${x.slot} ${x.displayName}`).join(' · ')}` : ` · singer ${m?.singerSlot ?? '…'}`}
        {s.state === 'temp' && ` · Temp, ${daysLeft(s.expiresAt)}`}
        {props.show && ' · shared with everyone in the meet'}
      </div>
      {!loaded && (
        <div class="row">
          <Spinner /> Loading files…
        </div>
      )}
      {videoUrl && <video ref={videoRef} src={videoUrl} muted={!isShow} controls={isShow} playsInline style="width:100%;border-radius:12px;background:#000;max-height:40dvh" />}
      {isShow && <div class="small faint">The show: everyone on stage over the stage background, with the whole mix — as Publisher mode showed it.</div>}
      {loaded && !isShow && !backing && <div class="callout warn">The backing track for this take isn't in your library any more — playing the vocal only.</div>}
      <div class="row">
        <button class="btn primary" disabled={!loaded} onClick={() => (playing ? stop() : void play())}>
          {playing ? <IcStop /> : <IcPlay />} {playing ? 'Stop' : isShow ? 'Play' : 'Play mix'}
        </button>
        {s.state === 'temp' && (
          <button class="btn accent" disabled={busy} onClick={() => void keep()}>
            Keep
          </button>
        )}
        {isDrive.value && (
          <button class="btn" onClick={() => void shareLink()}>
            <IcShare /> Share link
          </button>
        )}
        <button class="btn" disabled={!loaded} onClick={download}>
          <IcDownload /> Download
        </button>
        {s.link && isDrive.value && (
          <a class="btn ghost" href={s.videoLink ?? s.link} target="_blank" rel="noopener">
            Open in Drive
          </a>
        )}
        <button class="btn danger" disabled={busy} onClick={() => void del()}>
          <IcTrash /> Delete
        </button>
      </div>
    </div>
  );
}
