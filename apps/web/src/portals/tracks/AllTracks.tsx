/**
 * The All tab of the Tracks portal: one search across what singers have sung (the SingersVoice track
 * database — the master database every Sing registers with), my own Drive, the public catalog and
 * YouTube. The database's answers come as a tree: every song name one group, the latest sung first;
 * inside it the versions — by artist, movie, language, source — each singable on its own; a song with
 * several artists cascades one level more. Sing on any row brings the song into MY Drive (Tracks),
 * shares it and opens the stage; a preview plays the backing track here. An access is on record only
 * once the song really opened or played — never for a search.
 */
import { formatMs, trackRecordLine, youtubeSearchQuery, type CatalogTrack, type TrackRecord, type TrackSearchGroup, type YtSearchItem, type YtStatus } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { IcDownload, IcPlay, IcSliders, IcStop } from '../../components/icons.tsx';
import { Empty, Progress, Spinner } from '../../components/ui.tsx';
import { ApiError, controlConfigured, controlStatus } from '../../lib/api.ts';
import { isSameTrack, myCatalogUserId, pullCatalogTrack, searchCatalog } from '../../lib/catalog.ts';
import { go, href } from '../../lib/nav.ts';
import { myHistory, myRegistryUserId, previewUrl, recordAccess, searchTracks, singRecord } from '../../lib/registry.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { importYoutubeTrack, searchYoutube, ytStatus } from '../../lib/ytTracks.ts';
import { isDrive } from '../../state/session.ts';

/** "today", "3 days ago", "Nov 2026" — when a song was last sung. */
export function sungAgo(iso: string | null): string {
  if (!iso) return 'not sung yet';
  const d = Date.now() - Date.parse(iso);
  if (!Number.isFinite(d)) return '';
  const m = Math.round(d / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 2) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

const sourceName = (s: TrackRecord['source']) => (s === 'youtube' ? 'YouTube' : s === 'catalog' ? 'Catalog' : 'Drive');

export function AllTracks(props: { tracks: TrackSummary[]; onChanged: () => void; onMore: (t: TrackSummary) => void }) {
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<TrackSearchGroup[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<TrackRecord[]>([]);
  const [catalog, setCatalog] = useState<CatalogTrack[]>([]);
  const [yt, setYt] = useState<{ q: string; items: YtSearchItem[] } | null>(null);
  const [ytSearching, setYtSearching] = useState(false);
  const [status, setStatus] = useState<YtStatus | null>(null);
  const [busy, setBusy] = useState<{ id: string; label: string; fraction: number } | null>(null);
  const [preview, setPreview] = useState<{ id: string; state: 'loading' | 'playing' } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewSeq = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!controlConfigured.value) return;
    void ytStatus().then(setStatus);
    void myHistory(8).then(setHistory).catch(() => undefined);
    return () => {
      audioRef.current?.pause();
      if (audioRef.current?.src) URL.revokeObjectURL(audioRef.current.src);
    };
  }, []);

  // The database and the catalog answer as the singer types (a quarter second after the last key); YouTube on Search.
  const load = async (query: string, append = false) => {
    if (!controlConfigured.value) return setGroups([]);
    try {
      const r = await searchTracks(query, { cursor: append ? cursor : null, limit: 20 });
      setGroups((prev) => (append && prev ? [...prev, ...r.groups] : r.groups));
      setTotal(r.total);
      setCursor(r.nextCursor);
      if (!append) setCatalog(query ? (await searchCatalog(query, { limit: 24 })).items : []);
    } catch (e) {
      setGroups([]);
      if (!(e instanceof ApiError && e.code === 'offline')) toast(errorText(e), 'error');
    }
  };
  useEffect(() => {
    const t = setTimeout(() => void load(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const searchYt = async () => {
    const query = q.trim();
    if (!query) return input.current?.focus();
    if (status && !status.available) return toast(status.note || 'YouTube is not available', 'warn');
    setYtSearching(true);
    try {
      setYt({ q: query, items: await searchYoutube(query) });
    } catch (e) {
      setYt({ q: query, items: [] });
      toast(errorText(e), 'error', 8000);
    } finally {
      setYtSearching(false);
    }
  };

  const needle = q.trim().toLowerCase();
  const mine = useMemo(() => (needle ? props.tracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(needle)) : []), [props.tracks, needle]);
  const inDb = useMemo(() => new Set((groups ?? []).flatMap((g) => g.versions.map((v) => v.trackId))), [groups]);
  const ytInDb = useMemo(() => new Set((groups ?? []).flatMap((g) => g.versions.map((v) => v.youtubeId).filter(Boolean))), [groups]);
  const me = myCatalogUserId();
  // Catalog entries the database already answered with are not listed twice.
  const catalogOnly = catalog.filter((c) => !(c.registryId && inDb.has(c.registryId)));
  const ytOnly = yt && yt.q === q.trim() ? yt.items.filter((it) => !ytInDb.has(it.id)) : null;

  /** Sing a record: the song comes into my Drive (or is there already), then the stage. */
  const sing = async (v: TrackRecord) => {
    setBusy({ id: v.trackId, label: 'Opening', fraction: 0.05 });
    try {
      const id = await singRecord(v, (p) => setBusy({ id: v.trackId, ...p }));
      props.onChanged();
      go(`/studio/sing/${encodeURIComponent(id)}`);
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'not_shared' ? "This song's files are no longer shared from any singer's Drive — it cannot be sung until somebody shares it again" : errorText(e), 'error', 9000);
      setBusy(null);
      void load(q.trim());
    }
  };
  /** A YouTube result: fetched into my Drive as a song track, then the stage. */
  const singYt = async (it: YtSearchItem) => {
    if (!isDrive.value) return toast('YouTube song tracks go into your Google Drive — sign in with Google first', 'warn');
    setBusy({ id: it.id, label: 'Starting', fraction: 0 });
    try {
      const saved = await importYoutubeTrack(it, (p) => setBusy({ id: it.id, ...p }));
      props.onChanged();
      go(`/studio/sing/${encodeURIComponent(saved.trackId)}`);
    } catch (e) {
      toast(errorText(e), 'error', 10000);
      setBusy(null);
    }
  };
  const addYt = async (it: YtSearchItem) => {
    if (!isDrive.value) return toast('YouTube song tracks go into your Google Drive — sign in with Google first', 'warn');
    setBusy({ id: it.id, label: 'Starting', fraction: 0 });
    try {
      const saved = await importYoutubeTrack(it, (p) => setBusy({ id: it.id, ...p }));
      toast(`"${saved.title}" is in your Drive (Tracks/YT) — ready to sing`, 'ok', 7000);
      props.onChanged();
      void load(q.trim());
    } catch (e) {
      toast(errorText(e), 'error', 10000);
    } finally {
      setBusy(null);
    }
  };
  const pull = async (c: CatalogTrack) => {
    setBusy({ id: c.trackId, label: "Fetching from the owner's Drive", fraction: 0.1 });
    try {
      await pullCatalogTrack(c, (p) => setBusy({ id: c.trackId, ...p }));
      toast(`"${c.title}" added to ${isDrive.value ? 'your Drive' : 'this device'}`, 'ok', 5000);
      props.onChanged();
      void load(q.trim());
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };
  /** A preview of the backing track, here; the access is on record once it plays (not when it fails). */
  const togglePreview = async (v: TrackRecord) => {
    const a = audioRef.current ?? (audioRef.current = new Audio());
    if (preview?.id === v.trackId) {
      a.pause();
      setPreview(null);
      return;
    }
    const seq = ++previewSeq.current;
    a.pause();
    setPreview({ id: v.trackId, state: 'loading' });
    try {
      const url = await previewUrl(v);
      if (seq !== previewSeq.current) return URL.revokeObjectURL(url);
      if (a.src) URL.revokeObjectURL(a.src);
      a.src = url;
      a.onplaying = () => {
        if (seq !== previewSeq.current) return;
        setPreview({ id: v.trackId, state: 'playing' });
        void recordAccess(v.trackId, 'play').then((r) => r && refreshRecord(r));
        a.onplaying = null; // once per start
      };
      a.onended = () => setPreview((p) => (p?.id === v.trackId ? null : p));
      await a.play();
    } catch (e) {
      if (seq !== previewSeq.current) return;
      setPreview(null);
      toast(e instanceof ApiError && e.code === 'not_shared' ? "This song's files are no longer shared from any singer's Drive" : errorText(e), 'error', 8000);
    }
  };
  /** A record as the service now has it (after an access of mine), in place. */
  const refreshRecord = (r: TrackRecord) => setGroups((gs) => (gs ? gs.map((g) => ({ ...g, versions: g.versions.map((v) => (v.trackId === r.trackId ? r : v)) })) : gs));

  if (!controlConfigured.value)
    return (
      <div class="stack">
        <input class="input" placeholder="Search my tracks" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
        <div class="callout warn">
          The SingersVoice track database, the public catalog and YouTube come online when the SingersVoice service is deployed — this build has no <span class="kbd">VITE_CONTROL_URL</span>. Your own tracks work meanwhile.
        </div>
        <MyRows tracks={needle ? mine : props.tracks} onMore={props.onMore} />
      </div>
    );

  return (
    <div class="stack" data-all-section>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void searchYt();
        }}
      >
        <input ref={input} class="input" style="flex:1" placeholder="Search everything — song, artist, movie, language…" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} data-all-query />
        <button class="btn primary" type="submit" disabled={ytSearching} data-all-search>
          {ytSearching ? <Spinner /> : null} Search
        </button>
      </form>
      <div class="row between small muted wrap">
        <span>
          {groups ? `${total} song${total === 1 ? '' : 's'} sung by singers${needle ? ' match' : ''}` : 'Loading…'} {controlStatus.value === 'offline' && <span class="chip warn">service unreachable</span>}
        </span>
        <span>{needle ? 'As you type: the track database, your Drive, the catalog · Search: YouTube too' : 'The latest sung first'}</span>
      </div>

      {!needle && history.length > 0 && (
        <section class="stack" data-all-history>
          <b class="small">Recently sung by you</b>
          <div class="list">
            {history.map((v) => (
              <VersionRow key={v.trackId} v={v} tracks={props.tracks} busy={busy} preview={preview} onSing={sing} onPreview={togglePreview} />
            ))}
          </div>
        </section>
      )}

      <section class="stack" data-all-db>
        <b class="small">{needle ? 'Sung by singers' : 'Latest in the SingersVoice track database'}</b>
        {groups && !groups.length && <Empty title={needle ? 'Nobody has sung that yet' : 'Nothing sung yet'} body={needle ? 'Your Drive, the catalog and YouTube are searched below.' : 'Sing any track — it is registered for everyone here.'} />}
        <div class="list" data-song-tree>
          {groups?.map((g) => (
            <SongGroup key={g.songKey} g={g} tracks={props.tracks} busy={busy} preview={preview} onSing={sing} onPreview={togglePreview} />
          ))}
        </div>
        {cursor && (
          <button class="btn block" onClick={() => void load(q.trim(), true)} data-all-more>
            More songs
          </button>
        )}
      </section>

      {needle && (
        <section class="stack" data-all-mine>
          <b class="small">In {isDrive.value ? 'my Drive' : 'this device'}</b>
          {!mine.length && <div class="muted small">No track of yours matches.</div>}
          <MyRows tracks={mine} onMore={props.onMore} />
        </section>
      )}

      {needle && catalogOnly.length > 0 && (
        <section class="stack" data-all-catalog>
          <b class="small">Public catalog</b>
          <div class="list">
            {catalogOnly.map((c) => {
              const owned = c.ownerUserId === me;
              const have = props.tracks.some((t) => isSameTrack(t.trackId, c.trackId));
              const b = busy?.id === c.trackId ? busy : null;
              return (
                <div class="item" key={c.trackId} data-catalog-result={c.trackId}>
                  <div class="thumb">{c.title.charAt(0).toUpperCase()}</div>
                  <div class="meta">
                    <div class="t">{c.title}</div>
                    <div class="s">
                      {c.artist || 'Unknown artist'} · {formatMs(c.durationMs)}
                    </div>
                    {b && <Progress fraction={b.fraction} label={b.label} />}
                  </div>
                  <div class="actions">
                    {owned || have ? (
                      <span class="chip ok">in my library</span>
                    ) : (
                      <button class="btn sm accent" disabled={busy !== null} onClick={() => void pull(c)}>
                        <IcDownload size={16} /> Add to my {isDrive.value ? 'Drive' : 'device'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {needle && (
        <section class="stack" data-all-youtube>
          <b class="small">YouTube</b>
          {status && !status.available && <div class="callout warn small">YouTube is not available: {status.note || 'the relay is not deployed'}.</div>}
          {ytOnly === null && status?.available !== false && <div class="muted small">Press Search for YouTube results{ytSearching ? '…' : ''}</div>}
          {ytOnly !== null && youtubeSearchQuery(q) !== q.trim() && (
            <div class="muted small" data-yt-asked>
              YouTube was asked for “{youtubeSearchQuery(q)}” — a karaoke track, always.
            </div>
          )}
          {ytOnly && !ytOnly.length && <div class="muted small">{yt?.items.length ? 'The YouTube results are all in the SingersVoice track database already (above).' : 'Nothing found on YouTube.'}</div>}
          {ytOnly && ytOnly.length > 0 && (
            <div class="list" data-yt-results>
              {ytOnly.map((it) => {
                const b = busy?.id === it.id ? busy : null;
                return (
                  <div class="item" key={it.id} data-yt-result={it.id}>
                    <img class="thumb" src={it.thumbnail} alt="" width={64} height={36} loading="lazy" style="object-fit:cover;aspect-ratio:16/9;width:72px;height:auto" />
                    <div class="meta">
                      <div class="t">{it.title}</div>
                      <div class="s">
                        {it.channel || 'YouTube'}
                        {it.durationMs ? ` · ${formatMs(it.durationMs)}` : ''}
                      </div>
                      {b && <Progress fraction={b.fraction} label={b.label} />}
                    </div>
                    <div class="actions">
                      <button class="btn sm primary" disabled={busy !== null || status?.available === false} onClick={() => void singYt(it)} data-yt-sing>
                        <IcPlay size={16} /> Sing
                      </button>
                      <button class="btn sm" disabled={busy !== null || status?.available === false} onClick={() => void addYt(it)} data-yt-add>
                        <IcDownload size={16} /> Add
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function MyRows(props: { tracks: TrackSummary[]; onMore: (t: TrackSummary) => void }) {
  return (
    <div class="list">
      {props.tracks.map((t) => (
        <div class="item" key={t.trackId} data-my-track={t.trackId}>
          <a class="thumb" href={href(`/studio/sing/${encodeURIComponent(t.trackId)}`)} style="text-decoration:none;color:inherit">
            {t.title.charAt(0).toUpperCase()}
          </a>
          <div class="meta">
            <div class="t">
              {t.title} {t.video && <span class="chip">video</span>} {t.registryId && <span class="chip ok">in the database</span>}
            </div>
            <div class="s">
              {t.artist || 'Unknown artist'} · {formatMs(t.durationMs)}
            </div>
          </div>
          <div class="actions">
            <a class="btn sm primary" href={href(`/studio/sing/${encodeURIComponent(t.trackId)}`)}>
              Sing
            </a>
            <button class="btn icon sm" aria-label="More" onClick={() => props.onMore(t)}>
              <IcSliders size={18} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

type RowProps = { tracks: TrackSummary[]; busy: { id: string; label: string; fraction: number } | null; preview: { id: string; state: 'loading' | 'playing' } | null; onSing: (v: TrackRecord) => void; onPreview: (v: TrackRecord) => void };

/**
 * One song: its versions under it. One version shows as the row itself; several open on a tap (the latest sung first);
 * several artists cascade one level more — an artist (or a movie) with its files under it.
 */
function SongGroup(props: { g: TrackSearchGroup } & RowProps) {
  const { g } = props;
  const [open, setOpen] = useState(false);
  if (g.versions.length === 1) return <VersionRow v={g.versions[0]!} {...props} />;
  const artists = new Map<string, TrackRecord[]>();
  for (const v of g.versions) {
    const k = v.artists || v.movie || 'Unknown artist';
    artists.set(k, [...(artists.get(k) ?? []), v]);
  }
  return (
    <div class="tree-node" data-song-group={g.songKey} data-open={open ? '1' : '0'}>
      <button type="button" class="item tree-head" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-song-toggle>
        <div class="thumb">{open ? '▾' : '▸'}</div>
        <div class="meta">
          <div class="t">{g.song}</div>
          <div class="s">
            {g.versions.length} versions · {artists.size > 1 ? `${artists.size} artists · ` : ''}
            {g.lastAccessedAt ? `last sung ${sungAgo(g.lastAccessedAt)}` : 'not sung yet'}
          </div>
        </div>
        <span class="small muted">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div class="tree-children" data-song-versions>
          {artists.size > 1
            ? [...artists.entries()].map(([name, vs]) => <ArtistBranch key={name} name={name} versions={vs} {...props} />)
            : g.versions.map((v) => <VersionRow key={v.trackId} v={v} {...props} />)}
        </div>
      )}
    </div>
  );
}

function ArtistBranch(props: { name: string; versions: TrackRecord[] } & RowProps) {
  const [open, setOpen] = useState(props.versions.length === 1);
  return (
    <div class="tree-node" data-artist-branch={props.name} data-open={open ? '1' : '0'}>
      <button type="button" class="item tree-head" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-artist-toggle>
        <div class="thumb">{open ? '▾' : '▸'}</div>
        <div class="meta">
          <div class="t">{props.name}</div>
          <div class="s">
            {props.versions.length} file{props.versions.length === 1 ? '' : 's'} · last sung {sungAgo(props.versions[0]!.lastAccessedAt)}
          </div>
        </div>
      </button>
      {open && (
        <div class="tree-children">
          {props.versions.map((v) => (
            <VersionRow key={v.trackId} v={v} {...props} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One file of a song: what it is (artist · movie · year · language · source), how many sang it, and Sing / a preview — never who (no singer's name on a track line). */
function VersionRow(props: { v: TrackRecord } & RowProps) {
  const { v } = props;
  const haveIt = props.tracks.some((t) => t.registryId === v.trackId || t.trackId === v.mine?.copyTrackId);
  const ownIt = v.ownerUserId === myRegistryUserId(); // mine: in my Drive as any other
  const b = props.busy?.id === v.trackId ? props.busy : null;
  const pv = props.preview?.id === v.trackId ? props.preview : null;
  const line = trackRecordLine(v);
  return (
    <div class={`item ${v.unavailable ? 'faint' : ''}`} data-version={v.trackId} data-version-source={v.source} data-last-accessed={v.lastAccessedAt ?? ''}>
      {v.thumbnail ? <img class="thumb" src={v.thumbnail} alt="" loading="lazy" style="object-fit:cover;aspect-ratio:16/9;width:72px;height:auto" /> : <div class="thumb">{v.song.charAt(0).toUpperCase()}</div>}
      <div class="meta">
        <div class="t">
          {v.song} <span class="chip">{sourceName(v.source)}</span> {v.hasVideo && <span class="chip">video</span>} {(haveIt || ownIt) && <span class="chip ok">in my Drive</span>} {v.unavailable && <span class="chip warn">unavailable</span>}
        </div>
        <div class="s">
          {line ? `${line} · ` : ''}
          {v.durationMs ? `${formatMs(v.durationMs)} · ` : ''}
          {v.singers ? `sung by ${v.singers} singer${v.singers === 1 ? '' : 's'} · ` : ''}
          <span data-sung-ago>{v.lastAccessedAt ? `last sung ${sungAgo(v.lastAccessedAt)}` : 'not sung yet'}</span>
        </div>
        {b && <Progress fraction={b.fraction} label={b.label} />}
      </div>
      <div class="actions">
        <button class="btn icon sm" aria-label={pv?.state === 'playing' ? 'Stop the preview' : 'Preview'} disabled={props.busy !== null} onClick={() => props.onPreview(v)} data-version-preview={pv?.state ?? 'idle'}>
          {pv?.state === 'loading' ? <Spinner /> : pv?.state === 'playing' ? <IcStop size={16} /> : <IcPlay size={16} />}
        </button>
        <button class="btn sm primary" disabled={props.busy !== null} onClick={() => props.onSing(v)} data-version-sing>
          Sing
        </button>
      </div>
    </div>
  );
}
