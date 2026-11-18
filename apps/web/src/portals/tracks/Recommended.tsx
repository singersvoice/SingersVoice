/**
 * The Recommended tab of the Tracks portal. Two things, in this order:
 *
 *   1. On a live stage — while this device is in a meet — what the singers on stage bookmarked, all of
 *      them together, each song saying whose it is (five singers on stage: five singers' bookmarks, in
 *      everyone's Recommended), read from the service every few seconds so a star tapped by anyone
 *      on stage shows up for all.
 *   2. For you: the songs of the SingersVoice track database in the languages the singer prefers
 *      (Settings → Songs you prefer; a country stands for its languages), the most sung first — the
 *      same song tree as the All tab. A singer who set nothing is asked right here with a dropdown
 *      (PrefsPick: a language or a country, kept for the session), and offered Settings.
 */
import { hasPrefs, languagesLine, SONG_COUNTRIES, SONG_LANGUAGES, type StageBookmark, type TrackSearchGroup } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Empty, Spinner } from '../../components/ui.tsx';
import { ApiError, controlConfigured } from '../../lib/api.ts';
import { stageBookmarks } from '../../lib/bookmarks.ts';
import { href } from '../../lib/nav.ts';
import { loadPrefs, pickName, preferredLanguages, setSongPick, songPick, songPrefs } from '../../lib/prefs.ts';
import { recommendedTracks } from '../../lib/registry.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { activeMeetId, activeRoomInfo } from '../meets/activeRoom.ts';
import { SongGroup, useRecordActions } from './AllTracks.tsx';
import { BookmarkRow, useSingBookmark } from './Bookmarks.tsx';

const STAGE_POLL_MS = 8000;

/** "Which songs do you prefer?" — a language or a country, for this session; Settings keeps it for good. */
export function PrefsPick() {
  return (
    <div class="row wrap" data-prefs-pick-row>
      <label class="small muted" for="prefs-pick">
        Which songs do you prefer?
      </label>
      <select id="prefs-pick" class="input" style="max-width:260px" value={songPick.value} onChange={(e) => setSongPick((e.currentTarget as HTMLSelectElement).value)} data-prefs-pick>
        <option value="">Every language</option>
        <optgroup label="Languages">
          {SONG_LANGUAGES.map((l) => (
            <option key={l} value={`language:${l}`}>
              {l}
            </option>
          ))}
        </optgroup>
        <optgroup label="Countries">
          {SONG_COUNTRIES.map((c) => (
            <option key={c.name} value={`country:${c.name}`}>
              {c.name}
            </option>
          ))}
        </optgroup>
      </select>
      <a class="small" href={href('/settings')} data-prefs-settings>
        Set it once in Settings
      </a>
    </div>
  );
}

/** What the singers on stage bookmarked, as the service answers it now (null until asked; polled while in a meet). */
export function useStageBookmarks(meetId: string | null, pollMs = STAGE_POLL_MS): StageBookmark[] | null {
  const [items, setItems] = useState<StageBookmark[] | null>(null);
  useEffect(() => {
    setItems(null);
    if (!meetId || !controlConfigured.value) return;
    let alive = true;
    const tick = () =>
      void stageBookmarks(meetId)
        .then((xs) => alive && setItems(xs))
        .catch(() => alive && setItems((cur) => cur ?? []));
    tick();
    const t = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [meetId]);
  return items;
}

export function Recommended(props: { tracks: TrackSummary[]; onChanged: () => void }) {
  const meetId = activeMeetId.value;
  const room = activeRoomInfo.value;
  const stage = useStageBookmarks(meetId);
  const { busy: markBusy, sing: singMark } = useSingBookmark(props.onChanged);
  const langs = preferredLanguages.value;
  const langKey = langs.join(',');
  const [groups, setGroups] = useState<TrackSearchGroup[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const { busy, preview, sing, togglePreview } = useRecordActions({ onChanged: props.onChanged, onFailed: () => void load(), onRecord: (r) => setGroups((gs) => (gs ? gs.map((g) => ({ ...g, versions: g.versions.map((v) => (v.trackId === r.trackId ? r : v)) })) : gs)) });

  useEffect(() => {
    void loadPrefs();
  }, []);
  const load = async (append = false) => {
    if (!controlConfigured.value || !langs.length) return setGroups([]);
    try {
      const r = await recommendedTracks(langs, { cursor: append ? cursor : null, limit: 20 });
      setGroups((prev) => (append && prev ? [...prev, ...r.groups] : r.groups));
      setTotal(r.total);
      setCursor(r.nextCursor);
    } catch (e) {
      setGroups([]);
      if (!(e instanceof ApiError && e.code === 'offline')) toast(errorText(e), 'error');
    }
  };
  useEffect(() => {
    setGroups(null);
    void load();
  }, [langKey]);

  if (!controlConfigured.value)
    return (
      <div class="callout warn">
        Recommendations come from the SingersVoice track database — this build has no <span class="kbd">VITE_CONTROL_URL</span>.
      </div>
    );
  const prefsSet = hasPrefs(songPrefs.value);
  return (
    <div class="stack" data-recommended-section>
      {meetId && (
        <section class="stack" data-rec-stage>
          <b class="small">Bookmarked by the singers on stage{room?.title ? ` · ${room.title}` : ''}</b>
          {stage === null && (
            <div class="row small muted">
              <Spinner /> Asking the stage…
            </div>
          )}
          {stage && !stage.length && <div class="muted small">Nobody on stage has bookmarked a song yet — the star on any song puts it here for everyone on stage.</div>}
          {stage && stage.length > 0 && (
            <div class="list" data-rec-stage-list>
              {stage.map((b) => (
                <BookmarkRow key={b.key} b={b} busy={markBusy} onSing={(x) => void singMark(x)} />
              ))}
            </div>
          )}
        </section>
      )}

      <section class="stack" data-rec-for-you>
        <div class="row between wrap">
          <b class="small" data-rec-title>
            For you{langs.length ? ` · ${prefsSet ? languagesLine(langs) : pickName(songPick.value)}` : ''}
          </b>
          {prefsSet && (
            <a class="small" href={href('/settings')} data-prefs-settings>
              Change in Settings
            </a>
          )}
        </div>
        {!prefsSet && <PrefsPick />}
        {!langs.length ? (
          <Empty title="Which songs do you prefer?" body="Pick a language or a country above — or set it once in Settings — and the songs singers sing in it come here, the most sung first." />
        ) : (
          <>
            <div class="small muted">{groups ? `${total} song${total === 1 ? '' : 's'} in ${languagesLine(langs)} · the most sung first` : 'Loading…'}</div>
            {groups && !groups.length && <Empty title={`Nothing sung in ${languagesLine(langs)} yet`} body="Sing any track in that language — it is registered for everyone here." />}
            <div class="list" data-song-tree>
              {groups?.map((g) => (
                <SongGroup key={g.songKey} g={g} tracks={props.tracks} busy={busy} preview={preview} onSing={sing} onPreview={togglePreview} />
              ))}
            </div>
            {cursor && (
              <button class="btn block" onClick={() => void load(true)} data-rec-more>
                More songs
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
