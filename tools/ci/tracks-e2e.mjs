// Track search e2e: the Tracks portal's All tab, the SingersVoice track database (the master database) and the
// Sing-time copy into a singer's own Drive — in the browser, the built app against the real sv-control, with
// Google Drive faked per singer (the unit tests' FakeDrive, served to the browser by Playwright routes and to the
// service over HTTP: the token check, public file reads with the folder's sharing inherited, the download pages).
//
//   1. The tabs: All · Recommended · Bookmarks · My Drive · Public catalog · YouTube, in that order; All first.
//   2. alice imports a song and sings it: the first Sing shares her folder (the shareable URL), registers the song
//      with a 12-character id and records her access; a second Sing adds nothing new (one record per source).
//   3. bob finds it under All (the latest sung first — no singer's name on the line), previews it (an access of his), sings it: the
//      files come through the service from alice's shared Drive, a copy lands under bob's own Tracks, shared and
//      registered as a copy; the Sing screen records his access; sung again, his copy is used, not copied twice.
//   4. The tree: bob's own "CI Sample Song" by another artist makes a second version — one song group, two
//      artists cascading; sorting by the latest access, newest first, on the page and in the database.
//   4b. Songs you prefer, bookmarks, Recommended: alice picks English and India in Settings (kept on her account);
//      Recommended shows her the songs in those languages, the most sung first; bob, with nothing set, is asked
//      with a dropdown there (his pick is the session's, never his account's); the star on any row keeps the song
//      on the account — a database record from Recommended, his own Drive track, a public catalog entry (alice's,
//      after she publishes one; the catalog keeps to her languages with "Every language" a tap away); the
//      Bookmarks tab lists them and sings from them; in a meet, Recommended and the song picker offer every
//      stage singer's bookmarks together, saying whose, and a pick from there puts the song up.
//   5. Unavailable links: alice unshares — carol still gets the song from bob's shared copy; with every copy
//      unshared, dave's Sing fails with the reason, nothing is saved, no access is counted, the row says so.
//   6. Searches never count: the access counts stand still through all the searching.
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/tracks-e2e.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
const work = path.join(tmpdir(), `sv-tracks-e2e-${process.pid}`);
mkdirSync(work, { recursive: true });

// ---- Google Drive, faked per singer (the unit tests' FakeDrive, bundled for Node) ----
execFileSync(path.resolve('node_modules/.bin/esbuild'), ['test/helpers/fakeDrive.ts', '--bundle', '--format=esm', '--platform=node', '--log-level=warning', `--outfile=${work}/fakeDrive.mjs`], { cwd: path.resolve('apps/web'), stdio: 'inherit' });
const { FakeDrive } = await import(`${work}/fakeDrive.mjs`);
const drives = new Map();
const driveOf = (name) => {
  if (!drives.has(name)) drives.set(name, new FakeDrive());
  return drives.get(name);
};
/** The file by id in any singer's Drive, with the Drive it is in. */
const findFile = (id) => {
  for (const [name, d] of drives) {
    const f = d.files.get(id);
    if (f) return { name, d, f };
  }
  return null;
};
/** Shared anyone-with-the-link: on the file or on any folder above it (Drive inherits). */
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

// Multipart as the browser sends it (metadata + file), back into the FormData the fake expects.
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
      const body = part.subarray(headEnd + 4, part.length - 2); // the CRLF before the next boundary
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

// Google over HTTP, for the browser (each singer's Drive by their token; CORS like the real API) and for the service (the
// token check; public file reads with the folder's sharing inherited, as the Drive API and the download pages).
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
  if (bearer && (url.pathname.startsWith('/drive/') || url.pathname.startsWith('/upload/')) ) {
    // The singer's own Drive, as the fake answers it; a resumable upload's Location comes back pointing here.
    const d = driveOf(bearer);
    const raw = await readBody(req);
    const type = req.headers['content-type'] ?? '';
    // An upload's body is the file's bytes (whatever its type says); the API's bodies are JSON.
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

const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = {};
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30000);
  errors[name] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors[name].push(m.text()));
  await page.goto(base + '?' + control, { waitUntil: 'networkidle' });
  await page.evaluate(([n, g]) => {
    localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: `${n}@dev.local`, picture: '', mode: 'drive' }));
    localStorage.setItem('sv.mode', 'drive');
    localStorage.setItem('sv.google.token', JSON.stringify({ accessToken: `tok-${n}`, expiresAt: Date.now() + 3600_000, scope: 'https://www.googleapis.com/auth/drive.file' }));
    localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true, cameraOn: false, cutout: false })); // a meet in 4b: the voice alone (no segmentation model on this machine)
    localStorage.setItem('sv.googleApiBase', g); // the browser's Drive API is the fake (drive.ts reads this on a local address only)
  }, [name, googleBase]);
  await page.goto(base + 'home?' + control, { waitUntil: 'networkidle' });
  return { ctx, page, name };
}

// Songs to import: short WAVs (the name becomes the title), and an .lrc that names another artist.
const wav = (file) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050', '-t', '3', '-ac', '1', file]);
const sample = path.join(work, 'CI Sample Song.wav');
const second = path.join(work, 'CI Second Song.wav');
const bobsSample = path.join(work, 'bob', 'CI Sample Song.wav');
mkdirSync(path.join(work, 'bob'), { recursive: true });
wav(sample);
wav(second);
wav(bobsSample);
const lrc = path.join(work, 'CI Sample Song.lrc');
writeFileSync(lrc, '[ti:CI Sample Song]\n[ar:Bob Singer]\n[00:00.00]la la la\n[00:01.50]la la\n');

/** Import a song through the Tracks portal's Import sheet; returns the title. */
async function importSong(p, audio, lyrics = null) {
  await p.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await p.page.getByRole('button', { name: 'Import' }).first().click();
  const sheet = p.page.locator('.sheet');
  await sheet.waitFor();
  const inputs = sheet.locator('input[type=file]');
  if (lyrics) await inputs.nth(0).setInputFiles(lyrics);
  await inputs.nth(1).setInputFiles(audio);
  await sheet.getByRole('button', { name: 'Import' }).click();
  const toast = p.page.locator('.toast').first();
  await toast.waitFor({ timeout: 60000 }).catch(() => undefined);
  const said = (await toast.innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (!/Imported/.test(said)) {
    console.log(`import toast: "${said}" · Drive calls: ${driveOf(p.name).calls.slice(-8).join(' | ')}`);
    throw new Error(`the import did not land: ${said || 'no toast'}`);
  }
  await p.page.locator('.sheet').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
}
/** The record of a song by its name, as the database answers a singer's search. */
const recordOf = async (who, q, pick = (vs) => vs[0]) => {
  const r = (await asUser(who, 'GET', `/tracks/search?q=${encodeURIComponent(q)}`)).json;
  const group = r?.groups?.find((g) => g.versions.some((v) => v.song.toLowerCase() === q.toLowerCase()));
  return { total: r?.total ?? 0, group, record: group ? pick(group.versions) : null, groups: r?.groups ?? [] };
};
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(500);
  }
};

const alice = await person('alice');
const bob = await person('bob');
try {
  // ---- 1. The tabs ----
  await alice.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  const tabs = await alice.page.getByRole('radio').allInnerTexts();
  check(tabs.map((t) => t.trim()).join(' · ') === 'All · Recommended · Bookmarks · My Drive · Public catalog · YouTube', `the tabs are All · Recommended · Bookmarks · My Drive · Public catalog · YouTube, in that order (${tabs.join(' · ')})`);
  check((await alice.page.getByRole('radio', { name: 'All' }).getAttribute('aria-checked')) === 'true', 'All is the tab that opens');
  await alice.page.screenshot({ path: `${out}/tracks-all-empty.png` });

  // ---- 2. alice imports a song and sings it: the first Sing registers it ----
  await importSong(alice, sample);
  check(true, 'alice imported "CI Sample Song" into her Drive');
  await alice.page.getByRole('radio', { name: 'All' }).click();
  await alice.page.locator('[data-all-query]').fill('ci sample');
  const mineRow = alice.page.locator('[data-all-mine] [data-my-track]').first();
  await mineRow.waitFor();
  check(/CI Sample Song/.test(await mineRow.innerText()) && !/in the database/.test(await mineRow.innerText()), 'typing lists her own track under "In my Drive" — not in the database yet');
  const before = await asUser('alice', 'GET', '/tracks/search?q=ci%20sample');
  check(before.json?.total === 0, 'searching registers nothing: the database has no record of it yet');
  await mineRow.getByRole('link', { name: 'Sing' }).click();
  await alice.page.waitForURL(/\/studio\/sing\//);
  await alice.page.locator('.sing').waitFor();
  const aliceRec = await until(async () => (await recordOf('alice', 'CI Sample Song')).record);
  check(Boolean(aliceRec), 'the Sing screen opened and the song is in the SingersVoice track database');
  if (!aliceRec) throw new Error('no record for alice');
  check(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}\d{4}$/.test(aliceRec.trackId), `its id is 12 characters — 8 random and the month minted (${aliceRec.trackId})`);
  check(aliceRec.source === 'drive' && aliceRec.song === 'CI Sample Song' && aliceRec.ownerName === 'alice', `registered from her Drive, by name, as hers (${aliceRec.source} · ${aliceRec.song} · ${aliceRec.ownerName})`);
  check(/^https:\/\/drive\.google\.com\/drive\/folders\//.test(aliceRec.driveUrl), `with a shareable Google Drive URL (${aliceRec.driveUrl})`);
  const aliceDrive = driveOf('alice');
  const aliceJson = [...aliceDrive.files.values()].find((f) => f.name === 'track.json');
  const aliceFolder = aliceDrive.files.get(aliceJson?.parents[0] ?? '');
  check(Boolean(aliceFolder) && aliceFolder.permissions.some((p) => p.type === 'anyone') && aliceRec.driveUrl.endsWith(aliceFolder.id), 'her track folder is really shared anyone-with-the-link, and the URL is that folder');
  check(aliceRec.refs.jsonId === aliceJson?.id && aliceRec.refs.folderId === aliceFolder?.id, "the record carries her file ids, so the service can fetch the files for others");
  const aliceAt = await until(async () => {
    const r = (await recordOf('alice', 'CI Sample Song')).record;
    return r?.lastAccessedAt ? r : null;
  });
  check(Boolean(aliceAt) && aliceAt.accessCount === 1 && aliceAt.singers === 1 && aliceAt.mine?.count === 1, `opening it for performance is her first access: last sung ${aliceAt?.lastAccessedAt}, 1 access, 1 singer`);
  check(Boolean(aliceAt?.lastAccessedAt) && /Z$/.test(aliceAt.lastAccessedAt) && Math.abs(Date.now() - Date.parse(aliceAt.lastAccessedAt)) < 60_000, 'the instant is now, in UTC');
  const jsonText = aliceJson?.bytes ? Buffer.from(aliceJson.bytes).toString() : '';
  check(JSON.parse(jsonText || '{}').registryId === aliceRec.trackId, 'the id is written into her track.json (known on every device from now on)');
  // Sung again: the same record, one more access, no second record.
  await alice.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await alice.page.locator('[data-all-query]').fill('ci sample');
  const mineAgain = alice.page.locator('[data-all-mine] [data-my-track]').first();
  await mineAgain.waitFor();
  check(/in the database/.test(await mineAgain.innerText()), 'her track now says "in the database"');
  await mineAgain.getByRole('link', { name: 'Sing' }).click();
  await alice.page.waitForURL(/\/studio\/sing\//);
  const aliceTwice = await until(async () => {
    const r = await recordOf('alice', 'CI Sample Song');
    return r.record?.accessCount === 2 ? r : null;
  });
  check(Boolean(aliceTwice) && aliceTwice.total === 1 && aliceTwice.group.versions.length === 1, 'sung again: the same one record (no duplicate), one more access');

  // ---- 3. bob finds it, previews it, sings it: a copy into HIS Drive ----
  await bob.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  const latest = bob.page.locator('[data-all-db] [data-version]').first();
  await latest.waitFor();
  check(/CI Sample Song/.test(await latest.innerText()) && /last sung/.test(await latest.innerText()) && !/alice|yours/.test(await latest.innerText()), `with nothing typed, All shows the latest sung by anyone — the song, when, never who: "${(await latest.innerText()).replace(/\s+/g, ' ').slice(0, 90)}"`);
  await bob.page.locator('[data-all-query]').fill('ci sample');
  const row = bob.page.locator(`[data-song-tree] [data-version="${aliceRec.trackId}"]`);
  await row.waitFor();
  check(!(await row.innerText()).includes('in my Drive'), 'bob does not have it yet');
  const countsBefore = (await recordOf('bob', 'CI Sample Song')).record;
  await row.locator('[data-version-preview]').click();
  await row.locator('[data-version-preview="playing"]').waitFor({ timeout: 20000 });
  const afterPlay = await until(async () => {
    const r = (await recordOf('bob', 'CI Sample Song')).record;
    return r && r.accessCount === countsBefore.accessCount + 1 ? r : null;
  });
  check(Boolean(afterPlay) && afterPlay.singers === 2 && afterPlay.mine?.count === 1, `a preview that plays is an access of bob's: ${afterPlay?.accessCount} accesses, 2 singers, in his own history`);
  check(Date.parse(afterPlay?.lastAccessedAt ?? '') > Date.parse(countsBefore.lastAccessedAt), 'the global last-accessed instant moved to his');
  await row.locator('[data-version-preview]').click(); // stop
  await bob.page.screenshot({ path: `${out}/tracks-all-bob.png`, fullPage: true });
  await row.locator('[data-version-sing]').click();
  await bob.page.waitForURL(/\/studio\/sing\//, { timeout: 60000 });
  await bob.page.locator('.sing').waitFor();
  const bobCopyUrl = bob.page.url();
  check(/\/studio\/sing\/reg-/.test(bobCopyUrl), `Sing brought the song into bob's library and opened it (${decodeURIComponent(bobCopyUrl.split('/sing/')[1]?.split('?')[0] ?? '')})`);
  const bobDrive = driveOf('bob');
  const bobJson = [...bobDrive.files.values()].find((f) => f.name === 'track.json');
  const bobFolder = bobDrive.files.get(bobJson?.parents[0] ?? '');
  const bobTracks = bobDrive.files.get(bobFolder?.parents[0] ?? '');
  check(Boolean(bobFolder) && bobFolder.name === 'CI Sample Song' && bobTracks?.name === 'Tracks', "the copy sits in bob's own Drive under Tracks/CI Sample Song");
  check(JSON.parse(bobJson?.bytes ? Buffer.from(bobJson.bytes).toString() : '{}').registryId === aliceRec.trackId, "bob's copy carries the song's id");
  const bobAudio = [...bobDrive.files.values()].find((f) => f.parents.includes(bobFolder?.id ?? '') && f.mimeType.startsWith('audio/'));
  const aliceAudio = [...aliceDrive.files.values()].find((f) => f.parents.includes(aliceFolder?.id ?? '') && f.mimeType.startsWith('audio/'));
  check(Boolean(bobAudio) && Boolean(aliceAudio) && Buffer.compare(Buffer.from(bobAudio.bytes), Buffer.from(aliceAudio.bytes)) === 0, "the backing track came over byte for byte (through the service, from alice's shared Drive)");
  const withCopy = await until(async () => {
    const r = (await recordOf('bob', 'CI Sample Song')).record;
    return r && r.copies >= 2 && r.mine?.count === 2 ? r : null;
  });
  check(Boolean(withCopy) && bobFolder.permissions.some((p) => p.type === 'anyone'), `bob's copy is shared and registered as one more place to fetch the song from (${withCopy?.copies} copies); the Sing screen recorded his access (${withCopy?.mine?.count} of his)`);
  // Sung again from his Drive: his copy, no second copy.
  await bob.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-all-query]').fill('ci sample');
  const rowHave = bob.page.locator(`[data-song-tree] [data-version="${aliceRec.trackId}"]`);
  await rowHave.waitFor();
  check(/in my Drive/.test(await rowHave.innerText()), 'the row now says "in my Drive"');
  await rowHave.locator('[data-version-sing]').click();
  await bob.page.waitForURL(/\/studio\/sing\//);
  await bob.page.locator('.sing').waitFor();
  check(bob.page.url() === bobCopyUrl, 'Sing again opens the same copy');
  await wait(1500);
  check([...bobDrive.files.values()].filter((f) => f.name === 'track.json' && !f.trashed).length === 1, 'no second copy was made');

  // ---- 4. The tree: another version of the same song, by another artist; the sorting ----
  await importSong(bob, bobsSample, lrc);
  await bob.page.getByRole('radio', { name: 'All' }).click();
  await bob.page.locator('[data-all-query]').fill('ci sample');
  const bobOwnRow = bob.page.locator('[data-all-mine] [data-my-track]', { hasText: 'Bob Singer' }).first();
  await bobOwnRow.waitFor();
  await bobOwnRow.getByRole('link', { name: 'Sing' }).click();
  await bob.page.waitForURL(/\/studio\/sing\//);
  const twoVersions = await until(async () => {
    const r = await recordOf('bob', 'CI Sample Song');
    return r.group && r.group.versions.length === 2 && r.group.versions.every((v) => v.lastAccessedAt) ? r : null;
  });
  check(Boolean(twoVersions) && twoVersions.total === 1, 'two files of "CI Sample Song" — one song group, two versions');
  const bobsVersion = twoVersions?.group.versions.find((v) => v.artists === 'Bob Singer');
  check(Boolean(bobsVersion) && bobsVersion.ownerName === 'bob' && bobsVersion.trackId !== aliceRec.trackId, `bob's version carries its artist from the .lrc and its own id (${bobsVersion?.trackId})`);
  check(twoVersions?.group.versions[0].trackId === bobsVersion?.trackId, "the versions sort by the latest access: bob's, just sung, first");
  await importSong(alice, second);
  await alice.page.getByRole('radio', { name: 'All' }).click();
  await alice.page.locator('[data-all-query]').fill('ci second');
  await alice.page.locator('[data-all-mine] [data-my-track]').first().getByRole('link', { name: 'Sing' }).click();
  await alice.page.waitForURL(/\/studio\/sing\//);
  const secondRec = await until(async () => {
    const r = (await recordOf('alice', 'CI Second Song')).record;
    return r?.lastAccessedAt ? r : null;
  });
  check(Boolean(secondRec), 'alice sang a second song');
  let order = (await asUser('bob', 'GET', '/tracks/search')).json?.groups.map((g) => g.song);
  check(order?.[0] === 'CI Second Song' && order?.[1] === 'CI Sample Song', `the groups sort by the latest access, newest first (${order?.join(' · ')})`);
  await bob.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-all-query]').fill('ci');
  const group = bob.page.locator('[data-song-group]').first();
  await group.waitFor();
  const treeOrder = await bob.page.locator('[data-song-tree] > *').evaluateAll((els) => els.map((e) => (e.querySelector('.t')?.textContent ?? '').trim()));
  check(treeOrder[0]?.startsWith('CI Second Song') && treeOrder[1]?.startsWith('CI Sample Song'), `the page shows them in that order (${treeOrder.join(' · ')})`);
  check(/2 versions · 2 artists/.test(await group.innerText()), `the song with two versions is one expandable group: "${(await group.locator('.s').first().innerText()).trim()}"`);
  check((await bob.page.locator(`[data-version="${aliceRec.trackId}"]`).count()) === 0, 'its versions are folded away until it is opened');
  await group.locator('[data-song-toggle]').click();
  await group.locator('[data-artist-branch]').first().waitFor();
  const branches = await group.locator('[data-artist-branch]').evaluateAll((els) => els.map((e) => e.getAttribute('data-artist-branch')));
  check(branches.length === 2 && branches.includes('Bob Singer'), `opened, it cascades by artist (${branches.join(' · ')})`);
  /** An artist's files: a branch with one file stands open already; one with several opens on a tap. */
  const openBranch = async (branch) => {
    if ((await branch.getAttribute('data-open')) !== '1') await branch.locator('[data-artist-toggle]').click();
  };
  await openBranch(group.locator('[data-artist-branch="Bob Singer"]'));
  await group.locator(`[data-artist-branch="Bob Singer"] [data-version="${bobsVersion?.trackId}"]`).waitFor();
  check(true, "an artist's branch shows its files, each with Sing");
  const other = group.locator('[data-artist-branch]').filter({ hasNot: bob.page.locator('[data-artist-branch="Bob Singer"]') }).first();
  await openBranch(other);
  await group.locator(`[data-version="${aliceRec.trackId}"]`).waitFor();
  check(true, "the other artist's branch shows alice's file");
  await bob.page.screenshot({ path: `${out}/tracks-all-tree.png`, fullPage: true });
  // bob sings alice's version again: that song group comes first again.
  await group.locator(`[data-version="${aliceRec.trackId}"] [data-version-sing]`).click();
  await bob.page.waitForURL(/\/studio\/sing\//);
  await until(async () => {
    const r = (await recordOf('bob', 'CI Sample Song')).record;
    return r && r.accessCount >= 4 ? r : null;
  });
  order = (await asUser('bob', 'GET', '/tracks/search')).json?.groups.map((g) => g.song);
  check(order?.[0] === 'CI Sample Song', `sung again, that song is the newest again (${order?.join(' · ')})`);
  const hist = (await asUser('bob', 'GET', '/tracks/history')).json?.items.map((i) => i.song);
  check(hist?.[0] === 'CI Sample Song' && hist.length === 2, `bob's own history: ${hist?.join(' · ')}`);
  const aliceHist = (await asUser('alice', 'GET', '/tracks/history')).json?.items.map((i) => i.trackId);
  check(Boolean(aliceHist) && !aliceHist.includes(bobsVersion?.trackId), "alice's history has only what she sang");
  const soFar = (await recordOf('bob', 'CI Sample Song')).record;

  // ---- 4b. Songs you prefer, bookmarks, Recommended ----
  // alice: Settings → Songs you prefer — English, and India (a country stands for its languages); kept on her account.
  await alice.page.goto(`${base}settings?${control}`, { waitUntil: 'networkidle' });
  const prefsCard = alice.page.locator('[data-song-prefs]');
  await prefsCard.waitFor();
  await prefsCard.locator('[data-pref-language="English"]').click();
  await alice.page.waitForFunction(() => document.querySelector('[data-pref-language="English"]')?.getAttribute('aria-pressed') === 'true');
  await prefsCard.locator('[data-pref-country="India"]').click();
  const alicePrefs = await until(async () => {
    const pr = (await asUser('alice', 'GET', '/prefs')).json?.prefs;
    return pr?.languages.includes('English') && pr?.countries.includes('India') ? pr : null;
  });
  check(alicePrefs?.languages.join() === 'English' && alicePrefs?.countries.join() === 'India', `her preference is on her account: ${JSON.stringify(alicePrefs)}`);
  const prefsLine = (await prefsCard.locator('[data-prefs-line]').innerText()).trim();
  check(/^Songs in English, Hindi, Telugu/.test(prefsLine), `the card says what it reaches: "${prefsLine}"`);
  await alice.page.screenshot({ path: `${out}/settings-song-prefs.png`, fullPage: true });
  // Her "CI Sample Song" is an English song (she corrects the metadata; the owner may); "CI Second Song" names no language.
  check((await asUser('alice', 'PATCH', `/tracks/${aliceRec.trackId}`, { language: 'English' })).status === 200, 'alice files her song under English');
  // Recommended, for alice: the songs in her languages, the most sung first — the English one, not the one without a language.
  await alice.page.goto(`${base}tracks?${control}#recommended`, { waitUntil: 'networkidle' });
  check((await alice.page.getByRole('radio', { name: 'Recommended' }).getAttribute('aria-checked')) === 'true', 'the address #recommended opens the Recommended tab');
  const forYou = alice.page.locator('[data-rec-for-you]');
  await forYou.locator(`[data-version="${aliceRec.trackId}"]`).waitFor({ timeout: 15000 });
  const recTitle = (await forYou.locator('[data-rec-title]').innerText()).replace(/\s+/g, ' ').trim();
  check(/^For you · English, Hindi, Telugu/.test(recTitle), `it says whose languages: "${recTitle}"`);
  const recSongs = await forYou.locator('[data-song-tree] > *').evaluateAll((els) => els.map((e) => (e.querySelector('.t')?.textContent ?? '').trim()));
  check(recSongs.some((t) => t.startsWith('CI Sample Song')) && !recSongs.some((t) => t.startsWith('CI Second Song')), `recommended for her: ${recSongs.join(' · ') || 'nothing'} (the song in English; not the one without a language)`);
  check((await forYou.locator(`[data-version="${bobsVersion?.trackId}"]`).count()) === 0, "bob's version of it (no language) is not among the versions");
  check((await forYou.locator('[data-prefs-pick]').count()) === 0, 'no dropdown for a singer whose preference is set');
  check((await alice.page.locator('[data-rec-stage]').count()) === 0, 'not in a meet: no stage section');
  await alice.page.screenshot({ path: `${out}/tracks-recommended-alice.png`, fullPage: true });
  // bob set nothing: Recommended asks him, right there; his pick is the session's, never his account's.
  await bob.page.goto(`${base}tracks?${control}#recommended`, { waitUntil: 'networkidle' });
  const bobFor = bob.page.locator('[data-rec-for-you]');
  await bobFor.locator('[data-prefs-pick]').waitFor();
  check(/Which songs do you prefer\?/.test(await bobFor.innerText()), 'with no preference set, Recommended asks which songs he prefers — a dropdown, and Settings offered');
  await bobFor.locator('[data-prefs-pick]').selectOption('language:English');
  await bobFor.locator(`[data-version="${aliceRec.trackId}"]`).waitFor({ timeout: 15000 });
  check(/^For you · English$/.test((await bobFor.locator('[data-rec-title]').innerText()).replace(/\s+/g, ' ').trim()), 'his pick shows the songs in English');
  check(((await asUser('bob', 'GET', '/prefs')).json?.prefs.languages ?? []).length === 0, "the pick is the session's — his account keeps no preference");
  // The star: bob bookmarks alice's song from Recommended — the star fills, the bookmark is on his account.
  const starOn = async (page, sel) => {
    await page.locator(sel).click();
    await page.waitForFunction((q) => document.querySelector(q)?.getAttribute('aria-pressed') === 'true', sel, { timeout: 15000 });
  };
  await starOn(bob.page, `[data-rec-for-you] [data-version="${aliceRec.trackId}"] [data-bookmark]`);
  const bobMarks = await until(async () => {
    const r = (await asUser('bob', 'GET', '/bookmarks')).json;
    return r?.items?.length ? r.items : null;
  });
  check(bobMarks?.length === 1 && bobMarks[0].key === `registry:${aliceRec.trackId}` && bobMarks[0].title === 'CI Sample Song' && bobMarks[0].language === 'English', `the star kept the song on bob's account (${bobMarks?.[0]?.key} · ${bobMarks?.[0]?.title})`);
  // His own track in My Drive (registered already): the star knows it at once; starred, it is a second bookmark.
  await bob.page.getByRole('radio', { name: 'My Drive' }).click();
  const bobOwnId = bobsVersion?.mine?.copyTrackId;
  const ownStar = `[data-my-track="${bobOwnId}"] [data-bookmark]`;
  await bob.page.locator(ownStar).waitFor();
  check((await bob.page.locator(ownStar).getAttribute('data-bookmark')) === `registry:${bobsVersion?.trackId}`, `his own track's star names the record it is (${bobsVersion?.trackId})`);
  await starOn(bob.page, ownStar);
  const bobTwo = await until(async () => {
    const r = (await asUser('bob', 'GET', '/bookmarks')).json;
    return r?.items?.length === 2 ? r.items : null;
  });
  check(bobTwo?.map((b) => b.key).join(' ') === `registry:${bobsVersion?.trackId} registry:${aliceRec.trackId}`, `two bookmarks, the latest first (${bobTwo?.map((b) => b.key).join(' · ')})`);
  // The Bookmarks tab: both, each saying what it is; Sing from there opens his copy (he has it).
  await bob.page.getByRole('radio', { name: 'Bookmarks' }).click();
  await bob.page.locator(`[data-bookmark-row="registry:${aliceRec.trackId}"]`).waitFor();
  const markRows = await bob.page.locator('[data-bookmark-row]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-bookmark-kind')}:${(e.querySelector('.t')?.textContent ?? '').replace(/\s+/g, ' ').trim()}`));
  check(markRows.length === 2 && markRows.every((r) => /^registry:CI Sample Song Track database$/.test(r)), `the Bookmarks tab lists them (${markRows.join(' · ')})`);
  await bob.page.screenshot({ path: `${out}/tracks-bookmarks-bob.png`, fullPage: true });
  await bob.page.locator(`[data-bookmark-row="registry:${aliceRec.trackId}"] [data-bookmark-sing]`).click();
  await bob.page.waitForURL(/\/studio\/sing\//);
  check(bob.page.url() === bobCopyUrl, 'Sing from a bookmark opens the copy he has (no second copy)');
  // The star again drops it: the Bookmarks tab is one shorter.
  await bob.page.goto(`${base}tracks?${control}#bookmarks`, { waitUntil: 'networkidle' });
  const dropStar = `[data-bookmark-row="registry:${bobsVersion?.trackId}"] [data-bookmark]`;
  await bob.page.locator(dropStar).waitFor();
  await bob.page.locator(dropStar).click();
  await bob.page.locator(`[data-bookmark-row="registry:${bobsVersion?.trackId}"]`).waitFor({ state: 'detached', timeout: 15000 });
  const bobOne = await until(async () => {
    const r = (await asUser('bob', 'GET', '/bookmarks')).json;
    return r?.items?.length === 1 ? r.items : null;
  });
  check(bobOne?.map((b) => b.key).join() === `registry:${aliceRec.trackId}`, 'the star tapped again drops the bookmark (on the account too)');
  // The public catalog: alice publishes "CI Second Song" (no language) — her catalog keeps to her languages, "Every language" a tap away; the star there is a catalog bookmark.
  await alice.page.goto(`${base}tracks?${control}#mine`, { waitUntil: 'networkidle' });
  const secondRow = alice.page.locator('[data-my-track]', { hasText: 'CI Second Song' }).first();
  await secondRow.waitFor();
  await secondRow.getByRole('button', { name: 'More' }).click();
  await alice.page.locator('.sheet').getByRole('button', { name: 'Publish to public catalog' }).click();
  await alice.page.locator('.toast', { hasText: /is in the public catalog/ }).waitFor({ timeout: 30000 });
  const published = (await asUser('alice', 'GET', '/catalog/tracks?q=ci%20second')).json?.items?.[0];
  check(Boolean(published) && published.title === 'CI Second Song' && published.registryId === secondRec?.trackId, `alice published "CI Second Song" to the catalog (its registry id ${published?.registryId})`);
  await alice.page.locator('.sheet').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
  await alice.page.getByRole('radio', { name: 'Public catalog' }).click();
  const catalogSec = alice.page.locator('[data-catalog-section]');
  await catalogSec.locator('[data-catalog-every="0"]').waitFor();
  await catalogSec.locator('.empty').waitFor({ timeout: 15000 });
  check(/0 public tracks in English, Hindi/.test((await catalogSec.locator('[data-catalog-count]').innerText()).replace(/\s+/g, ' ')) && (await catalogSec.locator('[data-catalog-entry]').count()) === 0, 'her catalog keeps to her languages: the entry without a language is not shown');
  await catalogSec.locator('[data-catalog-every="0"]').click();
  await catalogSec.locator(`[data-catalog-entry="${published?.trackId}"]`).waitFor({ timeout: 15000 });
  check(/^Only English, Hindi/.test((await catalogSec.locator('[data-catalog-every="1"]').innerText()).trim()), '"Every language" shows it, and offers her languages back');
  await starOn(alice.page, `[data-catalog-entry="${published?.trackId}"] [data-bookmark]`);
  const aliceMarks = await until(async () => {
    const r = (await asUser('alice', 'GET', '/bookmarks')).json;
    return r?.items?.length ? r.items : null;
  });
  check(aliceMarks?.length === 1 && aliceMarks[0].key === `catalog:${published?.trackId}` && aliceMarks[0].registryId === secondRec?.trackId, `the star on a catalog entry keeps it as one, with its registry id (${aliceMarks?.[0]?.key})`);
  // bob, with nothing set, is asked in the catalog too; "Every language" (nothing picked) lists the entry.
  await bob.page.goto(`${base}tracks?${control}#catalog`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-catalog-section] [data-prefs-pick]').waitFor();
  await bob.page.locator('[data-catalog-section] [data-prefs-pick]').selectOption('');
  await bob.page.locator(`[data-catalog-entry="${published?.trackId}"]`).waitFor({ timeout: 15000 });
  check(true, 'the catalog asks a singer without a preference, and shows every language when he picks that');
  await bob.page.locator('[data-catalog-section] [data-prefs-pick]').selectOption('country:India');
  await bob.page.locator('[data-catalog-section] .empty').waitFor({ timeout: 15000 });
  check(/in India/.test((await bob.page.locator('[data-catalog-count]').innerText()).replace(/\s+/g, ' ')), 'his pick of a country keeps the catalog to its languages');
  // A meet: alice hosts (on stage), bob takes a slot — Recommended and the song picker offer every stage singer's bookmarks together, saying whose.
  const meet = (await asUser('alice', 'POST', '/meets', { title: 'Bookmarks meet' })).json?.meet;
  check(Boolean(meet?.meetId), `alice opened a meet (${meet?.meetId})`);
  await alice.page.goto(`${base}meet/${meet.meetId}?${control}`, { waitUntil: 'networkidle' });
  await alice.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 30000 });
  await bob.page.goto(`${base}meet/${meet.meetId}?${control}`, { waitUntil: 'networkidle' });
  await bob.page.getByRole('button', { name: 'Take a stage slot' }).click();
  await bob.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 30000 });
  check(true, 'alice and bob are on the stage');
  const stageMarks = (await asUser('bob', 'GET', `/meets/${meet.meetId}/bookmarks`)).json?.items ?? [];
  const byOf = (key) => stageMarks.find((b) => b.key === key)?.by.map((x) => x.displayName).join('+');
  check(stageMarks.length === 2 && byOf(`registry:${aliceRec.trackId}`) === 'bob' && byOf(`catalog:${published?.trackId}`) === 'alice', `the meet answers both singers' bookmarks, each saying whose (${stageMarks.map((b) => `${b.key} by ${b.by.map((x) => x.displayName).join('+')}`).join(' · ')})`);
  check((await asUser('carol', 'GET', `/meets/${meet.meetId}/bookmarks`)).status === 403, 'an account that is not in the meet gets nothing');
  // bob's Recommended, while in the meet (the room stays mounted as he browses): the stage section first, both bookmarks.
  await bob.page.locator('.topbar a[aria-label="Settings"]').click();
  await bob.page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Tracks', exact: true }).click(); // the menu's (Settings lists the Drive folder of that name too)
  await bob.page.getByRole('radio', { name: 'Recommended' }).click();
  const stageSec = bob.page.locator('[data-rec-stage]');
  await stageSec.locator('[data-bookmark-row]').first().waitFor({ timeout: 20000 });
  const stageRows = await stageSec.locator('[data-bookmark-row]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-bookmark-row')} ${(e.querySelector('[data-bookmark-by]')?.textContent ?? '').trim()}`));
  check(stageRows.length === 2 && stageRows.includes(`registry:${aliceRec.trackId} bookmarked by bob`) && stageRows.includes(`catalog:${published?.trackId} bookmarked by alice`), `Recommended shows what the singers on stage bookmarked, saying whose (${stageRows.join(' · ')})`);
  check(/Bookmarks meet/.test(await stageSec.innerText()), 'and names the meet');
  await bob.page.screenshot({ path: `${out}/tracks-recommended-stage.png`, fullPage: true });
  // Back in the room, the picker offers them too; alice's catalog bookmark — not in bob's library — picked from there goes up for the meet.
  await bob.page.locator('.roompill').getByRole('link', { name: 'Return' }).click();
  await bob.page.getByRole('button', { name: 'Pick your selection of song' }).click();
  await bob.page.locator('[data-picker-marks] [data-picker-mark]').first().waitFor({ timeout: 15000 });
  const pickerMarks = await bob.page.locator('[data-picker-marks] [data-picker-mark]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-picker-mark')} ${(e.querySelector('.from')?.textContent ?? '').trim()}`));
  check(pickerMarks.length === 2 && pickerMarks.includes(`catalog:${published?.trackId} bookmarked by alice`), `the song picker offers the stage's bookmarks first (${pickerMarks.join(' · ')})`);
  await bob.page.screenshot({ path: `${out}/meet-picker-bookmarks.png` });
  await bob.page.locator(`[data-picker-mark="catalog:${published?.trackId}"] [data-picker-mark-pick]`).click();
  await bob.page.getByText(/is up —|is put forward/).waitFor({ timeout: 20000 });
  const meetNow = await until(async () => {
    const m = (await asUser('bob', 'GET', `/meets/${meet.meetId}`)).json?.meet;
    return m?.trackTitle === 'CI Second Song' ? m : null;
  });
  check(Boolean(meetNow) && meetNow.catalogTrackId === published?.trackId && meetNow.registryId === secondRec?.trackId, `picked from alice's bookmark, "CI Second Song" is up for the meet (catalog ${meetNow?.catalogTrackId}, registry ${meetNow?.registryId})`);
  await bob.page.screenshot({ path: `${out}/meet-picked-from-bookmark.png` });
  // Done with the meet: both leave (the slots go), and the room is gone from their tabs.
  for (const p of [alice, bob]) await p.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await asUser('alice', 'POST', `/meets/${meet.meetId}/end`);

  // ---- 5. Unavailable links: a copy stands in; with none left, the Sing fails cleanly ----
  const unshare = (d, f) => {
    f.permissions = f.permissions.filter((p) => p.type !== 'anyone');
  };
  unshare(aliceDrive, aliceFolder);
  const carol = await person('carol');
  await carol.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await carol.page.locator('[data-all-query]').fill('ci sample');
  const carolGroup = carol.page.locator('[data-song-group]').first();
  await carolGroup.waitFor();
  await carolGroup.locator('[data-song-toggle]').click();
  const aliceBranch = carolGroup.locator('[data-artist-branch]').filter({ hasNot: carol.page.locator('[data-artist-branch="Bob Singer"]') }).first();
  await openBranch(aliceBranch);
  await carolGroup.locator(`[data-version="${aliceRec.trackId}"] [data-version-sing]`).click();
  await carol.page.waitForURL(/\/studio\/sing\//, { timeout: 60000 });
  await carol.page.locator('.sing').waitFor();
  const carolDrive = driveOf('carol');
  const carolAudio = [...carolDrive.files.values()].find((f) => f.mimeType.startsWith('audio/'));
  check(Boolean(carolAudio) && Buffer.compare(Buffer.from(carolAudio.bytes), Buffer.from(aliceAudio.bytes)) === 0, "alice unshared her folder — carol still got the song, from bob's shared copy through the service");
  for (const d of drives.values()) for (const f of d.files.values()) unshare(d, f);
  const dave = await person('dave');
  await dave.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await dave.page.locator('[data-all-query]').fill('ci sample');
  const daveGroup = dave.page.locator('[data-song-group]').first();
  await daveGroup.waitFor();
  await daveGroup.locator('[data-song-toggle]').click();
  const daveBranch = daveGroup.locator('[data-artist-branch]').filter({ hasNot: dave.page.locator('[data-artist-branch="Bob Singer"]') }).first();
  await openBranch(daveBranch);
  const countsBeforeFail = (await recordOf('dave', 'CI Sample Song')).record;
  await daveGroup.locator(`[data-version="${aliceRec.trackId}"] [data-version-sing]`).click();
  await dave.page.locator('.toast', { hasText: /no longer shared/ }).waitFor({ timeout: 30000 });
  check(true, 'with every copy unshared, Sing says the files are no longer shared from any singer\'s Drive');
  check(dave.page.url().includes('/tracks'), 'nothing opened');
  check([...driveOf('dave').files.values()].every((f) => f.name !== 'track.json'), 'nothing was saved into his Drive');
  const afterFail = (await recordOf('dave', 'CI Sample Song')).record;
  check(afterFail.accessCount === countsBeforeFail.accessCount && afterFail.lastAccessedAt === countsBeforeFail.lastAccessedAt && !afterFail.mine, 'a failed copy is no access: the counts and the instant stand still, nothing in his history');
  check(afterFail.unavailable === true, 'the record is marked unavailable');
  await dave.page.locator(`[data-version="${aliceRec.trackId}"] .chip`, { hasText: 'unavailable' }).waitFor({ timeout: 15000 });
  check(true, 'and the row says so');
  await dave.page.screenshot({ path: `${out}/tracks-all-unavailable.png`, fullPage: true });

  // ---- 6. Searches never count ----
  for (const q of ['ci', 'sample', 'song', 'bob']) await asUser('dave', 'GET', `/tracks/search?q=${q}`);
  const end = (await recordOf('dave', 'CI Sample Song')).record;
  check(end.accessCount === afterFail.accessCount && end.lastAccessedAt === afterFail.lastAccessedAt && end.accessCount === soFar.accessCount + 1, `searching changed nothing: ${end.accessCount} accesses (bob's and alice's, carol's one), last sung ${end.lastAccessedAt}`);
  check(Object.values(errors).every((v) => v.filter((e) => !/favicon|Failed to load resource|403|404/.test(e)).length === 0), `no page errors (${JSON.stringify(Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v.filter((e) => !/favicon|Failed to load resource|403|404/.test(e))]))).slice(0, 400)})`);
  await carol.ctx.close();
  await dave.ctx.close();
} catch (e) {
  failed = true;
  console.error('FAIL', e);
  await alice.page.screenshot({ path: `${out}/tracks-alice-fail.png`, fullPage: true }).catch(() => {});
  await bob.page.screenshot({ path: `${out}/tracks-bob-fail.png`, fullPage: true }).catch(() => {});
  console.error('errors', JSON.stringify(errors));
}
await browser.close();
google.close();
servers.stop();
process.exit(failed ? 1 : 0);
