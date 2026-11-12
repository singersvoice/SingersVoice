/**
 * Live Meets portal home — create a meet (shareable link + 6-letter code), join one, see yours.
 * Rules: anyone signed in can create; anyone with the link/code can join; a meet self-expires after
 * 5 minutes without activity; up to 10 on stage, unlimited audience with chat.
 */
import { MAX_PERFORMERS, meetIsOpen, type CatalogTrack, type Meet } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { BackgroundPicker } from '../../components/BackgroundPicker.tsx';
import { IcChat, IcPlus, IcUsers } from '../../components/icons.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Field, Progress, Sheet, Spinner } from '../../components/ui.tsx';
import { api, ApiError, checkControl, controlConfigured, controlStatus } from '../../lib/api.ts';
import { canPublish, isSameTrack, myCatalogUserId, myPublishedIds, publishTrack, searchCatalog } from '../../lib/catalog.ts';
import { go, href } from '../../lib/nav.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { isDrive, profile, withProvider } from '../../state/session.ts';
import { appSettings, updateApp } from '../../state/settings.ts';

export function MeetsHome() {
  const [meets, setMeets] = useState<Meet[] | null>(null);
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<CatalogTrack[]>([]);
  const [title, setTitle] = useState('');
  // "<id>" = one of my tracks, "catalog:<id>" = a public track straight from the catalog.
  const [trackId, setTrackId] = useState(() => {
    try {
      return new URLSearchParams(location.search).get('track') ?? '';
    } catch {
      return '';
    }
  });
  const [publishing, setPublishing] = useState<{ label: string; fraction: number } | null>(null);
  const [code, setCode] = useState('');
  const [bgOpen, setBgOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const app = appSettings.value;
  const configured = controlConfigured.value;

  useEffect(() => {
    void withProvider(async (p) => {
      await p.ready();
      setTracks(await p.listTracks());
    }).catch(() => undefined);
    if (!configured) return;
    void checkControl();
    api
      .get('GET /meets', '/meets')
      .then((r) => setMeets(r.meets))
      .catch((e) => {
        setMeets([]);
        if (!(e instanceof ApiError && e.code === 'offline')) toast(errorText(e), 'error');
      });
    void myPublishedIds().then(setPublished);
    searchCatalog('', { limit: 50 })
      .then((r) => setCatalog(r.items.filter((t) => t.ownerUserId !== myCatalogUserId())))
      .catch(() => undefined);
  }, [configured]);

  const create = async () => {
    setBusy(true);
    try {
      const fromCatalog = trackId.startsWith('catalog:') ? catalog.find((c) => `catalog:${c.trackId}` === trackId) : undefined;
      const t = tracks.find((x) => x.trackId === trackId);
      const r = await api.post('POST /meets', '/meets', {
        title: title.trim() || `${profile.value?.name?.split(' ')[0] ?? 'My'} meet`,
        trackId: fromCatalog?.trackId ?? t?.trackId ?? null,
        trackTitle: fromCatalog?.title ?? t?.title ?? '',
        // Performers load the track from the catalog: my published track, or the public one picked.
        catalogTrackId: fromCatalog?.trackId ?? (t && (published.has(t.trackId) ? t.trackId : catalog.find((c) => isSameTrack(t.trackId, c.trackId))?.trackId)) ?? null,
        backgroundId: app.backgroundId,
      });
      go(`/meet/${encodeURIComponent(r.meet.meetId)}`);
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    } finally {
      setBusy(false);
    }
  };

  const joinByCode = async () => {
    const c = code.trim().toUpperCase();
    if (c.length < 6) return;
    setBusy(true);
    try {
      const r = await api.get('GET /meets/code/:code', `/meets/code/${encodeURIComponent(c)}`);
      go(`/meet/${encodeURIComponent(r.meet.meetId)}`);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? 'No meet with that code' : errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const selectedMine = tracks.find((t) => t.trackId === trackId);
  const selectedPublished = Boolean(trackId && (trackId.startsWith('catalog:') || published.has(trackId) || catalog.some((c) => isSameTrack(trackId, c.trackId))));

  const publishSelected = async () => {
    if (!selectedMine) return;
    setPublishing({ label: 'Publishing', fraction: 0.1 });
    try {
      await publishTrack(selectedMine.trackId, setPublishing);
      setPublished((s) => new Set([...s, selectedMine.trackId]));
      toast(`"${selectedMine.title}" is public — every performer can load it`, 'ok', 6000);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setPublishing(null);
    }
  };

  return (
    <Page title="Live Meets">
      <div class="stack" style="gap:18px">
        {!configured && (
          <div class="callout warn">
            Live meets need the SingersVoice service (SVT DB). This build has no <span class="kbd">VITE_CONTROL_URL</span> yet — deploy <span class="kbd">services/control</span> (see docs/DEPLOY_CONTROL.md) and redeploy the web app.
          </div>
        )}
        {configured && controlStatus.value === 'offline' && <div class="callout danger">The SingersVoice service is unreachable right now — retrying in the background.</div>}

        <section class="card stack">
          <h2>
            <IcPlus size={18} /> Create a meet
          </h2>
          <p class="muted small">
            You get a link and a 6-letter code to share — like a Zoom/Teams meeting. Up to {MAX_PERFORMERS} singers take stage slots; everyone else watches and chats. The meet closes itself after 5 idle minutes.
          </p>
          <Field label="Title">
            <input class="input" value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} placeholder="Sunday SV music meet" maxLength={80} />
          </Field>
          <Field label="Track (every performer loads it from the public catalog — my published tracks and any public track)">
            <select class="input" value={trackId} onChange={(e) => setTrackId((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">Pick later</option>
              {tracks.length > 0 && (
                <optgroup label={`My tracks (${isDrive.value ? 'Drive' : 'this device'})`}>
                  {tracks.map((t) => (
                    <option key={t.trackId} value={t.trackId}>
                      {t.title} {published.has(t.trackId) || catalog.some((c) => isSameTrack(t.trackId, c.trackId)) ? '· public' : '· private'}
                    </option>
                  ))}
                </optgroup>
              )}
              {catalog.length > 0 && (
                <optgroup label="Public catalog">
                  {catalog.map((c) => (
                    <option key={c.trackId} value={`catalog:${c.trackId}`}>
                      {c.title} · {c.artist || 'Unknown artist'} · by {c.ownerName}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          {trackId && !selectedPublished && (
            <div class="callout warn stack" style="gap:8px">
              <span>This track is private: other performers won't be able to load it.</span>
              {publishing && <Progress fraction={publishing.fraction} label={publishing.label} />}
              {canPublish() ? (
                <button class="btn sm accent" disabled={publishing !== null} onClick={() => void publishSelected()}>
                  Publish it to the public catalog now
                </button>
              ) : (
                <span class="small">Sign in with Google to publish it (tracks are shared from your Drive).</span>
              )}
            </div>
          )}
          <div class="row">
            <button class="btn" onClick={() => setBgOpen(true)}>
              Stage background
            </button>
            <button class="btn primary" disabled={!configured || busy} onClick={() => void create()}>
              {busy ? <Spinner /> : <IcUsers />} Create meet
            </button>
          </div>
        </section>

        <section class="card stack">
          <h2>Join with a code</h2>
          <div class="row">
            <input class="input mono" style="flex:1;text-transform:uppercase;letter-spacing:.2em" value={code} maxLength={6} placeholder="ABC123" onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && void joinByCode()} />
            <button class="btn" disabled={!configured || busy || code.trim().length < 6} onClick={() => void joinByCode()}>
              Join
            </button>
          </div>
          <div class="small faint">Got a link instead? Just open it — it lands in the meet room.</div>
        </section>

        <section class="stack">
          <h2>My meets</h2>
          {configured && meets === null && (
            <div class="row">
              <Spinner /> Loading…
            </div>
          )}
          {meets && !meets.length && <Empty title="No meets yet" body="Create one above and share the link." icon={<IcChat size={28} />} />}
          <div class="list">
            {meets?.map((m) => (
              <a class="item" key={m.meetId} href={href(`/meet/${encodeURIComponent(m.meetId)}`)}>
                <div class="thumb">
                  <IcUsers size={20} />
                </div>
                <div class="meta">
                  <div class="t">{m.title}</div>
                  <div class="s">
                    {m.trackTitle || 'no track'} · host {m.hostName} · {new Date(m.createdAt).toLocaleString()} · code {m.joinCode}
                  </div>
                </div>
                <span class={`chip ${meetIsOpen(m) ? 'ok' : ''}`}>{m.state}</span>
              </a>
            ))}
          </div>
        </section>
      </div>
      <Sheet open={bgOpen} onClose={() => setBgOpen(false)} title="Stage background">
        <BackgroundPicker value={app.backgroundId} onChange={(id) => updateApp({ backgroundId: id })} />
      </Sheet>
    </Page>
  );
}
