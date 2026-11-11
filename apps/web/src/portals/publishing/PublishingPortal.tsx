/**
 * Publishing mode — privileged users push a meet to YouTube / Facebook / Instagram / Twitch and the
 * in-house watch portal. Screens: Destinations (ingest URL + stream key, enable), Publish (pick a
 * meet, destinations, title, go live / stop), History (jobs with their event timeline).
 * The encoder that executes a job lives in the session container (next increment); jobs queue here.
 */
import { DESTINATIONS, meetIsOpen, type Destination, type DestinationKind, type Meet, type PublishJob } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { IcCheck, IcPlay, IcStop } from '../../components/icons.tsx';
import { Page } from '../../components/Shell.tsx';
import { Empty, Field, Seg, Spinner, Switch } from '../../components/ui.tsx';
import { api, ApiError, controlConfigured, refreshAccount } from '../../lib/api.ts';
import { href } from '../../lib/nav.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { privileged } from '../../state/session.ts';

type Tab = 'publish' | 'destinations' | 'history';

export function PublishingPortal() {
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('meet') ? 'publish' : 'destinations'));
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
  const [dests, setDests] = useState<Destination[]>([]);
  const [meetId, setMeetId] = useState(() => new URLSearchParams(location.search).get('meet') ?? '');
  const [picked, setPicked] = useState<DestinationKind[]>(['inhouse']);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<PublishJob | null>(null);

  useEffect(() => {
    void api.get('GET /meets', '/meets').then((r) => setMeets(r.meets)).catch(() => setMeets([]));
    void api.get('GET /publishing/destinations', '/publishing/destinations').then((r) => setDests(r.destinations)).catch(() => undefined);
  }, []);
  useEffect(() => {
    const m = meets?.find((x) => x.meetId === meetId);
    if (m && !title) setTitle(m.title);
  }, [meetId, meets]);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post('POST /publishing/jobs', '/publishing/jobs', { meetId, destinations: picked, title, description });
      setJob(r.job);
      toast('Publish job queued', 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : errorText(e), 'error', 8000);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!job) return;
    try {
      const r = await api.post('POST /publishing/jobs/:id/stop', `/publishing/jobs/${encodeURIComponent(job.jobId)}/stop`);
      setJob(r.job);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const enabled = dests.filter((d) => d.enabled).map((d) => d.kind);
  return (
    <div class="stack">
      <section class="card stack">
        <h3>1 · Which meet</h3>
        {meets === null ? (
          <Spinner />
        ) : (
          <select class="input" value={meetId} onChange={(e) => setMeetId((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">Pick a meet you host</option>
            {meets.map((m) => (
              <option key={m.meetId} value={m.meetId}>
                {m.title} · {m.state} · {new Date(m.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        )}
        {meetId && meets?.find((m) => m.meetId === meetId && !meetIsOpen(m)) && <div class="small muted">This meet is over — the job records the configuration; start a new meet to stream live.</div>}
      </section>
      <section class="card stack">
        <h3>2 · Where</h3>
        {DESTINATIONS.map((d) => (
          <Switch
            key={d.kind}
            checked={picked.includes(d.kind)}
            disabled={!enabled.includes(d.kind)}
            onChange={(v) => setPicked((p) => (v ? [...p, d.kind] : p.filter((k) => k !== d.kind)))}
            label={d.label}
            hint={enabled.includes(d.kind) ? undefined : 'Enable it under Destinations first'}
          />
        ))}
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
        <h3>4 · Go live</h3>
        <p class="muted small">
          Queues a publish job. When the meet's host starts the song, the session container composes the stage (performers' takes, lyrics, background) and pushes RTMPS to the chosen platforms; the in-house portal gets an LL-HLS stream. Until the container is deployed, the job stays <b>requested</b> — nothing is sent anywhere.
        </p>
        {!job ? (
          <button class="btn accent lg" disabled={busy || !meetId || !picked.length} onClick={() => void go()}>
            {busy ? <Spinner /> : <IcPlay />} Queue publish
          </button>
        ) : (
          <JobCard job={job} onStop={stop} />
        )}
        {job && (
          <button class="btn ghost" onClick={props.onDone}>
            See history
          </button>
        )}
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
      {active && props.onStop && (
        <button class="btn danger sm" onClick={props.onStop}>
          <IcStop size={16} /> Stop
        </button>
      )}
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
