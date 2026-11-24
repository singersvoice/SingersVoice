// Joining e2e: a solo take sung in the Studio, opened for others; a second singer joins it from the link (their
// voice and picture beside the first's, the show so far as their backing), a third joins the second's — in the
// browser, the built app against the real sv-control, Google Drive faked per singer (as tracks-e2e.mjs), fake
// cameras with a synthetic person (fake-person.mjs: the real segmentation model cuts them out), a fake microphone.
//
//   1. alice imports a song and sings it in the Studio with her camera on: the take lands in her Drive as the
//      show AND her cut-out video beside it (both found again from the show's properties); Keep moves both.
//   2. "Invite others to join": the take is shared anyone-with-the-link (both files), the song is in the track
//      database, the invite is on record with one layer (alice, her cut-out) — and the link is the app's own page.
//   3. bob — a free account (voice only in live meets) — opens the link: the show and alice's cut-out come through
//      the service, the song from the track database; his stage says "joining alice · you are singer 2" with two
//      performers, alice's picture on it before a note is sung; tempo and key are fixed. He sings with his camera
//      on (the camera is every Studio singer's: a plan gates live meets alone), finishes, keeps: his take says
//      "with alice", its manifest remembers what it joined and both singers, his saved show has two cut-outs on it.
//   4. bob opens his for joining: alice's invite counts one join; her Performances page lists "Joined yours" with
//      bob's (Watch, Join too) and marks her take "open to join · 1 joined".
//   5. carol joins bob's: three on stage, in slot order; her saved show has three cut-outs.
//   6. alice closes hers: the link no longer opens it.
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/join-e2e.mjs [outDir]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeSong } from './e2e-song.mjs';
import { freePort, startServers } from './servers.mjs';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/npm-tools/node_modules/playwright');
}
const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const work = path.join(tmpdir(), `sv-join-e2e-${process.pid}`);
mkdirSync(work, { recursive: true });

// ---- Google Drive, faked per singer (the unit tests' FakeDrive, bundled for Node) — as tracks-e2e.mjs ----
execFileSync(path.resolve('node_modules/.bin/esbuild'), ['test/helpers/fakeDrive.ts', '--bundle', '--format=esm', '--platform=node', '--log-level=warning', `--outfile=${work}/fakeDrive.mjs`], { cwd: path.resolve('apps/web'), stdio: 'inherit' });
const { FakeDrive } = await import(`${work}/fakeDrive.mjs`);
const drives = new Map();
const driveOf = (name) => {
  if (!drives.has(name)) drives.set(name, new FakeDrive());
  return drives.get(name);
};
const findFile = (id) => {
  for (const [name, d] of drives) {
    const f = d.files.get(id);
    if (f) return { name, d, f };
  }
  return null;
};
const sharedPublicly = (d, f) => {
  const seen = new Set();
  const walk = (x) => {
    if (!x || seen.has(x.id)) return false;
    seen.add(x.id);
    if (x.permissions.some((p) => p.type === 'anyone')) return true;
    return x.parents.some((pid) => walk(d.files.get(pid)));
  };
  return walk(f);
};
const parseMultipart = (buf, contentType) => {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
  const form = new FormData();
  if (!boundary) return form;
  const sep = Buffer.from(`--${boundary}`);
  let at = buf.indexOf(sep);
  while (at !== -1) {
    const next = buf.indexOf(sep, at + sep.length);
    if (next === -1) break;
    const part = buf.subarray(at + sep.length, next);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = part.subarray(0, headEnd).toString();
      const body = part.subarray(headEnd + 4, part.length - 2);
      const name = /name="([^"]+)"/.exec(head)?.[1] ?? 'file';
      const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? 'application/octet-stream';
      form.append(name, new Blob([body], { type }), name);
    }
    at = next;
  }
  return form;
};
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
const googlePort = await freePort();
const googleBase = `http://127.0.0.1:${googlePort}`;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'Location, Range, Content-Type' };
const google = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, body) => {
    res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const bearer = /^Bearer tok-(\w+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (bearer && (url.pathname.startsWith('/drive/') || url.pathname.startsWith('/upload/'))) {
    const d = driveOf(bearer);
    const raw = await readBody(req);
    const type = req.headers['content-type'] ?? '';
    const body = !raw.length ? undefined : type.startsWith('multipart/') ? parseMultipart(raw, type) : url.pathname.startsWith('/upload/') || !type.includes('json') ? new Blob([raw], { type: type || 'application/octet-stream' }) : raw.toString();
    try {
      const r = await d.fetch(`https://www.googleapis.com${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
      const headers = { ...CORS };
      r.headers.forEach((v, k) => (headers[k] = k === 'location' ? v.replace('https://www.googleapis.com', googleBase) : v));
      res.writeHead(r.status, headers);
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      console.log(`fake Drive (${bearer}) ${req.method} ${url.pathname}: ${e}`);
      return json(500, { error: { message: String(e) } });
    }
  }
  if (url.pathname === '/tokeninfo') {
    const m = /^tok-(\w+)$/.exec(url.searchParams.get('access_token') ?? '');
    return m ? json(200, { sub: m[1], email: `${m[1]}@dev.local`, expires_in: '3600', aud: 'e2e-client' }) : json(400, { error: 'invalid_token' });
  }
  if (url.pathname === '/oauth2/v3/userinfo') {
    const m = /^Bearer tok-(\w+)$/.exec(req.headers.authorization ?? '');
    return m ? json(200, { name: m[1], picture: '' }) : json(401, { error: 'unauthorized' });
  }
  const media = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)?.[1] ?? (url.pathname === '/download' || url.pathname === '/uc' ? url.searchParams.get('id') : null);
  if (media) {
    const hit = findFile(media);
    if (!hit || !sharedPublicly(hit.d, hit.f)) {
      res.writeHead(hit ? 403 : 404, { 'content-type': 'text/html' });
      return res.end('<html>Sorry, you cannot view or download this file at this time.</html>');
    }
    res.writeHead(200, { 'content-type': hit.f.mimeType, 'content-length': String(hit.f.bytes?.length ?? 0) });
    return res.end(hit.f.bytes ? Buffer.from(hit.f.bytes) : undefined);
  }
  json(404, { error: `unhandled ${url.pathname}` });
});
await new Promise((r) => google.listen(googlePort, '127.0.0.1', r));
process.env.SV_FAKE_DRIVE_URL = googleBase;

const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/' });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
const asUser = async (who, method, route, body) => {
  const r = await fetch(`${servers.controlUrl}${route}`, { method, headers: { Authorization: `Bearer tok-${who}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

// ---- The song (24 s: a take ends on its own), the fake camera (a synthetic person) and the fake microphone (a voice) ----
const SONG_S = 24;
const song = makeSong(path.join(work, 'song.mp3'), SONG_S);
const trackJson = path.join(work, 'song.track.json');
{
  const t = JSON.parse(readFileSync('apps/web/test/fixtures/sample.track.json', 'utf8'));
  t.durationMs = SONG_S * 1000;
  t.title = 'CI Join Song';
  writeFileSync(trackJson, JSON.stringify(t));
}
const clip = path.join(work, 'fake-person.y4m');
execFileSync('node', [new URL('./fake-person.mjs', import.meta.url).pathname, clip], { stdio: 'inherit' });
const voice = path.join(work, 'fake-voice.wav');
const vib = (h) => `sin(2*PI*${h * 180}*t+${((h * 0.012 * 180) / 5.5).toFixed(4)}*sin(2*PI*5.5*t))`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='0.25*(0.55+0.45*sin(2*PI*0.7*t))*(${vib(1)}+0.5*${vib(2)}+0.33*${vib(3)}+0.25*${vib(4)}+0.2*${vib(5)})':s=48000:d=30`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', voice]);

const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, `--use-file-for-fake-audio-capture=${voice}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = {};
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone', 'camera'], deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60000);
  errors[name] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors[name].push(m.text()));
  page.on('dialog', (d) => void d.accept()); // the app's confirms (Close to joining)
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) console.log(`[${name}] HTTP ${r.status()} ${r.request().method()} ${r.url().replace(servers.controlUrl, '')}`); });
  await page.goto(base + '?' + control, { waitUntil: 'networkidle' });
  await page.evaluate(([n, g]) => {
    localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: `${n}@dev.local`, picture: '', mode: 'drive' }));
    localStorage.setItem('sv.mode', 'drive');
    localStorage.setItem('sv.google.token', JSON.stringify({ accessToken: `tok-${n}`, expiresAt: Date.now() + 3600_000, scope: 'https://www.googleapis.com/auth/drive.file' }));
    // socialOffer off: the clip sheet (its own e2e) would sit over the review's Invite button.
    localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true, countIn: false, cameraOn: true, socialOffer: false }));
    localStorage.setItem('sv.googleApiBase', g);
  }, [name, googleBase]);
  await page.goto(base + 'home?' + control, { waitUntil: 'networkidle' });
  return { ctx, page, name };
}

/** Import the song (its track.json + the audio) through the Tracks portal's Import sheet. */
async function importSong(p) {
  await p.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await p.page.getByRole('button', { name: 'Import' }).first().click();
  const sheet = p.page.locator('.sheet');
  await sheet.waitFor();
  await sheet.locator('input[type=file][accept*=".json"]').setInputFiles(trackJson);
  await sheet.locator('input[type=file][accept*="audio"]').setInputFiles(song);
  await sheet.getByRole('button', { name: 'Import' }).click();
  await p.page.getByText(/^Imported/).waitFor({ timeout: 60000 });
  await p.page.locator('.sheet').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
}

/** The stage as the singer sees it: the compositor's performers and where their pixels are (left / right halves). */
const stageInfo = (page) =>
  page.evaluate(async () => {
    const bar = document.querySelector('.stagebar');
    const c = document.querySelector('canvas.stagecanvas');
    const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let left = 0, right = 0, headLeft = 0, headRight = 0;
    const w = c.width;
    for (let i = 0, px = 0; i + 3 < d.length; i += 4, px++) {
      if (d[i + 3] > 40) { if (px % w < w / 2) left++; else right++; }
      // the fake person's skin-tone head (fake-person.mjs: 8d 55 24, lifted by up to half again at the source — enhance.ts): a real picture of them, not a placeholder; the head is above the riser whatever the framing
      if (d[i + 3] > 200 && d[i] > 110 && d[i] < 240 && d[i + 1] > 60 && d[i + 1] < 150 && d[i + 2] > 10 && d[i + 2] < 85 && d[i] > d[i + 1] + 30 && d[i + 1] > d[i + 2] + 20) { if (px % w < w / 2) headLeft++; else headRight++; }
    }
    return { performers: bar.dataset.performers, blend: bar.dataset.blend, left, right, headLeft, headRight, w, h: c.height, text: bar.innerText.replace(/\s+/g, ' ') };
  });
/** The stage once every singer's picture (their head) is on it — the earlier singers' cut-outs decoded, this singer's first cut-out drawn — or as it stands after 20 s. */
const stageWithPictures = async (page, performers) => {
  let info = null;
  for (let i = 0; i < 40; i++) {
    info = await stageInfo(page);
    if (info.performers === String(performers) && info.headLeft > 200 && info.headRight > 200) return info;
    await wait(500);
  }
  return info;
};
/** Wait until the segmentation model cuts the singer out (the cut-out beside the show needs it). */
const waitForModel = async (page) => {
  for (let i = 0; i < 120; i++) {
    const b = await page.locator('.stagebar').getAttribute('data-blend').catch(() => null);
    if (b === 'model') return true;
    await wait(500);
  }
  return false;
};
/** Sing the song that is open on the page through to its end; returns the Review page's saved id (Temp). */
async function singThrough(p, during) {
  await p.page.getByRole('button', { name: 'Start singing' }).click();
  await p.page.locator('button', { hasText: 'Finish' }).waitFor({ timeout: 30000 });
  if (during) {
    await wait(4000); // the show is up and laid out
    p.rowSeen = await during();
  }
  await p.page.locator('[data-review]').waitFor({ timeout: (SONG_S + 40) * 1000 });
  for (let i = 0; i < 120; i++) {
    const id = await p.page.locator('[data-review]').getAttribute('data-saved-id');
    if (id) return id;
    await wait(500);
  }
  throw new Error(`${p.name}'s take never saved`);
}
const keep = async (p) => {
  await p.page.getByRole('button', { name: 'Keep', exact: true }).click();
  await p.page.locator('[data-review][data-saved-state="kept"]').waitFor({ timeout: 60000 });
};
const invite = async (p) => {
  await p.page.locator('[data-invite-open]').click();
  const link = p.page.locator('[data-join-link]');
  await link.waitFor({ timeout: 60000 });
  return link.inputValue();
};
/** The files of a performance in a singer's fake Drive: the show (its manifest in the description) and the cut-out. */
const perfFiles = (who, performanceId) => {
  const d = driveOf(who);
  const all = [...d.files.values()];
  const show = all.find((f) => f.appProperties?.svType === 'performance' && f.appProperties?.svPerfId === performanceId) ?? null;
  const cutout = all.find((f) => f.appProperties?.svType === 'performanceCutout' && f.appProperties?.svPerfId === performanceId) ?? null;
  let manifest = null;
  try {
    manifest = show?.description ? JSON.parse(show.description) : null;
  } catch {
    manifest = null;
  }
  return { show, cutout, manifest, d };
};
/** How many singers a frame of a saved show carries: the fake person's brown head, once per cut-out (always above the riser, whatever the seat's framing), clustered by where it is. */
const singersInFrame = (file, atS) => {
  const W = 640, H = 360;
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, atS)), '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 25 });
  const xs = [];
  for (let i = 0, px = 0; i + 2 < rgb.length && px < W * H; i += 3, px++) {
    const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
    if (r > 110 && r < 240 && g > 60 && g < 150 && b > 10 && b < 85 && r > g + 30 && g > b + 20) xs.push(px % W);
  }
  xs.sort((a, b) => a - b);
  const clusters = [];
  for (const x of xs) {
    const c = clusters[clusters.length - 1];
    if (c && x - c.max <= 24) {
      c.max = x;
      c.n++;
    } else clusters.push({ min: x, max: x, n: 1 });
  }
  const real = clusters.filter((c) => c.n >= 150);
  return { singers: real.length, at: real.map((c) => Math.round((c.min + c.max) / 2)), pixels: xs.length, w: W };
};
const saveShow = (who, performanceId, name) => {
  const { show, cutout } = perfFiles(who, performanceId);
  if (!show?.bytes) return null;
  const file = `${out}/${name}.${/mp4/.test(show.mimeType) ? 'mp4' : 'webm'}`;
  writeFileSync(file, Buffer.from(show.bytes));
  if (cutout?.bytes) writeFileSync(`${out}/${name}-cutout.${/mp4/.test(cutout.mimeType) ? 'mp4' : 'webm'}`, Buffer.from(cutout.bytes));
  return file;
};
const loudness = (file) => {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(`${r.stdout}${r.stderr}`)?.[1] ?? NaN);
};
const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());

const alice = await person('alice');
const bob = await person('bob');
const carol = await person('carol');
try {
  // ---- 1. alice sings in the Studio: the show and her cut-out beside it ----
  await importSong(alice);
  await alice.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await alice.page.getByRole('radio', { name: 'All' }).click();
  await alice.page.locator('[data-all-query]').fill('ci join');
  const mineRow = alice.page.locator('[data-all-mine] [data-my-track]').first();
  await mineRow.waitFor();
  await mineRow.getByRole('link', { name: 'Sing' }).click();
  await alice.page.waitForURL(/\/studio\/sing\//);
  await alice.page.locator('.sing').waitFor();
  check(await waitForModel(alice.page), "alice's camera is on in the Studio and the model cuts her out");
  const aliceStage = await stageInfo(alice.page);
  check(aliceStage.performers === '1' && aliceStage.left + aliceStage.right > 500, `alone on her stage (${aliceStage.performers} performer, ${aliceStage.left + aliceStage.right} px of her)`);
  const aliceId = await singThrough(alice);
  check(/^perf-/.test(aliceId), `alice sang the song through; the take saved itself to Temp (${aliceId})`);
  await alice.page.screenshot({ path: `${out}/alice-review.png` });
  let a = perfFiles('alice', aliceId);
  check(Boolean(a.show) && Boolean(a.cutout), `her Drive holds the show (${a.show?.bytes?.length ?? 0} bytes) and her cut-out beside it (${a.cutout?.bytes?.length ?? 0} bytes), both found from the take's id`);
  check(a.show?.appProperties?.svCutoutId === a.cutout?.id && a.show?.appProperties?.svCutoutMime === a.cutout?.mimeType, `the show's own properties name the cut-out (${a.show?.appProperties?.svCutoutId})`);
  check(a.manifest?.files?.some((f) => f.name.startsWith('cutout.')) && typeof a.manifest?.timeline?.cutoutOffsetMs === 'number' && typeof a.manifest?.timeline?.videoOffsetMs === 'number', `the manifest lists the cut-out and where its frame 0 falls (cut-out ${a.manifest?.timeline?.cutoutOffsetMs} ms, show ${a.manifest?.timeline?.videoOffsetMs} ms)`);
  check(a.cutout?.parents?.[0] === a.show?.parents?.[0], 'the cut-out sits in the same folder as the show (Temp)');
  await keep(alice);
  a = perfFiles('alice', aliceId);
  check(a.show?.appProperties?.svState === 'kept' && a.cutout?.parents?.[0] === a.show?.parents?.[0], 'Keep moved the show and the cut-out together');
  const aliceShow = saveShow('alice', aliceId, 'show-alice');
  const aliceFrame = aliceShow ? singersInFrame(aliceShow, 8) : { singers: 0 };
  check(aliceFrame.singers === 1, `her saved show has one singer on it (${aliceFrame.singers}, badge at x ${aliceFrame.at?.join(',')})`);

  // ---- 2. Invite others to join ----
  const aliceLink = await invite(alice);
  check(new RegExp(`/studio/join/${aliceId}$`).test(aliceLink), `the join link is the app's own page for the take (${aliceLink})`);
  a = perfFiles('alice', aliceId);
  check(sharedPublicly(a.d, a.show) && sharedPublicly(a.d, a.cutout), 'both files are shared anyone-with-the-link');
  const aliceInv = (await asUser('bob', 'GET', `/performances/${aliceId}/invite`)).json?.invite;
  check(aliceInv?.ownerName === 'alice' && aliceInv?.layers?.length === 1 && aliceInv.layers[0].slot === 1 && aliceInv.layers[0].displayName === 'alice', `the invite is on record: alice, one layer (${JSON.stringify(aliceInv?.layers?.map((l) => [l.slot, l.displayName, l.atShowMs]))})`);
  check(aliceInv?.show?.driveId === a.show?.id && aliceInv?.layers?.[0]?.cutout?.driveId === a.cutout?.id, "it names the show's file and the cut-out's");
  check(/^[A-Za-z0-9]{12}$/.test(aliceInv?.registryId ?? ''), `the song is in the track database (${aliceInv?.registryId})`);
  check(aliceInv?.joins === 0 && aliceInv?.joinedFrom === null && aliceInv?.tempo === 1, 'nobody joined yet; a first take; sung at 1×');
  check(Math.abs((aliceInv?.durationMs ?? 0) - SONG_S * 1000) < 2500 && Math.abs((a.manifest?.durationMs ?? 0) - SONG_S * 1000) < 2500, `a take that plays to the end has the song's length (${aliceInv?.durationMs} ms), not 0:00`);
  const bobMe = (await asUser('bob', 'GET', '/me')).json;
  check(bobMe?.user?.entitlement?.plan === 'free' && bobMe?.user?.media === 'audio', `bob is a free account: in a live meet he would sing with the voice alone (${bobMe?.user?.entitlement?.plan} / ${bobMe?.user?.media})`);

  // ---- 3. bob joins from the link: the landing (watch it first), then the stage ----
  await bob.page.goto(`${aliceLink}?${control}`, { waitUntil: 'networkidle' });
  const landing = bob.page.locator(`[data-join-landing="${aliceId}"]`);
  await landing.waitFor({ timeout: 30000 });
  const landingText = (await landing.innerText()).replace(/\s+/g, ' ');
  check(/CI Join Song/.test(landingText) && /Sung by alice/.test(landingText) && /alice · singer 1/.test(landingText) && /You will be singer 2/.test(landingText), `the link opens a landing: the song, who sang it, the slot bob would take (${landingText.slice(0, 120)}…)`);
  await bob.page.locator('[data-join-watch-open]').click();
  await bob.page.locator('video[data-join-watch]').waitFor({ timeout: 60000 });
  const watched = await bob.page.evaluate(() => new Promise((res) => { const v = document.querySelector('video[data-join-watch]'); const done = () => res({ w: v.videoWidth, h: v.videoHeight, d: v.duration }); if (v.readyState >= 1) done(); else { v.addEventListener('loadedmetadata', done, { once: true }); setTimeout(done, 15000); } }));
  check((watched.w === 1280 && watched.h === 720) || (watched.w === 1920 && watched.h === 1080), `Watch it first plays alice's show right there (${watched.w}×${watched.h})`);
  await bob.page.screenshot({ path: `${out}/bob-join-landing.png` });
  await bob.page.locator('[data-join-go]').click();
  await bob.page.locator('.sing[data-join]').waitFor({ timeout: 120000 });
  check((await bob.page.locator('.sing').getAttribute('data-join')) === aliceId && (await bob.page.locator('.sing').getAttribute('data-stage-slot')) === '2', 'the link opens the Studio stage over alice\'s take; bob takes slot 2');
  check(/joining alice · you are singer 2/.test(await bob.page.locator('[data-join-with]').innerText()), `the stage says so (${(await bob.page.locator('[data-join-with]').innerText()).trim()})`);
  check(await waitForModel(bob.page), "bob's camera is on — a free account's camera in the Studio is as free as anyone's");
  const bobStage = await stageWithPictures(bob.page, 2);
  const bobLayers0 = await bob.page.evaluate(() => window.__svJoin?.layers?.state() ?? null);
  writeFileSync(`${out}/bob-stage-canvas.png`, Buffer.from((await bob.page.evaluate(() => document.querySelector('.sing canvas.stagecanvas').toDataURL('image/png'))).split(',')[1], 'base64')); // what the stage drew (support)
  check(bobStage.performers === '2' && bobStage.headLeft > 200 && bobStage.headRight > 200, `two performers on bob's stage before a note is sung: alice's picture on the left (${bobStage.headLeft} px of her), bob's on the right (${bobStage.headRight} px) — layers ${JSON.stringify(bobLayers0)}, canvas ${bobStage.w}×${bobStage.h}`);
  check(!/audio only/.test(bobStage.text), 'nothing about audio only on a join');
  await bob.page.getByRole('button', { name: 'Camera & zoom' }).click();
  await bob.page.locator('.sheet').waitFor();
  check(/Singer 2/.test(await bob.page.locator('.sheet .btn.accent').first().innerText()), "bob sings the song's second part by default — the one alice did not");
  // The picture choices, right in the sheet: 'My camera as it is' makes the whole camera picture go out (the mask white to its corners —
  // nothing cut away); 'Me on the stage' cuts bob out again (the corner, where nobody is, dark). The framing choice sits beside it.
  const maskCorner = () => bob.page.evaluate(() => { const f = window.__svFeed; if (!f) return -1; const d = f.maskCanvas.getContext('2d').getImageData(4, 4, 1, 1).data; return d[0]; });
  const maskAfter = async (want) => { for (let i = 0; i < 40; i++) { const v = await maskCorner(); if (want(v)) return v; await wait(250); } return maskCorner(); };
  check((await bob.page.locator('.sheet [role=radiogroup][aria-label="My picture"] button').allInnerTexts()).join('|') === 'Me on the stage|My camera as it is' && (await bob.page.locator('.sheet').getByRole('checkbox', { name: 'Auto zoom' }).count()) === 1, 'the sheet offers the picture (me on the stage / my camera as it is) and the Auto zoom switch');
  check((await bob.page.locator('.sheet').getByRole('checkbox', { name: 'Auto zoom' }).isChecked()) === false, 'Auto zoom is off by default: the picture framed once, still and centred — the same switch a live meet has');
  await bob.page.locator('.sheet').getByRole('radio', { name: 'My camera as it is' }).click();
  const cornerCamera = await maskAfter((v) => v > 200);
  check(cornerCamera > 200, `'My camera as it is': the picture goes out whole, room and all (mask corner ${cornerCamera})`);
  await bob.page.locator('.sheet').getByRole('radio', { name: 'Me on the stage' }).click();
  const cornerCutout = await maskAfter((v) => v >= 0 && v < 40);
  check(cornerCutout >= 0 && cornerCutout < 40, `'Me on the stage': cut out again (mask corner ${cornerCutout})`);
  await bob.page.locator('.sheet').getByRole('button', { name: 'Close' }).click(); // (Escape reaches the window only once the page has the focus; the X always does)
  await bob.page.locator('.sheet').waitFor({ state: 'detached', timeout: 10000 });
  check((await bob.page.locator('.lyrics').count()) === 1, 'the lyrics are there: the song came from the track database');
  await bob.page.getByRole('button', { name: 'Sound' }).click();
  await bob.page.locator('.sheet').waitFor();
  check((await bob.page.locator('.sheet [data-tempo][disabled]').count()) === 1 && (await bob.page.locator('.sheet [data-key-shift][disabled]').count()) === 1, 'tempo and key are fixed on a join (the show is sung as it was)');
  await bob.page.locator('.sheet').getByRole('button', { name: 'Close' }).click();
  await bob.page.locator('.sheet').waitFor({ state: 'detached', timeout: 10000 });
  await bob.page.screenshot({ path: `${out}/bob-join-stage.png` });
  const bobId = await singThrough(bob);
  check(/^perf-/.test(bobId), `bob sang his part through; the take saved itself (${bobId})`);
  const layerState = (p) => p.page.evaluate(() => window.__svJoin?.layers?.state() ?? null);
  const bobLayers = await layerState(bob);
  console.log("bob's layers after the take:", JSON.stringify(bobLayers));
  check(Array.isArray(bobLayers) && bobLayers.every((l) => l.readyState >= 2 && !l.error && Number.isFinite(l.duration) && l.duration > SONG_S - 8), `alice's cut-out played on bob's device: ready, no error, ${bobLayers?.map((l) => `${l.duration?.toFixed?.(1)} s`).join(', ')}`);
  check(/with alice/.test(await bob.page.locator('.review-hero h2').innerText()), 'the review says "with alice"');
  await bob.page.screenshot({ path: `${out}/bob-review.png` });
  await keep(bob);
  const b = perfFiles('bob', bobId);
  check(Boolean(b.show) && Boolean(b.cutout), `bob's Drive holds his show (${b.show?.bytes?.length ?? 0} bytes) and his cut-out (${b.cutout?.bytes?.length ?? 0} bytes)`);
  check(b.manifest?.join?.fromPerformanceId === aliceId && b.manifest?.join?.fromOwnerName === 'alice', 'the manifest remembers what it joined');
  check(JSON.stringify(b.manifest?.singers?.map((s) => [s.slot, s.displayName])) === JSON.stringify([[1, 'alice'], [2, 'bob']]), `both singers are on it, in slot order (${JSON.stringify(b.manifest?.singers?.map((s) => [s.slot, s.displayName]))})`);
  check(b.manifest?.join?.layers?.length === 1 && b.manifest.join.layers[0].cutout?.driveId === a.cutout?.id && b.manifest.join.layers[0].atShowMs === aliceInv.layers[0].atShowMs - (b.manifest.timeline.videoOffsetMs - b.manifest.timeline.latencyCompMs), `alice's layer is inherited on bob's clock (at ${b.manifest?.join?.layers?.[0]?.atShowMs} ms: hers ${aliceInv?.layers?.[0]?.atShowMs} − (${b.manifest?.timeline?.videoOffsetMs} − ${b.manifest?.timeline?.latencyCompMs}))`);
  check(b.manifest?.kind === 'show' && b.manifest?.singerSlot === 2, 'a show, sung as singer 2');
  const bobShow = saveShow('bob', bobId, 'show-bob');
  const bobFrame = bobShow ? singersInFrame(bobShow, 8) : { singers: 0 };
  check(bobFrame.singers === 2, `bob's saved show has two singers on it — alice's cut-out and his (${bobFrame.singers}, heads at x ${bobFrame.at?.join(',')})`);
  check(bobShow && duration(bobShow) > SONG_S - 6 && loudness(bobShow) > -35, `his show runs the song (${bobShow ? duration(bobShow).toFixed(1) : '?'} s) with sound (${bobShow ? loudness(bobShow).toFixed(1) : '?'} dB)`);

  // ---- 4. bob opens his; alice sees the join ----
  const bobLink = await invite(bob);
  const aliceInv2 = (await asUser('carol', 'GET', `/performances/${aliceId}/invite`)).json?.invite;
  check(aliceInv2?.joins === 1, `alice's invite counts one join (${aliceInv2?.joins})`);
  const bobInv = (await asUser('carol', 'GET', `/performances/${bobId}/invite`)).json?.invite;
  check(bobInv?.layers?.length === 2 && bobInv.layers[1].displayName === 'bob' && bobInv.layers[1].cutout?.driveId === b.cutout?.id && bobInv.joinedFrom === aliceId, `bob's invite has two layers with his cut-out, and names alice's take (${JSON.stringify(bobInv?.layers?.map((l) => [l.slot, l.displayName]))})`);
  await alice.page.goto(`${base}studio/performances?${control}`, { waitUntil: 'networkidle' });
  const joinedRow = alice.page.locator(`[data-joined="${bobId}"]`);
  await joinedRow.waitFor({ timeout: 30000 });
  const joinedText = (await joinedRow.innerText()).replace(/\s+/g, ' ');
  check(/CI Join Song · alice & bob/.test(joinedText) && /bob joined/.test(joinedText) && /2 on stage/.test(joinedText), `alice's Performances lists "Joined yours": ${joinedText.slice(0, 90)}`);
  check((await joinedRow.getByRole('link', { name: 'Watch' }).getAttribute('href')) === bobInv.show.link && new RegExp(`/studio/join/${bobId}$`).test(await joinedRow.locator('[data-join-too]').getAttribute('href')), 'with Watch (bob\'s show) and Join too (his join page)');
  const aliceRow = alice.page.locator(`[data-take="${aliceId}"]`);
  check((await aliceRow.locator('[data-open-to-join]').getAttribute('data-open-to-join')) === '1' && (await aliceRow.locator('[data-join-link-copy]').count()) === 1 && (await aliceRow.locator('[data-join-close]').count()) === 1, 'her own take is marked open to join · 1 joined, with its link and Close');
  await alice.page.screenshot({ path: `${out}/alice-performances.png` });

  // ---- 5. carol joins bob's: three on stage ----
  await carol.page.goto(`${bobLink}?${control}`, { waitUntil: 'networkidle' });
  await carol.page.locator(`[data-join-landing="${bobId}"]`).waitFor({ timeout: 30000 });
  check(/Sung by alice & bob/.test((await carol.page.locator('[data-join-landing]').innerText()).replace(/\s+/g, ' ')), "bob's landing names both singers");
  await carol.page.locator('[data-join-go]').click();
  await carol.page.locator('.sing[data-join]').waitFor({ timeout: 120000 });
  check(/joining alice & bob · you are singer 3/.test(await carol.page.locator('[data-join-with]').innerText()), `carol joins bob's: ${(await carol.page.locator('[data-join-with]').innerText()).trim()}`);
  check(await waitForModel(carol.page), "carol's camera is on");
  const carolStage = await stageWithPictures(carol.page, 3);
  check(carolStage.performers === '3' && carolStage.headLeft > 400, `three performers on carol's stage, the earlier singers' pictures on it (${carolStage.performers}; ${carolStage.headLeft} px of them on the left)`);
  await carol.page.screenshot({ path: `${out}/carol-join-stage.png` });
  const carolId = await singThrough(carol, async () => (await carol.page.evaluate(() => (window.__svShow && window.__svShow.row ? window.__svShow.row.map((t) => t.label) : null))));
  const carolOrder = carol.rowSeen?.map((l) => (/^You\b/.test(l) ? 'carol' : (l.match(/alice|bob|carol/i) || [l])[0].toLowerCase()));
  const carolLayers = await layerState(carol);
  console.log("carol's layers after the take:", JSON.stringify(carolLayers));
  check(Array.isArray(carolLayers) && carolLayers.length === 2 && carolLayers.every((l) => l.readyState >= 2 && !l.error && Number.isFinite(l.duration)), "alice's and bob's cut-outs played on carol's device");
  await keep(carol);
  const c = perfFiles('carol', carolId);
  check(JSON.stringify(c.manifest?.singers?.map((s) => [s.slot, s.displayName])) === JSON.stringify([[1, 'alice'], [2, 'bob'], [3, 'carol']]), `carol's take has all three, in slot order (${JSON.stringify(c.manifest?.singers?.map((s) => [s.slot, s.displayName]))})`);
  check(c.manifest?.join?.fromPerformanceId === bobId && c.manifest?.join?.layers?.length === 2, "it joined bob's and inherited two layers");
  const carolShow = saveShow('carol', carolId, 'show-carol');
  const carolFrame = carolShow ? singersInFrame(carolShow, 8) : { singers: 0 };
  check(carolFrame.singers === 3, `carol's saved show has three singers on it (${carolFrame.singers}, heads at x ${carolFrame.at?.join(',')})`);
  check(carolFrame.at && carolFrame.at[0] < carolFrame.at[1] && carolFrame.at[1] < carolFrame.at[2] && Math.abs(carolFrame.at[1] - carolFrame.w / 2) < carolFrame.w * 0.08, `three across, one in the middle of the picture (heads at x ${carolFrame.at?.join(',')} of ${carolFrame.w})`);
  check(JSON.stringify(carolOrder) === JSON.stringify(['carol', 'alice', 'bob']), `the row from the middle out: alice (the first singer) in the centre, bob to her right, carol to her left — ${carolOrder?.join(' · ')} left to right on carol's stage`);

  // ---- 6. Closing ----
  await alice.page.locator(`[data-take="${aliceId}"] [data-join-close]`).click();
  await alice.page.locator('.toast', { hasText: 'Closed' }).waitFor({ timeout: 15000 });
  check((await asUser('bob', 'GET', `/performances/${aliceId}/invite`)).status === 404, "alice closed hers: the invite is gone from the service");
  await carol.page.goto(`${aliceLink}?${control}`, { waitUntil: 'networkidle' });
  await carol.page.locator('.toast', { hasText: /not open for joining/ }).waitFor({ timeout: 30000 });
  check(/\/studio\/performances/.test(carol.page.url()), 'the link says it is not open any more and leads to Performances');
} catch (e) {
  check(false, `threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  for (const p of [alice, bob, carol]) await p.page.screenshot({ path: `${out}/${p.name}-at-error.png` }).catch(() => undefined);
} finally {
  for (const [who, list] of Object.entries(errors)) if (list.length) console.log(`${who} page errors:`, list.slice(0, 6).join(' | '));
  await browser.close();
  await servers.stop();
  google.close();
}
console.log(failed ? 'JOIN E2E FAILED' : 'JOIN E2E OK');
process.exit(failed ? 1 : 0);
