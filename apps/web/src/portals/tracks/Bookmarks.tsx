/**
 * The Bookmarks tab of the Tracks portal: every song this singer kept with the star — a song of the
 * SingersVoice track database, a public catalog entry, a YouTube result, a track of their own Drive
 * (registered when starred) — the latest first, each singable from here (lib/bookmarks.ts) and
 * droppable with the same star. BookmarkRow is the Recommended tab's and the song picker's row too,
 * where a bookmark says whose it is.
 */
import { formatMs, type Bookmark, type BookmarkInput, type StageBookmark } from '@singersvoice/protocol';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BookmarkButton } from '../../components/BookmarkButton.tsx';
import { IcPlay } from '../../components/icons.tsx';
import { Empty, Progress, Spinner } from '../../components/ui.tsx';
import { controlConfigured } from '../../lib/api.ts';
import { bookmarks, bookmarksLoaded, list, loadBookmarks, singBookmark } from '../../lib/bookmarks.ts';
import { go } from '../../lib/nav.ts';
import { errorText, toast } from '../../lib/toast.ts';
import type { Busy } from './AllTracks.tsx';

export const kindName = (k: Bookmark['kind']): string => (k === 'youtube' ? 'YouTube' : k === 'catalog' ? 'Public catalog' : 'Track database');

/** What the star needs of a bookmark (its own fields, without the key and the date). */
export const inputOf = (b: Bookmark): BookmarkInput => ({ kind: b.kind, ref: b.ref, title: b.title, artist: b.artist, language: b.language, durationMs: b.durationMs, thumbnail: b.thumbnail, registryId: b.registryId, catalogTrackId: b.catalogTrackId, youtube: b.youtube });

/** "alice", "alice & bob", "alice, bob & carol". */
export const byLine = (by: StageBookmark['by']): string => {
  const names = by.map((b) => b.displayName.split(' ')[0] || 'a singer');
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
};

/** Singing bookmarks from a list: the song comes into my library the way its kind does, then the stage. */
export function useSingBookmark(onChanged: () => void) {
  const [busy, setBusy] = useState<Busy | null>(null);
  const sing = async (b: Bookmark) => {
    setBusy({ id: b.key, label: 'Opening', fraction: 0.05 });
    try {
      const id = await singBookmark(b, (p) => setBusy({ id: b.key, ...p }));
      onChanged();
      go(`/studio/sing/${encodeURIComponent(id)}`);
    } catch (e) {
      toast(errorText(e), 'error', 9000);
      setBusy(null);
    }
  };
  return { busy, sing };
}

export function BookmarkRow(props: { b: Bookmark | StageBookmark; busy: Busy | null; onSing: (b: Bookmark) => void; action?: ComponentChildren }) {
  const { b } = props;
  const by = 'by' in b ? b.by : null;
  const busy = props.busy?.id === b.key ? props.busy : null;
  return (
    <div class="item" data-bookmark-row={b.key} data-bookmark-kind={b.kind}>
      {b.thumbnail ? <img class="thumb" src={b.thumbnail} alt="" loading="lazy" style="object-fit:cover;aspect-ratio:16/9;width:72px;height:auto" /> : <div class="thumb">{b.title.trim().charAt(0).toUpperCase() || '♪'}</div>}
      <div class="meta">
        <div class="t">
          {b.title} <span class="chip">{kindName(b.kind)}</span>
        </div>
        <div class="s">
          {[b.artist, b.language, b.durationMs ? formatMs(b.durationMs) : ''].filter(Boolean).join(' · ')}
          {by && by.length > 0 && (
            <>
              {' · '}
              <span data-bookmark-by>bookmarked by {byLine(by)}</span>
            </>
          )}
        </div>
        {busy && <Progress fraction={busy.fraction} label={busy.label} />}
      </div>
      <div class="actions">
        <BookmarkButton input={inputOf(b)} />
        {props.action ?? (
          <button class="btn sm primary" disabled={props.busy !== null} onClick={() => props.onSing(b)} data-bookmark-sing>
            {busy ? <Spinner /> : <IcPlay size={16} />} Sing
          </button>
        )}
      </div>
    </div>
  );
}

export function Bookmarks(props: { onChanged: () => void }) {
  const { busy, sing } = useSingBookmark(props.onChanged);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!controlConfigured.value) return;
    void loadBookmarks(true).catch((e) => setError(errorText(e)));
  }, []);
  void bookmarks.value; // redraw on any change
  const items = list();

  if (!controlConfigured.value)
    return (
      <div class="callout warn">
        Bookmarks are kept on your SingersVoice account — this build has no <span class="kbd">VITE_CONTROL_URL</span>.
      </div>
    );
  return (
    <div class="stack" data-bookmarks-section>
      <div class="row between small muted">
        <span>{bookmarksLoaded.value ? `${items.length} bookmark${items.length === 1 ? '' : 's'}` : 'Loading…'}</span>
        <span>The star on any song keeps it here</span>
      </div>
      {error && <div class="callout warn small">{error}</div>}
      {bookmarksLoaded.value && !items.length && <Empty title="No bookmarks yet" body="Tap the star on any song — in All, Recommended, Public catalog, YouTube or your own Drive — and it is kept here. On a live stage, every singer's bookmarks show under Recommended for all the singers on stage." />}
      <div class="list">
        {items.map((b) => (
          <BookmarkRow key={b.key} b={b} busy={busy} onSing={(x) => void sing(x)} />
        ))}
      </div>
    </div>
  );
}
