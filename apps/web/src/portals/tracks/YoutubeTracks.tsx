/**
 * YouTube song tracks — the third section of the Tracks portal. Type a few words (or paste a YouTube
 * link), pick the karaoke video you want, and one tap brings it into your Drive as a song track
 * (`SingersVoice/Tracks/YT/<title>`: the video, shared anyone-with-the-link, and its sound), ready to
 * sing here and in a meet like any Track Maker song — the video stands where the lyrics would be.
 */
import { youtubeSearchQuery, formatMs, type YtSearchItem, type YtStatus } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BookmarkButton } from '../../components/BookmarkButton.tsx';
import { IcDownload, IcPlay } from '../../components/icons.tsx';
import { Empty, Progress, Spinner } from '../../components/ui.tsx';
import { controlConfigured } from '../../lib/api.ts';
import { bookmarkOfYoutube } from '../../lib/bookmarks.ts';
import { href } from '../../lib/nav.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { importYoutubeTrack, searchYoutube, ytStatus } from '../../lib/ytTracks.ts';
import { isDrive } from '../../state/session.ts';

const views = (n: number | null): string => (n === null ? '' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M views` : n >= 1000 ? `${Math.round(n / 1000)}K views` : `${n} views`);

export function YoutubeTracks(props: { tracks: TrackSummary[]; onAdded: () => void }) {
  const [status, setStatus] = useState<YtStatus | null>(null);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<YtSearchItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [job, setJob] = useState<{ id: string; label: string; fraction: number } | null>(null);
  const [done, setDone] = useState<Record<string, TrackSummary>>({});
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void ytStatus().then(setStatus);
  }, []);

  const search = async () => {
    const query = q.trim();
    if (!query) return input.current?.focus();
    setSearching(true);
    try {
      setItems(await searchYoutube(query));
    } catch (e) {
      setItems([]);
      toast(errorText(e), 'error', 8000);
    } finally {
      setSearching(false);
    }
  };

  const add = async (it: YtSearchItem) => {
    if (!isDrive.value) return toast('YouTube song tracks go into your Google Drive — sign in with Google first', 'warn');
    setJob({ id: it.id, label: 'Starting', fraction: 0 });
    try {
      const saved = await importYoutubeTrack(it, (p) => setJob({ id: it.id, ...p }));
      setDone((d) => ({ ...d, [it.id]: saved }));
      toast(`"${saved.title}" is in your Drive (Tracks/YT) — ready to sing`, 'ok', 7000);
      props.onAdded();
    } catch (e) {
      toast(errorText(e), 'error', 10000);
    } finally {
      setJob(null);
    }
  };

  const mine = props.tracks.filter((t) => t.video);

  if (!controlConfigured.value)
    return (
      <div class="callout warn">
        YouTube song tracks come through the SingersVoice service — this build has no <span class="kbd">VITE_CONTROL_URL</span>.
      </div>
    );

  return (
    <div class="stack" data-yt-section>
      <p class="muted small">Find a karaoke video on YouTube and bring it into your Drive as a song track. The video goes to <span class="kbd">SingersVoice/Tracks/YT</span> with a link anyone can play; its sound becomes the backing track, and the video stands in for the lyrics on stage — here and in a meet, for every singer.</p>
      {status && !status.available && (
        <div class="callout warn" data-yt-unavailable>
          <b>Not available yet.</b> {status.note || 'The relay that fetches YouTube videos is not deployed.'} Deploying it is one GitHub secret away (docs/RELAY.md).
        </div>
      )}
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input ref={input} class="input" style="flex:1" placeholder="Song or artist — or paste a YouTube link" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} data-yt-query />
        <button class="btn primary" type="submit" disabled={searching || status?.available === false} data-yt-search>
          {searching ? <Spinner /> : null} Search
        </button>
      </form>
      {q.trim() && youtubeSearchQuery(q) !== q.trim() && (
        <div class="small muted" data-yt-asked>
          YouTube is asked for “{youtubeSearchQuery(q)}” — a karaoke track, always.
        </div>
      )}
      {items && !items.length && <Empty title="Nothing found" body="Try the song's name another way, or paste the video's link." />}
      {items && items.length > 0 && (
        <div class="list" data-yt-results>
          {items.map((it) => {
            const saved = done[it.id];
            const busy = job?.id === it.id;
            return (
              <div class="item" key={it.id} data-yt-result={it.id}>
                <img class="thumb" src={it.thumbnail} alt="" width={64} height={36} loading="lazy" style="object-fit:cover;aspect-ratio:16/9;width:72px;height:auto" />
                <div class="meta">
                  <div class="t">{it.title}</div>
                  <div class="s">
                    {it.channel || 'YouTube'}
                    {it.durationMs ? ` · ${formatMs(it.durationMs)}` : ''}
                    {it.views !== null ? ` · ${views(it.views)}` : ''}
                  </div>
                  {busy && job && <Progress fraction={job.fraction} label={job.label} />}
                </div>
                <div class="row" style="gap:6px">
                  <BookmarkButton input={bookmarkOfYoutube(it)} />
                  {saved ? (
                    <a class="btn sm primary" href={href(`/studio/sing/${encodeURIComponent(saved.trackId)}`)}>
                      <IcPlay size={16} /> Sing
                    </a>
                  ) : (
                    <button class="btn sm accent" disabled={job !== null || status?.available === false} onClick={() => void add(it)} data-yt-add>
                      {busy ? <Spinner /> : <IcDownload size={16} />} {busy ? 'Fetching…' : 'Add to my Drive'}
                    </button>
                  )}
                  <a class="btn icon sm ghost" aria-label="Open on YouTube" href={it.url} target="_blank" rel="noopener">
                    ↗
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div class="row between small muted" style="margin-top:8px">
        <b>Your YouTube song tracks</b>
        <span>{mine.length ? `${mine.length} in Tracks/YT` : 'none yet'}</span>
      </div>
      {mine.length > 0 && (
        <div class="list" data-yt-mine>
          {mine.map((t) => (
            <div class="item" key={t.trackId}>
              <a class="thumb" href={href(`/studio/sing/${encodeURIComponent(t.trackId)}`)} style="text-decoration:none;color:inherit">
                ▶
              </a>
              <div class="meta">
                <div class="t">
                  {t.title} <span class="chip">video</span>
                </div>
                <div class="s">
                  {t.artist || 'YouTube'} · {formatMs(t.durationMs)}
                </div>
              </div>
              <a class="btn sm primary" href={href(`/studio/sing/${encodeURIComponent(t.trackId)}`)}>
                Sing
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
