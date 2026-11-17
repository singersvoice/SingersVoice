import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Stand-ins: yt-dlp (answers a search, "downloads" a fixture, complains like the real one), ffprobe (one
// H.264 + AAC file), ffmpeg (copies its input to its output) — and Google's API (a resumable upload that
// keeps the bytes, and the permission call). The relay's job runs against these end to end.
const dir = mkdtempSync(path.join(tmpdir(), 'sv-yt-test-'));
const fixture = path.join(dir, 'fixture.mp4');
const fixtureBytes = randomBytes(20 * 1024 * 1024 + 12_345); // three resumable pieces, the last one short
writeFileSync(fixture, fixtureBytes);

const ytdlp = path.join(dir, 'yt-dlp');
writeFileSync(
  ytdlp,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2025.11.12"; exit 0; fi
if [ "$1" = "-U" ]; then echo "yt-dlp is up to date (2025.11.12)"; exit 0; fi
case "$*" in
  *--dump-json*)
    case "$*" in
      *nothing*) exit 0 ;;
      *fail*) echo "ERROR: [youtube] Sign in to confirm you’re not a bot. Use --cookies" >&2; exit 1 ;;
    esac
    echo '{"id":"dQw4w9WgXcQ","title":"Never Gonna Give You Up (Karaoke Version)","channel":"Sing King","duration":213,"view_count":1234567}'
    echo '{"id":"abcdefghijk","title":"Another Song","uploader":"KaraFun","duration":180.4}'
    echo 'not json'
    exit 0 ;;
esac
# a download: -o <dir>/video.%(ext)s
out=""; prev=""
for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
d=$(dirname "$out")
case "$*" in *privvvvvvvv*) echo "ERROR: [youtube] privvvvvvvv: Private video. Sign in if you've been granted access to this video" >&2; exit 1 ;; esac
echo "[download]  12.5% of   20.00MiB at    2.10MiB/s ETA 00:12"
echo "[download] 100% of   20.00MiB in 00:08"
echo "[Merger] Merging formats into \\"$d/video.mp4\\""
cp "\${STUB_VIDEO}" "$d/video.mp4"
printf '%s' '{"title":"Never Gonna Give You Up (Karaoke Version)","channel":"Sing King","duration":213.4,"width":1280,"height":720}' > "$d/video.info.json"
exit 0
`,
);
const ffprobe = path.join(dir, 'ffprobe');
writeFileSync(ffprobe, `#!/bin/sh\necho '{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"213.400000"}}'\n`);
const ffmpeg = path.join(dir, 'ffmpeg');
writeFileSync(
  ffmpeg,
  `#!/bin/sh
if [ "$1" = "-version" ]; then echo "ffmpeg version stub"; exit 0; fi
in=""; prev=""; last=""
for a in "$@"; do if [ "$prev" = "-i" ]; then in="$a"; fi; prev="$a"; last="$a"; done
cp "$in" "$last"
`,
);
for (const f of [ytdlp, ffprobe, ffmpeg]) chmodSync(f, 0o755);

// Google's API, as far as the job uses it.
const uploads = new Map(); // session id → { meta, bytes, mime, total }
const permissions = [];
const google = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://g');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const auth = req.headers.authorization;
    if (auth !== 'Bearer tok-123' && !url.pathname.startsWith('/upload/session/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid Credentials' } }));
    }
    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const id = `s${uploads.size + 1}`;
      uploads.set(id, { meta: JSON.parse(body.toString('utf8')), bytes: Buffer.alloc(0), mime: req.headers['x-upload-content-type'], total: Number(req.headers['x-upload-content-length']) });
      res.writeHead(200, { Location: `http://127.0.0.1:${google.address().port}/upload/session/${id}` });
      return res.end();
    }
    const up = url.pathname.match(/^\/upload\/session\/(s\d+)$/);
    if (req.method === 'PUT' && up) {
      const u = uploads.get(up[1]);
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] ?? '');
      assert.ok(m, 'every piece carries its range');
      assert.equal(Number(m[1]), u.bytes.length, 'pieces arrive in order');
      assert.equal(body.length, Number(m[2]) - Number(m[1]) + 1, 'the piece is as long as its range says');
      u.bytes = Buffer.concat([u.bytes, body]);
      if (u.bytes.length < u.total) {
        res.writeHead(308, { Range: `bytes=0-${u.bytes.length - 1}` });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: `file-${up[1]}`, name: u.meta.name, size: String(u.bytes.length), mimeType: u.mime }));
    }
    const perm = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
    if (req.method === 'POST' && perm) {
      permissions.push({ fileId: perm[1], ...JSON.parse(body.toString('utf8')) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'anyoneWithLink' }));
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));

process.env.RELAY_SECRET = 'test-secret';
process.env.RELAY_YTDLP = ytdlp;
process.env.RELAY_FFMPEG = ffmpeg;
process.env.RELAY_FFPROBE = ffprobe;
process.env.RELAY_GOOGLE_API = `http://127.0.0.1:${google.address().port}`;
process.env.STUB_VIDEO = fixture;
const { handle } = await import('../src/server.mjs');
const { startYtdlp, searchItem, ytReason, resetJobs } = await import('../src/yt.mjs');
await startYtdlp({ update: false });

const server = http.createServer(handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (method, p, body) => fetch(`${base}${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: 'Bearer test-secret', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('search: yt-dlp\'s flat JSON becomes a list (id, title, channel, duration, a thumbnail); a link is that one video; refusals in words', async () => {
  const it = searchItem({ id: 'dQw4w9WgXcQ', title: 'T', uploader: 'U', duration: 213, view_count: 5 });
  assert.deepEqual(it, { id: 'dQw4w9WgXcQ', title: 'T', channel: 'U', durationMs: 213000, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', views: 5, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.equal(searchItem({ id: 'not-an-id' }), null);
  assert.equal((await fetch(`${base}/yt/search?q=x`)).status, 401, 'the secret is needed');
  const r = await (await call('GET', '/yt/search?q=never%20gonna%20karaoke')).json();
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].title, 'Never Gonna Give You Up (Karaoke Version)');
  assert.equal(r.items[1].channel, 'KaraFun');
  assert.equal(r.items[1].durationMs, 180400);
  const none = await (await call('GET', '/yt/search?q=nothing%20here')).json();
  assert.deepEqual(none.items, []);
  const failed = await call('GET', '/yt/search?q=please%20fail');
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /asked the server to sign in/);
  assert.match(ytReason('ERROR: [youtube] x: Private video.'), /private/);
  assert.match(ytReason('ERROR: HTTP Error 429: Too Many Requests'), /rate-limiting/);
  assert.match(ytReason('x does not pass filter (duration<=1200 & !is_live), skipping'), /longer than 20 minutes/);
  assert.equal(ytReason('ERROR: something odd happened', 'YouTube did not hand the video over'), 'YouTube did not hand the video over: something odd happened');
  const status = await (await call('GET', '/yt')).json();
  assert.deepEqual(status, { available: true, ytdlp: '2025.11.12', note: '' });
});

test('a fetch job: refused when malformed; downloaded, the sound taken out, both files uploaded in pieces into the folder with the app\'s properties, the video shared; the token never shown', async () => {
  resetJobs();
  assert.equal((await call('POST', '/yt/fetch', { videoId: 'short', trackId: 't1', folderId: 'folder-1234567890', name: 'x', token: 'tok-123' })).status, 400);
  assert.equal((await call('POST', '/yt/fetch', { videoId: 'dQw4w9WgXcQ', trackId: 't1', folderId: 'folder-1234567890', name: 'x' })).status, 400, 'the token is required');
  const started = await call('POST', '/yt/fetch', { videoId: 'dQw4w9WgXcQ', trackId: 'trk-1', folderId: 'folder-1234567890', name: 'Never Gonna Give You Up / Karaoke: "Sing King"', token: 'tok-123' });
  assert.equal(started.status, 202);
  const { job } = await started.json();
  assert.equal(job.state === 'queued' || job.state === 'downloading', true);
  assert.equal('token' in job, false, 'the token is not in the answer');
  assert.equal(job.videoId, 'dQw4w9WgXcQ');
  // The same ask again while it runs is the same job.
  const again = await (await call('POST', '/yt/fetch', { videoId: 'dQw4w9WgXcQ', trackId: 'trk-1', folderId: 'folder-1234567890', name: 'x', token: 'tok-123' })).json();
  assert.equal(again.job.jobId, job.jobId);
  let j = job;
  const notes = new Set();
  for (let i = 0; i < 400 && j.state !== 'done' && j.state !== 'error'; i++) {
    await sleep(50);
    j = (await (await call('GET', `/yt/jobs/${job.jobId}`)).json()).job;
    notes.add(j.state);
  }
  assert.equal(j.state, 'done', j.error);
  assert.ok(notes.has('uploading'), `the job was seen uploading (${[...notes].join(', ')})`);
  assert.equal(j.fraction, 1);
  assert.equal('token' in j, false);
  assert.equal(j.result.title, 'Never Gonna Give You Up (Karaoke Version)');
  assert.equal(j.result.channel, 'Sing King');
  assert.equal(j.result.durationMs, 213400);
  assert.equal(j.result.width, 1280);
  assert.equal(j.result.youtubeId, 'dQw4w9WgXcQ');
  assert.equal(j.result.sourceUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  // What Drive got.
  const files = [...uploads.values()];
  assert.equal(files.length, 2);
  const video = files.find((u) => u.meta.mimeType === 'video/mp4');
  const audio = files.find((u) => u.meta.mimeType === 'audio/mp4');
  assert.equal(video.meta.name, 'Never Gonna Give You Up Karaoke Sing King.mp4', 'the name the singer gave, made safe for a file');
  assert.deepEqual(video.meta.parents, ['folder-1234567890']);
  assert.deepEqual(video.meta.appProperties, { svType: 'trackVideo', svId: 'trk-1', svTrackId: 'trk-1', svYoutubeId: 'dQw4w9WgXcQ' });
  assert.match(video.meta.description, /Sing King/);
  assert.equal(video.bytes.equals(fixtureBytes), true, 'the video reached Drive whole, in order');
  assert.equal(audio.meta.name, 'backing.m4a');
  assert.deepEqual(audio.meta.appProperties, { svType: 'trackAudio', svId: 'trk-1', svTrackId: 'trk-1', svYoutubeId: 'dQw4w9WgXcQ' });
  assert.equal(audio.bytes.equals(fixtureBytes), true);
  assert.equal(j.result.videoFileId, `file-${[...uploads.keys()][0]}`);
  assert.deepEqual(permissions, [{ fileId: j.result.videoFileId, role: 'reader', type: 'anyone' }], 'the video, and only the video, is shared anyone-with-the-link');
  assert.equal(j.result.bytes, fixtureBytes.length * 2);
  assert.equal((await call('GET', '/yt/jobs/nope')).status, 404);
});

test('a video YouTube will not hand over ends the job with the reason in words', async () => {
  const { job } = await (await call('POST', '/yt/fetch', { videoId: 'privvvvvvvv', trackId: 'trk-2', folderId: 'folder-1234567890', name: 'p', token: 'tok-123' })).json();
  let j = job;
  for (let i = 0; i < 200 && j.state !== 'done' && j.state !== 'error'; i++) {
    await sleep(50);
    j = (await (await call('GET', `/yt/jobs/${job.jobId}`)).json()).job;
  }
  assert.equal(j.state, 'error');
  assert.equal(j.error, 'This video is private on YouTube.');
  assert.equal('token' in j, false);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ytdlp, '2025.11.12');
  server.close();
  google.close();
});
