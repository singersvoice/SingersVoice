/**
 * Performances (/studio/performances): everything you ever sang, by date and name.
 *
 * - Meet performances: the film of every meet you hosted or were in — one file for the whole meet,
 *   the stage with everyone on it over the stage background, with the whole mix, exactly as
 *   Publisher mode showed it, a chapter mark per song, pause and stretch of stage. The host's device
 *   recorded it; it lives in the host's Drive, shared with everyone who was in the meet, and anyone
 *   with its link can watch it. (A broadcast's footage, and an older build's per-song shows and
 *   chapter files, are listed the same way.)
 * - Your takes: your own Studio takes, Temp or kept.
 *
 * Deleting is plain: a Delete on every row, and Delete all for a whole section — the files go from
 * your Drive for good (never the trash), and a meet performance is unlisted for everyone in the meet.
 */
import { formatMs, joinPath, singersLine, type JoinInvite, type MeetPerformance } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ClipSheet } from '../../components/ClipSheet.tsx';
import { IcDownload, IcPlay, IcShare, IcStop, IcTrash, IcUsers } from '../../components/icons.tsx';
import { SaveStatus } from '../../components/SaveStatus.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Seg, Sheet, Spinner } from '../../components/ui.tsx';
import { api, controlConfigured } from '../../lib/api.ts';
import { downloadBlob, shareOrCopy } from '../../lib/download.ts';
import { href, safeHref } from '../../lib/nav.ts';
import { closeInvite, invitePerformance, joinUrl } from '../../lib/joins.ts';
import type { LoadedPerformance, PerformanceSummary } from '../../lib/storage/types.ts';
import { chapterGlyph, marksLine, markTitle } from '../../video/chapters.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { saveJobs } from '../../lib/saveQueue.ts';
import { accountUserId, isDrive, withProvider } from '../../state/session.ts';
import { appSettings } from '../../state/settings.ts';
import { TakePlayback } from '../../audio/takePlayback.ts';

export function Performances() {
  const [list, setList] = useState<PerformanceSummary[] | null>(null);
  const [shows, setShows] = useState<MeetPerformance[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'kept' | 'temp'>('all');
  const [open, setOpen] = useState<PerformanceSummary | null>(null);
  /** Joining (lib/joins.ts): the takes I opened for others, and the performances others made by joining mine. */
  const [invites, setInvites] = useState<{ mine: JoinInvite[]; joined: JoinInvite[] } | null>(null);
  const [inviting, setInviting] = useState<string | null>(null);

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
    if (controlConfigured.value) {
      api
        .get('GET /performances', '/performances')
        .then((r) => setShows(r.performances))
        .catch(() => setShows([]));
      api
        .get('GET /performances/invites', '/performances/invites')
        .then(setInvites)
        .catch(() => setInvites({ mine: [], joined: [] }));
    } else {
      setShows([]);
      setInvites({ mine: [], joined: [] });
    }
  };
  useEffect(() => void reload(), []);

  const mine = useMemo(() => new Map((list ?? []).map((p) => [p.performanceId, p])), [list]);
  const showIds = useMemo(() => new Set((shows ?? []).map((s) => s.performanceId)), [shows]);
  const me = accountUserId.value;
  /** A film in my own Drive the meet's registry does not list (the host left before it was listed; a broadcast's footage): shown among the meet performances all the same. */
  const ownFilms: MeetPerformance[] = useMemo(
    () => (list ?? []).filter((p) => !showIds.has(p.performanceId) && (p.chapters?.length || p.chapter)).map((p) => ({ performanceId: p.performanceId, meetId: p.meetId ?? '', meetTitle: p.meetTitle ?? '', hostUserId: me ?? '', hostName: '', songTitle: p.trackTitle, trackId: p.trackId, singers: p.singers ?? [], link: p.link ?? null, videoLink: p.videoLink ?? null, durationMs: p.durationMs, bytes: 0, mimeType: '', createdAt: p.createdAt, ...(p.chapters?.length ? { chapters: p.chapters } : {}), ...(p.chapter ? { chapter: p.chapter } : {}) })),
    [list, showIds, me],
  );
  const takes = (list ?? []).filter((p) => !showIds.has(p.performanceId) && !p.chapter && !p.chapters?.length).filter((p) => filter === 'all' || p.state === filter);
  const songShows = useMemo(() => [...(shows ?? []), ...ownFilms].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [shows, ownFilms]);

  const share = async (title: string, url: string | null) => {
    if (!url) return toast('No link yet — the host saved this performance without Drive', 'warn');
    const r = await shareOrCopy(title, 'A SingersVoice performance', url);
    toast(r === 'copied' ? 'Link copied' : r === 'shared' ? 'Shared' : url, r === 'failed' ? 'warn' : 'ok');
  };

  const openFor = useMemo(() => new Map((invites?.mine ?? []).map((i) => [i.performanceId, i])), [invites]);
  /** Open a take for others to sing over (kept, shared, on record) and hand out its link. */
  const inviteTake = async (p: PerformanceSummary) => {
    setInviting(p.performanceId);
    try {
      const { url } = await invitePerformance(p.performanceId);
      const r = await shareOrCopy(`Join me on "${p.trackTitle}"`, 'Sing this with me on SingersVoice', url);
      toast(r === 'copied' ? 'Join link copied — send it to whoever sings next' : r === 'shared' ? 'Join link shared' : url, r === 'failed' ? 'warn' : 'ok', 7000);
      reload();
    } catch (e) {
      toast(errorText(e), 'error', 9000);
    } finally {
      setInviting(null);
    }
  };
  const copyJoin = async (p: { performanceId: string; trackTitle: string }) => {
    const url = joinUrl(p.performanceId);
    const r = await shareOrCopy(`Join me on "${p.trackTitle}"`, 'Sing this with me on SingersVoice', url);
    toast(r === 'copied' ? 'Join link copied' : r === 'shared' ? 'Shared' : url, r === 'failed' ? 'warn' : 'ok', 6000);
  };
  const closeJoin = async (p: PerformanceSummary) => {
    if (!confirm(`Close "${p.trackTitle}" to joining? The link stops opening it (the files stay with whoever has them).`)) return;
    try {
      await closeInvite(p.performanceId);
      toast('Closed to joining', 'ok');
      reload();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    }
  };
  /** The joining controls on one of my takes: open it, or (open already) its link, how many joined, close. */
  const joinControls = (p: PerformanceSummary) => {
    if (!isDrive.value || !p.hasVideo || (p.kind ?? 'take') !== 'show' || !controlConfigured.value) return null;
    const inv = openFor.get(p.performanceId);
    return inv ? (
      <>
        <span class="chip ok" data-open-to-join={inv.joins}>
          open to join · {inv.joins} joined
        </span>
        <button class="btn sm" aria-label={`Copy the join link for ${p.trackTitle}`} onClick={() => void copyJoin(p)} data-join-link-copy>
          <IcShare size={14} /> Join link
        </button>
        <button class="btn sm" aria-label={`Close ${p.trackTitle} to joining`} onClick={() => void closeJoin(p)} data-join-close>
          Close
        </button>
      </>
    ) : (
      <button class="btn sm accent" disabled={inviting !== null} aria-label={`Invite others to join ${p.trackTitle}`} onClick={() => void inviteTake(p)} data-invite-join>
        {inviting === p.performanceId ? <Spinner /> : <IcUsers size={14} />} Invite to join
      </button>
    );
  };

  const saving = saveJobs.value;
  // A save that just finished changes the lists: refresh when the saver goes quiet.
  const doneCount = saving.filter((j) => j.state === 'done').length;
  useEffect(() => {
    if (doneCount) reload();
  }, [doneCount]);

  /** Deleting, one after the other: which row is going, and how far through a Delete all we are. */
  const [deleting, setDeleting] = useState<{ id: string | null; done: number; total: number } | null>(null);
  /** Gone for good: the file out of Drive (not the trash); a meet performance unlisted for the whole meet. */
  const deleteOne = async (performanceId: string, show: boolean) => {
    await withProvider((p) => p.deletePerformance(performanceId));
    if (show && controlConfigured.value) await api.del('DELETE /performances/:id', `/performances/${encodeURIComponent(performanceId)}`).catch(() => undefined);
  };
  const deleteRows = async (rows: { id: string; show: boolean }[], what: string) => {
    if (!rows.length) return;
    const one = rows.length === 1;
    if (!confirm(one ? `Delete ${what} permanently? The file is removed from your Drive — this cannot be undone.` : `Delete all ${rows.length} ${what} permanently? The files are removed from your Drive — this cannot be undone.`)) return;
    setDeleting({ id: null, done: 0, total: rows.length });
    let failed = 0;
    for (const [i, r] of rows.entries()) {
      setDeleting({ id: r.id, done: i, total: rows.length });
      try {
        await deleteOne(r.id, r.show);
      } catch (e) {
        failed++;
        toast(errorText(e), 'error', 6000);
      }
    }
    setDeleting(null);
    toast(failed ? `${rows.length - failed} deleted, ${failed} could not be` : one ? 'Deleted' : `${rows.length} deleted`, failed ? 'warn' : 'ok');
    reload();
  };
  const hostedShows = songShows.filter((s) => s.hostUserId === me);

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
        <section class="card stack pad-sm" data-section="shows">
          <div class="row between">
            <h3 style="margin:0">Meet performances</h3>
            <span class="row" style="gap:8px">
              {hostedShows.length > 1 && (
                <button class="btn sm danger" disabled={deleting !== null} aria-label="Delete all the meet performances you hosted" onClick={() => void deleteRows(hostedShows.map((x) => ({ id: x.performanceId, show: true })), 'meet performances you hosted')}>
                  <IcTrash size={14} /> Delete all ({hostedShows.length})
                </button>
              )}
              <span class="chip">{shows?.length ?? '…'}</span>
            </span>
          </div>
          <div class="muted small">The film of every meet you hosted or were in — one file for the whole meet: everyone on stage over the stage background, with the whole mix, what Publisher mode showed, with a chapter mark per song, pause and stretch of stage. It lives in the host's Drive, shared with everyone who was in the meet; anyone with the link can watch. Delete removes the file from your Drive for good (the host deletes; a film in another host's Drive is theirs to delete).</div>
          {deleting && deleting.total > 1 && (
            <div class="row small muted">
              <Spinner /> Deleting {deleting.done + 1} of {deleting.total}…
            </div>
          )}
          {shows === null && (
            <div class="row">
              <Spinner /> Loading…
            </div>
          )}
          {shows && !songShows.length && <div class="muted small">Nothing yet — hold a live meet and the host's device films it here for everyone in it.</div>}
          <div class="list">
            {songShows.map((s) => {
              const own = mine.get(s.performanceId);
              const hosted = s.hostUserId === me;
              const url = s.videoLink ?? own?.videoLink ?? s.link ?? own?.link ?? null;
              const marks = s.chapters ?? [];
              const label = s.chapter ? `${s.chapter.eventTitle} ${String(s.chapter.index).padStart(2, '0')} · ${chapterGlyph(s.chapter.kind)} ${s.songTitle}` : s.songTitle || 'Untitled song';
              return (
                <div class="item wide-actions" key={s.performanceId} data-show={s.performanceId} data-film-marks={marks.length} data-film-kinds={marks.map((c) => c.kind).join(",")}>
                  <div class="thumb" style="background:linear-gradient(135deg,#3a1a6a,#7a3aa8)">
                    <IcUsers size={20} />
                  </div>
                  <div class="meta">
                    <div class="t">
                      {s.meetTitle ? `${s.meetTitle} · ` : ''}
                      {label}
                    </div>
                    <div class="s">
                      {new Date(s.createdAt).toLocaleString()} · {formatMs(s.durationMs)} · {s.singers.map((x) => x.displayName.split(' ')[0]).join(', ') || s.hostName}
                      {hosted ? ' · you hosted' : s.hostName ? ` · host ${s.hostName}` : ''}
                    </div>
                    {marks.length > 0 && (
                      <div class="s" data-film-chapters>
                        {marksLine(marks)}
                      </div>
                    )}
                  </div>
                  <div class="actions">
                    {own && !marks.length ? (
                      <button class="btn sm primary" onClick={() => setOpen(own)}>
                        <IcPlay size={14} /> Play
                      </button>
                    ) : url ? (
                      <a class="btn sm primary" href={safeHref(url)} target="_blank" rel="noopener" title={marks.length ? 'The whole film, streamed from Drive' : 'Watch'}>
                        <IcPlay size={14} /> Watch
                      </a>
                    ) : own ? (
                      <button class="btn sm primary" onClick={() => setOpen(own)}>
                        <IcPlay size={14} /> Play
                      </button>
                    ) : (
                      <span class="chip">no link</span>
                    )}
                    {own && marks.length > 0 && (
                      <button class="btn sm" onClick={() => setOpen(own)} title="Play here, with a button per chapter" data-film-play>
                        Chapters
                      </button>
                    )}
                    <button class="btn sm" aria-label={`Share ${s.songTitle}`} onClick={() => void share(`${s.meetTitle} — ${s.songTitle}`, url)}>
                      <IcShare size={14} /> Share
                    </button>
                    {(hosted || (own && !showIds.has(s.performanceId))) && (
                      <button class="btn sm danger" disabled={deleting !== null} aria-label={`Delete ${s.songTitle || 'this performance'}`} title="Delete permanently from your Drive (everyone in the meet loses it)" onClick={() => void deleteRows([{ id: s.performanceId, show: showIds.has(s.performanceId) }], `"${s.songTitle || 'this performance'}"`)}>
                        {deleting?.id === s.performanceId ? <Spinner /> : <IcTrash size={14} />} Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {invites && invites.joined.length > 0 && (
          <section class="card stack pad-sm" data-section="joined">
            <div class="row between">
              <h3 style="margin:0">Joined yours</h3>
              <span class="chip">{invites.joined.length}</span>
            </div>
            <div class="muted small">Performances other singers made by joining one of yours: their part over your take, everyone on one stage. Each lives in its singer's Drive; watch it, or join it too.</div>
            <div class="list">
              {invites.joined.map((i) => (
                <div class="item wide-actions" key={i.performanceId} data-joined={i.performanceId}>
                  <div class="thumb" style="background:linear-gradient(135deg,#1a4a3a,#2a8a6a)">
                    <IcUsers size={20} />
                  </div>
                  <div class="meta">
                    <div class="t">
                      {i.trackTitle} · {singersLine(i.layers)}
                    </div>
                    <div class="s">
                      {new Date(i.createdAt).toLocaleString()} · {formatMs(i.durationMs)} · {i.ownerName} joined · {i.layers.length} on stage
                      {i.joins ? ` · ${i.joins} joined theirs` : ''}
                    </div>
                  </div>
                  <div class="actions">
                    <a class="btn sm primary" href={safeHref(i.show.link)} target="_blank" rel="noopener">
                      <IcPlay size={14} /> Watch
                    </a>
                    <a class="btn sm accent" href={href(joinPath(i.performanceId))} data-join-too>
                      <IcUsers size={14} /> Join too
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section class="card stack pad-sm" data-section="takes">
          <div class="row between">
            <h3 style="margin:0">Your takes</h3>
            <span class="row" style="gap:8px">
              {takes.length > 1 && (
                <button class="btn sm danger" disabled={deleting !== null} aria-label={`Delete all ${takes.length} takes shown`} onClick={() => void deleteRows(takes.map((x) => ({ id: x.performanceId, show: false })), filter === 'all' ? 'takes' : filter === 'kept' ? 'kept takes' : 'Temp takes')}>
                  <IcTrash size={14} /> Delete all ({takes.length})
                </button>
              )}
              <Seg<'all' | 'kept' | 'temp'>
                value={filter}
                onChange={setFilter}
                options={[
                  { v: 'all', label: 'All' },
                  { v: 'kept', label: 'Saved' },
                  { v: 'temp', label: 'Temp (7 days)' },
                ]}
              />
            </span>
          </div>
          {list === null && (
            <div class="row">
              <Spinner /> Loading…
            </div>
          )}
          {list && !takes.length && (
            <Empty title="No takes here" body="Takes land here after you finish singing — the video is the show (the stage with everyone, with the mix). Temp takes auto-delete after 7 days unless you keep them. Invite others to join a take and they sing their part over it.">
              <a class="btn primary" href={href('/studio/sing')}>
                Sing something
              </a>
            </Empty>
          )}
          <div class="list">
            {takes.map((p) => (
              <div class="item wide-actions" key={p.performanceId} data-take={p.performanceId}>
                <button class="thumb" style={{ cursor: 'pointer', border: 0, color: 'inherit', background: p.state === 'temp' ? 'linear-gradient(135deg,#5a3a10,#8a5a1a)' : undefined }} aria-label={`Play ${p.trackTitle}`} onClick={() => setOpen(p)}>
                  <IcPlay size={20} />
                </button>
                <div class="meta" style="cursor:pointer" onClick={() => setOpen(p)}>
                  <div class="t">
                    {p.meetTitle ? `${p.meetTitle} · ` : ''}
                    {p.trackTitle}
                    {p.with ? <span class="muted"> · with {p.with}</span> : null}
                  </div>
                  <div class="s">
                    {new Date(p.createdAt).toLocaleString()} · {formatMs(p.durationMs)} · {p.mode}
                    {p.hasVideo ? (p.kind === 'show' ? ' · show video' : ' · video') : ''}
                  </div>
                </div>
                <div class="actions">
                  <span class={`chip ${p.state === 'temp' ? 'warn' : 'ok'}`}>{p.state === 'temp' ? `Temp · ${daysLeft(p.expiresAt)}` : 'Saved'}</span>
                  {joinControls(p)}
                  <button class="btn sm danger" disabled={deleting !== null} aria-label={`Delete ${p.trackTitle}`} title="Delete permanently from your Drive" onClick={() => void deleteRows([{ id: p.performanceId, show: false }], `"${p.trackTitle}"`)}>
                    {deleting?.id === p.performanceId ? <Spinner /> : <IcTrash size={14} />} Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <Sheet open={open !== null} onClose={() => setOpen(null)} wide={Boolean(open?.hasVideo)} title={open ? `${open.meetTitle ? `${open.meetTitle} · ` : ''}${open.chapter ? `${open.chapter.eventTitle} ${String(open.chapter.index).padStart(2, '0')} · ` : ''}${open.trackTitle}` : ''}>
        {open && <PerformanceDetail summary={open} show={(shows ?? []).find((s) => s.performanceId === open.performanceId) ?? null} onChanged={() => (setOpen(null), void reload())} />}
      </Sheet>
    </Page>
  );
}


function daysLeft(expiresAt: string | null): string {
  if (!expiresAt) return '';
  const d = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 86400000));
  return d === 0 ? 'expires today' : `${d}d left`;
}

function PerformanceDetail(props: { summary: PerformanceSummary; show: MeetPerformance | null; onChanged: () => void }) {
  const [loaded, setLoaded] = useState<LoadedPerformance | null>(null);
  const [backing, setBacking] = useState<Blob | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState<{ link: string; videoLink: string | null } | null>(props.summary.shared && props.summary.link ? { link: props.summary.link, videoLink: props.summary.videoLink ?? null } : null);
  const [clipping, setClipping] = useState(false);
  /** A take (no show): the vocal over the track through the mix bus, as a saved show mixes them (audio/takePlayback.ts). */
  const player = useRef<TakePlayback | null>(null);
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
      player.current?.close();
      player.current = null;
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [props.summary.performanceId]);

  const stop = () => {
    player.current?.stop();
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
    const m = loaded.manifest;
    const p = player.current ?? new TakePlayback();
    player.current = p;
    const a = appSettings.peek();
    await p.play({ backing, trackId: m.trackId, vocal: loaded.vocal, vocalAtMs: m.timeline.vocalOffsetMs, trackDb: a.trackDb, vocalDb: a.vocalDb, onEnded: () => setPlaying(false) });
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
      toast('Saved', 'ok');
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
  /** The files themselves — the show video (and a take's vocal); the details stay with the performance, never a file of their own. */
  const download = () => {
    if (!loaded) return;
    const base = `${props.summary.trackTitle} ${props.summary.createdAt.slice(0, 16).replace(/[:T]/g, '-')}`;
    if (loaded.vocal.size) downloadBlob(loaded.vocal, `${base} vocal.wav`);
    if (loaded.video) downloadBlob(loaded.video, `${base} ${isShow ? 'show' : 'video'}.${loaded.video.type.includes('mp4') ? 'mp4' : 'webm'}`);
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
      {videoUrl && <video ref={videoRef} src={videoUrl} muted={!isShow} controls={isShow} playsInline class="perf-video" data-perf-video />}
      {videoUrl && (s.chapters?.length ?? 0) > 0 && (
        <div class="row wrap" style="gap:6px" data-film-marks-row>
          {s.chapters!.map((c) => (
            <button
              class="btn sm"
              key={c.index}
              data-film-mark={c.index}
              data-film-mark-kind={c.kind}
              data-film-mark-at={c.startedAt}
              data-film-mark-ms={c.startMs}
              title={`Jump to ${formatMs(c.startMs)}`}
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                v.currentTime = c.startMs / 1000;
                v.muted = false;
                void v.play().catch(() => undefined);
                setPlaying(true);
              }}
            >
              {String(c.index).padStart(2, '0')} {chapterGlyph(c.kind)} {markTitle(c)} · {formatMs(c.startMs)}
            </button>
          ))}
        </div>
      )}
      {isShow && <div class="small faint">The show: everyone on stage over the stage background, with the whole mix — as Publisher mode showed it.</div>}
      {loaded && !isShow && !backing && <div class="callout warn">The backing track for this take isn't in your library any more — playing the vocal only.</div>}
      <div class="row">
        <button class="btn primary" disabled={!loaded} onClick={() => (playing ? stop() : void play())}>
          {playing ? <IcStop /> : <IcPlay />} {playing ? 'Stop' : isShow ? 'Play' : 'Play mix'}
        </button>
        {s.state === 'temp' && (
          <button class="btn accent" disabled={busy} onClick={() => void keep()}>
            Save
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
        {loaded?.video && (
          <button class="btn accent" onClick={() => (stop(), setClipping(true))} data-post-clip>
            <IcShare /> Post a clip
          </button>
        )}
        {s.link && isDrive.value && (
          <a class="btn ghost" href={safeHref(s.videoLink ?? s.link)} target="_blank" rel="noopener">
            Open in Drive
          </a>
        )}
        <button class="btn danger" disabled={busy} onClick={() => void del()}>
          <IcTrash /> Delete
        </button>
      </div>
      <Sheet open={clipping} onClose={() => setClipping(false)} title={`Post a clip — ${s.trackTitle}`}>
        {clipping && loaded?.video && <ClipSheet source={{ video: loaded.video, durationMs: s.durationMs, title: s.trackTitle, performanceId: s.performanceId, singers: m?.singers?.map((x) => x.displayName), link: shared?.videoLink ?? shared?.link ?? s.videoLink ?? s.link ?? null }} onClose={() => setClipping(false)} />}
      </Sheet>
    </div>
  );
}
