/**
 * Pick a song for the meet: one of my saved tracks (my Drive library) or a track another singer
 * shares. Picking is all a singer does — the song then loads on every device in the meet so all
 * the singers sing the same lines at the same time. A track of mine that other devices cannot
 * reach yet is shared on the way (its Drive folder gets an anyone-with-the-link permission and a
 * public catalog entry, through lib/catalog.ts — the same thing the Tracks portal does); nobody is
 * asked about it here.
 */
import { formatMs, type CatalogTrack, type SongPick } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { IcMusic, IcX } from '../../components/icons.tsx';
import { Progress, Spinner } from '../../components/ui.tsx';
import { canPublish, isSameTrack, myCatalogUserId, myPublishedIds, publishTrack, searchCatalog } from '../../lib/catalog.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { withProvider } from '../../state/session.ts';

export function SongPicker(props: { onPick: (song: SongPick) => Promise<void>; onClose: () => void; canPlayNow?: boolean; onPlayNow?: (song: SongPick) => Promise<void> }) {
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<CatalogTrack[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [sharing, setSharing] = useState<{ label: string; fraction: number } | null>(null);

  useEffect(() => {
    void withProvider(async (p) => {
      await p.ready();
      setTracks(await p.listTracks());
    }).catch(() => setTracks([]));
    void myPublishedIds().then(setPublished).catch(() => undefined);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void searchCatalog(q, { limit: 30 }).then((r) => setCatalog(r.items)).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [q]);

  const sharedId = (t: TrackSummary) => (published.has(t.trackId) ? t.trackId : (catalog.find((c) => isSameTrack(t.trackId, c.trackId))?.trackId ?? null));
  const needle = q.trim().toLowerCase();
  const mine = (tracks ?? []).filter((t) => !needle || `${t.title} ${t.artist}`.toLowerCase().includes(needle));
  const me = myCatalogUserId();
  const others = catalog.filter((c) => c.ownerUserId !== me && !(tracks ?? []).some((t) => isSameTrack(t.trackId, c.trackId)));

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

  const row = (key: string, title: string, sub: string, pick: (now: boolean) => Promise<void>) => (
    <div class="item" key={key}>
      <div class="meta">
        <div class="t">{title}</div>
        <div class="s">{sub}</div>
      </div>
      <button class="btn sm primary" disabled={busy !== null} aria-label={`Pick ${title}`} onClick={() => void pick(false)}>
        {busy === key ? <Spinner /> : <IcMusic size={16} />} Pick
      </button>
      {props.canPlayNow && (
        <button class="btn sm" disabled={busy !== null} aria-label={`Sing ${title} now`} onClick={() => void pick(true)}>
          Now
        </button>
      )}
    </div>
  );

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
      <input class="input" value={q} placeholder="Search songs" aria-label="Search songs" onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
      {sharing && <Progress fraction={sharing.fraction} label={sharing.label} />}
      <div class="small muted">My songs</div>
      {tracks === null ? (
        <Spinner />
      ) : !mine.length ? (
        <div class="small muted">{tracks.length ? 'No match.' : 'No saved songs yet — make one in the Studio.'}</div>
      ) : (
        <div class="list">{mine.map((t) => row(t.trackId, t.title, `${t.artist || 'Unknown artist'} · ${formatMs(t.durationMs)} · ${t.singerCount} singer${t.singerCount > 1 ? 's' : ''}`, (now) => pickMine(t, now)))}</div>
      )}
      <div class="small muted">Songs from other singers</div>
      {!others.length ? <div class="small muted">{needle ? 'No match.' : 'None shared yet.'}</div> : <div class="list">{others.map((c) => row(c.trackId, c.title, `${c.artist || 'Unknown artist'} · ${formatMs(c.durationMs)} · ${c.ownerName}`, (now) => pickShared(c, now)))}</div>}
      <div class="small faint">The song you pick loads on every device in the meet, so all the singers on stage sing the same lines at the same time.</div>
    </div>
  );
}
