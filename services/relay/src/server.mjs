/**
 * sv-relay — the RTMP leg of a SingersVoice broadcast.
 *
 * Browsers cannot speak RTMP, and RTMP is what YouTube's ultra-low-latency ingestion, Facebook,
 * Instagram and Twitch take. The publisher's browser already produces H.264 + AAC MPEG-TS segments
 * (two seconds each) and sends them to sv-control; sv-control forwards each one here, and this
 * process pipes the bytes, unchanged, into one ffmpeg per show that writes them to every RTMP
 * target at once (`-c copy`: no transcoding, a sliver of a CPU per stream).
 *
 *   POST /streams/:id/start     { targets: [{ kind, url, key }] }   → starts ffmpeg for this show
 *   POST /streams/:id/segments  <MPEG-TS bytes>                     → one more segment, in order
 *   POST /streams/:id/stop                                          → ends the stream
 *   GET  /streams/:id                                               → running, bytes, ffmpeg's last words
 *   GET  /health                                                    → ok, ffmpeg version, stream count
 *
 * Every call carries `Authorization: Bearer <RELAY_SECRET>` — sv-control is the only caller, and
 * the stream keys travel only between the two services, never through a browser. A stream that
 * receives nothing for a minute is closed. Keys never appear in logs.
 */
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.RELAY_SECRET || '';
const FFMPEG = process.env.RELAY_FFMPEG || 'ffmpeg';
const MAX_STREAMS = Number(process.env.RELAY_MAX_STREAMS || 20);
const IDLE_MS = Number(process.env.RELAY_IDLE_MS || 60_000);
const MAX_SEGMENT = 8_000_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** @type {Map<string, {proc: import('node:child_process').ChildProcess, targets: number, bytes: number, segments: number, startedAt: number, lastAt: number, log: string[], exit: number | null}>} */
const streams = new Map();

/** The RTMP url for a target: the ingest url and the key, slash between them. */
export function rtmpTarget(t) {
  const url = String(t.url || '').replace(/\/+$/, '');
  const key = String(t.key || '').trim();
  return key ? `${url}/${key}` : url;
}

/** ffmpeg's arguments for a show: MPEG-TS on stdin, copied to every target as FLV over RTMP(S). */
export function ffmpegArgs(targets) {
  // `aac_adtstoasc`: AAC comes out of MPEG-TS in ADTS frames and FLV wants it raw; the H.264 is copied as is.
  const base = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-fflags', '+genpts+nobuffer', '-f', 'mpegts', '-i', 'pipe:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-map', '0:v?', '-map', '0:a?', '-flvflags', 'no_duration_filesize'];
  if (targets.length === 1) return [...base, '-f', 'flv', rtmpTarget(targets[0])];
  const tee = targets.map((t) => `[f=flv:onfail=ignore]${rtmpTarget(t).replace(/[|[\]]/g, '\\$&')}`).join('|');
  return [...base, '-f', 'tee', tee];
}

/** Keys must not reach the logs: a target is logged as its host only. */
const hostOf = (t) => {
  try {
    return new URL(String(t.url)).host;
  } catch {
    return 'target';
  }
};

function startStream(id, targets) {
  stopStream(id);
  if (streams.size >= MAX_STREAMS) throw Object.assign(new Error(`The relay already carries ${MAX_STREAMS} streams`), { status: 503 });
  const proc = spawn(FFMPEG, ffmpegArgs(targets), { stdio: ['pipe', 'ignore', 'pipe'] });
  const s = { proc, targets: targets.length, bytes: 0, segments: 0, startedAt: Date.now(), lastAt: Date.now(), log: [], exit: null };
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      const l = line.trim();
      if (!l) continue;
      s.log.push(l.slice(0, 300));
      if (s.log.length > 20) s.log.shift();
    }
  });
  proc.on('exit', (code) => {
    s.exit = code ?? -1;
    console.log(`[relay] ${id} ffmpeg exited ${s.exit} after ${s.segments} segments (${s.bytes} bytes) to ${targets.map(hostOf).join(', ')}`);
  });
  proc.stdin.on('error', () => undefined); // a closed pipe is reported through `exit`
  streams.set(id, s);
  console.log(`[relay] ${id} started → ${targets.map(hostOf).join(', ')}`);
  return s;
}

function stopStream(id) {
  const s = streams.get(id);
  if (!s) return false;
  streams.delete(id);
  try {
    s.proc.stdin.end();
  } catch {
    /* already closed */
  }
  const t = setTimeout(() => {
    try {
      s.proc.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }, 3000);
  s.proc.once('exit', () => clearTimeout(t));
  return true;
}

/** Write one segment to ffmpeg, honouring back-pressure (a slow RTMP link must not pile bytes up in memory). */
function writeSegment(s, bytes) {
  return new Promise((resolve, reject) => {
    if (s.exit !== null) return reject(Object.assign(new Error(`ffmpeg is gone (exit ${s.exit}): ${s.log.at(-1) ?? ''}`), { status: 502 }));
    const ok = s.proc.stdin.write(bytes, (e) => (e ? reject(Object.assign(e, { status: 502 })) : undefined));
    s.bytes += bytes.length;
    s.segments += 1;
    s.lastAt = Date.now();
    if (ok) return resolve();
    const timer = setTimeout(() => resolve(), 5000); // the link is slow: let the caller go on, the bytes are queued
    s.proc.stdin.once('drain', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** `Authorization: Bearer <RELAY_SECRET>`, compared in constant time. */
function authorized(header) {
  if (!SECRET || typeof header !== 'string') return false;
  const given = Buffer.from(header);
  const want = Buffer.from(`Bearer ${SECRET}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

let ffmpegVersion = null;
execFile(FFMPEG, ['-version'], (e, out) => {
  ffmpegVersion = e ? `not found (${e.message})` : String(out).split('\n')[0];
});

export function handle(req, res) {
  const url = new URL(req.url, 'http://relay');
  if (url.pathname === '/health') return json(res, 200, { ok: true, ffmpeg: ffmpegVersion, streams: streams.size });
  if (!authorized(req.headers.authorization)) return json(res, 401, { error: 'unauthorized' });
  const m = /^\/streams\/([^/]+)(?:\/(start|segments|stop))?$/.exec(url.pathname);
  if (!m || !ID.test(m[1])) return json(res, 404, { error: 'not found' });
  const [, id, action] = m;
  (async () => {
    if (req.method === 'GET' && !action) {
      const s = streams.get(id);
      return json(res, s ? 200 : 404, s ? { running: s.exit === null, bytes: s.bytes, segments: s.segments, startedAt: s.startedAt, lastAt: s.lastAt, exit: s.exit, targets: s.targets, log: s.log.slice(-5) } : { error: 'no stream' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    if (action === 'start') {
      const body = JSON.parse((await readBody(req, 64_000)).toString('utf8') || '{}');
      const targets = Array.isArray(body.targets) ? body.targets.filter((t) => t && typeof t.url === 'string' && /^rtmps?:\/\//.test(t.url)) : [];
      if (!targets.length) return json(res, 400, { error: 'no rtmp targets' });
      const s = startStream(id, targets);
      return json(res, 200, { ok: true, targets: s.targets });
    }
    if (action === 'segments') {
      const s = streams.get(id);
      if (!s) return json(res, 404, { error: 'no stream — start it first' });
      const bytes = await readBody(req, MAX_SEGMENT);
      if (!bytes.length) return json(res, 400, { error: 'empty segment' });
      await writeSegment(s, bytes);
      return json(res, 200, { ok: true, bytes: s.bytes, segments: s.segments, log: s.log.slice(-2) });
    }
    if (action === 'stop') return json(res, 200, { ok: true, stopped: stopStream(id) });
    return json(res, 404, { error: 'not found' });
  })().catch((e) => json(res, e.status ?? 500, { error: e.message }));
}

/** Streams nobody fed for a minute are closed (a publisher's tab that vanished). */
export function sweep(now = Date.now()) {
  for (const [id, s] of streams) if (now - s.lastAt > IDLE_MS || s.exit !== null) stopStream(id);
}

export function streamCount() {
  return streams.size;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  if (!SECRET) console.warn('[relay] RELAY_SECRET is not set — every call will be refused');
  setInterval(sweep, 15_000).unref();
  http.createServer(handle).listen(PORT, () => console.log(`[relay] listening on :${PORT} (ffmpeg: ${FFMPEG}, up to ${MAX_STREAMS} streams)`));
}
