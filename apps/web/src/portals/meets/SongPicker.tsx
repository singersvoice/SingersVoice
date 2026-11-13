/**
 * Pick a song for the meet: one of my saved tracks (my Drive library) or a track another singer
 * shares. Built for a big library: one search box over both — every word you type must match
 * (title, artist, genre, language or the singer who shared it, in any order), my songs filtered
 * right here, the shared ones searched in the catalog (SVT DB) page by page, counts shown, Enter
 * picks the top match. Picking is all a singer does — the song then loads on every device in the
 * meet so all the singers sing the same lines at the same time. A track of mine that other devices
 * cannot reach yet is shared on the way (its Drive folder gets an anyone-with-the-link permission
 * and a public catalog entry, through lib/catalog.ts — the same thing the Tracks portal does);
 * nobody is asked about it here.
 */
import { formatMs, type CatalogTrack, type SongPick } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { IcMusic, IcX } from '../../components/icons.tsx';
import { Progress, Spinner } from '../../components/ui.tsx';
import { canPublish, isSameTrack, myCatalogUserId, myPublishedIds, publishTrack, searchCatalog } from '../../lib/catalog.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { withProvider } from '../../state/session.ts';

const PAGE = 30;
const MINE_PAGE = 40;

/** Every word must appear somewhere in the text, in any order. */
export function matchesWords(text: string, q: string): boolean {
  const hay = text.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function SongPicker(props: { onPick: (song: SongPick) => Promise<void>; onClose: () => void; canPlayNow?: boolean; onPlayNow?: (song: SongPick) => Promise<void> }) {
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<{ items: CatalogTrack[]; total: number; nextCursor: string | null; q: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');
  const [mineShown, setMineShown] = useState(MINE_PAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const [sharing, setSharing] = useState<{ label: string; fraction: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void withProvider(async (p) => {
      await p.ready();
      setTracks(await p.listTracks());
    }).catch(() => setTracks([]));
    void myPublishedIds().then(setPublished).catch(() => undefined);
    inputRef.current?.focus();
  }, []);
  // The catalog: searched as you type (every word, any order), a page at a time.
  useEffect(() => {
    setMineShown(MINE_PAGE);
    setSearching(true);
    const t = setTimeout(
      () =>
        void searchCatalog(q.trim(), { limit: PAGE })
          .then((r) => setCatalog({ items: r.items, total: r.total, nextCursor: r.nextCursor, q }))
          .catch(() => setCatalog({ items: [], total: 0, nextCursor: null, q }))
          .finally(() => setSearching(false)),
      250,
    );
    return () => clearTimeout(t);
  }, [q]);
  const more = async () => {
    if (!catalog?.nextCursor) return;
    setSearching(true);
    try {
      const r = await searchCatalog(catalog.q.trim(), { limit: PAGE, cursor: catalog.nextCursor });
      setCatalog((c) => (c ? { ...c, items: [...c.items, ...r.items.filter((x) => !c.items.some((y) => y.trackId === x.trackId))], nextCursor: r.nextCursor, total: r.total } : c));
    } catch (e) {
      toast(errorText(e), 'warn');
    } finally {
      setSearching(false);
    }
  };

  const items = catalog?.items ?? [];
  const sharedId = (t: TrackSummary) => (published.has(t.trackId) ? t.trackId : (items.find((c) => isSameTrack(t.trackId, c.trackId))?.trackId ?? null));
  const needle = q.trim();
  const mineAll = (tracks ?? []).filter((t) => !needle || matchesWords(`${t.title} ${t.artist}`, needle));
  const mine = mineAll.slice(0, mineShown);
  const me = myCatalogUserId();
  const others = items.filter((c) => c.ownerUserId !== me && !(tracks ?? []).some((t) => isSameTrack(t.trackId, c.trackId)));

  const deliver = async (song: SongPick, now: boolean) => {
    await (now && props.onPlayNow ? props.onPlayNow(song) : props.onPick(song));
    props.onClose();
  };
  /** My track: share it on the way if other devices cannot reach it yet (quietly; a failure still seats the song for my own devices). */
  const pickMine = async (t: TrackSummary, now: boolean) => {
    setBusy(t.trackId);
    try {
      let catalogTrackId = sharedId(t);
      if (!catalogTrackId && canPublish()) {
        setSharing({ label: 'Sharing the song with the meet', fraction: 0.1 });
        try {
          await publishTrack(t.trackId, setSharing);
          catalogTrackId = t.trackId;
          setPublished((s) => new Set([...s, t.trackId]));
        } catch (e) {
          toast(`Could not share "${t.title}" with the other devices (${errorText(e)}) — only your own devices can play it`, 'warn', 8000);
        } finally {
          setSharing(null);
        }
      }
      await deliver({ trackId: t.trackId, catalogTrackId, trackTitle: t.title, durationMs: t.durationMs }, now);
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    } finally {
      setBusy(null);
    }
  };
  const pickShared = async (c: CatalogTrack, now: boolean) => {
    setBusy(c.trackId);
    try {
      await deliver({ trackId: null, catalogTrackId: c.trackId, trackTitle: c.title, durationMs: c.durationMs }, now);
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    } finally {
      setBusy(null);
    }
  };
  /** Enter picks the top match (mine first). */
  const pickTop = () => {
    if (busy) return;
    if (mine[0]) void pickMine(mine[0], false);
    else if (others[0]) void pickShared(others[0], false);
  };

  type Row = { key: string; title: string; sub: string; from: string; pick: (now: boolean) => Promise<void> };
  // One list: my songs first, then the shared ones (never the same song twice), each saying where it comes from.
  const rows: Row[] = [
    ...mine.map((t) => ({ key: t.trackId, title: t.title, sub: `${t.artist || 'Unknown artist'} · ${formatMs(t.durationMs)} · ${t.singerCount} singer${t.singerCount > 1 ? 's' : ''}`, from: 'Your library', pick: (now: boolean) => pickMine(t, now) })),
    ...others.map((c) => ({ key: c.trackId, title: c.title, sub: `${c.artist || 'Unknown artist'} · ${formatMs(c.durationMs)}`, from: `Shared by ${c.ownerName}`, pick: (now: boolean) => pickShared(c, now) })),
  ];
  const total = catalog?.total ?? 0;
  const loading = tracks === null || (catalog === null && searching);
  const counts = [tracks ? `${mineAll.length} of your ${tracks.length}` : null, catalog ? `${others.length}${total > items.length ? ` of ${total.toLocaleString()}` : ''} shared` : null].filter(Boolean).join(' · ');
  return (
    <div class="card stack songpicker" role="dialog" aria-label="Pick a song">
      <div class="row between">
        <h3>
          <IcMusic size={18} /> Pick a song
        </h3>
        <button class="btn icon sm" aria-label="Close the song picker" onClick={props.onClose}>
          <IcX size={16} />
        </button>
      </div>
      <input
        ref={inputRef}
        class="input"
        type="search"
        value={q}
        placeholder={`Search ${tracks?.length ? `your ${tracks.length} song${tracks.length === 1 ? '' : 's'} and ` : ''}${total ? `${total.toLocaleString()} shared songs` : 'the shared songs'} — title, artist, language…`}
        aria-label="Search songs"
        autocomplete="off"
        onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), pickTop())}
      />
      <div class="row between">
        <div class="small faint">Any words, in any order — Enter picks the top match.</div>
        <div class="small muted" data-picker-counts>
          {counts} {searching && <Spinner />}
        </div>
      </div>
      {sharing && <Progress fraction={sharing.fraction} label={sharing.label} />}
      {loading ? (
        <div class="row">
          <Spinner /> Loading songs…
        </div>
      ) : !rows.length ? (
        <div class="small muted" data-picker-empty>
          {needle ? `No song matches “${needle}” — in your library or among the shared songs.` : tracks?.length ? 'Nothing shared by other singers yet — your own songs are listed above.' : 'No songs yet: make one in the Studio (Track Maker), or wait for another singer to share one.'}
        </div>
      ) : (
        <div class="list">
          {rows.map((r) => (
            <div class="item" key={r.key} data-from={r.from === 'Your library' ? 'mine' : 'shared'}>
              <div class="meta">
                <div class="t">{r.title}</div>
                <div class="s">
                  {r.sub} · <span class="chip">{r.from}</span>
                </div>
              </div>
              <button class="btn sm primary" disabled={busy !== null} aria-label={`Pick ${r.title}`} onClick={() => void r.pick(false)}>
                {busy === r.key ? <Spinner /> : <IcMusic size={16} />} Pick
              </button>
              {props.canPlayNow && (
                <button class="btn sm" disabled={busy !== null} aria-label={`Sing ${r.title} now`} onClick={() => void r.pick(true)}>
                  Now
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {mineAll.length > mine.length && (
        <button class="btn sm" onClick={() => setMineShown((n) => n + MINE_PAGE)}>
          Show more of your songs ({mineAll.length - mine.length} more)
        </button>
      )}
      {catalog?.nextCursor && (
        <button class="btn sm" disabled={searching} onClick={() => void more()}>
          More shared songs
        </button>
      )}
      <div class="small faint">The song you pick loads on every device in the meet, so all the singers on stage sing the same lines at the same time — and lands in every singer's own Drive library.</div>
    </div>
  );
}
