import { createTrack, formatMs, importTrackV1, parseLrc, toLrc, type TrackMakerV1, type TrackPackageV2 } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { IcDrive, IcPlus, IcShare, IcTrash, IcUpload, IcDownload, IcSliders } from '../components/icons.tsx';
import { Page } from '../components/Shell.tsx';
import { Empty, Field, Progress, Sheet, Spinner } from '../components/ui.tsx';
import { probeDuration } from '../lib/decode.ts';
import { downloadBlob, shareOrCopy } from '../lib/download.ts';
import { GOOGLE_API_KEY, pickFromDrive } from '../lib/google.ts';
import { go, href } from '../lib/nav.ts';
import type { TrackSummary } from '../lib/storage/types.ts';
import { errorText, toast } from '../lib/toast.ts';
import { driveProvider, isDrive, token, withProvider } from '../state/session.ts';

export function Library() {
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<TrackSummary | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<{ label: string; fraction: number } | null>(null);

  const reload = () =>
    withProvider(async (p) => {
      await p.ready();
      setTracks(await p.listTracks());
    }).catch((e) => {
      setTracks([]);
      toast(errorText(e), 'error');
    });
  useEffect(() => void reload(), []);

  const filtered = (tracks ?? []).filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q.toLowerCase()));

  const share = async (t: TrackSummary, mode: 'anyone' | 'user') => {
    try {
      let link: string;
      if (mode === 'user') {
        const email = prompt('Share with Google account (email):')?.trim();
        if (!email) return;
        link = await withProvider((p) => p.shareTrack(t.trackId, { type: 'user', email }));
        toast(`Shared with ${email}`, 'ok');
      } else {
        link = await withProvider((p) => p.shareTrack(t.trackId, { type: 'anyone' }));
        const r = await shareOrCopy(`SingersVoice track: ${t.title}`, `Sing "${t.title}" with me on SingersVoice`, link);
        toast(r === 'copied' ? 'Link copied — anyone with it can open the track folder' : r === 'shared' ? 'Shared' : link, r === 'failed' ? 'warn' : 'ok', 6000);
      }
      void reload();
      setSel(null);
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    }
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
      await withProvider((p) => p.deleteTrack(t.trackId));
      setSel(null);
      void reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const importFromDrive = async () => {
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
      title="Library"
      right={
        <button class="btn icon sm" aria-label="Import" onClick={() => setImportOpen(true)}>
          <IcUpload />
        </button>
      }
    >
      <div class="stack">
        <div class="row">
          <input class="input" style="flex:1" placeholder="Search tracks" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
          <a class="btn primary" href={href('/trackmaker')}>
            <IcPlus /> New
          </a>
        </div>
        {busy && <Progress fraction={busy.fraction} label={busy.label} />}
        {tracks === null && (
          <div class="row">
            <Spinner /> <span class="muted">Loading your tracks…</span>
          </div>
        )}
        {tracks && !filtered.length && (
          <Empty title={q ? 'No matches' : 'No tracks yet'} body={q ? 'Try another search.' : 'Build one in Track Maker or import a track.json / LRC with its audio file.'}>
            <div class="row">
              <a class="btn primary" href={href('/trackmaker')}>
                Open Track Maker
              </a>
              <button class="btn" onClick={() => setImportOpen(true)}>
                Import
              </button>
            </div>
          </Empty>
        )}
        <div class="list">
          {filtered.map((t) => (
            <div class="item" key={t.trackId}>
              <a class="thumb" href={href(`/sing/${encodeURIComponent(t.trackId)}`)} style="text-decoration:none;color:inherit">
                {t.title.charAt(0).toUpperCase()}
              </a>
              <div class="meta">
                <div class="t">
                  {t.title} {t.shared && <span class="chip ok">shared</span>}
                </div>
                <div class="s">
                  {t.artist || 'Unknown artist'} · {formatMs(t.durationMs)} · {t.singerCount} singer{t.singerCount > 1 ? 's' : ''}
                </div>
              </div>
              <div class="row" style="gap:6px">
                <a class="btn sm primary" href={href(`/sing/${encodeURIComponent(t.trackId)}`)}>
                  Sing
                </a>
                <button class="btn icon sm" aria-label="More" onClick={() => setSel(t)}>
                  <IcSliders size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Sheet open={sel !== null} onClose={() => setSel(null)} title={sel?.title}>
        {sel && (
          <div class="stack">
            <div class="muted small">
              {sel.artist || 'Unknown artist'} · {formatMs(sel.durationMs)} · updated {new Date(sel.updatedAt).toLocaleDateString()}
            </div>
            <a class="btn primary block" href={href(`/sing/${encodeURIComponent(sel.trackId)}`)}>
              Sing this track
            </a>
            <button class="btn block" onClick={() => go(`/trackmaker/${encodeURIComponent(sel.trackId)}`)}>
              <IcSliders /> Edit lyrics & timing
            </button>
            {isDrive.value ? (
              <>
                <button class="btn block" onClick={() => void share(sel, 'anyone')}>
                  <IcShare /> Share link (anyone with the link)
                </button>
                <button class="btn block" onClick={() => void share(sel, 'user')}>
                  <IcDrive /> Share with a Google account
                </button>
                {sel.link && (
                  <a class="btn block ghost" href={sel.link} target="_blank" rel="noopener">
                    Open folder in Drive
                  </a>
                )}
              </>
            ) : (
              <div class="callout">Sharing works through Google Drive. Link your account in Settings, or export the files and send them.</div>
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
        onPicker={isDrive.value && GOOGLE_API_KEY ? importFromDrive : null}
      />
    </Page>
  );
}

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
        <p class="muted small">Bring in an SVOld <span class="kbd">.trackmaker.json</span>, a v2 <span class="kbd">track.json</span> or an <span class="kbd">.lrc</span> file together with its audio. Audio alone makes a track you can time in Track Maker.</p>
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
            <IcDrive /> Import a track shared with me (Drive)
          </button>
        )}
      </div>
    </Sheet>
  );
}
