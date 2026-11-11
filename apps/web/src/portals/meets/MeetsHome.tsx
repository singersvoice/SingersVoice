/**
 * Live Meets portal home — create a meet (shareable link + 6-letter code), join one, see yours.
 * Rules: anyone signed in can create; anyone with the link/code can join; a meet self-expires after
 * 5 minutes without activity; up to 10 on stage, unlimited audience with chat.
 */
import { MAX_PERFORMERS, meetIsOpen, type Meet } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { BackgroundPicker } from '../../components/BackgroundPicker.tsx';
import { IcChat, IcPlus, IcUsers } from '../../components/icons.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Field, Sheet, Spinner } from '../../components/ui.tsx';
import { api, ApiError, checkControl, controlConfigured, controlStatus } from '../../lib/api.ts';
import { go, href } from '../../lib/nav.ts';
import type { TrackSummary } from '../../lib/storage/types.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { profile, withProvider } from '../../state/session.ts';
import { appSettings, updateApp } from '../../state/settings.ts';

export function MeetsHome() {
  const [meets, setMeets] = useState<Meet[] | null>(null);
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [trackId, setTrackId] = useState('');
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
    api
      .get('GET /catalog/tracks', '/catalog/tracks?mine=1&limit=50')
      .then((r) => setPublished(new Set(r.items.map((t) => t.trackId))))
      .catch(() => undefined);
  }, [configured]);

  const create = async () => {
    setBusy(true);
    try {
      const t = tracks.find((x) => x.trackId === trackId);
      const r = await api.post('POST /meets', '/meets', {
        title: title.trim() || `${profile.value?.name?.split(' ')[0] ?? 'My'} meet`,
        trackId: t?.trackId ?? null,
        trackTitle: t?.title ?? '',
        catalogTrackId: t && published.has(t.trackId) ? t.trackId : null,
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

  const selectedPublished = trackId && published.has(trackId);

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
          <Field label="Track (performers need it on their device — publish it to the catalog so everyone can load it)">
            <select class="input" value={trackId} onChange={(e) => setTrackId((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">Pick later</option>
              {tracks.map((t) => (
                <option key={t.trackId} value={t.trackId}>
                  {t.title} {published.has(t.trackId) ? '· public' : '· private'}
                </option>
              ))}
            </select>
          </Field>
          {trackId && !selectedPublished && (
            <div class="callout warn">
              This track is private: other performers won't be able to load it. Publish it first in <a href={href('/tracks')}>Tracks → Publish to public catalog</a>.
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
