/**
 * Publishing mode — its own portal, for privileged accounts only: push a meet to YouTube / Facebook /
 * Instagram / Twitch and the in-house watch portal. Screens: Publish (pick a meet — one you host or
 * joined, or any meet by link / code — pick destinations, Publish → the show view), Preview (admin
 * monitoring: every open meet eligible to publish, each with the exact picture the platforms would
 * play), Destinations (ingest URL + stream key per platform), History (jobs with their event
 * timeline). The show view (/publishing/show/:id) is the broadcast picture: performers huge on one
 * stage, no lyrics.
 * The encoder is the show view's own browser (WebCodecs → MPEG-TS segments → the service → YouTube's
 * HLS ingestion and the in-house portal); Facebook, Instagram and Twitch take RTMP(S) only and wait
 * for a session container, so their jobs queue here.
 */
import { DESTINATIONS, meetIsOpen, type Destination, type DestinationKind, type Meet, type PublishJob } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { IcCheck, IcPlay, IcStop } from '../../components/icons.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Field, Seg, Spinner, Switch } from '../../components/ui.tsx';
import { api, ApiError, controlConfigured, refreshAccount } from '../../lib/api.ts';
import { go, href } from '../../lib/nav.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { canPublish, profile, publishingNote } from '../../state/session.ts';
import { appSettings, updateApp } from '../../state/settings.ts';
import { forgetYoutube } from '../../lib/youtube.ts';
import { connectYoutubeDestination, saveDestination } from './destinations.ts';
import { LiveLinks } from './LiveLinks.tsx';
import { resolveMeet } from './meetLookup.ts';
import { Preview } from './Preview.tsx';

type Tab = 'publish' | 'preview' | 'destinations' | 'history';

const initialTab = (): Tab => {
  const q = new URLSearchParams(location.search);
  const t = q.get('tab');
  if (t === 'publish' || t === 'preview' || t === 'destinations' || t === 'history') return t;
  return 'publish';
};

export function PublishingPortal() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    void refreshAccount().finally(() => setChecked(true));
  }, []);

  if (!controlConfigured.value)
    return (
      <Page title="Publishing">
        <div class="callout warn">Publishing needs the SingersVoice service (VITE_CONTROL_URL).</div>
      </Page>
    );
  if (!canPublish.value)
    return (
      <Page title="Publishing">
        <div class="stack">
          {!checked && (
            <div class="row">
              <Spinner /> Checking your account…
            </div>
          )}
          <Empty title="Publishing mode is for club owners" body={`${publishingNote.value || 'Streaming meets to YouTube and the in-house watch page — the show view, destinations, going live — is for club owners with an active yearly subscription, and for the SingersVoice admins.'} Singing, hosting and joining meets stay open to everyone.`}>
            <a class="btn primary" href={href('/plans')}>
              See the plans
            </a>
            <a class="btn" href={href('/meets')}>
              Back to Live Meets
            </a>
          </Empty>
        </div>
      </Page>
    );

  return (
    <Page title="Publishing">
      <div class="stack">
        <Seg<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { v: 'publish', label: 'Publish a meet' },
            { v: 'preview', label: 'Preview' },
            { v: 'destinations', label: 'Destinations' },
            { v: 'history', label: 'History' },
          ]}
        />
        {tab === 'destinations' && <Destinations />}
        {tab === 'publish' && <Publish onDone={() => setTab('history')} />}
        {tab === 'preview' && <Preview />}
        {tab === 'history' && <History />}
      </div>
    </Page>
  );
}

// ---------------- Destinations ----------------

/** An ingest URL the server hands out as a hint only (Instagram's has a "…" in it) is not a URL yet. */
const usableIngest = (u: string): string => (u && !u.includes('…') ? u : '');
const looksLikeIngest = (u: string): boolean => /^rtmps?:\/\/\S+/i.test(u.trim());

/**
 * YouTube, run by the app: one tap connects the publisher's YouTube channel (the Google screen once more, with the
 * YouTube permission) and makes the channel's HLS stream key for the service to keep — from then on every show
 * gets a YouTube broadcast of its own, with its public link, the moment Go live is tapped. Nothing to paste.
 */
function YoutubeConnect(props: { dest: Destination; onSaved: (d: Destination) => void }) {
  const [busy, setBusy] = useState(false);
  const app = appSettings.value;
  const signedIn = profile.value?.mode === 'drive';
  const connect = async () => {
    setBusy(true);
    try {
      const d = await connectYoutubeDestination(props.dest, profile.value?.email);
      toast(`YouTube is connected — the stream key was made for you (ends with ${d.keyHint}); every show gets its own YouTube link when you go live`, 'ok', 9000);
      props.onSaved(d);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : errorText(e), 'error', 12000);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      forgetYoutube();
      const d = await saveDestination('youtube', { enabled: props.dest.enabled, ingestUrl: props.dest.ingestUrl, auto: false });
      toast('YouTube is no longer run by the app — paste a stream key and your live link by hand, or connect again', 'ok', 7000);
      props.onSaved(d);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (props.dest.auto)
    return (
      <div class="callout ok stack" data-youtube-auto="1" style="gap:8px">
        <div>
          <b>YouTube is connected.</b> The stream key was made by the app (ends with {props.dest.keyHint}); every show gets a YouTube broadcast of its own, with its public link, the moment you tap <b>Go live</b> — and the bar reads YouTube's own word on the stream while it runs. Nothing to paste or look up in YouTube Studio.
        </div>
        <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
          <label class="small row" style="gap:6px">
            Broadcasts are
            <select class="input" value={app.youtubePrivacy} onChange={(e) => updateApp({ youtubePrivacy: (e.currentTarget as HTMLSelectElement).value === 'unlisted' ? 'unlisted' : 'public' })}>
              <option value="unlisted">unlisted (anyone with the link can watch; not on the channel's page)</option>
              <option value="public">public (on the channel for everyone to find)</option>
            </select>
          </label>
          <button class="btn ghost sm" disabled={busy} onClick={() => void disconnect()}>
            Disconnect YouTube
          </button>
        </div>
      </div>
    );
  return (
    <div class="callout stack" data-youtube-connect="1" style="gap:8px">
      <div>
        <b>Let the app run YouTube for you.</b> One tap connects your YouTube channel (the Google screen once more, asking to manage your YouTube account): the app makes the HLS stream key, and from then on every show gets its own YouTube broadcast and link when you go live — nothing to paste. {signedIn ? '' : 'Sign in with Google first (Settings).'}
      </div>
      <div class="row">
        <button class="btn accent" disabled={busy || !signedIn} onClick={() => void connect()} data-youtube-connect-button>
          {busy ? <Spinner /> : <IcCheck />} Connect YouTube
        </button>
        <span class="small muted">or set it up by hand below</span>
      </div>
    </div>
  );
}

/** The live-link field of a platform: the page viewers open to watch you there — a link, or just the channel name. */
function WatchLinkField(props: { kind: DestinationKind; value: string; onInput: (v: string) => void }) {
  const def = DESTINATIONS.find((x) => x.kind === props.kind)!;
  return (
    <Field label={`Your ${def.short} live link`} hint={`The page viewers open to watch you on ${def.short} — paste the link, or just your channel name${props.kind === 'youtube' ? ' (your @handle: the link then always points at your current live stream)' : ''}. It is the "${def.short} link" button while you are on air.`}>
      <input class="input mono" value={props.value} placeholder={def.watchHint} aria-label={`${def.label} live link`} autocomplete="off" spellcheck={false} onInput={(ev) => props.onInput((ev.currentTarget as HTMLInputElement).value)} />
    </Field>
  );
}

/**
 * The stream key setup of one platform, inline: ingest URL (the platform's default filled in) and the
 * key (never shown again once saved — only its last 4 characters). Save enables the platform.
 */
function DestinationSetup(props: { dest: Destination; onSaved: (d: Destination) => void; onCancel?: () => void }) {
  const def = DESTINATIONS.find((x) => x.kind === props.dest.kind)!;
  const [ingestUrl, setIngestUrl] = useState(() => usableIngest(props.dest.ingestUrl) || usableIngest(def.ingestHint));
  const [streamKey, setStreamKey] = useState('');
  const [watchUrl, setWatchUrl] = useState(props.dest.watchUrl ?? '');
  const [busy, setBusy] = useState(false);
  const canSave = looksLikeIngest(ingestUrl) && (streamKey.trim().length > 0 || Boolean(props.dest.keyHint));
  const save = async () => {
    if (!looksLikeIngest(ingestUrl)) return toast('The ingest URL must start with rtmps:// (or rtmp://)', 'warn');
    if (!streamKey.trim() && !props.dest.keyHint) return toast(`Paste the ${def.label} stream key first`, 'warn');
    setBusy(true);
    try {
      const d = await saveDestination(props.dest.kind, { enabled: true, ingestUrl, streamKey, watchUrl });
      toast(`${def.label} is set up — key ends with ${d.keyHint}`, 'ok');
      props.onSaved(d);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : errorText(e), 'error', 7000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack" data-dest-setup={props.dest.kind} style="padding:8px 0 4px 0">
      {props.dest.kind === 'youtube' && <YoutubeConnect dest={props.dest} onSaved={props.onSaved} />}
      {props.dest.kind === 'youtube' && !props.dest.auto && (
        <div class="callout" data-youtube-hls-note>
          <b>Without the RTMP relay, YouTube takes the show over HLS — and that needs a stream key made for HLS.</b> In YouTube Studio → Go live → Stream settings → Stream key, choose <b>Create new stream key</b>, set the <b>streaming protocol to HLS</b>, and paste that key here. A key made for RTMP can be accepted segment by segment and still show nothing in YouTube Studio. Set the latency to <b>Low latency</b> (ultra-low is RTMP only).
        </div>
      )}
      {!(props.dest.kind === 'youtube' && props.dest.auto) && (
        <>
      <Field label="Ingest URL (RTMPS)">
        <input class="input mono" value={ingestUrl} placeholder={def.ingestHint} aria-label={`${def.label} ingest URL`} autocomplete="off" spellcheck={false} onInput={(ev) => setIngestUrl((ev.currentTarget as HTMLInputElement).value)} />
      </Field>
      <Field label={def.keyLabel} hint={props.dest.keyHint ? `Saved key ends with ${props.dest.keyHint} — leave empty to keep it` : 'Stored encrypted on the service; never shown again'}>
        <input
          class="input mono"
          type="password"
          autocomplete="off"
          value={streamKey}
          placeholder={props.dest.keyHint ? 'Leave empty to keep the saved key' : 'Paste the stream key'}
          aria-label={`${def.label} stream key`}
          onInput={(ev) => setStreamKey((ev.currentTarget as HTMLInputElement).value)}
          onKeyDown={(ev) => ev.key === 'Enter' && canSave && void save()}
        />
      </Field>
      <WatchLinkField kind={props.dest.kind} value={watchUrl} onInput={setWatchUrl} />
      <div class="row">
        <button class="btn accent" disabled={busy || !canSave} onClick={() => void save()}>
          {busy ? <Spinner /> : <IcCheck />} {props.dest.enabled ? 'Save' : 'Save & enable'}
        </button>
        {props.onCancel && (
          <button class="btn ghost" disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
        </>
      )}
    </div>
  );
}

function Destinations() {
  const [list, setList] = useState<Destination[] | null>(null);
  const [relay, setRelay] = useState(false);
  const [edit, setEdit] = useState<Record<string, { ingestUrl: string; streamKey: string; watchUrl: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api
      .get('GET /publishing/destinations', '/publishing/destinations')
      .then((r) => {
        setList(r.destinations);
        setRelay(Boolean(r.relay));
      })
      .catch((e) => {
        setList([]);
        toast(errorText(e), 'error');
      });
  useEffect(() => void load(), []);

  const save = async (d: Destination, enabled: boolean) => {
    setBusy(d.kind);
    try {
      const e = edit[d.kind] ?? { ingestUrl: usableIngest(d.ingestUrl), streamKey: '', watchUrl: d.watchUrl ?? '' };
      const def = DESTINATIONS.find((x) => x.kind === d.kind)!;
      if (def.needsKey && enabled && !looksLikeIngest(e.ingestUrl)) throw new ApiError(400, 'bad_ingest', 'The ingest URL must start with rtmps:// (or rtmp://)');
      const destination = await saveDestination(d.kind, { enabled, ingestUrl: e.ingestUrl, streamKey: e.streamKey, ...(def.needsKey ? { watchUrl: e.watchUrl } : {}) });
      setList((l) => (l ?? []).map((x) => (x.kind === d.kind ? destination : x)));
      setEdit((m) => ({ ...m, [d.kind]: { ingestUrl: destination.ingestUrl, streamKey: '', watchUrl: destination.watchUrl ?? '' } }));
      toast(enabled !== d.enabled ? `${d.label} ${enabled ? 'enabled' : 'disabled'}` : `${d.label} saved`, 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : errorText(e), 'error', 7000);
    } finally {
      setBusy(null);
    }
  };

  if (!list)
    return (
      <div class="row">
        <Spinner /> Loading destinations…
      </div>
    );
  return (
    <div class="stack">
      <p class="muted small">Stream keys are stored encrypted on the service and never shown again (only the last 4 characters). Each meet can go to any enabled destinations at once — set up once, remembered for every show.</p>
      <p class="muted small" data-relay={relay ? '1' : '0'}>
        {relay ? (
          <>
            The <b>RTMP relay</b> is on: YouTube runs at its <b>ultra-low latency</b> (set that in YouTube Studio → Stream settings → Stream latency), and Facebook, Instagram and Twitch go out live too.
          </>
        ) : (
          <>
            No RTMP relay is deployed: YouTube goes through HLS ingestion (choose <b>Low latency</b> in YouTube Studio; expect 10–20 s), and Facebook, Instagram and Twitch stay queued. The relay is one small container — see docs/RELAY.md.
          </>
        )}
      </p>
      {list.map((d) => {
        const def = DESTINATIONS.find((x) => x.kind === d.kind)!;
        const e = edit[d.kind] ?? { ingestUrl: usableIngest(d.ingestUrl), streamKey: '', watchUrl: d.watchUrl ?? '' };
        return (
          <section class="card stack" key={d.kind} data-destination={d.kind}>
            <div class="row between">
              <h3>{d.label}</h3>
              <span class={`chip ${d.enabled ? 'ok' : ''}`}>{d.enabled ? 'enabled' : 'off'}</span>
            </div>
            {def.needsKey ? (
              <>
                <Field label="Ingest URL (RTMPS)">
                  <input class="input mono" value={e.ingestUrl} aria-label={`${d.label} ingest URL`} autocomplete="off" spellcheck={false} onInput={(ev) => setEdit((m) => ({ ...m, [d.kind]: { ...e, ingestUrl: (ev.currentTarget as HTMLInputElement).value } }))} placeholder={def.ingestHint} />
                </Field>
                <Field label={def.keyLabel} hint={d.keyHint ? `Saved key ends with ${d.keyHint}` : 'No key saved yet'}>
                  <input class="input mono" type="password" autocomplete="off" value={e.streamKey} aria-label={`${d.label} stream key`} onInput={(ev) => setEdit((m) => ({ ...m, [d.kind]: { ...e, streamKey: (ev.currentTarget as HTMLInputElement).value } }))} placeholder={d.keyHint ? 'Leave empty to keep the saved key' : 'Paste the stream key'} />
                </Field>
                <WatchLinkField kind={d.kind} value={e.watchUrl} onInput={(v) => setEdit((m) => ({ ...m, [d.kind]: { ...e, watchUrl: v } }))} />
              </>
            ) : (
              <div class="muted small">{def.ingestHint}. Viewers open the watch link; chat and lyrics follow the meet.</div>
            )}
            <div class="row">
              <button class="btn" disabled={busy === d.kind} onClick={() => void save(d, d.enabled)}>
                Save
              </button>
              <button class={`btn ${d.enabled ? 'danger' : 'accent'}`} disabled={busy === d.kind} onClick={() => void save(d, !d.enabled)}>
                {busy === d.kind ? <Spinner /> : d.enabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---------------- Publish ----------------

function Publish(props: { onDone: () => void }) {
  const [meets, setMeets] = useState<Meet[] | null>(null);
  const [dests, setDests] = useState<Destination[] | null>(null);
  const [relay, setRelay] = useState(false);
  const [meetId, setMeetId] = useState(() => new URLSearchParams(location.search).get('meet') ?? '');
  const [link, setLink] = useState('');
  const [resolving, setResolving] = useState(false);
  const [picked, setPicked] = useState<DestinationKind[] | null>(null);
  /** The platform whose stream key is being set up inline (switched on without a key yet). */
  const [setup, setSetup] = useState<DestinationKind | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    void api.get('GET /meets', '/meets').then((r) => setMeets(r.meets)).catch(() => setMeets([]));
    void api
      .get('GET /publishing/destinations', '/publishing/destinations')
      .then((r) => {
        setDests(r.destinations);
        setRelay(Boolean(r.relay));
        setPicked((p) => p ?? r.destinations.filter((d) => d.enabled).map((d) => d.kind));
      })
      .catch(() => setDests([]));
  }, []);
  useEffect(() => {
    const m = meets?.find((x) => x.meetId === meetId);
    if (m && !title) setTitle(m.title);
  }, [meetId, meets]);

  /** Any meet by link or code: it is added to the list and selected (the show view joins it as the publisher). */
  const addByLink = async () => {
    setResolving(true);
    try {
      const m = await resolveMeet(link);
      setMeets((l) => (l ?? []).some((x) => x.meetId === m.meetId) ? l : [m, ...(l ?? [])]);
      setMeetId(m.meetId);
      setTitle((t) => t || m.title);
      setLink('');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : errorText(e), 'error', 6000);
    } finally {
      setResolving(false);
    }
  };

  const selected = meets?.find((m) => m.meetId === meetId) ?? null;
  const chosen = picked ?? [];
  const showUrl = (id: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ dest: chosen.join(','), ...extra });
    return `/publishing/show/${encodeURIComponent(id)}?${q.toString()}`;
  };

  /**
   * Publish — one tap: the show view opens (performers huge, no lyrics) and goes live by itself to the chosen
   * destinations, with the listing's title and description; YouTube, when connected, gets a broadcast of its own
   * and the link appears in the show view's bar.
   */
  const publish = () => {
    if (!meetId) return;
    go(showUrl(meetId, { go: '1', ...(title.trim() ? { title: title.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}) }));
  };

  return (
    <div class="stack">
      <section class="card stack">
        <h3>1 · Which meet</h3>
        {meets === null ? (
          <Spinner />
        ) : (
          <select class="input" value={meetId} onChange={(e) => setMeetId((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">Pick a meet you host or joined</option>
            {meets.map((m) => (
              <option key={m.meetId} value={m.meetId}>
                {m.title} · {m.state} · {new Date(m.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        )}
        <div class="row">
          <input class="input" style="flex:1 1 240px" value={link} placeholder="…or paste a meet link / 6-letter code" aria-label="Meet link or code" onInput={(e) => setLink((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && void addByLink()} />
          <button class="btn" disabled={resolving || !link.trim()} onClick={() => void addByLink()}>
            {resolving ? <Spinner /> : 'Add'}
          </button>
        </div>
        {selected && !meetIsOpen(selected) && <div class="small muted">This meet is over — the job only records the configuration; publish an open meet to stream live.</div>}
      </section>
      <section class="card stack">
        <h3>2 · Where</h3>
        <p class="muted small">Switch on every place this meet should go. A platform that has no stream key yet asks for it right here (once — it stays set for the next meets).</p>
        {dests === null ? (
          <Spinner />
        ) : (
          DESTINATIONS.map((def) => {
            const d = dests.find((x) => x.kind === def.kind) ?? { kind: def.kind, label: def.label, enabled: !def.needsKey, ingestUrl: '', keyHint: '', updatedAt: '' };
            const ready = !def.needsKey || d.enabled;
            const on = chosen.includes(def.kind);
            const open = setup === def.kind;
            return (
              <div class="stack" key={def.kind} data-publish-dest={def.kind} data-ready={ready ? '1' : '0'} style="gap:2px">
                <div class="row between">
                  <Switch
                    checked={on || open}
                    onChange={(v) => {
                      if (v && !ready) {
                        setSetup(def.kind); // no key yet: set it up on the spot; the switch comes on when it is saved
                        return;
                      }
                      setPicked((p) => (v ? [...(p ?? []).filter((k) => k !== def.kind), def.kind] : (p ?? []).filter((k) => k !== def.kind)));
                      if (!v && open) setSetup(null);
                    }}
                    label={def.label}
                    hint={!def.needsKey ? undefined : `${ready ? `Stream key ends with ${d.keyHint || '…'}` : 'Needs its stream key — switch it on to set it up'}${def.browserLive || relay ? '' : ' · RTMP only: needs the relay (docs/RELAY.md), stays queued without it'}`}
                  />
                  {def.needsKey && ready && !open && (
                    <button class="btn ghost sm" onClick={() => setSetup(def.kind)}>
                      Change key
                    </button>
                  )}
                </div>
                {open && (
                  <DestinationSetup
                    dest={d}
                    onSaved={(saved) => {
                      setDests((l) => (l ?? []).map((x) => (x.kind === saved.kind ? saved : x)));
                      setPicked((p) => [...(p ?? []).filter((k) => k !== saved.kind), saved.kind]);
                      setSetup(null);
                    }}
                    onCancel={() => setSetup(null)}
                  />
                )}
              </div>
            );
          })
        )}
      </section>
      <section class="card stack">
        <h3>3 · Listing</h3>
        <Field label="Title">
          <input class="input" value={title} maxLength={120} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
        </Field>
        <Field label="Description">
          <textarea class="input" rows={3} value={description} maxLength={2000} onInput={(e) => setDescription((e.currentTarget as HTMLTextAreaElement).value)} />
        </Field>
      </section>
      <section class="card stack">
        <h3>4 · Publish</h3>
        <p class="muted small">
          Opens the <b>show view</b>: the performers cut out of their cameras, huge on one stage, no lyrics, the track and every singer's voice blended — the show your audience sees and hears. <b>Go live</b> there makes this browser the encoder (Chrome or Edge on Windows or Mac for sound — the platforms need AAC): the show goes out to the <b>in-house portal</b> (the watch page, a few seconds behind)
          {relay ? (
            <>
              {' '}
              and, through the <b>RTMP relay</b>, to <b>YouTube</b> at ultra-low latency, <b>Facebook</b>, <b>Instagram</b> and <b>Twitch</b> — a few seconds behind the stage.
            </>
          ) : (
            <>
              {' '}
              and to <b>YouTube</b> through its HLS ingestion (10–20 s behind with YouTube's "Low latency" setting). Facebook, Instagram and Twitch take RTMP only, which a browser cannot send: those jobs stay <b>requested</b> until the RTMP relay is deployed (docs/RELAY.md — it also takes YouTube down to a few seconds).
            </>
          )}
        </p>
        <div class="row">
          <button class="btn accent lg" disabled={!meetId || !chosen.length} onClick={publish} title="Opens the show view and goes live at once — YouTube's link appears in its bar">
            <IcPlay /> Publish
          </button>
          <button class="btn lg" disabled={!meetId} onClick={() => meetId && go(showUrl(meetId))} title="Open the broadcast picture without going live (Go live is there)">
            Open show view
          </button>
        </div>
        <button class="btn ghost" onClick={props.onDone}>
          See history
        </button>
      </section>
    </div>
  );
}

function JobCard(props: { job: PublishJob; dests: Destination[]; onStop?: () => void }) {
  const j = props.job;
  const active = j.state === 'requested' || j.state === 'starting' || j.state === 'live';
  return (
    <div class="card stack pad-sm" style="background:var(--surface-2)">
      <div class="row between">
        <b>{j.title}</b>
        <span class={`chip ${j.state === 'live' ? 'ok' : active ? 'warn' : ''}`}>{j.state}</span>
      </div>
      <div class="small muted">
        {j.destinations.join(' · ')} · created {new Date(j.createdAt).toLocaleString()}
        {j.watchUrl && (
          <>
            {' '}
            · <a href={href(j.watchUrl)}>watch page</a>
          </>
        )}
      </div>
      {(active || j.links?.youtube) && <LiveLinks title={j.title} destinations={j.destinations} dests={props.dests} watchPage={j.watchUrl} links={j.links} over={!active} />}
      <div class="small">
        {j.events.map((e, i) => (
          <div key={i}>
            <span class="faint">{new Date(e.at).toLocaleTimeString()}</span> <b>{e.state}</b> — {e.note}
          </div>
        ))}
      </div>
      {j.error && <div class="callout danger">{j.error}</div>}
      <div class="row">
        {active && (
          <a class="btn sm primary" href={href(`/publishing/show/${encodeURIComponent(j.meetId)}?job=${encodeURIComponent(j.jobId)}`)}>
            <IcPlay size={16} /> Show view
          </a>
        )}
        {active && props.onStop && (
          <button class="btn danger sm" onClick={props.onStop}>
            <IcStop size={16} /> Stop
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------- History ----------------

function History() {
  const [jobs, setJobs] = useState<PublishJob[] | null>(null);
  const [dests, setDests] = useState<Destination[]>([]);
  const load = () => api.get('GET /publishing/jobs', '/publishing/jobs').then((r) => setJobs(r.jobs)).catch(() => setJobs([]));
  useEffect(() => {
    void load();
    void api
      .get('GET /publishing/destinations', '/publishing/destinations')
      .then((r) => setDests(r.destinations))
      .catch(() => undefined);
  }, []);
  const stop = async (j: PublishJob) => {
    try {
      await api.post('POST /publishing/jobs/:id/stop', `/publishing/jobs/${encodeURIComponent(j.jobId)}/stop`);
      void load();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  if (!jobs) return <Spinner />;
  if (!jobs.length) return <Empty title="No publish jobs yet" body="Queue one from the Publish tab." icon={<IcCheck size={28} />} />;
  return (
    <div class="stack">
      {jobs.map((j) => (
        <JobCard key={j.jobId} job={j} dests={dests} onStop={() => void stop(j)} />
      ))}
    </div>
  );
}
