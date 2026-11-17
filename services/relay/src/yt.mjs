/**
 * YouTube song tracks — the part of the relay that fetches a karaoke video from YouTube into a
 * singer's own Drive, so the app can sing to it like any other track (packages/protocol/ytTracks.ts):
 *
 *   GET  /yt/search?q=…        → the first dozen YouTube results for the words (yt-dlp, no API key)
 *   POST /yt/fetch             { videoId, trackId, folderId, name, token } → a job; the browser polls it
 *   GET  /yt/jobs/:id          → queued · downloading · converting · uploading · done · error, with a fraction
 *   GET  /yt                   → whether yt-dlp is here, and its version
 *
 * A job: yt-dlp downloads the video (H.264 + AAC in an mp4, 720p at most — a karaoke video's words read
 * fine, the file stays a few dozen MB), ffmpeg takes the sound out into its own file (the backing layer
 * the singers sing to; the video itself stays muted on stage) and makes the mp4 start fast, and both
 * files are uploaded into the singer's Drive folder with the singer's own Google token — the one the
 * browser already uses for Drive, handed over by sv-control for this job alone — stamped with the app's
 * properties so the app lists them as a track, the video shared anyone-with-the-link (what the singer
 * asked for: a link anyone can play, and every singer of a meet can show it). The token lives in the
 * job for its duration and is never written to a log or an answer.
 *
 * Only sv-control calls here (the secret), and it only forwards what a signed-in singer asked for.
 */
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, open as openFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const YTDLP = process.env.RELAY_YTDLP || 'yt-dlp';
/** Extra yt-dlp arguments for every call (RELAY_YTDLP_ARGS, space-separated): a proxy, an extractor argument — tuned without a code change. */
const YTDLP_ARGS = (process.env.RELAY_YTDLP_ARGS || '').split(/\s+/).filter(Boolean);
// RELAY_YTDLP_COOKIES: a browser's YouTube cookies (Netscape format, the text itself — `fly secrets set` takes it) for a
// machine YouTube keeps asking to sign in; written once where only this process reads it, never logged.
if (process.env.RELAY_YTDLP_COOKIES) {
  const cookieFile = path.join(tmpdir(), `sv-yt-cookies-${process.pid}.txt`);
  writeFileSync(cookieFile, process.env.RELAY_YTDLP_COOKIES, { mode: 0o600 });
  YTDLP_ARGS.push('--cookies', cookieFile);
}
const FFMPEG = process.env.RELAY_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RELAY_FFPROBE || 'ffprobe';
/** Tests point this at a stand-in for Google's API host. */
const GOOGLE_API = (process.env.RELAY_GOOGLE_API || 'https://www.googleapis.com').replace(/\/$/, '');
const MAX_JOBS = Number(process.env.RELAY_YT_JOBS || 2);
const MAX_QUEUE = Number(process.env.RELAY_YT_QUEUE || 8);
const SEARCH_LIMIT = 12;
const SEARCH_TIMEOUT_MS = Number(process.env.RELAY_YT_SEARCH_TIMEOUT_MS || 45_000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.RELAY_YT_DOWNLOAD_TIMEOUT_MS || 15 * 60_000);
const MAX_HEIGHT = 720;
const MAX_DURATION_S = 20 * 60;
const JOB_TTL_MS = 60 * 60_000;
const CHUNK = 8 * 1024 * 1024;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;

export const ytWatchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// ---------- yt-dlp itself ----------

let ytdlpVersion = null;
/** The first version read on the way (the relay answers about yt-dlp only once it knows). */
let versionRead = null;
/** yt-dlp's version (null until known or when it is not installed). */
export const ytdlpInfo = () => ytdlpVersion;
/** yt-dlp's version once the first read is in — a machine that just started answers its first ask right. */
export const ytdlpReady = () => versionRead ?? (versionRead = readVersion());

function readVersion() {
  return new Promise((resolve) => {
    execFile(YTDLP, ['--version'], { timeout: 20_000 }, (e, out) => {
      ytdlpVersion = e ? null : String(out).trim() || 'unknown';
      resolve(ytdlpVersion);
    });
  });
}

/**
 * YouTube changes under yt-dlp every few weeks; a stale yt-dlp downloads nothing. The relay asks it to
 * update itself when it starts (the standalone binary fetches its newest release) and once a day after.
 */
export function startYtdlp({ update = process.env.RELAY_YTDLP_UPDATE !== '0' } = {}) {
  versionRead = readVersion();
  const first = versionRead.then((v) => {
    if (v === null) console.warn(`[relay] yt-dlp not found (${YTDLP}) — YouTube song tracks are off`);
    else console.log(`[relay] yt-dlp ${v}`);
    return v;
  });
  if (!update) return first;
  const upgrade = () =>
    execFile(YTDLP, ['-U'], { timeout: 120_000 }, (e, out) => {
      const line = String(out || '').trim().split('\n').pop() || '';
      if (e) console.warn(`[relay] yt-dlp self-update: ${e.message.split('\n')[0]}`);
      else if (line) console.log(`[relay] yt-dlp: ${line}`);
      void readVersion();
    });
  setTimeout(upgrade, 2000).unref();
  setInterval(upgrade, 24 * 60 * 60_000).unref();
  return first;
}

/** Run a program to completion, collecting stdout/stderr (bounded), with a timeout; `onLine` sees each stdout line as it comes. */
function run(cmd, args, { timeoutMs, onLine, onErrLine } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    let rest = '';
    let restErr = '';
    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* gone */
          }
          errText += '\n[relay] timed out';
        }, timeoutMs)
      : null;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      if (out.length < 4_000_000) out += d;
      if (onLine) {
        rest += d;
        const lines = rest.split(/\r?\n|\r/);
        rest = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) onLine(l);
      }
    });
    proc.stderr.on('data', (d) => {
      if (errText.length < 200_000) errText += d;
      if (onErrLine) {
        restErr += d;
        const lines = restErr.split(/\r?\n|\r/);
        restErr = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) onErrLine(l);
      }
    });
    proc.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, out, err: `${errText}\n${e.message}` });
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && rest.trim()) onLine(rest);
      resolve({ code: code ?? -1, out, err: errText });
    });
  });
}

// ---------- search ----------

const searchCache = new Map();
const SEARCH_CACHE_MS = 10 * 60_000;

/** One search result from yt-dlp's flat JSON (a line per video). */
export function searchItem(j) {
  if (!j || typeof j !== 'object' || !VIDEO_ID.test(String(j.id ?? ''))) return null;
  const id = String(j.id);
  const duration = Number(j.duration);
  return {
    id,
    title: String(j.title ?? '').slice(0, 200),
    channel: String(j.channel ?? j.uploader ?? '').slice(0, 120),
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0,
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    views: Number.isFinite(Number(j.view_count)) ? Number(j.view_count) : null,
    url: ytWatchUrl(id),
  };
}

export async function search(q) {
  const query = String(q ?? '').trim().slice(0, 120);
  if (!query) return { items: [] };
  const hit = searchCache.get(query.toLowerCase());
  if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) return { items: hit.items };
  // A pasted YouTube link or id is that one video.
  const direct = query.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/)?.[1] ?? (VIDEO_ID.test(query) ? query : null);
  const target = direct ? ytWatchUrl(direct) : `ytsearch${SEARCH_LIMIT}:${query}`;
  const r = await run(YTDLP, [...YTDLP_ARGS, '--dump-json', '--flat-playlist', '--no-warnings', '--ignore-errors', '--no-playlist', '--', target], { timeoutMs: SEARCH_TIMEOUT_MS });
  const items = [];
  for (const line of r.out.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const it = searchItem(JSON.parse(line));
      if (it && !items.some((x) => x.id === it.id)) items.push(it);
    } catch {
      /* a partial line */
    }
  }
  if (!items.length && r.code !== 0) throw Object.assign(new Error(ytReason(r.err, 'YouTube search failed')), { status: 502 });
  searchCache.set(query.toLowerCase(), { at: Date.now(), items });
  if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);
  return { items };
}

/** yt-dlp's complaint in the singer's words. */
export function ytReason(stderr, fallback) {
  const s = String(stderr ?? '');
  if (/sign in to confirm|not a bot|cookies/i.test(s)) return 'YouTube asked the server to sign in — it blocks downloads from some servers for a while. Try again later, or another video.';
  if (/private video/i.test(s)) return 'This video is private on YouTube.';
  if (/members-only|join this channel/i.test(s)) return 'This video is for channel members only.';
  if (/age[- ]restricted|confirm your age/i.test(s)) return 'This video is age-restricted on YouTube and cannot be fetched.';
  if (/video unavailable|not available|has been removed|no longer available/i.test(s)) return 'YouTube says this video is unavailable.';
  if (/HTTP Error 429|rate.?limit/i.test(s)) return 'YouTube is rate-limiting the server — try again in a few minutes.';
  if (/does not pass filter/i.test(s)) return `This video is longer than ${MAX_DURATION_S / 60} minutes or a live stream — song tracks are songs.`;
  if (/is live|live event/i.test(s)) return 'This is a live stream, not a song.';
  if (/unsupported url/i.test(s)) return 'That is not a YouTube video.';
  if (/timed out/i.test(s)) return 'The download took too long and was stopped — try again, or a shorter video.';
  if (/not found|No such file|ENOENT/i.test(s) && /yt-dlp/i.test(s)) return 'yt-dlp is not installed on the relay.';
  const last = s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[download\]/.test(l))
    .pop();
  return last ? `${fallback}: ${last.replace(/^ERROR:\s*/i, '').slice(0, 200)}` : fallback;
}

// ---------- fetch jobs ----------

/** @type {Map<string, any>} */
const jobs = new Map();
const queue = [];
let running = 0;

const newJobId = () => `yt-${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

/** The job as the browser may see it (no token). */
export function publicJob(j) {
  const { token: _t, dir: _d, ...rest } = j;
  return rest;
}

export function getJob(id) {
  const j = jobs.get(id);
  return j ? publicJob(j) : null;
}

export function jobCount() {
  return jobs.size;
}

/** Jobs are kept an hour after they end; a job that is queued or running stays. */
export function sweepJobs(now = Date.now()) {
  for (const [id, j] of jobs) if ((j.state === 'done' || j.state === 'error') && now - (j.endedAt ?? now) > JOB_TTL_MS) jobs.delete(id);
}

/** Start (or queue) a fetch. Throws with `status` on a bad request or a full queue. */
export async function startFetch(body) {
  await ytdlpReady();
  const videoId = String(body?.videoId ?? '').trim();
  const trackId = String(body?.trackId ?? '').trim();
  const folderId = String(body?.folderId ?? '').trim();
  const token = String(body?.token ?? '').trim();
  const name = String(body?.name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  if (!VIDEO_ID.test(videoId)) throw Object.assign(new Error('videoId must be an 11-character YouTube id'), { status: 400 });
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(trackId)) throw Object.assign(new Error('trackId is required'), { status: 400 });
  if (!DRIVE_ID.test(folderId)) throw Object.assign(new Error('folderId must be a Drive folder id'), { status: 400 });
  if (!token) throw Object.assign(new Error('the Google token is required'), { status: 400 });
  if (ytdlpVersion === null) throw Object.assign(new Error('yt-dlp is not installed on the relay'), { status: 503 });
  // The same video into the same track asked for twice (a browser retrying): the one job.
  for (const j of jobs.values()) if (j.videoId === videoId && j.trackId === trackId && j.state !== 'done' && j.state !== 'error') return publicJob(j);
  if (queue.length >= MAX_QUEUE) throw Object.assign(new Error(`The relay already has ${MAX_QUEUE} downloads waiting — try again in a few minutes`), { status: 503 });
  const job = { jobId: newJobId(), state: 'queued', fraction: 0, note: running >= MAX_JOBS ? `waiting for ${running} download${running === 1 ? '' : 's'} ahead` : 'starting', videoId, trackId, startedAt: new Date().toISOString(), token, folderId, name: name || videoId, endedAt: null };
  jobs.set(job.jobId, job);
  queue.push(job);
  pump();
  return publicJob(job);
}

function pump() {
  while (running < MAX_JOBS && queue.length) {
    const job = queue.shift();
    running += 1;
    runJob(job).finally(() => {
      running -= 1;
      pump();
    });
  }
}

function setState(job, state, fraction, note) {
  job.state = state;
  job.fraction = Math.max(job.fraction, Math.min(1, fraction));
  job.note = note;
}

const mb = (n) => `${(n / 1_048_576).toFixed(n < 10 * 1_048_576 ? 1 : 0)} MB`;

async function runJob(job) {
  const log = (m) => console.log(`[relay] yt ${job.jobId} ${job.videoId}: ${m}`);
  try {
    job.dir = await mkdtemp(path.join(tmpdir(), 'sv-yt-'));
    // 1. the video from YouTube: H.264 + AAC in an mp4 when YouTube has it (every browser plays that), 720p at most.
    setState(job, 'downloading', 0.02, 'asking YouTube');
    log('download starts');
    const format = `bv*[height<=${MAX_HEIGHT}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<=${MAX_HEIGHT}][ext=mp4]/bv*[height<=${MAX_HEIGHT}]+ba/b`;
    const dl = await run(YTDLP, [...YTDLP_ARGS, '-f', format, '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings', '--newline', '--no-mtime', '--write-info-json', '--no-write-playlist-metafiles', '--match-filter', `duration<=${MAX_DURATION_S} & !is_live`, '-o', path.join(job.dir, 'video.%(ext)s'), '--', ytWatchUrl(job.videoId)], {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      onLine: (l) => {
        const m = l.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\s*\w+))?/);
        if (m) setState(job, 'downloading', 0.02 + (Number(m[1]) / 100) * 0.5, `downloading · ${Math.round(Number(m[1]))} %${m[2] ? ` of ${m[2].replace(/\s+/g, '')}` : ''}`);
        else if (/\[Merger\]/.test(l)) setState(job, 'downloading', 0.53, 'joining picture and sound');
      },
    });
    const file = path.join(job.dir, 'video.mp4');
    const have = await stat(file).catch(() => null);
    if (!have || !have.size) throw new Error(ytReason(`${dl.err}\n${dl.out}`, 'YouTube did not hand the video over'));
    let info = {};
    try {
      info = JSON.parse(await readFile(path.join(job.dir, 'video.info.json'), 'utf8'));
    } catch {
      /* the probe below has the rest */
    }
    // 2. what we got, and the sound taken out into its own file.
    setState(job, 'converting', 0.55, 'reading the file');
    const probe = await probeMedia(file);
    if (!probe.video) throw new Error('The file YouTube handed over has no picture');
    const title = String(info.title ?? job.name).slice(0, 200);
    const channel = String(info.channel ?? info.uploader ?? '').slice(0, 120);
    const durationMs = Math.round((Number(info.duration) || probe.durationS || 0) * 1000);
    const audioOut = path.join(job.dir, 'backing.m4a');
    setState(job, 'converting', 0.57, 'taking the sound out');
    if (!probe.audio) throw new Error('The video has no sound — a song track needs its music');
    const aArgs = probe.audio.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];
    const a = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vn', ...aArgs, '-movflags', '+faststart', audioOut], { timeoutMs: 10 * 60_000 });
    if (a.code !== 0) throw new Error(`The sound could not be taken out: ${a.err.trim().split('\n').pop() ?? 'ffmpeg failed'}`);
    // The picture: H.264 copied as is (made to start fast); anything else re-encoded so every browser plays it.
    const videoOut = path.join(job.dir, 'out.mp4');
    const copyVideo = probe.video.codec === 'h264';
    setState(job, 'converting', 0.6, copyVideo ? 'packing the video' : 're-encoding the picture for every browser (a few minutes)');
    const vArgs = copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', `scale=-2:'min(${MAX_HEIGHT},ih)'`];
    const v = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats', '-i', file, ...vArgs, ...aArgs, '-movflags', '+faststart', videoOut], {
      timeoutMs: 30 * 60_000,
      onLine: (l) => {
        const m = l.match(/^out_time_(?:ms|us)=(\d+)/);
        if (m && durationMs > 0) setState(job, 'converting', 0.6 + Math.min(1, Number(m[1]) / 1000 / durationMs) * 0.08, copyVideo ? 'packing the video' : `re-encoding the picture · ${Math.round(Math.min(1, Number(m[1]) / 1000 / durationMs) * 100)} %`);
      },
    });
    if (v.code !== 0) throw new Error(`The video could not be packed: ${v.err.trim().split('\n').pop() ?? 'ffmpeg failed'}`);
    const videoSize = (await stat(videoOut)).size;
    const audioSize = (await stat(audioOut)).size;
    // 3. into the singer's Drive, video first (shared anyone-with-the-link), then its sound.
    const props = (type) => ({ svType: type, svId: job.trackId, svTrackId: job.trackId, svYoutubeId: job.videoId });
    const video = await uploadResumable(job, { path: videoOut, size: videoSize, mime: 'video/mp4', name: `${job.name}.mp4`, parents: [job.folderId], appProperties: props('trackVideo'), description: `${title}${channel ? ` — ${channel}` : ''}\n${ytWatchUrl(job.videoId)}` }, 0.68, 0.92, 'uploading the video');
    setState(job, 'uploading', 0.93, 'sharing the video (anyone with the link)');
    await shareAnyone(job, video.id);
    const audio = await uploadResumable(job, { path: audioOut, size: audioSize, mime: 'audio/mp4', name: 'backing.m4a', parents: [job.folderId], appProperties: props('trackAudio') }, 0.94, 0.99, 'uploading the sound');
    job.result = { videoFileId: video.id, videoMime: 'video/mp4', audioFileId: audio.id, audioMime: 'audio/mp4', durationMs, width: probe.video.width, height: probe.video.height, title, channel, bytes: videoSize + audioSize, youtubeId: job.videoId, sourceUrl: ytWatchUrl(job.videoId) };
    setState(job, 'done', 1, `done · ${mb(videoSize)} video, ${mb(audioSize)} sound`);
    log(`done: ${probe.video.width}x${probe.video.height}, ${Math.round(durationMs / 1000)} s, ${mb(videoSize)} + ${mb(audioSize)}`);
  } catch (e) {
    job.state = 'error';
    job.error = e instanceof Error ? e.message : String(e);
    job.note = 'failed';
    log(`failed: ${job.error}`);
  } finally {
    job.endedAt = Date.now();
    delete job.token;
    if (job.dir) await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
    delete job.dir;
  }
}

/** ffprobe: the streams (codec, size) and the duration. */
async function probeMedia(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`The file could not be read: ${r.err.trim().split('\n').pop() ?? 'ffprobe failed'}`);
  const j = JSON.parse(r.out || '{}');
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  return {
    durationS: Number(j.format?.duration) || 0,
    video: v ? { codec: String(v.codec_name ?? ''), width: Number(v.width) || 0, height: Number(v.height) || 0 } : null,
    audio: a ? { codec: String(a.codec_name ?? '') } : null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function driveError(r) {
  const text = await r.text().catch(() => '');
  let msg = '';
  try {
    msg = JSON.parse(text)?.error?.message ?? '';
  } catch {
    /* not JSON */
  }
  if (r.status === 401) return 'the Google sign-in expired before the upload — sign in again and retry';
  if (r.status === 403 && /storage|quota/i.test(msg)) return 'the Drive is full';
  if (r.status === 404) return 'the Drive folder for this track was not found';
  return `Drive answered ${r.status}${msg ? ` (${msg.slice(0, 160)})` : ''}`;
}

/** A resumable Drive upload from a file on disk, in 8 MiB pieces, resumed on a network error; the job's note follows it. */
async function uploadResumable(job, f, from, to, label) {
  setState(job, 'uploading', from, `${label} · ${mb(f.size)}`);
  const meta = { name: f.name, parents: f.parents, mimeType: f.mime, appProperties: f.appProperties, ...(f.description ? { description: f.description } : {}) };
  const start = await fetch(`${GOOGLE_API}/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,mimeType,md5Checksum`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${job.token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': f.mime, 'X-Upload-Content-Length': String(f.size) },
    body: JSON.stringify(meta),
  });
  if (!start.ok) throw new Error(`The upload could not start: ${await driveError(start)}`);
  const session = start.headers.get('location');
  if (!session) throw new Error('Drive did not open an upload session');
  let offset = 0;
  let failures = 0;
  const fh = await openFile(f.path, 'r');
  try {
    while (offset < f.size) {
      const end = Math.min(f.size, offset + CHUNK);
      // One piece in memory at a time (8 MiB): Drive wants each piece's length up front.
      const piece = Buffer.alloc(end - offset);
      await fh.read(piece, 0, piece.length, offset);
      let r;
      try {
        r = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${f.size}`, 'Content-Type': f.mime }, body: piece });
      } catch (e) {
        if (++failures > 6) throw new Error(`The upload failed after repeated network errors (${e instanceof Error ? e.message : String(e)})`);
        await sleep(1000 * 2 ** failures);
        offset = await resumeOffset(session, f.size);
        continue;
      }
      if (r.status === 308) {
        const range = r.headers.get('range');
        offset = range ? Number(range.split('-')[1]) + 1 : end;
        failures = 0;
      } else if (r.ok) {
        const file = await r.json();
        if (Number(file.size ?? f.size) !== f.size) throw new Error(`Drive kept ${file.size} of ${f.size} bytes — retry`);
        setState(job, 'uploading', to, `${label} · done`);
        return file;
      } else if (r.status >= 500 || r.status === 429) {
        if (++failures > 6) throw new Error(`The upload failed: ${await driveError(r)}`);
        await sleep(1000 * 2 ** failures);
        offset = await resumeOffset(session, f.size);
        continue;
      } else {
        throw new Error(`The upload failed: ${await driveError(r)}`);
      }
      setState(job, 'uploading', from + (offset / f.size) * (to - from), `${label} · ${mb(offset)} of ${mb(f.size)}`);
    }
  } finally {
    await fh.close().catch(() => undefined);
  }
  throw new Error('The upload ended without Drive confirming the file');
}

async function resumeOffset(session, total) {
  try {
    const r = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' } });
    if (r.status === 308) {
      const range = r.headers.get('range');
      return range ? Number(range.split('-')[1]) + 1 : 0;
    }
    if (r.ok) return total;
  } catch {
    /* start over */
  }
  return 0;
}

/** The video for anyone with the link (a reader): what the singer asked for, and how every singer of a meet gets to show it. */
async function shareAnyone(job, fileId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${GOOGLE_API}/drive/v3/files/${fileId}/permissions?fields=id`, { method: 'POST', headers: { Authorization: `Bearer ${job.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) }).catch(() => null);
    if (r?.ok) return;
    if (r && r.status < 500 && r.status !== 429) throw new Error(`The video could not be shared: ${await driveError(r)}`);
    await sleep(800 * 2 ** attempt);
  }
  throw new Error('The video could not be shared: Drive did not answer');
}

/** Tests: forget every job. */
export function resetJobs() {
  jobs.clear();
  queue.length = 0;
}
