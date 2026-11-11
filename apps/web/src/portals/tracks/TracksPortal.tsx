/**
 * Tracks portal — your tracks in Drive, the public catalog (SVT DB) and imports.
 * Publishing a track = Drive folder shared "anyone with the link" + catalog entry; any signed-in
 * singer can pull a published track into their own Drive. Independent of Studio/Meets/Publishing.
 */
import { createTrack, formatMs, importTrackV1, parseLrc, toLrc, type CatalogTrack, type TrackMakerV1, type TrackPackageV2 } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { IcDownload, IcDrive, IcPlus, IcShare, IcSliders, IcTrash, IcUpload } from '../../components/icons.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Field, Progress, Seg, Sheet, Spinner } from '../../components/ui.tsx';
import { api, ApiError, controlConfigured, controlStatus } from '../../lib/api.ts';
import { probeDuration } from '../../lib/decode.ts';
import { downloadBlob, shareOrCopy } from '../../lib/download.ts';
import { GOOGLE_API_KEY, pickFromDrive } from '../../lib/google.ts';
import { go, href } from '../../lib/nav.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { driveProvider, isDrive, profile, token, withProvider } from '../../state/session.ts';

type Tab = 'mine' | 'catalog';

export function TracksPortal() {
  const [tab, setTab] = useState<Tab>('mine');
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<TrackSummary | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<{ label: string; fraction: number } | null>(null);

  const reload = async () => {
    await withProvider(async (p) => {
      await p.ready();
      setTracks(await p.listTracks());
    }).catch((e) => {
      setTracks([]);
      toast(errorText(e), 'error');
    });
    if (controlConfigured.value) {
      api
        .get('GET /catalog/tracks', '/catalog/tracks?mine=1&limit=50')
        .then((r) => setPublished(new Set(r.items.map((t) => t.trackId))))
        .catch(() => undefined);
    }
  };
  useEffect(() => void reload(), []);

  const filtered = (tracks ?? []).filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q.toLowerCase()));

  // ----- actions on my tracks -----

  const publish = async (t: TrackSummary) => {
    const d = driveProvider();
    if (!d) return toast('Publishing to the catalog needs Google Drive', 'warn');
    if (!controlConfigured.value) return toast('The catalog service is not configured for this build yet', 'warn');
    setBusy({ label: 'Sharing the Drive folder (anyone with the link)', fraction: 0.2 });
    try {
      const link = await d.shareTrack(t.trackId, { type: 'anyone' });
      const refs = await d.publicTrackRefs(t.trackId);
      setBusy({ label: 'Registering in the SingersVoice catalog', fraction: 0.7 });
      const loaded = await d.getTrack(t.trackId);
      await api.post('POST /catalog/tracks', '/catalog/tracks', {
        trackId: t.trackId,
        title: t.title,
        artist: t.artist,
        genre: loaded?.track.genre ?? '',
        language: loaded?.track.language ?? '',
        durationMs: t.durationMs,
        singerCount: t.singerCount,
        lineCount: loaded?.track.lyrics.length ?? 0,
        driveFolderId: refs.folderId,
        driveFolderLink: link,
        trackJsonId: refs.trackJsonId,
        audioId: refs.audioId,
        audioMime: refs.audioMime,
      });
      setPublished((s) => new Set([...s, t.trackId]));
      toast(`"${t.title}" is in the public catalog — every SingersVoice singer can pull it`, 'ok', 6000);
      setSel(null);
      void reload();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  const unpublish = async (t: TrackSummary) => {
    const d = driveProvider();
    if (!d) return;
    setBusy({ label: 'Removing from the catalog', fraction: 0.3 });
    try {
      await api.del('DELETE /catalog/tracks/:id', `/catalog/tracks/${encodeURIComponent(t.trackId)}`).catch((e) => {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      });
      await d.unshareTrack(t.trackId);
      setPublished((s) => {
        const n = new Set(s);
        n.delete(t.trackId);
        return n;
      });
      toast('Unpublished — the Drive link no longer works for others', 'ok');
      setSel(null);
      void reload();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const shareWithAccount = async (t: TrackSummary) => {
    const email = prompt('Share with Google account (email):')?.trim();
    if (!email) return;
    try {
      await withProvider((p) => p.shareTrack(t.trackId, { type: 'user', email }));
      toast(`Shared with ${email}`, 'ok');
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    }
  };

  const copyLink = async (t: TrackSummary) => {
    if (!t.link) return;
    const r = await shareOrCopy(`SingersVoice track: ${t.title}`, `Sing "${t.title}" with me on SingersVoice`, t.link);
    toast(r === 'copied' ? 'Drive link copied' : r === 'shared' ? 'Shared' : t.link, r === 'failed' ? 'warn' : 'ok');
  };

  const exportTrack = async (t: TrackSummary) => {
    try {
      const loaded = await withProvider((p) => p.getTrack(t.trackId));
      if (!loaded) throw new Error('Track files not found');
      downloadBlob(new Blob([JSON.stringify(loaded.track, null, 1)], { type: 'application/json' }), `${t.title}.track.json`);
      downloadBlob(new Blob([toLrc(loaded.track)], { type: 'text/plain' }), `${t.title}.lrc`);
      downloadBlob(loaded.audio, `${t.title}.${loaded.audioMime.includes('wav') ? 'wav' : loaded.audioMime.includes('mp4') || loaded.audioMime.includes('m4a') ? 'm4a' : 'mp3'}`);
      toast('Exported track.json, .lrc and audio', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const remove = async (t: TrackSummary) => {
    if (!confirm(`Delete "${t.title}"? ${isDrive.value ? 'It moves to Drive trash.' : 'This cannot be undone.'}`)) return;
    try {
      if (published.has(t.trackId)) await api.del('DELETE /catalog/tracks/:id', `/catalog/tracks/${encodeURIComponent(t.trackId)}`).catch(() => undefined);
      await withProvider((p) => p.deleteTrack(t.trackId));
      setSel(null);
      void reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const importFromPicker = async () => {
    const d = driveProvider();
    const tk = token.value;
    if (!d || !tk) return toast('Link Google Drive first', 'warn');
    try {
      const docs = await pickFromDrive(tk);
      const doc = docs[0];
      if (!doc) return;
      setBusy({ label: 'Copying shared track into your Drive', fraction: 0.2 });
      const loaded = await d.importShared(doc.id);
      const copy = createTrack({ ...loaded.track, trackId: undefined, origin: 'unknown', notes: `${loaded.track.notes}\nImported from a shared Drive folder`.trim() });
      await d.saveTrack(copy, loaded.audio, (p) => setBusy(p));
      toast(`Imported "${copy.title}"`, 'ok');
      void reload();
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page
      title="Tracks"
      right={
        <button class="btn icon sm" aria-label="Import" onClick={() => setImportOpen(true)}>
          <IcUpload />
        </button>
      }
    >
      <div class="stack">
        <div class="row between">
          <Seg<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { v: 'mine', label: isDrive.value ? 'My Drive' : 'This device' },
              { v: 'catalog', label: 'Public catalog' },
            ]}
          />
          <a class="btn primary sm" href={href('/studio/trackmaker')}>
            <IcPlus size={18} /> New track
          </a>
        </div>
        {busy && <Progress fraction={busy.fraction} label={busy.label} />}

        {tab === 'mine' && (
          <>
            <input class="input" placeholder="Search my tracks" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
            {tracks === null && (
              <div class="row">
                <Spinner /> <span class="muted">Loading your tracks…</span>
              </div>
            )}
            {tracks && !filtered.length && (
              <Empty title={q ? 'No matches' : 'No tracks yet'} body={q ? 'Try another search.' : 'Build one in the Studio, import a file, or pull one from the public catalog.'}>
                <div class="row">
                  <a class="btn primary" href={href('/studio/trackmaker')}>
                    Open Track Maker
                  </a>
                  <button class="btn" onClick={() => setTab('catalog')}>
                    Browse catalog
                  </button>
                </div>
              </Empty>
            )}
            <div class="list">
              {filtered.map((t) => (
                <div class="item" key={t.trackId}>
                  <a class="thumb" href={href(`/studio/sing/${encodeURIComponent(t.trackId)}`)} style="text-decoration:none;color:inherit">
                    {t.title.charAt(0).toUpperCase()}
                  </a>
                  <div class="meta">
                    <div class="t">
                      {t.title} {published.has(t.trackId) && <span class="chip ok">public</span>}
                    </div>
                    <div class="s">
                      {t.artist || 'Unknown artist'} · {formatMs(t.durationMs)} · {t.singerCount} singer{t.singerCount > 1 ? 's' : ''}
                    </div>
                  </div>
                  <div class="row" style="gap:6px">
                    <a class="btn sm primary" href={href(`/studio/sing/${encodeURIComponent(t.trackId)}`)}>
                      Sing
                    </a>
                    <button class="btn icon sm" aria-label="More" onClick={() => setSel(t)}>
                      <IcSliders size={18} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'catalog' && <Catalog onPulled={() => void reload()} myIds={new Set((tracks ?? []).map((t) => t.trackId))} />}
      </div>

      <Sheet open={sel !== null} onClose={() => setSel(null)} title={sel?.title}>
        {sel && (
          <div class="stack">
            <div class="muted small">
              {sel.artist || 'Unknown artist'} · {formatMs(sel.durationMs)} · updated {new Date(sel.updatedAt).toLocaleDateString()}
            </div>
            <a class="btn primary block" href={href(`/studio/sing/${encodeURIComponent(sel.trackId)}`)}>
              Sing this track
            </a>
            <button class="btn block" onClick={() => go(`/studio/trackmaker/${encodeURIComponent(sel.trackId)}`)}>
              <IcSliders /> Edit lyrics & timing
            </button>
            {isDrive.value ? (
              <>
                {published.has(sel.trackId) ? (
                  <button class="btn block" disabled={busy !== null} onClick={() => void unpublish(sel)}>
                    <IcShare /> Remove from public catalog
                  </button>
                ) : (
                  <button class="btn block accent" disabled={busy !== null || !controlConfigured.value} onClick={() => void publish(sel)}>
                    <IcShare /> Publish to public catalog
                  </button>
                )}
                {!controlConfigured.value && <div class="small faint">Catalog publishing needs the SingersVoice service (VITE_CONTROL_URL).</div>}
                <button class="btn block" onClick={() => void shareWithAccount(sel)}>
                  <IcDrive /> Share with a Google account
                </button>
                {sel.link && (
                  <div class="row">
                    <button class="btn" onClick={() => void copyLink(sel)}>
                      Copy Drive link
                    </button>
                    <a class="btn ghost" href={sel.link} target="_blank" rel="noopener">
                      Open in Drive
                    </a>
                  </div>
                )}
              </>
            ) : (
              <div class="callout">Sharing and the public catalog work through Google Drive. Sign in with Google to use them.</div>
            )}
            <button class="btn block" onClick={() => void exportTrack(sel)}>
              <IcDownload /> Export (.track.json + .lrc + audio)
            </button>
            <button class="btn block danger" onClick={() => void remove(sel)}>
              <IcTrash /> Delete
            </button>
          </div>
        )}
      </Sheet>

      <ImportSheet
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          void reload();
        }}
        onPicker={isDrive.value && GOOGLE_API_KEY ? importFromPicker : null}
      />
    </Page>
  );
}

// ---------------- Public catalog ----------------

function Catalog(props: { onPulled: () => void; myIds: Set<string> }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CatalogTrack[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pulling, setPulling] = useState<{ id: string; label: string; fraction: number } | null>(null);
  const me = profile.value?.sub ? `g-${profile.value.sub}` : '';

  const load = async (append = false) => {
    if (!controlConfigured.value) return setItems([]);
    try {
      const r = await api.get('GET /catalog/tracks', `/catalog/tracks?q=${encodeURIComponent(q)}&limit=24${append && cursor ? `&cursor=${cursor}` : ''}`);
      setItems((prev) => (append && prev ? [...prev, ...r.items] : r.items));
      setTotal(r.total);
      setCursor(r.nextCursor);
    } catch (e) {
      setItems([]);
      if (!(e instanceof ApiError && e.code === 'offline')) toast(errorText(e), 'error');
    }
  };
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [q]);

  const pull = async (t: CatalogTrack) => {
    const d = driveProvider();
    setPulling({ id: t.trackId, label: 'Fetching from the owner’s Drive', fraction: 0.1 });
    try {
      let jsonBlob: Blob;
      let audio: Blob;
      if (d) {
        jsonBlob = await d.downloadPublic(t.trackJsonId, GOOGLE_API_KEY);
        setPulling({ id: t.trackId, label: 'Fetching backing track', fraction: 0.35 });
        audio = await d.downloadPublic(t.audioId, GOOGLE_API_KEY);
      } else {
        const key = GOOGLE_API_KEY ? `&key=${encodeURIComponent(GOOGLE_API_KEY)}` : '';
        const [j, a] = await Promise.all([
          fetch(`https://www.googleapis.com/drive/v3/files/${t.trackJsonId}?alt=media${key}`),
          fetch(`https://www.googleapis.com/drive/v3/files/${t.audioId}?alt=media${key}`),
        ]);
        if (!j.ok || !a.ok) throw new Error('Sign in with Google to pull catalog tracks');
        jsonBlob = await j.blob();
        audio = await a.blob();
      }
      const pkg = JSON.parse(await jsonBlob.text()) as TrackPackageV2;
      const copy = createTrack({ ...pkg, trackId: `${t.trackId}-copy-${me.slice(-4) || 'x'}`, notes: `${pkg.notes}\nFrom the public catalog (by ${t.ownerName})`.trim(), origin: 'unknown' });
      await withProvider((p) => p.saveTrack(copy, new Blob([audio], { type: t.audioMime || audio.type || 'audio/mpeg' }), (pr) => setPulling({ id: t.trackId, ...pr })));
      await api.post('POST /catalog/tracks/:id/pull', `/catalog/tracks/${encodeURIComponent(t.trackId)}/pull`).catch(() => undefined);
      toast(`"${t.title}" added to ${isDrive.value ? 'your Drive' : 'this device'}`, 'ok', 5000);
      props.onPulled();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setPulling(null);
    }
  };

  if (!controlConfigured.value)
    return (
      <div class="callout warn">
        The public catalog (SVT DB) comes online when the SingersVoice service is deployed — this build has no <span class="kbd">VITE_CONTROL_URL</span>. Your own tracks and Drive sharing work meanwhile.
      </div>
    );

  return (
    <div class="stack">
      <input class="input" placeholder="Search the public catalog (title, artist, language, singer)" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
      <div class="row between small muted">
        <span>
          {items ? `${total} public track${total === 1 ? '' : 's'}` : 'Loading…'} {controlStatus.value === 'offline' && <span class="chip warn">service unreachable</span>}
        </span>
        <span>Published tracks are shared from their owner's Drive</span>
      </div>
      {items && !items.length && <Empty title="Nothing published yet" body="Publish one of your tracks (My Drive → track → Publish to public catalog) and it shows up here for everyone." />}
      <div class="list">
        {items?.map((t) => {
          const mine = t.ownerUserId === me;
          const have = props.myIds.has(t.trackId) || [...props.myIds].some((id) => id.startsWith(`${t.trackId}-copy-`));
          return (
            <div class="item" key={t.trackId}>
              <div class="thumb">{t.title.charAt(0).toUpperCase()}</div>
              <div class="meta">
                <div class="t">{t.title}</div>
                <div class="s">
                  {t.artist || 'Unknown artist'} · {formatMs(t.durationMs)} · {t.singerCount} singer{t.singerCount > 1 ? 's' : ''} · by {t.ownerName}
                  {t.pulls ? ` · ${t.pulls} pull${t.pulls === 1 ? '' : 's'}` : ''}
                </div>
                {pulling?.id === t.trackId && <Progress fraction={pulling.fraction} label={pulling.label} />}
              </div>
              <div class="row" style="gap:6px">
                {mine ? (
                  <span class="chip ok">yours</span>
                ) : have ? (
                  <span class="chip ok">in my library</span>
                ) : (
                  <button class="btn sm accent" disabled={pulling !== null} onClick={() => void pull(t)}>
                    <IcDownload size={16} /> Add to my {isDrive.value ? 'Drive' : 'device'}
                  </button>
                )}
                <a class="btn icon sm ghost" aria-label="Open Drive folder" href={t.driveFolderLink} target="_blank" rel="noopener">
                  <IcDrive size={18} />
                </a>
              </div>
            </div>
          );
        })}
      </div>
      {cursor && (
        <button class="btn block" onClick={() => void load(true)}>
          Load more
        </button>
      )}
    </div>
  );
}

// ---------------- Import ----------------

function ImportSheet(props: { open: boolean; onClose: () => void; onImported: () => void; onPicker: (() => Promise<void>) | null }) {
  const [meta, setMeta] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [busy, setBusy] = useState<{ label: string; fraction: number } | null>(null);
  const metaRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);

  const run = async () => {
    if (!audio) return toast('Pick the audio file', 'warn');
    setBusy({ label: 'Reading files', fraction: 0.05 });
    try {
      let track: TrackPackageV2;
      if (meta) {
        const text = await meta.text();
        if (meta.name.toLowerCase().endsWith('.lrc')) {
          const { lines, meta: m } = parseLrc(text);
          track = createTrack({ title: m.ti ?? meta.name.replace(/\.lrc$/i, ''), artist: m.ar ?? '', lyrics: lines, origin: 'import-lrc' });
        } else {
          const j = JSON.parse(text) as { schema?: string };
          if (j.schema === 'singersvoice.trackmaker.v1') track = importTrackV1(j as TrackMakerV1);
          else if (j.schema === 'singersvoice.track.v2') track = createTrack({ ...(j as TrackPackageV2), trackId: undefined });
          else throw new Error('Unknown JSON — expected singersvoice.trackmaker.v1 or singersvoice.track.v2');
        }
      } else {
        track = createTrack({ title: audio.name.replace(/\.[^.]+$/, ''), origin: 'trackmaker' });
      }
      const durationMs = await probeDuration(audio);
      track = createTrack({ ...track, durationMs: durationMs || track.durationMs, layers: [{ id: 'L1', kind: 'backing', file: 'backing', mimeType: audio.type || 'audio/mpeg', gain: 1, enabledByDefault: true }] });
      const saved = await withProvider((p) => p.saveTrack(track, audio, (pr) => setBusy(pr)));
      toast(`Imported "${saved.title}"`, 'ok');
      setMeta(null);
      setAudio(null);
      props.onImported();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Import a track">
      <div class="stack">
        <p class="muted small">Bring in an SVOld <span class="kbd">.trackmaker.json</span>, a v2 <span class="kbd">track.json</span> or an <span class="kbd">.lrc</span> file together with its audio. Audio alone makes a track you can time in the Studio.</p>
        <Field label="Lyrics / timing file (optional)">
          <input ref={metaRef} type="file" accept=".json,.lrc,application/json,text/plain" class="input" onChange={(e) => setMeta((e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
        </Field>
        <Field label="Audio file (mp3, m4a, wav, ogg)">
          <input ref={audioRef} type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm" class="input" onChange={(e) => setAudio((e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
        </Field>
        {busy && <Progress fraction={busy.fraction} label={busy.label} />}
        <button class="btn primary block" disabled={!audio || busy !== null} onClick={() => void run()}>
          {busy ? <Spinner /> : <IcUpload />} Import
        </button>
        {props.onPicker && (
          <button class="btn block" onClick={() => void props.onPicker?.()}>
            <IcDrive /> Import a track shared with me (Drive picker)
          </button>
        )}
      </div>
    </Sheet>
  );
}
