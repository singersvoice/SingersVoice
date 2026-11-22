/**
 * Admin → Live now: what runs on the service this moment — every open meet, who is in it, and what each device's links
 * to the other singers carry as that device last reported with its heartbeat (links up of how many, sound and pictures
 * arriving, by relay, strained). Read every ten seconds from the service's memory (`GET /admin/live`, no row read);
 * the storage counters beside it. The operator's view during a meet, without being in the room.
 */
import type { AdminLiveResponse } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Spinner } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { errorText } from '../lib/toast.ts';

const REFRESH_MS = 10_000;

const ago = (iso: string, now: number): string => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

export function AdminLive() {
  const [live, setLive] = useState<AdminLiveResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let gone = false;
    const load = async () => {
      try {
        const r = await api.get('GET /admin/live', '/admin/live');
        if (!gone) {
          setLive(r);
          setError('');
        }
      } catch (e) {
        if (!gone) setError(errorText(e));
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, []);
  const now = live?.serverEpochMs ?? Date.now();
  return (
    <section class="card stack pad-sm" id="live" data-admin-live={live ? live.meets.length : 'loading'}>
      <div class="row between wrap">
        <div>
          <h3 style="margin:0">Live now</h3>
          <div class="small muted">Every open meet on the service and what each device's links carry, as the device last reported (refreshed every {REFRESH_MS / 1000} s).</div>
        </div>
        {live && (
          <span class={`chip ${live.storage.writes === 'ok' ? '' : 'warn'}`} title={`Rows the service read and wrote since ${new Date(live.storage.since).toLocaleString()} (Cloudflare's free plan allows 100,000 written a day)`}>
            storage · {live.storage.rowsWritten.toLocaleString()} written · {live.storage.rowsRead.toLocaleString()} read · writes {live.storage.writes}
          </span>
        )}
      </div>
      {error && <div class="callout warn">{error}</div>}
      {!live && !error && (
        <div class="row">
          <Spinner /> Loading…
        </div>
      )}
      {live && live.meets.length === 0 && <div class="small muted">No meet is open right now.</div>}
      {live?.meets.map((m) => (
        <div class="stack" style="gap:6px;padding:8px 0;border-top:1px solid var(--line, #ddd)" key={m.meetId} data-live-meet={m.meetId}>
          <div class="row wrap" style="gap:8px;align-items:center">
            <b>{m.title}</b>
            <span class="small muted">hosted by {m.hostName}</span>
            <span class="chip">{m.state}</span>
            <span class="chip">{m.onStage} on stage · {m.audience} listening</span>
            <span class="small faint">since {new Date(m.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · closes {ago(m.expiresAt, now).replace(' ago', '')} from now without activity</span>
            {m.jobs.map((j) => (
              <span class="chip ok" key={j.jobId} title={`Broadcast ${j.jobId}: ${j.destinations.join(', ')}${j.lastSegmentAt ? ` — last segment ${ago(j.lastSegmentAt, now)}` : ' — no segment yet'}`}>
                on air · {j.destinations.join(', ')}
              </span>
            ))}
          </div>
          <div class="row wrap small" style="gap:6px">
            {m.participants.map((p) => {
              const l = p.links;
              const short = l && l.of > 0 && (l.up < l.of || l.sound < l.up);
              return (
                <span class={`chip ${short ? 'warn' : l ? 'ok' : ''}`} key={p.participantId} data-live-participant={p.participantId} data-live-links={l ? `${l.up}/${l.of}/${l.sound}/${l.pictures}/${l.relay}${l.strained ? '/strained' : ''}` : undefined} title={`${p.displayName} · ${p.role}${p.slot ? ` · S${p.slot}` : ''}${p.media === 'audio' ? ' · voice only' : ''} · heard from ${ago(p.lastSeenAt, now)}${l ? ` · links ${l.up}/${l.of} up, sound from ${l.sound}, pictures from ${l.pictures}${l.relay ? `, ${l.relay} by relay` : ''}${l.strained ? ' — straining' : ''} (reported ${ago(l.at, now)})` : ' · no link report yet'}`}>
                  {p.slot ? `S${p.slot} ` : ''}
                  {p.displayName}
                  {l ? ` · ${l.up}/${l.of}${l.sound < l.up ? ` · sound ${l.sound}` : ''}${l.relay ? ` · ${l.relay} relay` : ''}${l.strained ? ' · straining' : ''}` : ''}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
