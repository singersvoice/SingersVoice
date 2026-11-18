/**
 * Performances (/studio/performances): everything you ever sang, by date and name.
 *
 * - Meet performances: one saved show per song of every meet you hosted or were in — the stage
 *   with everyone on it over the stage background, with the whole mix, exactly as Publisher mode
 *   showed it. The host's device recorded it; it lives in the host's Drive, shared with everyone
 *   who was in the meet, and anyone with its link can watch it.
 * - Your takes: your own takes (Studio, or your personal take of a meet song), Temp or kept.
 *
 * Deleting is plain: a Delete on every row, and Delete all for a whole section — the files go from
 * your Drive for good (never the trash), and a meet performance is unlisted for everyone in the meet.
 */
import { formatMs, joinPath, singersLine, type JoinInvite, type MeetPerformance } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { IcDownload, IcPlay, IcShare, IcStop, IcTrash, IcUsers } from '../../components/icons.tsx';
import { SaveStatus } from '../../components/SaveStatus.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Seg, Sheet, Spinner } from '../../components/ui.tsx';
import { api, controlConfigured } from '../../lib/api.ts';
import { downloadBlob, shareOrCopy } from '../../lib/download.ts';
import { href } from '../../lib/nav.ts';
import { closeInvite, invitePerformance, joinUrl } from '../../lib/joins.ts';
import { groupEvents, type FilmEvent } from '../../lib/filmEvents.ts';
import type { LoadedPerformance, PerformanceSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { saveJobs } from '../../lib/saveQueue.ts';
import { accountUserId, isDrive, withProvider } from '../../state/session.ts';

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
  const takes = (list ?? []).filter((p) => !showIds.has(p.performanceId) && !p.chapter).filter((p) => filter === 'all' || p.state === filter);
  const me = accountUserId.value;
  /** The filmed events (the film of a meet, a broadcast's footage): their chapters, from the meet's registry and from my own Drive, grouped and ordered. */
  const events = useMemo(() => groupEvents(shows ?? [], list ?? []), [shows, list]);
  const songShows = (shows ?? []).filter((s) => !s.chapter);
  const [openEvent, setOpenEvent] = useState<FilmEvent | null>(null);

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
          <div class="muted small">One saved show per song of every meet you hosted or were in: everyone on stage over the stage background, with the whole mix — what Publisher mode showed. One file each, straight under Performances in the host's Drive, shared with everyone who was in the meet; anyone with the link can watch. Delete removes the file from your Drive for good (the host deletes; a performance in another host's Drive is theirs to delete).</div>
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
          {shows && !shows.length && !events.length && <div class="muted small">Nothing yet — sing a song in a live meet and the host's device saves the show here for everyone in it.</div>}
          {events.length > 0 && (
            <div class="stack" data-events>
              {events.map((ev) => {
                const hosted = ev.hostUserId === me || ev.chapters.every((c) => c.own && !c.show);
                return (
                  <div class="card stack pad-sm" key={ev.eventId} data-event={ev.eventId} style="background:var(--surface-2, rgba(255,255,255,0.03))">
                    <div class="row between wrap">
                      <div>
                        <b>
                          {ev.title} · {ev.meetTitle}
                        </b>
                        <div class="small muted">
                          {new Date(ev.startedAt).toLocaleString()} · {ev.chapters.length} chapter{ev.chapters.length === 1 ? '' : 's'} · {formatMs(ev.durationMs)}
                          {ev.hostUserId === me ? ' · you hosted' : ev.hostName ? ` · host ${ev.hostName}` : ''}
                        </div>
                        <div class="small faint">One file per chapter: every song, pause and stretch of stage on its own, in order, with its time — nothing merged, nothing lost with the next.</div>
                      </div>
                      <div class="row" style="gap:6px">
                        {ev.chapters.some((c) => c.own) && (
                          <button class="btn sm primary" onClick={() => setOpenEvent(ev)} data-play-all>
                            <IcPlay size={14} /> Play all
                          </button>
                        )}
                        {hosted && ev.chapters.length > 1 && (
                          <button class="btn sm danger" disabled={deleting !== null} aria-label={`Delete every chapter of ${ev.title}`} onClick={() => void deleteRows(ev.chapters.map((c) => ({ id: c.performanceId, show: Boolean(c.show) })), `chapters of "${ev.title} · ${ev.meetTitle}"`)}>
                            <IcTrash size={14} /> Delete all
                          </button>
                        )}
                      </div>
                    </div>
                    <div class="list">
                      {ev.chapters.map((c) => {
                        const url = c.show?.videoLink ?? c.own?.videoLink ?? c.show?.link ?? c.own?.link ?? null;
                        return (
                          <div class="item wide-actions" key={c.performanceId} data-chapter={c.index} data-chapter-kind={c.kind} data-chapter-at={c.startedAt} data-performance-id={c.performanceId}>
                            <div class="thumb" style={{ background: c.kind === 'song' ? 'linear-gradient(135deg,#3a1a6a,#7a3aa8)' : c.kind === 'pause' ? 'linear-gradient(135deg,#5a3a10,#8a5a1a)' : 'linear-gradient(135deg,#1a3a4a,#2a6a7a)' }}>
                              <span class="small">{String(c.index).padStart(2, '0')}</span>
                            </div>
                            <div class="meta">
                              <div class="t">
                                {c.kind === 'song' ? '♪ ' : c.kind === 'pause' ? '⏸ ' : '▪ '}
                                {c.title}
                              </div>
                              <div class="s">
                                {new Date(c.startedAt).toLocaleTimeString()} · {formatMs(c.durationMs)}
                                {c.singers.length ? ` · ${c.singers.map((x) => x.displayName.split(' ')[0]).join(', ')}` : ''}
                              </div>
                            </div>
                            <div class="actions">
                              {c.own ? (
                                <button class="btn sm primary" onClick={() => setOpen(c.own!)}>
                                  <IcPlay size={14} /> Play
                                </button>
                              ) : url ? (
                                <a class="btn sm primary" href={url} target="_blank" rel="noopener">
                                  <IcPlay size={14} /> Watch
                                </a>
                              ) : (
                                <span class="chip">no link</span>
                              )}
                              <button class="btn sm" aria-label={`Share chapter ${c.index}`} onClick={() => void share(`${ev.title} ${String(c.index).padStart(2, '0')} · ${c.title}`, url)}>
                                <IcShare size={14} /> Share
                              </button>
                              {(c.show ? c.show.hostUserId === me : Boolean(c.own)) && (
                                <button class="btn sm danger" disabled={deleting !== null} aria-label={`Delete chapter ${c.index}`} title="Delete permanently from your Drive" onClick={() => void deleteRows([{ id: c.performanceId, show: Boolean(c.show) }], `chapter ${c.index} "${c.title}"`)}>
                                  {deleting?.id === c.performanceId ? <Spinner /> : <IcTrash size={14} />} Delete
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div class="list">
            {songShows.map((s) => {
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
                      <button class="btn sm danger" disabled={deleting !== null} aria-label={`Delete ${s.songTitle || 'this performance'}`} title="Delete permanently from your Drive (everyone in the meet loses it)" onClick={() => void deleteRows([{ id: s.performanceId, show: true }], `"${s.songTitle || 'this performance'}"`)}>
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
                    <a class="btn sm primary" href={i.show.link} target="_blank" rel="noopener">
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
                  { v: 'kept', label: 'Kept' },
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
                  <span class={`chip ${p.state === 'temp' ? 'warn' : 'ok'}`}>{p.state === 'temp' ? `Temp · ${daysLeft(p.expiresAt)}` : 'Kept'}</span>
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
      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open ? `${open.meetTitle ? `${open.meetTitle} · ` : ''}${open.chapter ? `${open.chapter.eventTitle} ${String(open.chapter.index).padStart(2, '0')} · ` : ''}${open.trackTitle}` : ''}>
        {open && <PerformanceDetail summary={open} show={(shows ?? []).find((s) => s.performanceId === open.performanceId) ?? null} onChanged={() => (setOpen(null), void reload())} />}
      </Sheet>
      <Sheet open={openEvent !== null} onClose={() => setOpenEvent(null)} title={openEvent ? `${openEvent.title} · ${openEvent.meetTitle}` : ''}>
        {openEvent && <EventPlayer event={openEvent} />}
      </Sheet>
    </Page>
  );
}

/** The whole filming, chapter after chapter: each file plays in turn (the chapters that are in my Drive). */
function EventPlayer(props: { event: FilmEvent }) {
  const playable = props.event.chapters.filter((c) => c.own);
  const [at, setAt] = useState(0);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const current = playable[at] ?? null;
  useEffect(() => {
    let gone = false;
    let made = '';
    if (!current) return;
    setLoading(true);
    void withProvider(async (p) => {
      const perf = await p.getPerformance(current.performanceId);
      if (!perf?.video || gone) return;
      made = URL.createObjectURL(perf.video);
      setUrl(made);
    })
      .catch((e) => toast(errorText(e), 'error'))
      .finally(() => !gone && setLoading(false));
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [current?.performanceId]);
  useEffect(() => {
    const v = videoRef.current;
    if (v && url) void v.play().catch(() => undefined);
  }, [url]);
  return (
    <div class="stack" data-event-player>
      <div class="small muted">
        Chapter {current ? String(current.index).padStart(2, '0') : '—'} of {playable.length}: {current?.title ?? ''}
        {current ? ` · ${new Date(current.startedAt).toLocaleTimeString()} · ${formatMs(current.durationMs)}` : ''}
      </div>
      {loading && (
        <div class="row">
          <Spinner /> Loading the chapter…
        </div>
      )}
      {url && <video ref={videoRef} src={url} controls playsInline style="width:100%;border-radius:12px;background:#000;max-height:40dvh" onEnded={() => at < playable.length - 1 && setAt(at + 1)} data-event-video={current?.index} />}
      <div class="row wrap" style="gap:6px">
        {playable.map((c, i) => (
          <button class={`btn sm ${i === at ? 'primary' : ''}`} key={c.performanceId} onClick={() => setAt(i)} data-event-chapter={c.index}>
            {String(c.index).padStart(2, '0')} {c.kind === 'song' ? '♪' : c.kind === 'pause' ? '⏸' : '▪'} {c.title}
          </button>
        ))}
      </div>
    </div>
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
