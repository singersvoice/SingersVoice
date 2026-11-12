/**
 * Pick a song for the meet's set list: one of my saved tracks (Drive library) or any public track from
 * the catalog. A private library track can only be loaded by my own devices, so the picker offers to
 * publish it first (the Tracks portal's own `publishTrack`, through lib/catalog.ts) — the meet itself
 * only ever stores ids; every device resolves them through `loadMeetTrack` (library, then catalog).
 */
import { formatMs, type CatalogTrack, type SongPick } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { IcMusic, IcPlus, IcX } from '../../components/icons.tsx';
import { Progress, Spinner } from '../../components/ui.tsx';
import { canPublish, isSameTrack, myCatalogUserId, myPublishedIds, publishTrack, searchCatalog } from '../../lib/catalog.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { isDrive, withProvider } from '../../state/session.ts';

export function SongPicker(props: { onPick: (song: SongPick) => Promise<void>; onClose: () => void; canPlayNow?: boolean; onPlayNow?: (song: SongPick) => Promise<void> }) {
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<CatalogTrack[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<{ label: string; fraction: number } | null>(null);
  const [confirmPrivate, setConfirmPrivate] = useState<TrackSummary | null>(null);

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

  const isPublic = (t: TrackSummary) => published.has(t.trackId) || catalog.some((c) => isSameTrack(t.trackId, c.trackId));
  const catalogIdFor = (t: TrackSummary) => (published.has(t.trackId) ? t.trackId : (catalog.find((c) => isSameTrack(t.trackId, c.trackId))?.trackId ?? null));
  const needle = q.trim().toLowerCase();
  const mine = (tracks ?? []).filter((t) => !needle || `${t.title} ${t.artist}`.toLowerCase().includes(needle));
  const me = myCatalogUserId();
  const publicOnly = catalog.filter((c) => c.ownerUserId !== me && !(tracks ?? []).some((t) => isSameTrack(t.trackId, c.trackId)));

  const pickMine = async (t: TrackSummary, now: boolean, force = false) => {
    if (!isPublic(t) && !force) {
      setConfirmPrivate(t);
      return;
    }
    setBusy(t.trackId);
    try {
      const song: SongPick = { trackId: t.trackId, catalogTrackId: catalogIdFor(t), trackTitle: t.title, durationMs: t.durationMs };
      await (now && props.onPlayNow ? props.onPlayNow(song) : props.onPick(song));
      props.onClose();
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    } finally {
      setBusy(null);
      setConfirmPrivate(null);
    }
  };
  const publishThenPick = async (t: TrackSummary, now: boolean) => {
    setPublishing({ label: 'Publishing', fraction: 0.1 });
    try {
      await publishTrack(t.trackId, setPublishing);
      setPublished((s) => new Set([...s, t.trackId]));
      toast(`"${t.title}" is public — every performer can load it`, 'ok', 6000);
      setPublishing(null);
      await pickMine({ ...t }, now, true);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
      setPublishing(null);
    }
  };
  const pickCatalog = async (c: CatalogTrack, now: boolean) => {
    setBusy(c.trackId);
    try {
      const song: SongPick = { trackId: null, catalogTrackId: c.trackId, trackTitle: c.title, durationMs: c.durationMs };
      await (now && props.onPlayNow ? props.onPlayNow(song) : props.onPick(song));
      props.onClose();
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    } finally {
      setBusy(null);
    }
  };

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
      <input class="input" value={q} placeholder="Search my tracks and the public catalog" aria-label="Search songs" onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
      {confirmPrivate && (
        <div class="callout warn stack" style="gap:8px">
          <span>
            <b>{confirmPrivate.title}</b> is private: only your own devices can load it. Publish it to the public catalog so every performer can sing it?
          </span>
          {publishing && <Progress fraction={publishing.fraction} label={publishing.label} />}
          <div class="row">
            {canPublish() ? (
              <button class="btn sm accent" disabled={publishing !== null} onClick={() => void publishThenPick(confirmPrivate, false)}>
                Publish & add
              </button>
            ) : (
              <span class="small">Sign in with Google to publish it (tracks are shared from your Drive).</span>
            )}
            <button class="btn sm" disabled={publishing !== null} onClick={() => void pickMine(confirmPrivate, false, true)}>
              Add anyway (only my devices)
            </button>
            <button class="btn sm ghost" onClick={() => setConfirmPrivate(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div class="small muted">My tracks ({isDrive.value ? 'Drive' : 'this device'})</div>
      {tracks === null ? (
        <Spinner />
      ) : !mine.length ? (
        <div class="small muted">{tracks.length ? 'No match.' : 'No saved tracks yet — make one in the Studio or pull one from the catalog.'}</div>
      ) : (
        <div class="list">
          {mine.map((t) => (
            <div class="item" key={t.trackId}>
              <div class="meta">
                <div class="t">{t.title}</div>
                <div class="s">
                  {t.artist || 'Unknown artist'} · {formatMs(t.durationMs)} · {t.singerCount} singer{t.singerCount > 1 ? 's' : ''} · {isPublic(t) ? 'public' : 'private'}
                </div>
              </div>
              <button class="btn sm primary" disabled={busy !== null} aria-label={`Add ${t.title} to the set list`} onClick={() => void pickMine(t, false)}>
                {busy === t.trackId ? <Spinner /> : <IcPlus size={16} />} Add
              </button>
              {props.canPlayNow && (
                <button class="btn sm" disabled={busy !== null} aria-label={`Play ${t.title} now`} onClick={() => void pickMine(t, true)}>
                  Now
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div class="small muted">Public catalog</div>
      {!publicOnly.length ? (
        <div class="small muted">{needle ? 'No public track matches.' : 'No other public tracks yet.'}</div>
      ) : (
        <div class="list">
          {publicOnly.map((c) => (
            <div class="item" key={c.trackId}>
              <div class="meta">
                <div class="t">{c.title}</div>
                <div class="s">
                  {c.artist || 'Unknown artist'} · {formatMs(c.durationMs)} · by {c.ownerName}
                </div>
              </div>
              <button class="btn sm primary" disabled={busy !== null} aria-label={`Add ${c.title} to the set list`} onClick={() => void pickCatalog(c, false)}>
                {busy === c.trackId ? <Spinner /> : <IcPlus size={16} />} Add
              </button>
              {props.canPlayNow && (
                <button class="btn sm" disabled={busy !== null} aria-label={`Play ${c.title} now`} onClick={() => void pickCatalog(c, true)}>
                  Now
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
