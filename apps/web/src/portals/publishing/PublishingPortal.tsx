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
import { privileged } from '../../state/session.ts';
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
  if (!privileged.value)
    return (
      <Page title="Publishing">
        <div class="stack">
          {!checked && (
            <div class="row">
              <Spinner /> Checking your account…
            </div>
          )}
          <Empty title="Publishing mode is for privileged users" body="Streaming meets to YouTube, Facebook, Instagram, Twitch and the in-house portal is enabled per account by the SingersVoice admin (PRIVILEGED_EMAILS on the service). Ask them to add your Google account, then reopen this page.">
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

/** Save a platform's ingest URL / stream key (an empty key keeps the saved one) and its enabled flag. */
async function saveDestination(kind: DestinationKind, patch: { enabled: boolean; ingestUrl: string; streamKey?: string }): Promise<Destination> {
  const r = await api.put('PUT /publishing/destinations/:kind', `/publishing/destinations/${kind}`, {
    enabled: patch.enabled,
    ingestUrl: patch.ingestUrl.trim(),
    ...(patch.streamKey?.trim() ? { streamKey: patch.streamKey.trim() } : {}),
  });
  return r.destination;
}

/**
 * The stream key setup of one platform, inline: ingest URL (the platform's default filled in) and the
 * key (never shown again once saved — only its last 4 characters). Save enables the platform.
 */
function DestinationSetup(props: { dest: Destination; onSaved: (d: Destination) => void; onCancel?: () => void }) {
  const def = DESTINATIONS.find((x) => x.kind === props.dest.kind)!;
  const [ingestUrl, setIngestUrl] = useState(() => usableIngest(props.dest.ingestUrl) || usableIngest(def.ingestHint));
  const [streamKey, setStreamKey] = useState('');
  const [busy, setBusy] = useState(false);
  const canSave = looksLikeIngest(ingestUrl) && (streamKey.trim().length > 0 || Boolean(props.dest.keyHint));
  const save = async () => {
    if (!looksLikeIngest(ingestUrl)) return toast('The ingest URL must start with rtmps:// (or rtmp://)', 'warn');
    if (!streamKey.trim() && !props.dest.keyHint) return toast(`Paste the ${def.label} stream key first`, 'warn');
    setBusy(true);
    try {
      const d = await saveDestination(props.dest.kind, { enabled: true, ingestUrl, streamKey });
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
    </div>
  );
}

function Destinations() {
  const [list, setList] = useState<Destination[] | null>(null);
  const [edit, setEdit] = useState<Record<string, { ingestUrl: string; streamKey: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api
      .get('GET /publishing/destinations', '/publishing/destinations')
      .then((r) => setList(r.destinations))
      .catch((e) => {
        setList([]);
        toast(errorText(e), 'error');
      });
  useEffect(() => void load(), []);

  const save = async (d: Destination, enabled: boolean) => {
    setBusy(d.kind);
    try {
      const e = edit[d.kind] ?? { ingestUrl: usableIngest(d.ingestUrl), streamKey: '' };
      const def = DESTINATIONS.find((x) => x.kind === d.kind)!;
      if (def.needsKey && enabled && !looksLikeIngest(e.ingestUrl)) throw new ApiError(400, 'bad_ingest', 'The ingest URL must start with rtmps:// (or rtmp://)');
      const destination = await saveDestination(d.kind, { enabled, ingestUrl: e.ingestUrl, streamKey: e.streamKey });
      setList((l) => (l ?? []).map((x) => (x.kind === d.kind ? destination : x)));
      setEdit((m) => ({ ...m, [d.kind]: { ingestUrl: destination.ingestUrl, streamKey: '' } }));
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
      <p class="muted small">Stream keys are stored encrypted on the service and never shown again (only the last 4 characters). Each meet can go to any enabled destinations at once.</p>
      {list.map((d) => {
        const def = DESTINATIONS.find((x) => x.kind === d.kind)!;
        const e = edit[d.kind] ?? { ingestUrl: usableIngest(d.ingestUrl), streamKey: '' };
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
  const [meetId, setMeetId] = useState(() => new URLSearchParams(location.search).get('meet') ?? '');
  const [link, setLink] = useState('');
  const [resolving, setResolving] = useState(false);
  const [picked, setPicked] = useState<DestinationKind[] | null>(null);
  /** The platform whose stream key is being set up inline (switched on without a key yet). */
  const [setup, setSetup] = useState<DestinationKind | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get('GET /meets', '/meets').then((r) => setMeets(r.meets)).catch(() => setMeets([]));
    void api
      .get('GET /publishing/destinations', '/publishing/destinations')
      .then((r) => {
        setDests(r.destinations);
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
  const showUrl = (id: string, job?: PublishJob) => `/publishing/show/${encodeURIComponent(id)}?dest=${encodeURIComponent(chosen.join(','))}${job ? `&job=${encodeURIComponent(job.jobId)}` : ''}`;

  /** Publish: queue the job for the chosen destinations, then open the show view (performers huge, no lyrics). */
  const publish = async () => {
    if (!meetId) return;
    setBusy(true);
    try {
      const r = await api.post('POST /publishing/jobs', '/publishing/jobs', { meetId, destinations: chosen, title, description });
      toast('Publishing requested — opening the show view', 'ok');
      go(showUrl(meetId, r.job));
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'already_publishing' || e.code === 'not_in_meet')) {
        // Already running, or we have to be in the meet first: the show view joins as the publisher and takes it from there.
        go(showUrl(meetId));
      } else toast(e instanceof ApiError ? e.message : errorText(e), 'error', 8000);
    } finally {
      setBusy(false);
    }
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
                    hint={!def.needsKey ? undefined : `${ready ? `Stream key ends with ${d.keyHint || '…'}` : 'Needs its stream key — switch it on to set it up'}${def.browserLive ? '' : ' · RTMP only: waits for the session container'}`}
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
          Opens the <b>show view</b>: the performers cut out of their cameras, huge on one stage, no lyrics, the track and every singer's voice blended — the show your audience sees and hears. <b>Go live</b> there makes this browser the encoder: the show goes out to <b>YouTube</b> (through the service, to YouTube's HLS ingestion — Chrome or Edge on Windows or Mac for sound, since YouTube needs AAC) and to the <b>in-house portal</b> (the watch page, a few seconds behind). Facebook, Instagram and Twitch take RTMP only, which a browser cannot send: those jobs stay <b>requested</b> until the session container exists.
        </p>
        <div class="row">
          <button class="btn accent lg" disabled={busy || !meetId || !chosen.length} onClick={() => void publish()}>
            {busy ? <Spinner /> : <IcPlay />} Publish
          </button>
          <button class="btn lg" disabled={!meetId} onClick={() => meetId && go(showUrl(meetId))} title="Open the broadcast picture without queueing a job">
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

function JobCard(props: { job: PublishJob; onStop?: () => void }) {
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
  const load = () => api.get('GET /publishing/jobs', '/publishing/jobs').then((r) => setJobs(r.jobs)).catch(() => setJobs([]));
  useEffect(() => void load(), []);
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
        <JobCard key={j.jobId} job={j} onStop={() => void stop(j)} />
      ))}
    </div>
  );
}
