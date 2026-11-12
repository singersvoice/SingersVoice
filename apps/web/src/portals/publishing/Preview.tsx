/**
 * Publishing › Preview — admin monitoring. Every open meet this account may publish (hosted or
 * joined; any other by link / code) gets a monitor tile with the exact picture the platforms would
 * be playing: the same receive-only video mesh and "show" compositor as the show view, in a 16:9
 * box, no lyrics, no controls in the picture. Each tile joins its meet as its own publisher
 * participant, so monitoring here and running the show view elsewhere never fight over one link.
 * The first few tiles connect by themselves; beyond that a tile connects on request, so a wall of
 * meets never floods the admin's downlink.
 */
import { meetIsOpen, type Meet, type PublishJob } from '@singersvoice/protocol';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { IcMic, IcPlay, IcUsers } from '../../components/icons.tsx';
import { Empty, Spinner } from '../../components/ui.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { href } from '../../lib/nav.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { MeetSession } from '../meets/meetSession.ts';
import { resolveMeet } from './meetLookup.ts';
import { activeJob } from './ShowView.tsx';
import { ShowPicture, useCountdown, useShowFeed, Vocals } from './showStage.tsx';

const REFRESH_MS = 10_000;
/** Tiles that connect by themselves; the rest connect on request. */
const AUTO_CONNECT = 4;
const ORDER: Record<Meet['state'], number> = { live: 0, countdown: 1, lobby: 2, ended: 3, expired: 4 };

export function Preview() {
  const [meets, setMeets] = useState<Meet[] | null>(null);
  const [extra, setExtra] = useState<Meet[]>([]);
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [link, setLink] = useState('');
  const [resolving, setResolving] = useState(false);
  const [forced, setForced] = useState<Set<string>>(new Set());

  const refresh = async () => {
    try {
      const [m, j] = await Promise.all([api.get('GET /meets', '/meets'), api.get('GET /publishing/jobs', '/publishing/jobs')]);
      setMeets(m.meets);
      setJobs(j.jobs);
    } catch (e) {
      setMeets((x) => x ?? []);
      toast(errorText(e), 'error');
    }
  };
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const addByLink = async () => {
    setResolving(true);
    try {
      const m = await resolveMeet(link);
      if (!meetIsOpen(m)) toast('That meet is over — only open meets can be previewed', 'warn');
      else setExtra((l) => (l.some((x) => x.meetId === m.meetId) ? l : [m, ...l]));
      setLink('');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : errorText(e), 'error', 6000);
    } finally {
      setResolving(false);
    }
  };

  const eligible = useMemo(() => {
    const all = [...extra, ...(meets ?? [])];
    const seen = new Set<string>();
    return all
      .filter((m) => meetIsOpen(m) && !seen.has(m.meetId) && seen.add(m.meetId))
      .sort((a, b) => ORDER[a.state] - ORDER[b.state] || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [meets, extra]);
  const jobFor = (meetId: string) => jobs.filter((j) => j.meetId === meetId).find(activeJob) ?? null;

  return (
    <div class="stack">
      <div class="row">
        <input class="input" style="flex:1 1 240px" value={link} placeholder="Preview another meet: paste its link / 6-letter code" aria-label="Meet link or code" onInput={(e) => setLink((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && void addByLink()} />
        <button class="btn" disabled={resolving || !link.trim()} onClick={() => void addByLink()}>
          {resolving ? <Spinner /> : 'Add'}
        </button>
      </div>
      {meets === null ? (
        <div class="row">
          <Spinner /> Looking for open meets…
        </div>
      ) : !eligible.length ? (
        <Empty title="No open meet to preview" body="Meets you host or joined show up here while they are open (lobby, countdown, live) with the exact picture the platforms would play. Paste a meet link or code to preview any other meet." icon={<IcUsers size={28} />} />
      ) : (
        <div class="monitors">
          {eligible.map((m, i) => (
            <MonitorTile key={m.meetId} meet={m} job={jobFor(m.meetId)} connect={i < AUTO_CONNECT || forced.has(m.meetId)} onConnect={() => setForced((f) => new Set(f).add(m.meetId))} />
          ))}
        </div>
      )}
      <p class="muted small">Each tile is a live monitor of the broadcast picture (performers cut out of their cameras, huge on the stage, no lyrics) — what the platforms would be playing. Tiles beyond the first {AUTO_CONNECT} connect when you ask, to spare your connection.</p>
    </div>
  );
}

function MonitorTile(props: { meet: Meet; job: PublishJob | null; connect: boolean; onConnect: () => void }) {
  const { meet, job } = props;
  const [status, setStatus] = useState<{ onStage: number; linked: number } | null>(null);
  const onAir = job?.state === 'live';
  const requested = job !== null && !onAir;
  return (
    <section class="card stack pad-sm monitor-card">
      <div class="row between">
        <div class="monitor-title">
          <b>{meet.title}</b>
          <div class="small muted">
            {meet.trackTitle || 'no track'} · host {meet.hostName}
          </div>
        </div>
        <div class="row monitor-chips">
          {onAir && <span class="onair">LIVE</span>}
          {requested && <span class="chip warn">requested</span>}
          <span class={`chip ${meet.state === 'live' ? 'ok' : ''}`}>{meet.state}</span>
          {status && (
            <span class="chip">
              <IcUsers size={14} /> {status.onStage} on stage · {status.linked}/{status.onStage} video
            </span>
          )}
        </div>
      </div>
      {props.connect ? (
        <LiveMonitor meet={meet} onStatus={setStatus} />
      ) : (
        <div class="monitor" data-state="idle">
          <div class="show-center">
            <button class="btn primary" onClick={props.onConnect}>
              <IcPlay /> Preview this meet
            </button>
          </div>
        </div>
      )}
      <div class="row between">
        <span class="small muted">{job ? `${job.state} · ${job.destinations.join(' · ')}` : 'not publishing'}</span>
        <div class="row monitor-chips">
          <a class="btn sm" href={href(`/meet/${encodeURIComponent(meet.meetId)}`)} target="_blank" rel="noopener" title="The meet room (stage, set list, chat) in a new tab">
            Room
          </a>
          <a class="btn sm" href={href(`/publishing/show/${encodeURIComponent(meet.meetId)}`)} target="_blank" rel="noopener">
            Show view
          </a>
          <a class="btn sm primary" href={href(`/publishing?tab=publish&meet=${encodeURIComponent(meet.meetId)}`)}>
            Publish
          </a>
        </div>
      </div>
    </section>
  );
}

/** A monitor tile's own publisher participant + feed; the picture is the shared ShowPicture. */
function LiveMonitor(props: { meet: Meet; onStatus: (s: { onStage: number; linked: number }) => void }) {
  const session = useMemo(() => new MeetSession(props.meet.meetId, 'preview', 'tile'), [props.meet.meetId]);
  const snap = session.snapshot.value;
  const you = session.you.value;
  const meet = snap?.meet ?? props.meet;
  useEffect(() => {
    void session.join('publisher').catch(() => undefined);
    return () => {
      void session.leave();
    };
  }, [props.meet.meetId]);
  if (session.error.value && !snap)
    return (
      <div class="monitor" data-state="error">
        <div class="show-center">
          <div class="callout danger">{session.error.value}</div>
        </div>
      </div>
    );
  if (!you)
    return (
      <div class="monitor" data-state="joining">
        <div class="show-center muted">
          <Spinner /> Connecting…
        </div>
      </div>
    );
  return <MonitorFeed session={session} meet={meet} you={you} onStatus={props.onStatus} />;
}

function MonitorFeed(props: { session: MeetSession; meet: Meet; you: NonNullable<MeetSession['you']['value']>; onStatus: (s: { onStage: number; linked: number }) => void }) {
  const feed = useShowFeed(props.session, props.meet, props.you);
  const countdown = useCountdown(props.meet);
  const [listen, setListen] = useState(false); // a wall of tiles monitors silently; one can be heard on request
  useEffect(() => props.onStatus({ onStage: feed.onStage, linked: feed.linked }), [feed.onStage, feed.linked]);
  // The picture is exact — status lives in the card, never in the frame.
  const n = Object.keys(feed.vocals).length;
  return (
    <div class="monitor" data-state={props.meet.state} data-performers={feed.onStage} data-linked={feed.linked} data-vocals={n}>
      <ShowPicture meet={props.meet} compositor={feed.compositor} countdown={countdown} />
      <Vocals vocals={feed.vocals} on={listen} />
      <button class={`btn icon sm monitor-listen ${listen ? 'on' : ''}`} aria-label={listen ? 'Mute this meet' : 'Hear this meet'} aria-pressed={listen} title={`${n} vocal${n === 1 ? '' : 's'} arriving`} onClick={() => setListen((l) => !l)}>
        <IcMic size={14} />
      </button>
    </div>
  );
}
