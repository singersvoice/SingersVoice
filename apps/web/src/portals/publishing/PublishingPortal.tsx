/**
 * Publishing mode — its own portal, for privileged accounts only: push a meet to YouTube / Facebook /
 * Instagram / Twitch and the in-house watch portal. Screens: Publish (pick a meet — one you host or
 * joined, or any meet by link / code — pick destinations, Publish → the show view), Destinations
 * (ingest URL + stream key per platform), History (jobs with their event timeline). The show view
 * (/publishing/show/:id) is the broadcast picture: performers huge on one stage, no lyrics.
 * The encoder that executes a job lives in the session container (next increment); jobs queue here.
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

type Tab = 'publish' | 'destinations' | 'history';

const initialTab = (): Tab => {
  const q = new URLSearchParams(location.search);
  const t = q.get('tab');
  if (t === 'publish' || t === 'destinations' || t === 'history') return t;
  return 'publish';
};

/** `/meet/<id>` link, a bare meet id, or a 6-letter join code → the meet. */
async function resolveMeet(input: string): Promise<Meet> {
  const s = input.trim();
  const m = /\/meet\/([^/?#\s]+)/.exec(s);
  if (m) return (await api.get('GET /meets/:id', `/meets/${encodeURIComponent(m[1]!)}`)).meet;
  if (/^[a-z0-9]{6}$/i.test(s)) return (await api.get('GET /meets/code/:code', `/meets/code/${encodeURIComponent(s.toUpperCase())}`)).meet;
  if (s) return (await api.get('GET /meets/:id', `/meets/${encodeURIComponent(s)}`)).meet;
  throw new Error('Paste a meet link or its 6-letter code');
}

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
            { v: 'destinations', label: 'Destinations' },
            { v: 'history', label: 'History' },
          ]}
        />
        {tab === 'destinations' && <Destinations />}
        {tab === 'publish' && <Publish onDone={() => setTab('history')} />}
        {tab === 'history' && <History />}
      </div>
    </Page>
  );
}

// ---------------- Destinations ----------------

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
      const e = edit[d.kind] ?? { ingestUrl: d.ingestUrl, streamKey: '' };
      const r = await api.put('PUT /publishing/destinations/:kind', `/publishing/destinations/${d.kind}`, {
        enabled,
        ingestUrl: e.ingestUrl,
        ...(e.streamKey ? { streamKey: e.streamKey } : {}),
      });
      setList((l) => (l ?? []).map((x) => (x.kind === d.kind ? r.destination : x)));
      setEdit((m) => ({ ...m, [d.kind]: { ingestUrl: r.destination.ingestUrl, streamKey: '' } }));
      toast(`${d.label} ${enabled ? 'enabled' : 'saved'}`, 'ok');
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
        const e = edit[d.kind] ?? { ingestUrl: d.ingestUrl, streamKey: '' };
        return (
          <section class="card stack" key={d.kind}>
            <div class="row between">
              <h3>{d.label}</h3>
              <span class={`chip ${d.enabled ? 'ok' : ''}`}>{d.enabled ? 'enabled' : 'off'}</span>
            </div>
            {def.needsKey ? (
              <>
                <Field label="Ingest URL (RTMPS)">
                  <input class="input mono" value={e.ingestUrl} onInput={(ev) => setEdit((m) => ({ ...m, [d.kind]: { ...e, ingestUrl: (ev.currentTarget as HTMLInputElement).value } }))} placeholder={def.ingestHint} />
                </Field>
                <Field label={def.keyLabel} hint={d.keyHint ? `Saved key ends with ${d.keyHint}` : 'No key saved yet'}>
                  <input class="input mono" type="password" autocomplete="off" value={e.streamKey} onInput={(ev) => setEdit((m) => ({ ...m, [d.kind]: { ...e, streamKey: (ev.currentTarget as HTMLInputElement).value } }))} placeholder={d.keyHint ? 'Leave empty to keep the saved key' : 'Paste the stream key'} />
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

  const enabled = (dests ?? []).filter((d) => d.enabled).map((d) => d.kind);
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
        {dests === null ? (
          <Spinner />
        ) : (
          DESTINATIONS.map((d) => (
            <Switch
              key={d.kind}
              checked={chosen.includes(d.kind)}
              disabled={!enabled.includes(d.kind)}
              onChange={(v) => setPicked((p) => (v ? [...(p ?? []), d.kind] : (p ?? []).filter((k) => k !== d.kind)))}
              label={d.label}
              hint={enabled.includes(d.kind) ? undefined : 'Enable it under Destinations first'}
            />
          ))
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
          Opens the <b>show view</b>: the performers cut out of their cameras, huge on one stage, no lyrics — the picture your audience sees. The job is queued for the chosen destinations; when the host starts the song, the session container composes the stage and pushes RTMPS to the platforms (the in-house portal gets LL-HLS). Until the container is deployed, the job stays <b>requested</b> — nothing is sent anywhere.
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
