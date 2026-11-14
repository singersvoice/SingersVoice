/**
 * sv-relay client — the RTMP leg of a broadcast (services/relay). When RELAY_URL and RELAY_SECRET
 * are set, a publish job whose destinations take RTMP (YouTube, Facebook, Instagram, Twitch)
 * starts a stream on the relay with the saved ingest urls and keys (opened from the sealed store
 * here; they never go through a browser), every segment the publisher's browser sends is handed
 * on, and the stream is stopped with the job. YouTube then runs on RTMP with its ultra-low-latency
 * setting (seconds behind the stage) instead of HLS ingestion (half a minute). Without a relay,
 * YouTube keeps working through HLS ingestion as before. The destinations the relay carries are
 * `RELAY_KINDS` in the protocol package.
 */
import type { DestinationKind } from '@singersvoice/protocol';

export interface RelayConfig {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
}

export interface RelayTarget {
  kind: DestinationKind;
  url: string;
  key: string;
}

export interface RelayOutcome {
  ok: boolean;
  status: number;
  note: string;
  /** ffmpeg's last words, when the relay had some. */
  log?: string[];
}

const TIMEOUT_MS = 8000;

async function call(cfg: RelayConfig, path: string, init: { method: 'GET' | 'POST'; body?: BodyInit; contentType?: string }): Promise<RelayOutcome> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${cfg.url.replace(/\/$/, '')}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${cfg.secret}`, ...(init.contentType ? { 'Content-Type': init.contentType } : {}) },
      body: init.body,
      signal: ctl.signal,
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string; log?: string[] };
    if (!r.ok) return { ok: false, status: r.status, note: j.error ?? `relay answered ${r.status}`, log: j.log };
    return { ok: true, status: r.status, note: 'relay is streaming', log: j.log };
  } catch (e) {
    return { ok: false, status: 0, note: e instanceof Error && e.name === 'AbortError' ? 'relay did not answer in time' : 'relay unreachable' };
  } finally {
    clearTimeout(t);
  }
}

export const relayStart = (cfg: RelayConfig, jobId: string, targets: RelayTarget[]): Promise<RelayOutcome> =>
  call(cfg, `/streams/${encodeURIComponent(jobId)}/start`, { method: 'POST', body: JSON.stringify({ targets }), contentType: 'application/json' });

export const relaySegment = (cfg: RelayConfig, jobId: string, bytes: Uint8Array): Promise<RelayOutcome> =>
  call(cfg, `/streams/${encodeURIComponent(jobId)}/segments`, { method: 'POST', body: bytes as unknown as BodyInit, contentType: 'video/MP2T' });

export const relayStop = (cfg: RelayConfig, jobId: string): Promise<RelayOutcome> => call(cfg, `/streams/${encodeURIComponent(jobId)}/stop`, { method: 'POST' });

/** A human line for the job's event log from a relay answer. */
export function relayNote(o: RelayOutcome): string {
  if (o.ok) return o.log?.length ? `relay: ${o.log.at(-1)}` : 'relay is streaming';
  return `relay: ${o.note}${o.log?.length ? ` (${o.log.at(-1)})` : ''}`;
}
