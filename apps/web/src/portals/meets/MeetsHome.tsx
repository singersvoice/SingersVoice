/**
 * Live Meets portal home — create a meet (shareable link + 6-letter code), join one, see yours.
 * Rules: anyone signed in can create; anyone with the link/code can join; a meet self-expires after
 * 5 minutes without activity; up to 10 on stage, unlimited audience with chat.
 */
import { MAX_OPEN_MEETS, MAX_PERFORMERS, meetIsOpen, type CatalogTrack, type Meet } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { BackgroundPicker } from '../../components/BackgroundPicker.tsx';
import { IcChat, IcPlus, IcStop, IcTrash, IcUsers } from '../../components/icons.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Field, Progress, Sheet, Spinner } from '../../components/ui.tsx';
import { api, ApiError, checkControl, controlConfigured, controlStatus, refreshAccount } from '../../lib/api.ts';
import { canPublish, isSameTrack, myCatalogUserId, myPublishedIds, publishTrack, searchCatalog } from '../../lib/catalog.ts';
import { go, href } from '../../lib/nav.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { accountUserId, profile, withProvider } from '../../state/session.ts';
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
    void refreshAccount();
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
      // Every device in the meet loads the song: a track of mine that others cannot reach yet is shared on the way.
      let catalogTrackId = fromCatalog?.trackId ?? (t && (published.has(t.trackId) ? t.trackId : catalog.find((c) => isSameTrack(t.trackId, c.trackId))?.trackId)) ?? null;
      if (t && !catalogTrackId && canPublish()) {
        setPublishing({ label: 'Sharing the song with the meet', fraction: 0.1 });
        try {
          await publishTrack(t.trackId, setPublishing);
          catalogTrackId = t.trackId;
          setPublished((s) => new Set([...s, t.trackId]));
        } catch (e) {
          toast(`Could not share "${t.title}" with the other devices (${errorText(e)}) — only your own devices can play it`, 'warn', 8000);
        } finally {
          setPublishing(null);
        }
      }
      const r = await api.post('POST /meets', '/meets', {
        title: title.trim() || `${profile.value?.name?.split(' ')[0] ?? 'My'} meet`,
        trackId: fromCatalog?.trackId ?? t?.trackId ?? null,
        trackTitle: fromCatalog?.title ?? t?.title ?? '',
        catalogTrackId,
        backgroundId: app.backgroundId,
      });
      go(`/meet/${encodeURIComponent(r.meet.meetId)}`);
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'too_many_meets' ? `${e.message}. End one in "My meets" below.` : errorText(e), 'error', 8000);
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

  const myUserId = (m: Meet) => m.hostUserId === accountUserId.value || m.hostUserId === myCatalogUserId();
  const openMine = (meets ?? []).filter((m) => myUserId(m) && meetIsOpen(m));
  const atLimit = openMine.length >= MAX_OPEN_MEETS;
  const [working, setWorking] = useState<string | null>(null);
  const endMeet = async (m: Meet) => {
    if (!confirm(`End "${m.title}" for everyone?`)) return;
    setWorking(m.meetId);
    try {
      const r = await api.post('POST /meets/:id/end', `/meets/${encodeURIComponent(m.meetId)}/end`);
      setMeets((l) => (l ?? []).map((x) => (x.meetId === m.meetId ? r.meet : x)));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setWorking(null);
    }
  };
  const deleteMeet = async (m: Meet) => {
    if (!confirm(`Delete "${m.title}"? ${meetIsOpen(m) ? 'It is still open — it ends for everyone and ' : ''}Its room, chat and take list are gone for good (takes stay in each singer's Drive).`)) return;
    setWorking(m.meetId);
    try {
      await api.del('DELETE /meets/:id', `/meets/${encodeURIComponent(m.meetId)}`);
      setMeets((l) => (l ?? []).filter((x) => x.meetId !== m.meetId));
      toast('Meet deleted', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setWorking(null);
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
          <Field label="First song (optional — the set list in the room takes the rest; it loads on every device in the meet)">
            <select class="input" value={trackId} onChange={(e) => setTrackId((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">Pick in the room</option>
              {tracks.length > 0 && (
                <optgroup label="My songs">
                  {tracks.map((t) => (
                    <option key={t.trackId} value={t.trackId}>
                      {t.title}
                    </option>
                  ))}
                </optgroup>
              )}
              {catalog.length > 0 && (
                <optgroup label="Songs from other singers">
                  {catalog.map((c) => (
                    <option key={c.trackId} value={`catalog:${c.trackId}`}>
                      {c.title} · {c.artist || 'Unknown artist'} · {c.ownerName}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          {publishing && <Progress fraction={publishing.fraction} label={publishing.label} />}
          <div class="row">
            <button class="btn" onClick={() => setBgOpen(true)}>
              Stage background
            </button>
            <button class="btn primary" disabled={!configured || busy || atLimit} title={atLimit ? `You already host ${MAX_OPEN_MEETS} open meets — end one below` : undefined} onClick={() => void create()}>
              {busy ? <Spinner /> : <IcUsers />} Create meet
            </button>
            <span class={`chip ${atLimit ? 'warn' : ''}`} data-open-meets={openMine.length}>
              open meets {openMine.length}/{MAX_OPEN_MEETS}
            </span>
          </div>
          {atLimit && <div class="callout warn">You host {openMine.length} open meets — the limit. End one in the list below to create a new one.</div>}
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
          <p class="muted small">Open a meet here, or in a new tab to run several side by side (each tab is its own place on its own stage). Ended meets stay for their take list until you delete them.</p>
          <div class="list">
            {meets?.map((m) => {
              const mine = myUserId(m);
              const open = meetIsOpen(m);
              const link = href(`/meet/${encodeURIComponent(m.meetId)}`);
              return (
                <div class={`item meet-item ${open ? 'open' : ''}`} key={m.meetId} data-state={m.state}>
                  <div class="thumb">
                    <IcUsers size={20} />
                  </div>
                  <div class="meta">
                    <div class="t">
                      {m.title} <span class={`chip ${open ? 'ok' : ''}`}>{m.state}</span>
                    </div>
                    <div class="s">
                      {m.trackTitle || 'no song yet'} · host {m.hostName} · {new Date(m.createdAt).toLocaleString()} · code {m.joinCode}
                    </div>
                  </div>
                  <div class="row monitor-chips">
                    <a class="btn sm primary" href={link}>
                      Open
                    </a>
                    <a class="btn sm" href={link} target="_blank" rel="noopener" title="Open this meet in a new tab">
                      New tab
                    </a>
                    {mine && open && (
                      <button class="btn sm" disabled={working === m.meetId} aria-label={`End ${m.title}`} title="End this meet for everyone" onClick={() => void endMeet(m)}>
                        <IcStop size={14} /> End
                      </button>
                    )}
                    {mine && (
                      <button class="btn icon sm" disabled={working === m.meetId} aria-label={`Delete ${m.title}`} title="Delete this meet for good" onClick={() => void deleteMeet(m)}>
                        <IcTrash size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
      <Sheet open={bgOpen} onClose={() => setBgOpen(false)} title="Stage background">
        <BackgroundPicker value={app.backgroundId} onChange={(id) => updateApp({ backgroundId: id })} />
      </Sheet>
    </Page>
  );
}
