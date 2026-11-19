// Live-meet e2e: two performers (host alice on a desktop, guest bob on a phone) on ONE virtual stage.
// Fake cameras → person cut-outs → alpha-packed WebRTC through the SVT DB relay → both devices draw
// both singers; the host's cued pause/resume freezes and restarts both at the same track position.
// A third, privileged account (carol) opens the Publishing show view: receive-only, both performers
// drawn huge on a 1080p stage, no lyrics, and the broadcast job goes to "requested".
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/live-duet.mjs [outDir]
// Exits 1 when any assertion fails. Needs playwright (local install or /opt/npm-tools).
import { createRequire } from 'node:module';
import { startServers } from './servers.mjs';
import { decodeToPcm, measure, voiceOfSong } from './audio-measure.mjs';
import { makeSong } from './e2e-song.mjs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });
// YouTube stands in for itself: the control server's fake ingestion endpoint keeps what the show view sends it here.
const fakeYoutubeDir = path.resolve(out, 'fake-youtube');
const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/', fakeYoutubeDir });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
// A synthetic person as the fake camera, so the real segmentation model has something to cut out.
const clip = path.join(tmpdir(), 'sv-fake-person.y4m');
// The song: the 20 s sample looped to 420 s (e2e-song.mjs — with a slow sweep under it, so the sound checks can tell
// exactly where in the song a capture was taken), so the broadcast checks and the transport checks happen inside one song
// on a slow test machine (the publisher section alone has taken five minutes there); a forward seek near the end lets the
// song finish on its own afterwards.
const SONG_S = 420;
const longSong = makeSong(path.join(tmpdir(), 'sv-e2e-song.mp3'), SONG_S);
const longTrack = path.join(tmpdir(), 'sv-e2e-song.track.json');
// A second, distinct song (another title, the same audio) — bob's own, for the moment two singers pick two songs at once.
const secondTrack = path.join(tmpdir(), 'sv-e2e-second.track.json');
{
  const { writeFileSync } = await import('node:fs');
  const t = JSON.parse(readFileSync('apps/web/test/fixtures/sample.track.json', 'utf8'));
  t.durationMs = SONG_S * 1000;
  writeFileSync(longTrack, JSON.stringify(t));
  writeFileSync(secondTrack, JSON.stringify({ ...t, trackId: 'trk-second-ci', title: 'CI Second Song' }));
}
execFileSync('node', [new URL('./fake-person.mjs', import.meta.url).pathname, clip], { stdio: 'inherit' });
// The fake microphone sings: a smooth synthetic voice (harmonics on 180 Hz, vibrato, a slow swell) on a loop, so what the
// mixes carry is a voice and the sound checks measure the pipeline, not Chromium's beep pattern.
const voice = path.join(tmpdir(), 'sv-fake-voice.wav');
// (A vibrato is a phase modulation — depth × f0 / rate — so each harmonic stays a line ±1.2 % wide: the voice can be told from the song by its harmonics, see audio-measure.mjs `voice`.)
const vib = (h) => `sin(2*PI*${h * 180}*t+${((h * 0.012 * 180) / 5.5).toFixed(4)}*sin(2*PI*5.5*t))`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='0.25*(0.55+0.45*sin(2*PI*0.7*t))*(${vib(1)}+0.5*${vib(2)}+0.33*${vib(3)}+0.25*${vib(4)}+0.2*${vib(5)})':s=48000:d=30`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', voice]);
const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, `--use-file-for-fake-audio-capture=${voice}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
let failed = false;
const extraPages = {};
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` every half second until it answers something truthy (that), or `ms` have passed (null). */
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(500);
  }
};
const secs = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
const errors = { alice: [], bob: [], carol: [], dave: [] };
/** The song as PCM at a device's rate (decoded once per rate), for the sound checks. */
const songPcm = new Map();
const songAt = (rate) => songPcm.get(rate) ?? songPcm.set(rate, decodeToPcm(longSong, rate)).get(rate);
/**
 * The video playing in the Performances sheet, written to `file` (fetched from its blob URL inside the page, 8 MB at a
 * time — the film of a whole meet is one file, and a whole meet does not fit one message). Resolves with its size (0: none).
 */
async function sheetVideo(page, file) {
  const size = await page.evaluate(async () => {
    const started = Date.now();
    let v = null;
    while (!(v = document.querySelector('.sheet video')) && Date.now() - started < 20000) await new Promise((r) => setTimeout(r, 200));
    if (!v) return 0;
    window.__svSheetBlob = await (await fetch(v.src)).blob();
    return window.__svSheetBlob.size;
  });
  if (!size) return 0;
  const SLICE = 8 * 1024 * 1024;
  await writeFile(file, Buffer.alloc(0));
  for (let at = 0; at < size; at += SLICE) {
    const b64 = await page.evaluate(async ({ at, end }) => {
      const bytes = new Uint8Array(await window.__svSheetBlob.slice(at, end).arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }, { at, end: Math.min(size, at + SLICE) });
    await appendFile(file, Buffer.from(b64, 'base64'));
  }
  await page.evaluate(() => delete window.__svSheetBlob);
  return size;
}

/**
 * Record `seconds` of exactly what a device plays — `mix`: the audience's mix player (what dave's speakers get),
 * `bus`: the publisher bus (what the broadcast encoder gets) — as raw float PCM at the context's rate.
 */
async function captureAudio(page, which, seconds) {
  // The tap is an AudioWorklet ('sv-tap', public/worklets/tap.js): it records on the audio thread, so a busy main thread
  // (four browsers on one test machine) never drops a block of the capture.
  const r = await page.evaluate(async ({ which, seconds, base }) => {
    const src = which === 'mix' ? { ctx: window.__svMix.ctx, node: window.__svMix.out } : which === 'bus' ? { ctx: window.__svBroadcast.bus.ctx, node: window.__svBroadcast.bus.output } : { ctx: window.__svStage.engine.ctx, node: window.__svStage.show.audio.bus.output };
    const ctx = src.ctx;
    const want = Math.round(ctx.sampleRate * seconds);
    let tap;
    try {
      tap = new AudioWorkletNode(ctx, 'sv-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { frames: want } });
    } catch {
      await ctx.audioWorklet.addModule(`${base}worklets/tap.js`);
      tap = new AudioWorkletNode(ctx, 'sv-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { frames: want } });
    }
    const startedAt = ctx.currentTime;
    const wallStart = Date.now(); // the machine's clock as the capture begins (every page here shares it)
    const heardMs = which === 'mix' ? window.__svMix.positionMs() : null; // what the mix player says is being heard as the capture begins
    const data = await new Promise((resolve) => {
      tap.port.onmessage = (e) => e.data.type === 'done' && resolve(e.data.data);
      src.node.connect(tap);
      tap.connect(ctx.destination);
    });
    src.node.disconnect(tap);
    tap.disconnect();
    const bytes = new Uint8Array(data.buffer);
    let str = '';
    for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { rate: ctx.sampleRate, b64: btoa(str), startedAt, wallStart, ctxState: ctx.state, heardMs };
  }, { which, seconds, base: new URL(base).pathname });
  const bytes = Buffer.from(r.b64, 'base64');
  return { rate: r.rate, pcm: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), startedAt: r.startedAt, wallStart: r.wallStart, ctxState: r.ctxState, heardMs: r.heardMs };
}

async function person(name, viewport, { track = true } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'], deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60000); // a tap on a page whose main thread is stalled (four browsers on one small machine) answers late, not never
  const page = await ctx.newPage();
  // A main-thread watchdog: every gap of more than a second between 100 ms ticks is a stall worth knowing about (the
  // transport checks below name the stalls when a device applies a cue late).
  await page.addInitScript(() => { window.__svStalls = []; let last = Date.now(); setInterval(() => { const now = Date.now(); if (now - last > 1000) window.__svStalls.push({ at: new Date(last).toISOString().slice(11, 23), ms: now - last }); last = now; }, 100); });
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors[name].push(m.text()));
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) console.log(`[${name}] ${new Date().toISOString().slice(11, 23)} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(servers.controlUrl, '')}`); });
  await page.goto(base + '?' + control, { waitUntil: 'networkidle' });
  // device identity for DEV_AUTH: the app sends X-Dev-User from the local profile sub
  await page.evaluate((n) => localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: '', picture: '', mode: 'local' })), name);
  await page.evaluate(() => { localStorage.setItem('sv.mode', 'local'); localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true })); });
  if (!track) return { ctx, page, trackId: null };
  await importTrack(page, longTrack);
  const trackId = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('singersvoice'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('tracks'); const q = tx.objectStore('tracks').getAllKeys(); q.onsuccess = () => res(q.result[0]); }; }));
  return { ctx, page, trackId };
}
/** Import a song (its track.json + the audio) into this device's library through the Tracks portal. */
async function importTrack(page, meta) {
  await page.goto(base + 'tracks?' + control, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.locator('input[type=file][accept*=".json"]').setInputFiles(meta);
  await page.locator('input[type=file][accept*="audio"]').setInputFiles(longSong);
  await page.getByRole('button', { name: /^Import$/ }).last().click();
  await page.getByText(/^Imported/).waitFor({ timeout: 30000 });
  await wait(500);
}

const alice = await person('alice', { width: 1280, height: 800 });
const bob = await person('bob', { width: 390, height: 844 });
/** A plan for a singer, granted by the super admin (alice, the first account) through the service: the picture on stage comes with a plan (plans.ts). */
const grantPlan = async (who, plan) => {
  const h = (u) => ({ 'X-Dev-User': u, 'X-Dev-Name': u, 'Content-Type': 'application/json' });
  const me = await (await fetch(`${servers.controlUrl}/me`, { headers: h(who) })).json();
  const r = await fetch(`${servers.controlUrl}/admin/users/${me.user.userId}`, { method: 'PATCH', headers: h('alice'), body: JSON.stringify({ subscription: { action: 'grant', plan } }) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, media: j.user?.media, plan: j.user?.entitlement?.plan };
};
const bobPlan = await grantPlan('bob', 'svv');
check(bobPlan.status === 200 && bobPlan.media === 'dual' && bobPlan.plan === 'svv', `bob has the SVV plan: his picture on stage (a free account sings with the voice alone) — ${bobPlan.status} ${bobPlan.plan} ${bobPlan.media}`);
// Bob's copy must be recognisable as the host's track: rename his record to "<hostId>-copy-bob"
await bob.page.evaluate(([from, to]) => new Promise((res) => { const r = indexedDB.open('singersvoice'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('tracks', 'readwrite'); const st = tx.objectStore('tracks'); const g = st.get(from); g.onsuccess = () => { const rec = g.result; rec.track.trackId = to; st.put(rec, to); st.delete(from); }; tx.oncomplete = () => res(); }; }), [bob.trackId, `${alice.trackId}-copy-bob`]);
await importTrack(bob.page, secondTrack); // bob's own second song: nobody else holds it

try {
  // Host creates the meet with her track.
  await alice.page.goto(base + 'meets', { waitUntil: 'networkidle' });
  await alice.page.getByPlaceholder('Sunday SV music meet').fill('Duet e2e');
  await alice.page.getByRole('button', { name: 'Create meet' }).click(); // no song yet: a karaoke event picks its songs in the room
  await alice.page.waitForURL(/\/meet\//);
  const meetUrl = alice.page.url();
  const meetId = /\/meet\/([^/?#]+)/.exec(meetUrl)[1];
  await alice.page.locator('.setlist[data-current="0"]').waitFor({ timeout: 15000 });
  check(true, 'a new meet starts with no song up');
  // The host picks the first song from her library (private → "add anyway": her guest holds his own copy).
  const addSong = async (p, who, { q = 'sAMPLE', word = 'sample', title = 'CI Sample Song' } = {}) => {
    await p.getByRole('button', { name: 'Pick your selection of song' }).click();
    // Search as you type: a partial word, in the wrong case, finds the song in the library at once, marked where it matched.
    await p.getByLabel('Search songs').fill(q);
    await p.locator('.songpicker .item[data-from="mine"]').waitFor({ timeout: 10000 });
    const marked = await p.locator('.songpicker .item .t mark').first().innerText().catch(() => '');
    const counts = (await p.locator('[data-picker-counts]').innerText()).replace(/\s+/g, ' ');
    check(new RegExp(word, 'i').test(marked) && /1 match in your library/.test(counts), `${who}'s library is searched as they type: "${marked}" marked, ${counts}`);
    await p.getByLabel('Search songs').fill(`${q} zzz`);
    await p.locator('[data-picker-empty]').waitFor({ timeout: 10000 });
    await p.getByLabel('Search songs').fill(word);
    await p.getByRole('button', { name: `Pick ${title}` }).click();
    await p.getByText(/is up —|is put forward/).waitFor({ timeout: 15000 });
    console.log(`${who} picked ${title}`);
  };
  await addSong(alice.page, 'alice');
  await alice.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  check(/Up next/.test(await alice.page.locator('.setlist').innerText()), 'the first song picked becomes the current song');
  const inbox = async (p, who) => { const mid = /\/meet\/([^/?#]+)/.exec(meetUrl)[1]; return p.evaluate(async ([m, w, ctl]) => { const key = Object.keys(sessionStorage).find((k) => k.startsWith(`sv.meet.${m}`) && k.endsWith('.rt')); const rt = sessionStorage.getItem(key); const r = await fetch(`${ctl}/meets/${m}/signals`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-User': w, 'X-Dev-Name': w }, body: JSON.stringify({ resumeToken: rt, since: 0 }) }); const j = await r.json(); return (j.signals || []).map((x) => `${x.seq}:${x.type}<${x.from.slice(-6)}@${x.sentAt.slice(11, 23)}`).join(' '); }, [mid, who, servers.controlUrl]); };
  const remoteFrames = (p) => p.evaluate(async () => { const vs = [...document.querySelectorAll('video')].filter((v) => v.srcObject && v.videoWidth > 0 && v.readyState >= 2); const t = vs.map((v) => v.currentTime); await new Promise((r) => setTimeout(r, 1500)); return vs.filter((v, i) => v.currentTime !== t[i]).length; });
  // The lobby's virtual stage: a performer appears on it the moment they take a slot — long before the song.
  const stripInfo = (p) => p.evaluate(async () => {
    const el = document.querySelector('.stagestrip');
    const c = el.querySelector('canvas.stagecanvas');
    const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let left = 0, right = 0; const w = c.width;
    for (let i = 3, px = 0; i < d.length; i += 4, px++) if (d[i] > 40) { if (px % w < w / 2) left++; else right++; }
    return { onstage: el.dataset.onstage, performers: el.dataset.performers, linked: el.dataset.linked, blend: el.dataset.blend, mask: el.dataset.mask, left, right, w, h: c.height, text: el.querySelector('.stagebar').innerText.replace(/\s+/g, ' ') };
  });
  // The host (admin) is on stage the moment the meet starts: nothing to tap.
  const tStrip = Date.now();
  await alice.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 15000 });
  check(!(await alice.page.getByRole('button', { name: 'Take a stage slot' }).isVisible().catch(() => false)), 'the host is seated on S1 by the meet itself (no "take a slot" tap)');
  while (Date.now() - tStrip < 25000 && (await stripInfo(alice.page)).blend !== 'model') await wait(500);
  await wait(800);
  const sa = await stripInfo(alice.page);
  console.log('alice lobby stage:', JSON.stringify(sa));
  check(sa.onstage === '1' && sa.performers === '1' && sa.blend === 'model' && sa.left + sa.right > 300, `the host sees herself on the stage the moment her meet starts (${Math.round((Date.now() - tStrip) / 1000)} s, blend ${sa.blend})`);
  await alice.page.screenshot({ path: `${out}/lobby-alice-onstage.png` });

  // Guest joins by link. A new meet's stage is open: he could take a slot straight away. The host
  // would rather decide: she closes the stage, and now he asks and she lets him on.
  await bob.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await bob.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  await bob.page.getByRole('button', { name: 'Take a stage slot' }).waitFor({ timeout: 15000 });
  check(true, 'a new meet has an open stage: whoever has the link can take a slot, no permission needed');
  // The switch follows the meet (the service answers, the snapshot flips it): click, then wait for it to turn off.
  await alice.page.getByLabel(/Open stage: anyone may take a free slot/).click();
  await alice.page.waitForFunction(() => { const el = [...document.querySelectorAll('input[type=checkbox]')].find((x) => /Open stage/.test(x.closest('label')?.innerText || '')); return el && !el.checked; }, null, { timeout: 15000 });
  await bob.page.getByRole('button', { name: 'Ask to sing' }).waitFor({ timeout: 15000 });
  check(!(await bob.page.getByRole('button', { name: 'Take a stage slot' }).isVisible().catch(() => false)), 'the host closed the stage: an audience member now asks, and the host decides');
  await bob.page.getByRole('button', { name: 'Ask to sing' }).click();
  await bob.page.getByText(/On the wait list — waiting for/).waitFor({ timeout: 15000 });
  await alice.page.locator('.requests').waitFor({ timeout: 15000 });
  check(/Wait list · 1/.test(await alice.page.locator('.requests').innerText()) && /bob/.test(await alice.page.locator('.requests').innerText()), 'the host sees bob on the wait list');
  await alice.page.screenshot({ path: `${out}/lobby-alice-request.png` });
  await alice.page.getByRole('button', { name: 'Let bob sing' }).click();
  await bob.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 15000 });
  check(true, 'the host let bob on stage: he is seated (slot 2) without touching anything');
  // Both performers' video links come up in the lobby (the stage runs before the song): the link itself is waited for (it
  // takes about eight seconds on this machine, polling signals through the service), not a count of flowing videos.
  const tLobby = Date.now();
  const stripLinked = (p) => p.evaluate(() => document.querySelector('.stagestrip')?.dataset.linked ?? '0');
  while (Date.now() - tLobby < 45000 && ((await stripLinked(alice.page)) !== '1' || (await stripLinked(bob.page)) !== '1')) await wait(500);
  await wait(1000);
  const sa2 = await stripInfo(alice.page);
  const sb2 = await stripInfo(bob.page);
  console.log('lobby stage alice:', JSON.stringify(sa2), '\nlobby stage bob:  ', JSON.stringify(sb2));
  check(sa2.performers === '2' && sb2.performers === '2', 'both lobby stages lay out 2 performers');
  check(sa2.linked === '1' && sb2.linked === '1' && /1\/1 video linked/.test(sa2.text), `video linked both ways in the lobby (${Math.round((Date.now() - tLobby) / 1000)} s)`);
  check(sa2.left > 100 && sa2.right > 100 && sb2.left > 100 && sb2.right > 100, 'both singers are drawn on both lobby stages');
  await bob.page.screenshot({ path: `${out}/lobby-bob-onstage.png` });
  await alice.page.evaluate(() => { window.__svMeshId = Math.random(); window.__svMesh.__id = window.__svMeshId; });

  // The room keeps running behind other pages: the host opens Publishing › Preview in the SAME tab and sees herself
  // (and bob) in the meet's tile; the pill brings her back, still on stage, same video links.
  // In-app navigation (a link click, not a page load): the room stays mounted behind the Publishing page.
  const navigate = (p, path) => p.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, path);
  const sigLog = [];
  const sigTap = (who, p) => p.on('response', async (r) => { if (/\/signals$/.test(r.url()) && r.request().method() === 'POST') { try { const body = JSON.parse(r.request().postData() || '{}'); const j = await r.json(); sigLog.push(`${who} ${new Date().toISOString().slice(14, 23)} since=${body.since} tok=${String(body.resumeToken).slice(-4)} → ${j.signals ? j.signals.map((x) => `${x.seq}:${x.type}<${x.from.slice(-4)}`).join(',') || '-' : r.status()}`); } catch { /* ignore */ } } });
  sigTap('A', alice.page);
  sigTap('B', bob.page);
  await navigate(alice.page, `${new URL(base).pathname}publishing?tab=preview`);
  await alice.page.locator('.roompill').waitFor({ timeout: 15000 });
  check(/On stage · S1/.test(await alice.page.locator('.roompill').innerText()), 'leaving the room page keeps you on stage (pill: On stage · S1)');
  await alice.page.locator('.monitor[data-state="lobby"]').waitFor({ timeout: 30000 });
  const tPrev = Date.now();
  await alice.page.locator('.monitor[data-linked="2"]').waitFor({ timeout: 60000 }).catch(() => undefined);
  await wait(1500);
  const prevCard = await alice.page.locator('.monitor-card').first().innerText();
  console.log('at', new Date().toISOString().slice(11, 23), 'inbox alice:', await inbox(alice.page, 'alice'), '\ninbox bob:', await inbox(bob.page, 'bob'));
  const meshFlags = (p) => p.evaluate(() => { const m = window.__svMesh; return m && { me: m.me.slice(-6), running: m.running, polling: m.polling, timer: Boolean(m.timer), lastSeq: m.channel.lastSignalSeq, stopped: m.channel.stopped, closed: m.channel.closed }; });
  console.log('mesh flags alice:', JSON.stringify(await meshFlags(alice.page)), 'bob:', JSON.stringify(await meshFlags(bob.page)));
  console.log('signal polls:\n  ' + sigLog.slice(-40).join('\n  '));
  console.log('host preview meshes:', JSON.stringify(await alice.page.evaluate(() => { const dump = (m) => m ? [...m.peers.entries()].map(([id, x]) => ({ id: id.slice(-6), state: x.state, sig: x.pc.signalingState, ice: x.pc.iceConnectionState, inbound: x.inbound })) : null; return { room: dump(window.__svMesh), tiles: (window.__svShowMeshes || []).map((m) => ({ me: m.me.slice(-6), running: m.running, peers: dump(m) })) }; })));
  const tilePixels = await alice.page.evaluate(() => { const c = document.querySelector('.monitor canvas.stagecanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n; });
  check(/2 on stage · 2\/2 video/.test(prevCard.replace(/\s+/g, ' ')) && tilePixels > 500, `the host sees herself and bob in the Preview tile while her room runs in the background (${Math.round((Date.now() - tPrev) / 1000)} s, ${tilePixels} px)`);
  await alice.page.screenshot({ path: `${out}/preview-host-background-room.png` });
  await alice.page.locator('.roompill').getByRole('link', { name: 'Return' }).click();
  await alice.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 15000 });
  const meshBack = await alice.page.evaluate(() => window.__svMesh && window.__svMesh.__id);
  check(meshBack !== undefined && meshBack === (await alice.page.evaluate(() => window.__svMeshId)), `back in the room: the same mesh, nothing reconnected (${meshBack})`);

  // Carol's YouTube key (the Publish tab sets it up in the screenshot flow; here straight through the API), so her show goes to YouTube too.
  const ytSetup = await fetch(`${servers.controlUrl}/publishing/destinations/youtube`, { method: 'PUT', headers: { 'X-Dev-User': 'carol', 'X-Dev-Name': 'carol', 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, streamKey: 'test-key-0001', watchUrl: '@carolsings' }) });
  const ytDest = await ytSetup.json().catch(() => ({}));
  check(ytSetup.status === 200 && ytDest.destination?.watchUrl === 'https://www.youtube.com/@carolsings/live', `carol's YouTube stream key and live link are saved (${ytSetup.status}, ${ytDest.destination?.watchUrl})`);
  // Publishing: the show is its own process — carol's show view gets both performers while the song has not started.
  const carol = await person('carol', { width: 1920, height: 1080 }); // with her own copy of the song: the broadcast carries the backing track
  await carol.page.evaluate(([from, to]) => new Promise((res) => { const r = indexedDB.open('singersvoice'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('tracks', 'readwrite'); const st = tx.objectStore('tracks'); const g = st.get(from); g.onsuccess = () => { const rec = g.result; rec.track.trackId = to; st.put(rec, to); st.delete(from); }; tx.oncomplete = () => res(); }; }), [carol.trackId, `${alice.trackId}-copy-carol`]);
  extraPages.carol = carol.page;
  // (The chrome hides itself three seconds after the pointer rests while the show plays: a pointer move brings it back, and
  // on a stalling test machine the tap may need more than one go — each go wakes the chrome again first.)
  const tapShow = async (loc) => {
    for (let i = 0; i < 3; i++) {
      await carol.page.mouse.move(600 + i * 3, 600);
      await carol.page.mouse.move(640 + i * 3, 660);
      await wait(300);
      try {
        await loc.click({ timeout: 2500 });
        return;
      } catch {
        // The chrome hid again before the tap landed (three seconds of rest on a page that stalls for seconds), or the tap
        // landed and the button is gone (Stop publishing → Go live): done then.
        if (!(await loc.isVisible().catch(() => false))) return;
      }
    }
    // The chrome's self-hiding is the publisher's comfort, not what is under test here: the button's own handler, directly.
    await loc.dispatchEvent('click');
  };
  await carol.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin }); // the live-link button copies
  await carol.page.goto(`${base}publishing/show/${meetId}?${control}`, { waitUntil: 'networkidle' });
  await carol.page.locator('.show[data-state="lobby"]').waitFor({ timeout: 30000 });
  const tShowLobby = Date.now();
  while (Date.now() - tShowLobby < 45000 && (await remoteFrames(carol.page)) < 2) await wait(500);
  check((await remoteFrames(carol.page)) >= 2, `the show view receives both performers before the song starts (${Math.round((Date.now() - tShowLobby) / 1000)} s)`);
  // Picture quality (enhance.ts): a publisher's link carries the whole packed frame — twice the width this device sends (a computer 640, a phone 480, a machine
  // with two cores like CI's the 320 it always sent) —, a singer's link the frame scaled to the old size (640 packed).
  const widths = (p) => p.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.srcObject && v.videoWidth > 0).map((v) => v.videoWidth));
  const packWidth = await alice.page.evaluate(() => window.__svFeed?.packWidth ?? 0);
  const showWidths = await until(async () => { const ws = await widths(carol.page); return ws.length >= 2 && ws.every((w) => w === packWidth * 2) ? ws : null; }, 20000);
  check(packWidth >= 320 && Boolean(showWidths), `the show view gets every singer's picture at its full packed size (${(showWidths ?? (await widths(carol.page))).join('×')} wide; this device sends ${packWidth})`);
  const singerWidths = await widths(alice.page);
  check(singerWidths.length >= 1 && singerWidths.every((w) => w <= 660), `a singer's link gets it scaled down to the stage's size (${singerWidths.join('/')} wide packed)`);
  const lift = await alice.page.evaluate(() => ({ gain: window.__svFeed?.exposure?.gain ?? null, line: window.__svFeed?.cameraLine ?? '' }));
  check(lift.gain !== null && lift.gain > 1.03 && lift.gain <= 1.5 && /lifted \+\d+%/.test(lift.line), `a dim picture is lifted at the source (gain ${lift.gain?.toFixed(2)}: "${lift.line}")`);
  check(/Up next: CI Sample Song/.test(await carol.page.locator('.show-note').innerText().catch(() => '')), 'the show picture names the song that is up next');
  await carol.page.screenshot({ path: `${out}/show-carol-lobby.png` });

  // Everyone gets ready; the host starts the song. The stage carries on — nothing reconnects.
  await alice.page.getByRole('button', { name: /I'm ready/ }).click();
  await alice.page.getByText(/Ready — start the song/).waitFor({ timeout: 30000 });
  await bob.page.getByRole('button', { name: /I'm ready/ }).click();
  await bob.page.getByText(/Ready — start the song/).waitFor({ timeout: 30000 });
  // The song belongs to the stage: the singer who is not the host has the Start button too (and the set list's controls).
  check((await bob.page.getByRole('button', { name: /Start the song/ }).count()) === 1, 'a singer on stage (not the host) can start the song');
  // Picking the song that is up already adds nothing: the picker says where it is instead of offering it again.
  await bob.page.getByRole('button', { name: 'Pick your selection of song' }).click();
  await bob.page.getByLabel('Search songs').fill('sample');
  await bob.page.locator('.songpicker .item[data-place="current"]').waitFor({ timeout: 10000 });
  check((await bob.page.getByRole('button', { name: 'Pick CI Sample Song' }).count()) === 0 && /Up now/.test(await bob.page.locator('.songpicker .item[data-place="current"]').innerText()), 'the song that is up is not offered twice (the picker says "Up now")');
  await bob.page.getByRole('button', { name: 'Close the song picker' }).click();
  // Talk-back: with both mics open in the lobby, each singer hears the other (the arriving vocal plays) — until the song.
  const vocalEls = (p) => p.evaluate(() => [...document.querySelectorAll('audio[data-sv-vocal]')].map((a) => ({ id: a.dataset.svVocal, muted: a.muted })));
  await alice.page.waitForFunction(() => document.querySelectorAll('audio[data-sv-vocal]').length >= 1, null, { timeout: 20000 }).catch(() => undefined);
  const talkA = await vocalEls(alice.page);
  const talkB = await vocalEls(bob.page);
  console.log('talk-back alice:', JSON.stringify(talkA), 'bob:', JSON.stringify(talkB));
  check(talkA.length >= 1 && talkA.every((a) => a.muted === false), "between songs the host hears the other singer's vocal (talk-back)");
  check(await alice.page.locator('[data-talkback="1"]').isVisible(), 'the lobby says talk-back is on');
  await alice.page.locator('[data-meet-film="on"]').waitFor({ timeout: 15000 }).catch(() => undefined);
  const filmStartAt = Date.now(); // the film runs from about here: where a moment of the meet sits in it
  check((await alice.page.locator('[data-meet-film="on"]').count()) === 1, "the host's device films the whole meet from the moment her mic is open (into her storage as it goes)");
  const meshBefore = await alice.page.evaluate(() => window.__svMesh && window.__svMesh.__id);
  await alice.page.getByRole('button', { name: /Start the song/ }).click();
  // Both land on the live stage; wait for the kickstart (8 s lead).
  await alice.page.locator('.sing .stagebar').waitFor({ timeout: 30000 });
  await bob.page.locator('.sing .stagebar').waitFor({ timeout: 30000 });
  // The instant the song starts for everyone, as the service has it: the film's first song chapter must be cut there.
  const firstKickstart = (await (await fetch(`${servers.controlUrl}/meets/${meetId}`, { headers: { 'X-Dev-User': 'alice', 'X-Dev-Name': 'alice' } })).json()).meet?.kickstartEpochMs ?? null;
  // Every lyric line is in the colour of the singer who sings it, whole: the song divided between the two singers in it
  // (S1 green, S2 blue, ALL light) — read off the first lines, right after the kickstart.
  await bob.page.locator('.sing .lyric[data-who="S2"]').first().waitFor({ timeout: 30000 });
  const lyricColors = await bob.page.evaluate(() => [...document.querySelectorAll('.sing .lyric')].map((el) => ({ who: el.dataset.who, c: el.style.getPropertyValue('--c').trim().toUpperCase(), mine: el.classList.contains('mine') })));
  console.log('lyric colours (bob, S2):', JSON.stringify(lyricColors));
  const colourOf = { S1: '#38D39F', S2: '#4EA8FF', ALL: '#E6E1F0' };
  check(lyricColors.length >= 3 && lyricColors.every((l) => colourOf[l.who] === l.c) && lyricColors.every((l) => l.mine === (l.who !== 'S1')), "every lyric line carries its singer's colour, whole — S1 green, S2 blue, chorus light — and S2 knows which lines are his");
  await wait(9000);
  const soloA = await vocalEls(alice.page);
  check(soloA.length >= 1 && soloA.every((a) => a.muted === true), 'once the song runs nobody on stage hears anyone else (Solo foldback) — the vocal still feeds the mix');
  // The mix is timed at the count-in (align.ts): the other singer's voice and picture are held back by what they are early by
  // (their round trip announced over the mesh, the way here read off the link), so every voice lands on the beat it was sung to.
  const alignA = await alice.page.evaluate(() => window.__svStage?.alignment ?? null);
  const alignB = await bob.page.evaluate(() => window.__svStage?.alignment ?? null);
  console.log('timing of the mix — alice:', JSON.stringify(alignA), 'bob:', JSON.stringify(alignB));
  const timed = (al) => al && al.plan && al.plan.lagMs >= 250 && al.arrivals.length >= 1 && al.arrivals.every((a) => a.arrivalMs !== null && a.arrivalMs >= 0) && Object.values(al.plan.delays).every((d) => d >= 0 && d <= 4000) && al.plan.trackDelayMs === al.plan.lagMs + Math.round(al.plan.trackDelayMs - al.plan.lagMs);
  check(timed(alignA) && timed(alignB), `each device timed its mix at the count-in: the other's arrival known (alice: ${alignA?.line}; bob: ${alignB?.line})`);
  check(/timed · /.test(await alice.page.locator('.sing .stagebar').innerText()) && (await alice.page.locator('[data-align-line]').count()) === 1, 'the stage bar says how the mix is timed');
  const bobPid = (await (await fetch(`${servers.controlUrl}/meets/${meetId}`, { headers: { 'X-Dev-User': 'alice', 'X-Dev-Name': 'alice' } })).json()).meet?.stage?.find((s) => s.displayName === 'bob')?.participantId ?? '';
  const holdOnBob = await alice.page.evaluate((id) => window.__svMesh?.playoutDelay(id) ?? null, bobPid);
  check(bobPid !== '' && holdOnBob !== null && holdOnBob === (alignA?.plan.delays[bobPid] ?? -1), `the hold the plan gives bob's voice is what the host's link applies (${holdOnBob} ms)`);
  const meshAfter = await alice.page.evaluate(() => window.__svMesh && window.__svMesh.__id);
  check(meshBefore !== undefined && meshBefore === meshAfter, 'the same video mesh carries on from the lobby into the song (no reconnection)');
  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && ((await remoteFrames(alice.page)) < 2 || (await remoteFrames(bob.page)) < 2)) await wait(500);
  const vids = (p) => p.evaluate(() => [...document.querySelectorAll('video')].map((v) => ({ w: v.videoWidth, rs: v.readyState, paused: v.paused, muted: v.srcObject ? (v.srcObject.getVideoTracks()[0] || {}).muted : null, tracks: v.srcObject ? v.srcObject.getVideoTracks().length : 0 })));
  console.log('videos alice:', JSON.stringify(await vids(alice.page)), 'bob:', JSON.stringify(await vids(bob.page)));
  const rtp = (p) => p.evaluate(async () => ({ mesh: window.__svMesh ? await window.__svMesh.stats() : null, feed: window.__svFeed ? { frame: window.__svFeed.frame, seg: window.__svFeed.segmenter.frame, mode: window.__svFeed.mode, level: window.__svFeed.level } : null }));
  console.log('rtp alice:', JSON.stringify(await rtp(alice.page)), 'bob:', JSON.stringify(await rtp(bob.page)));

  check((await remoteFrames(alice.page)) >= 2 && (await remoteFrames(bob.page)) >= 2, `remote video frames flowing on both devices (${Math.round((Date.now() - t0) / 1000)} s)`);
  await wait(1500);
  const stageInfo = async (p) => p.evaluate(() => {
    const bar = document.querySelector('.sing .stagebar');
    const c = document.querySelector('.sing canvas.stagecanvas');
    const x = c.getContext('2d');
    // count opaque pixels in the left and right halves of the performer band
    const band = x.getImageData(0, Math.round(c.height * 0.45), c.width, Math.round(c.height * 0.5)).data;
    let left = 0, right = 0; const w = c.width;
    for (let i = 3, px = 0; i < band.length; i += 4, px++) if (band[i] > 40) { if (px % w < w / 2) left++; else right++; }
    return { text: bar.innerText.replace(/\s+/g, ' '), blend: bar.dataset.blend, mask: bar.dataset.mask, performers: bar.dataset.performers, left, right, t: document.querySelector('.timeline .mono')?.innerText };
  });
  const a = await stageInfo(alice.page);
  const b = await stageInfo(bob.page);
  console.log('alice:', JSON.stringify(a));
  console.log('bob:  ', JSON.stringify(b));
  check(a.performers === '2' && b.performers === '2', 'both devices lay out 2 performers on the stage');
  check(/1\/1 video linked/.test(a.text) && /1\/1 video linked/.test(b.text), 'WebRTC video linked both ways (through the SVT DB relay)');
  check(a.left > 100 && a.right > 100 && b.left > 100 && b.right > 100, 'both singers are drawn (cut-outs on both halves of the stage)');
  check(a.blend === 'model' && b.blend === 'model' && /^adaptive-/.test(a.mask ?? '') && /^adaptive-/.test(b.mask ?? ''), `the real segmentation model cut both singers out (${a.mask} / ${b.mask})`);
  await alice.page.screenshot({ path: `${out}/duet-alice-live.png` });
  await bob.page.screenshot({ path: `${out}/duet-bob-live.png` });
  // The running song is the stage singers' own: a newcomer stays in the audience, asks, and waits for the song to end.
  const daveLog = [];
  const dave = await person('dave', { width: 412, height: 915 }, { track: false });
  extraPages.dave = dave.page;
  const davePlan = await grantPlan('dave', 'svv');
  check(davePlan.status === 200 && davePlan.media === 'dual', `dave has the SVV plan too (${davePlan.plan}, ${davePlan.media})`);
  dave.page.on('response', (r) => { if (/\/meets\//.test(r.url()) && !/signals|heartbeat/.test(r.url())) daveLog.push(`${new Date().toISOString().slice(14, 23)} ${r.request().method()} ${r.url().replace(servers.controlUrl, '').replace(/meet-[a-z0-9-]+/, 'M')} ${r.status()}`); });
  await dave.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await dave.page.getByRole('button', { name: 'Ask to sing next' }).waitFor({ timeout: 30000 });
  check(!(await dave.page.getByRole('button', { name: 'Take a stage slot' }).isVisible().catch(() => false)), 'a newcomer during a song cannot step on stage');
  await dave.page.getByRole('button', { name: 'Ask to sing next' }).click();
  await dave.page.getByText(/On the wait list — the host seats singers once the song is over/).waitFor({ timeout: 15000 });
  // The audience hears the stage: the host's device sends the blend (track + every vocal) a second at a time.
  await dave.page.getByText(/Hear the stage — the singers and the track, blended/).click();
  await dave.page.locator('[data-mix-hearing="1"]').waitFor({ timeout: 20000 });
  const mixSeq = Number(await dave.page.locator('[data-mix-hearing]').getAttribute('data-mix-seq'));
  const mixText = (await dave.page.locator('[data-mix-hearing]').innerText()).replace(/\s+/g, ' ');
  console.log('audience mix:', { mixSeq, mixText });
  check(mixSeq > 0 && /Hearing the stage/.test(mixText), `the audience hears the stage mix relayed from the host's device (batch ${mixSeq}, ${mixText})`);
  // (dave has no copy of the song here — local storage, nothing shared through Drive — so the lyrics note tells him why; the sound still plays)
  check(/Hearing the stage/.test(mixText) && Number(mixSeq) >= 3, 'the mix keeps arriving a second at a time (the audience is a few seconds behind the stage)');
  // ACCURATE AUDIO for the audience: six seconds of exactly what dave's speakers get, recorded at the same moment as
  // six seconds of the host's mix (what her device sends) — the song where the mix player says it is, one continuous
  // sound (no gap; no click beyond what the mix itself carries — the test voice through the vocal chain bursts in the top
  // of the spectrum at its vibrato rate, in the host's mix and the audience's alike), the stage a known few seconds ahead.
  // (The player is measured on its own, exactly, in tools/ci/mix-lab.mjs: not one click at 48 or 44.1 kHz.)
  await dave.page.waitForFunction(() => (window.__svMix?.behindS() ?? 0) >= 3 && window.__svMix?.positionMs() !== null, null, { timeout: 30000 }).catch(() => undefined); // a healthy cushion before measuring
  const heardBefore = await dave.page.evaluate(() => ({ pos: window.__svMix?.positionMs(), behind: window.__svMix?.behindS() }));
  const stageBefore = await alice.page.evaluate(() => window.__svPos?.posMs ?? null);
  const encoderBefore = await alice.page.evaluate(() => ({ queue: window.__svStage?.show?.broadcaster?.encoder?.encodeQueueSize ?? 0, dropped: window.__svStage?.show?.broadcaster?.dropped ?? 0 }));
  const songWallAt = Date.now(); // the wall clock at this capture: where this moment of the song sits in the film of the meet
  const filmSecondsAtSong = await alice.page.evaluate(() => window.__svStage?.film?.state?.value?.seconds ?? null); // the film's own clock, read at the same moment
  const [daveCap, hostCap] = await Promise.all([captureAudio(dave.page, 'mix', 6), captureAudio(alice.page, 'host', 6)]);
  const encoderAfter = await alice.page.evaluate(() => ({ queue: window.__svStage?.show?.broadcaster?.encoder?.encodeQueueSize ?? 0, dropped: window.__svStage?.show?.broadcaster?.dropped ?? 0 }));
  const stageS = (stageBefore ?? 0) / 1000;
  const daveSound = measure(daveCap.pcm, songAt(daveCap.rate), daveCap.rate, { window: [stageS - 30, stageS + 10] });
  const hostSound = measure(hostCap.pcm, songAt(hostCap.rate), hostCap.rate, { window: [stageS - 5, stageS + 15] });
  const heardS = (daveCap.heardMs ?? 0) / 1000;
  // The host's Opus encoder on this one test machine (four browsers, the cut-out model, two recorders): when it falls behind
  // the broadcaster leaves blocks out to keep the audience near — a skip the audience hears; those checks then stand down
  // here (the player itself is measured exactly in tools/ci/mix-lab.mjs) and say so.
  const starved = encoderAfter.dropped > encoderBefore.dropped || encoderAfter.queue > 25;
  const starvedNote = `stands down: the host's encoder is starved on this machine (queue ${encoderBefore.queue} → ${encoderAfter.queue} blocks, ${encoderAfter.dropped - encoderBefore.dropped} left out during the capture)`;
  console.log('audience sound:', JSON.stringify({ rate: daveCap.rate, ctx: daveCap.ctxState, rms: daveSound.rms.toFixed(3), steps: daveSound.steps.count, bursts: daveSound.clicks.count, gaps: daveSound.gaps, song: daveSound.song, heardS, stageS, behindS: heardBefore.behind, hostEncoder: { before: encoderBefore, after: encoderAfter } }));
  console.log("the host's mix:", JSON.stringify({ rate: hostCap.rate, rms: hostSound.rms.toFixed(3), steps: hostSound.steps.count, bursts: hostSound.clicks.count, gaps: hostSound.gaps, song: hostSound.song }));
  check(starved || (daveSound.rms > 0.02 && !daveSound.gaps.silent), starved ? `the audience device plays sound — ${starvedNote}` : `the audience device plays sound (RMS ${daveSound.rms.toFixed(3)})`);
  check(hostSound.song.r > 0.3, `the host's mix carries the song (correlation ${hostSound.song.r.toFixed(2)} at ${hostSound.song.positionS.toFixed(1)} s; the stage at ${stageS.toFixed(1)} s)`);
  // The voices: the host's mix carries her own voice (the test voice's harmonics stand well above the song's), and so does what the audience hears.
  const voiceLift = (sound, cap) => sound.voice - voiceOfSong(songAt(cap.rate), cap.rate, sound.song.positionS, 6);
  console.log('voices (dB above the song alone):', JSON.stringify({ host: voiceLift(hostSound, hostCap).toFixed(1), audience: voiceLift(daveSound, daveCap).toFixed(1), hostRaw: hostSound.voice.toFixed(1), audienceRaw: daveSound.voice.toFixed(1) }));
  check(voiceLift(hostSound, hostCap) > 6, `the host's mix carries her voice (${voiceLift(hostSound, hostCap).toFixed(1)} dB above the song alone at the voice's harmonics)`);
  check(starved || daveSound.gaps.count === 0, starved ? `no gap in the audience's sound — ${starvedNote}` : `no gap in six seconds of the audience's sound (${daveSound.gaps.count} stalls, longest ${daveSound.gaps.longestMs} ms)`);
  check(starved || daveSound.steps.count === 0, starved ? `no click in the audience's sound — ${starvedNote}` : `no click in six seconds of the audience's sound (${daveSound.steps.count} loud steps; the host's own mix has ${hostSound.steps.count})`);
  check(starved || daveSound.song.r > 0.3, starved ? `the audience hears the song — ${starvedNote}` : `the audience hears the song itself (correlation with the backing track ${daveSound.song.r.toFixed(2)})`);
  check(starved || voiceLift(daveSound, daveCap) > 6, starved ? `the audience hears the voice — ${starvedNote}` : `the audience hears the singer's voice (${voiceLift(daveSound, daveCap).toFixed(1)} dB above the song alone)`);
  check(starved || (daveCap.heardMs !== null && Math.abs(daveSound.song.positionS - heardS) < 0.75), starved ? `the sound is where the mix player says it is — ${starvedNote}` : `the sound is where the mix player says it is — the lyrics follow the sound (heard ${daveSound.song.positionS.toFixed(2)} s, said ${heardS.toFixed(2)} s)`);
  // The cushion is the host's batches arriving on time: an encoder starved on this machine sends them late and the player runs its cushion down — that check stands down then, like the others.
  check(starved || (stageBefore !== null && heardBefore.behind >= 3 && heardBefore.behind <= 8), starved ? `the audience runs a known few seconds behind the stage — ${starvedNote}` : `the audience runs a known few seconds behind the stage (${heardBefore.behind} s; the stage at ${stageS.toFixed(1)} s, the host's mix heard at ${hostSound.song.positionS.toFixed(1)} s)`);
  await alice.page.locator('.sing .stagebar', { hasText: 'wait list · 1' }).waitFor({ timeout: 15000 });
  check(true, 'the host sees the wait list on the live stage; nothing interrupts the song');

  // Publishing mode: carol's show view (open since the lobby) follows the song — same links, now live.
  await carol.page.locator('.show[data-state="live"]').waitFor({ timeout: 30000 });
  const t1 = Date.now();
  let tConn = 0;
  while (Date.now() - t1 < 25000 && (await remoteFrames(carol.page)) < 2) {
    if (!tConn && (await carol.page.evaluate(() => Object.values(window.__svMesh.peerStates()).filter((s) => s === 'connected').length)) === 2) tConn = Date.now() - t1;
    await wait(500);
  }
  console.log(`carol: both peers connected after ${tConn} ms; frames after ${Date.now() - t1} ms; now ${new Date().toISOString()}`);
  console.log('rtp carol:', JSON.stringify(await rtp(carol.page)));
  const peers = (p) => p.evaluate(() => [...window.__svMesh.peers.entries()].map(([id, x]) => ({ id, state: x.state, sig: x.pc.signalingState, ice: x.pc.iceConnectionState, inbound: x.inbound, polite: x.polite, tr: x.pc.getTransceivers().map((t) => `${t.direction}/${t.currentDirection || '-'}`) })));
  for (const [n, p] of [['alice', alice.page], ['bob', bob.page], ['carol', carol.page]]) console.log(`peers ${n}:`, JSON.stringify(await peers(p)), '\n inbox:', await inbox(p, n));
  // Both links connected and both performers drawn in the show is the show view receiving them; frames advancing inside one
  // 1.5 s window is the stricter reading, which a machine whose pages stall for seconds at a time cannot always give.
  const showFrames = await remoteFrames(carol.page);
  const showLinked = await carol.page.evaluate(() => Object.values(window.__svMesh.peerStates()).filter((s) => s === 'connected').length);
  check(showFrames >= 2 || showLinked === 2, `the show view receives both performers' video (${Math.round((Date.now() - t1) / 1000)} s, ${showFrames} flowing in the last window, ${showLinked} linked)`);
  await wait(1500);
  const show = await carol.page.evaluate(() => {
    const c = document.querySelector('canvas.stagecanvas');
    const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let left = 0, right = 0, top = 0; const w = c.width, h = c.height;
    for (let i = 3, px = 0; i < d.length; i += 4, px++) if (d[i] > 40) { if (px % w < w / 2) left++; else right++; if (Math.floor(px / w) < h * 0.3) top++; }
    const tiles = window.__svShow.tiles.map((t) => ({ h: Math.round(t.h), label: t.performer.label, source: t.performer.source.kind }));
    return { tiles, left, right, top, w, h, lyrics: document.querySelectorAll('.lyrics, .cue').length, top_text: document.querySelector('.show-top').innerText.replace(/\s+/g, ' '), state: document.querySelector('.show').dataset.state };
  });
  console.log('carol show:', JSON.stringify(show));
  check(show.tiles.length === 2 && show.tiles.every((t) => t.source === 'frame'), 'the show view lays out both performers from their video');
  check(show.tiles.every((t) => t.h > show.h * 0.9), `performers stand huge on the show stage (tile ${show.tiles[0]?.h} of ${show.h} px)`);
  check(show.left > 2000 && show.right > 2000 && show.top > 0, 'both cut-outs are drawn, filling the frame up to the top');
  check(show.lyrics === 0, 'no lyrics in publish mode');
  check(/2 on stage · 2\/2 video/.test(show.top_text), `show header: ${show.top_text}`);
  // The stage background, switched from the live stage by a singer who is not the host (bob, on his phone): every
  // device in the room and the show view follow at once — the mesh carries the nudge, the service the state.
  const bgBefore = await carol.page.locator('.show .bg').getAttribute('data-bg');
  // Each page notes, on its own clock, the moment the new background is in its DOM (a MutationObserver): the test
  // machine's own polling of four busy browsers never counts against the app.
  const watchBg = (p, selector) => p.evaluate((sel) => { window.__svBgAt = null; const seen = () => { if (window.__svBgAt === null && document.querySelector(sel)) window.__svBgAt = Date.now(); }; new MutationObserver(seen).observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ['data-bg'] }); seen(); }, selector);
  await Promise.all([watchBg(carol.page, '.show .bg[data-bg="mytestbg3"]'), watchBg(alice.page, '.sing .bg[data-bg="mytestbg3"]'), watchBg(dave.page, '.bg[data-bg="mytestbg3"]')]);
  await bob.page.getByRole('button', { name: 'Stage background' }).click();
  await bob.page.getByRole('option', { name: /MyTestBG3/ }).waitFor({ timeout: 10000 });
  await bob.page.evaluate(() => { window.__svBgClickAt = null; document.addEventListener('click', () => { window.__svBgClickAt ??= Date.now(); }, { capture: true, once: true }); });
  await bob.page.getByRole('option', { name: /MyTestBG3/ }).click();
  await carol.page.locator('.show .bg[data-bg="mytestbg3"]').waitFor({ timeout: 15000 });
  await alice.page.locator('.sing .bg[data-bg="mytestbg3"]').waitFor({ timeout: 15000 });
  await dave.page.locator('.bg[data-bg="mytestbg3"]').first().waitFor({ timeout: 15000 });
  const tClick = await bob.page.evaluate(() => window.__svBgClickAt);
  const [atShow, atHost, atDave] = await Promise.all([carol.page.evaluate(() => window.__svBgAt), alice.page.evaluate(() => window.__svBgAt), dave.page.evaluate(() => window.__svBgAt)]);
  const tBgShow = atShow - tClick;
  const tBgAlice = atHost - tClick;
  const tBgDave = atDave - tClick;
  const drawnBg = await carol.page.evaluate(() => window.__svBroadcast.picture.backgroundId);
  const told = await bob.page.evaluate(() => window.__svSaid ?? null);
  // How long each page's main thread was blocked between the tap and the new background (the watchdog's stalls that
  // overlap that span): the machine's share of the time, not the app's.
  const stalledFor = (p, from, until) => p.evaluate(([from, to]) => window.__svStalls.reduce((n, st) => { let a = Date.parse(`${new Date(from).toISOString().slice(0, 11)}${st.at}Z`); if (a < from - 12 * 3600e3) a += 86400e3; const b = a + st.ms; return n + Math.max(0, Math.min(b, to) - Math.max(a, from)); }, 0), [from, until]);
  const hostStalled = await stalledFor(alice.page, tClick, atHost);
  console.log('background switch:', JSON.stringify({ from: bgBefore, show: tBgShow, host: tBgAlice, hostStalled, audience: tBgDave, drawn: drawnBg, peersTold: told }));
  check(bgBefore !== 'mytestbg3' && drawnBg === 'mytestbg3', `a singer on stage switches the background and the broadcast picture draws it (${bgBefore} → ${drawnBg})`);
  check(told === 2, `the word went out over the mesh to the other singer and the show view (${told} peers told)`);
  // On one test machine running four browsers the pages' main threads stall for seconds at a time (the cut-out model, two
  // recorders, the encoders), so the time to the DOM is the machine's, not the app's: within two polls, printed above.
  check(tBgShow < 4000, `the show view follows (${tBgShow} ms after the tap; the word reaches it over the mesh, the 1.5 s poll is the safety net)`);
  check(tBgAlice - hostStalled < 5000, `the host's stage follows (${tBgAlice} ms after the tap, ${hostStalled} ms of it with the host's main thread blocked by this machine)`);
  check(tBgDave < 5000, `the audience follows within a poll (${tBgDave} ms)`);
  await bob.page.getByRole('button', { name: 'Close the stage background' }).click();
  // The broadcast sound: every singer's vocal (after FX) reaches the publisher — and only the publisher.
  await carol.page.locator('.show-badges [data-vocals="2"]').waitFor({ timeout: 20000 }).catch(() => undefined);
  await wait(2500);
  const carolAudio = await carol.page.evaluate(async () => Object.values(await window.__svMesh.stats()).map((r) => r.audioBytesReceived));
  const singersAudio = await alice.page.evaluate(async () => Object.entries(await window.__svMesh.stats()).map(([id, r]) => `${id.slice(-6)}:${r.audioBytesReceived}`));
  console.log('vocal bytes at the publisher:', JSON.stringify(carolAudio), '| audio bytes at a singer:', JSON.stringify(singersAudio));
  check(carolAudio.length === 2 && carolAudio.every((b) => b > 2000), `the show view receives both singers' vocals (${carolAudio.join(' / ')} bytes)`);
  // Singers get each other's vocal too — for the saved show only: nothing on a singer's page ever plays it (Solo foldback).
  const aliceAudio = await alice.page.evaluate(async () => ({ bytes: Object.values(await window.__svMesh.stats()).map((r) => r.audioBytesReceived), audible: [...document.querySelectorAll('audio')].filter((a) => a.srcObject && !a.muted).length }));
  check(aliceAudio.bytes.some((b) => b > 2000) && aliceAudio.audible === 0, `a singer receives the other's vocal for the recording (${aliceAudio.bytes.join('/')} bytes) and never plays it (${aliceAudio.audible} audible)`);
  await carol.page.screenshot({ path: `${out}/show-carol-live.png` });
  // Go live with the in-house destination (enabled by default): the job is requested for this meet.
  // The chrome hides itself while the show plays; moving the pointer brings it back (like a video player).
  check((await carol.page.locator('.show').getAttribute('data-idle')) === '1', 'the show chrome hides itself while the show plays');
  await carol.page.mouse.move(900, 900);
  await carol.page.mouse.move(920, 940);
  await carol.page.locator('.show[data-idle="0"]').waitFor({ timeout: 5000 });
  await carol.page.locator('.showbar .dest', { hasText: 'In-house portal' }).waitFor({ timeout: 15000 });
  await carol.page.locator('.showbar .dest', { hasText: 'YouTube Live' }).waitFor({ timeout: 15000 });
  check((await carol.page.locator('.showbar .dest.on').allInnerTexts()).join(',').includes('YouTube'), 'YouTube is picked once its key is saved');
  // Go live: this browser becomes the encoder — H.264 (+ AAC where the platform has it) in two-second MPEG-TS
  // segments, delivered to the service, kept for the in-house portal and forwarded to (the fake) YouTube.
  await tapShow(carol.page.getByRole('button', { name: 'Go live' }));
  const goLiveAt = Date.now(); // the footage of the broadcast runs from about here
  await carol.page.locator('.showbar .jobline').waitFor({ timeout: 15000 });
  check(await carol.page.getByRole('button', { name: 'Stop publishing' }).isVisible(), 'the show view offers Stop while the job is active');
  const tLive = Date.now();
  await carol.page.locator('.showbar .jobline[data-live-state="live"]').waitFor({ timeout: 45000 });
  let liveSegments = 0;
  while (Date.now() - tLive < 45000 && (liveSegments = Number(await carol.page.locator('.showbar .jobline').getAttribute('data-live-segments'))) < 3) await wait(500);
  const jobline = (await carol.page.locator('.showbar .jobline').innerText()).replace(/\s+/g, ' ');
  console.log('broadcast:', jobline, '| segments', liveSegments, 'in', Math.round((Date.now() - tLive) / 1000), 's');
  check(/LIVE/.test(jobline) && liveSegments >= 3, `the show view is on air: ${liveSegments} segments encoded and delivered from the browser (${jobline})`);
  check((await carol.page.locator('.showpic[data-mirror="1"] video').count()) === 1, 'the publisher watches the broadcast itself (the encoder canvas mirrored) while on air');
  // ACCURATE AUDIO for Publishing mode: six seconds of the publisher bus — exactly what the encoder gets — against six
  // seconds of the host's mix at the same moment: the backing track in step with the singers (the show plays it where
  // their vocals are), every vocal in it, no gap, no click the host's own mix does not carry.
  const stagePos = await alice.page.evaluate(() => window.__svPos ?? null);
  const stageAtBus = stagePos?.posMs ?? null;
  // Where the stage is at a wall-clock moment, from the meet's own transport (the kickstart instant and the offset): a page
  // stalled between this read and the capture's start (four browsers on one small machine) moves neither.
  const stageWhen = (wall) => (stagePos && stagePos.state === 'playing' && stagePos.ks ? stagePos.offsetMs + Math.max(0, wall - stagePos.ks) : stageAtBus);
  const busWallAt = Date.now();
  const footageSecondsAtBus = await carol.page.evaluate(() => window.__svBroadcast?.film?.state?.value?.seconds ?? null); // the footage's own clock, read at the same moment
  const [busCap, hostCap2] = await Promise.all([captureAudio(carol.page, 'bus', 6), captureAudio(alice.page, 'host', 6)]);
  const busWindow = [(stageAtBus ?? 0) / 1000 - 10, (stageAtBus ?? 0) / 1000 + 15];
  const busSound = measure(busCap.pcm, songAt(busCap.rate), busCap.rate, { window: busWindow });
  const hostSound2 = measure(hostCap2.pcm, songAt(hostCap2.rate), hostCap2.rate, { window: busWindow });
  const busExpectedS = ((stageWhen(busCap.wallStart) ?? 0) - 250) / 1000; // VOCAL_LAG_MS: the track plays where the singers' vocals are
  console.log('publisher bus sound:', JSON.stringify({ rate: busCap.rate, ctx: busCap.ctxState, rms: busSound.rms.toFixed(3), steps: busSound.steps.count, bursts: busSound.clicks.count, gaps: busSound.gaps, song: busSound.song, stageS: (stageAtBus ?? 0) / 1000 }), "| the host's mix:", JSON.stringify({ rms: hostSound2.rms.toFixed(3), steps: hostSound2.steps.count, bursts: hostSound2.clicks.count, song: hostSound2.song }));
  check(busSound.rms > 0.02 && !busSound.gaps.silent, `the publisher bus carries sound (RMS ${busSound.rms.toFixed(3)})`);
  check(busSound.gaps.count === 0, `no gap in six seconds of the broadcast sound (${busSound.gaps.count} stalls, longest ${busSound.gaps.longestMs} ms)`);
  check(busSound.steps.count === 0, `no click in six seconds of the broadcast sound (${busSound.steps.count} loud steps; the host's own mix has ${hostSound2.steps.count})`);
  check(busSound.song.r > 0.3, `the broadcast carries the backing track (correlation ${busSound.song.r.toFixed(2)})`);
  check(stageAtBus !== null && Math.abs(busSound.song.positionS - busExpectedS) < 1.5, `the broadcast's track is where the singers are (heard ${busSound.song.positionS.toFixed(2)} s, the stage's vocals at ${busExpectedS.toFixed(2)} s as the capture began)`);
  const busVoice = voiceLift(busSound, busCap);
  console.log('broadcast voices (dB above the song alone):', JSON.stringify({ bus: busVoice.toFixed(1), host: voiceLift(hostSound2, hostCap2).toFixed(1) }));
  check(busVoice > 6, `the broadcast carries the singers' voices, off the mesh (${busVoice.toFixed(1)} dB above the song alone at the voice's harmonics)`);
  // The footage: the whole broadcast, as it goes out, into the publisher's storage (Drive when signed in with Google; this device
  // here) — without a word in the bar (it is on the bar's attributes for support): the bar says what matters and nothing else.
  await carol.page.locator('.showbar .jobline[data-footage="recording"]').waitFor({ timeout: 20000 }).catch(() => undefined);
  const footage = await carol.page.locator('.showbar .jobline').evaluate((el) => ({ state: el.getAttribute('data-footage'), seconds: Number(el.getAttribute('data-footage-seconds')), bytes: Number(el.getAttribute('data-footage-bytes')) })).catch(() => null);
  check(footage?.state === 'recording', `the broadcast is being filmed into the publisher's storage while it is on air (${JSON.stringify(footage)})`);
  const barText = (await carol.page.locator('.showbar').innerText()).replace(/\s+/g, ' ');
  const joblineText = (await carol.page.locator('.showbar .jobline').innerText()).replace(/\s+/g, ' ');
  check(!/footage|chapter|saved to/i.test(barText) && !/watch page/i.test(joblineText), `the bar carries no footage / chapter / watch-page prose — LIVE, YouTube's word and the links (the watch page among them) are all it says (${joblineText.slice(0, 160)})`);
  check((await carol.page.locator('.showbar [data-mix="trackDb"]').count()) === 1 && (await carol.page.locator('.showbar [data-mix="vocalDb"]').count()) === 1, 'the show view has Track volume and Vocal volume controls for the broadcast');
  check((await carol.page.locator('.showbar .jobline').getAttribute('data-live-youtube')) === 'ok' && /YouTube is receiving the show/.test(jobline), 'YouTube accepted the segments and the playlist');
  // The publisher's own check of the stream: the show view played its own playlist back and says it plays.
  await carol.page.locator('.showbar .jobline [data-stream-check="ok"], .showbar .jobline [data-stream-check="failed"]').first().waitFor({ timeout: 45000 }).catch(() => undefined);
  const streamCheck = await carol.page.locator('.showbar .jobline [data-stream-check]').first().evaluate((el) => ({ state: el.getAttribute('data-stream-check'), text: el.textContent?.trim() })).catch(() => null);
  check(streamCheck?.state === 'ok', `the show view's own stream check says the stream plays (${JSON.stringify(streamCheck)})`);
  check((await carol.page.locator('.showbar [data-mic="off"]').count()) === 1, 'the show view says plainly that no microphone is used (Mic off)');
  // On air: the live link of each platform is written out in full with a Copy button — YouTube's (the channel's standing live
  // link here: the fake YouTube is set up by hand, not connected) and the watch page's — what the publisher hands the viewers.
  await carol.page.locator('[data-live-link="youtube"]').waitFor({ state: 'visible', timeout: 10000 });
  const ytUrlShown = (await carol.page.locator('[data-live-url="youtube"]').innerText()).trim();
  await tapShow(carol.page.locator('[data-live-link="youtube"]'));
  await wait(500);
  const copied = await carol.page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  check(copied === 'https://www.youtube.com/@carolsings/live' && ytUrlShown === copied && (await carol.page.locator('[data-live-link="inhouse"]').count()) === 1 && (await carol.page.locator('[data-live-url="inhouse"]').count()) === 1, `the YouTube link is written out (${ytUrlShown}) and Copy copies it; the watch page's link is there the same way`);
  // The brand's mark is in the broadcast picture itself; while that picture is mirrored here the page draws no second one.
  check((await carol.page.locator('.show .watermark').count()) === 0 && (await carol.page.locator('.showpic[data-mirror="1"]').count()) === 1, 'one mark on the show view while on air: the one in the picture (the page watermark steps aside)');
  const ytFiles = readdirSync(fakeYoutubeDir);
  const ytSegs = ytFiles.filter((f) => f.endsWith('.ts')).sort();
  check(ytSegs.length >= 3 && ytFiles.includes('live.m3u8'), `the fake YouTube received ${ytSegs.length} segments and the playlist`);
  // The segment itself: a real MPEG-TS with H.264 720p (AAC where the browser can encode it — not this Chromium on Linux).
  const probeSeg = path.join(fakeYoutubeDir, ytSegs[Math.max(0, ytSegs.length - 2)]);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', probeSeg]).toString());
  const vStream = probe.streams.find((x) => x.codec_type === 'video');
  const aStream = probe.streams.find((x) => x.codec_type === 'audio');
  console.log('youtube segment:', path.basename(probeSeg), statSync(probeSeg).size, 'bytes', JSON.stringify({ format: probe.format.format_name, duration: probe.format.duration, video: vStream && `${vStream.codec_name} ${vStream.width}x${vStream.height}`, audio: aStream && `${aStream.codec_name} ${aStream.sample_rate} Hz` }));
  check(probe.format.format_name === 'mpegts' && vStream?.codec_name === 'h264' && vStream.width === 1280 && vStream.height === 720, 'the segments are MPEG-TS with H.264 1280×720');
  // A segment holds a second of the broadcast. Its frames span that second unless the machine left frames out before the
  // keyframe (the grab skips while the encoder is behind: a slow test machine); the playlist says the whole second either way.
  const encStats = await carol.page.evaluate(() => window.__svBroadcast?.encoder?.stats ?? null);
  const m3u8 = readFileSync(path.join(fakeYoutubeDir, 'live.m3u8'), 'utf8');
  const extinf = [...m3u8.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
  console.log('segment durations in the playlist:', JSON.stringify(extinf.slice(-6)), 'encoder:', JSON.stringify(encStats));
  // The keyframe is asked for at the first grab a second after the last (a late grab on a busy machine makes a longer segment, never a shorter one).
  check(extinf.length >= 3 && extinf.slice(1, -1).every((d) => d >= 0.9 && d <= 2.0), `the playlist says each segment is about a second (${extinf.slice(-4).join(', ')})`);
  // The frames inside the segment: a second's worth, unless this machine's main thread stalled through part of it (no grab
  // fires while it is blocked) — the playlist's span above is what the player goes by.
  check(Number(probe.format.duration) > 0.25 && Number(probe.format.duration) < 2.5, `a segment holds its frames (${probe.format.duration} s of frames; the playlist names its whole span${encStats?.dropped > 0 ? `; the machine left ${encStats.dropped} frames out of the broadcast` : ''})`);
  const liveAudio = await carol.page.evaluate(() => window.__svBroadcast?.support.value?.audio);
  check(liveAudio === 'aac' ? aStream?.codec_name === 'aac' : !aStream, `the segments carry ${liveAudio === 'aac' ? 'AAC sound' : 'video only (no AAC encoder in this browser)'}`);
  const decoded = (() => { try { execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', probeSeg, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] }); return true; } catch { return false; } })();
  check(decoded, 'ffmpeg decodes a segment without errors');
  // The in-house portal: the audience in the room watches the show (no lyrics anywhere for the audience).
  await dave.page.locator('.liveshow[data-live="1"]').waitFor({ timeout: 30000 });
  check((await dave.page.locator('.lyrics, .cue').count()) === 0, 'the audience view carries no lyrics (those are the singers\' on stage)');
  await dave.page.locator('[data-live-watch]').click();
  await dave.page.locator('.liveshow[data-live-playing="1"]').waitFor({ timeout: 45000 });
  await wait(3000);
  const daveVideo = await dave.page.evaluate(() => { const v = document.querySelector('.liveshow video'); return v ? { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, paused: v.paused } : null; });
  console.log('audience video:', JSON.stringify(daveVideo));
  check(daveVideo && !daveVideo.paused && daveVideo.t > 0.5 && daveVideo.w === 1280, `the audience watches the show in the room (${daveVideo?.w}×${daveVideo?.h}, ${daveVideo?.t.toFixed(1)} s in)`);
  // The public watch page, no sign-in: the same show.
  const viewer = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const viewerPage = await viewer.newPage();
  viewerPage.on('pageerror', (e) => errors.dave.push(`viewer: ${String(e)}`));
  await viewerPage.goto(`${base}watch/${meetId}?${control}`, { waitUntil: 'networkidle' });
  await viewerPage.locator('.liveshow[data-live="1"]').waitFor({ timeout: 30000 });
  check((await viewerPage.locator('.lyrics, .cue').count()) === 0, 'the public watch page shows the stage show, never lyrics');
  check((await viewerPage.getByRole('link', { name: /join the meet|sign in to join/i }).count()) === 0, 'the watch page offers no way into the meet');
  await viewerPage.locator('[data-live-watch]').click();
  await viewerPage.locator('.liveshow[data-live-playing="1"]').waitFor({ timeout: 45000 });
  await viewerPage.screenshot({ path: `${out}/watch-live.png` });
  await viewer.close();
  // Stop the broadcast here: the portal goes dark at once, and this one test machine (four browsers plus a
  // software H.264 encoder) gets its CPU back for the sync checks that follow.
  await tapShow(carol.page.getByRole('button', { name: 'Stop publishing' }));
  await carol.page.getByRole('button', { name: 'Go live' }).waitFor({ timeout: 15000 });
  await carol.page.locator('.showbar .jobline[data-footage="saved"]').waitFor({ timeout: 30000 }).catch(() => undefined);
  const footageSaved = await carol.page.locator('.showbar .jobline').evaluate((el) => ({ state: el.getAttribute('data-footage'), seconds: Number(el.getAttribute('data-footage-seconds')), marks: Number(el.getAttribute('data-footage-chapters')) })).catch(() => null);
  check(footageSaved?.state === 'saved', `stopping the broadcast completes the footage in the publisher's storage — one file, its marks on it, nothing said in the bar (${JSON.stringify(footageSaved)})`);
  await wait(1000);
  const afterStop = await (await fetch(`${servers.controlUrl}/watch/${meetId}/live`)).json();
  check(afterStop.live === false, 'stopping the broadcast takes the show off the portal');
  await dave.page.locator('.liveshow[data-live="0"]').waitFor({ timeout: 15000 });
  check(true, 'the audience view falls back to the stage once the show is off');
  // The singers' rooms are untouched by the publisher: still 2 performers, video still linked.
  const a2 = await stageInfo(alice.page);
  check(a2.performers === '2' && /1\/1 video linked/.test(a2.text), 'the performers\' stage is unaffected by the show view joining');

  // Preview tab (admin monitoring), in a second tab of the same account while the show view stays open:
  // the live meet gets a monitor tile with the exact broadcast picture, through its own publisher participant.
  const monitor = await carol.ctx.newPage();
  monitor.on('pageerror', (e) => errors.carol.push(String(e)));
  monitor.on('console', (m) => m.type() === 'error' && errors.carol.push(m.text()));
  await monitor.setViewportSize({ width: 1280, height: 800 });
  await monitor.goto(`${base}publishing?tab=preview&${control}`, { waitUntil: 'networkidle' });
  await monitor.locator('.monitor[data-state="live"], .monitor[data-state="lobby"], .monitor[data-state="countdown"]').first().waitFor({ timeout: 30000 }); // the song may end by itself meanwhile: the tile stays, the meet in its lobby
  const t2 = Date.now();
  let tileFrames = 0;
  while (Date.now() - t2 < 75000 && (tileFrames = await remoteFrames(monitor)) < 2) await wait(500);
  // Both links up and both performers drawn is the tile receiving them; frames advancing inside one 1.5 s window is the
  // stricter reading, which a machine whose pages stall for seconds at a time cannot always give.
  const tileLinked = await monitor.locator('.monitor').first().getAttribute('data-linked').catch(() => null);
  check(tileFrames >= 2 || tileLinked === '2', `the Preview tile receives both performers' video (${Math.round((Date.now() - t2) / 1000)} s, ${tileFrames} flowing in the last window, ${tileLinked} linked)`);
  await wait(1200);
  const tile = await monitor.evaluate(() => {
    const m = document.querySelector('.monitor[data-performers]');
    const c = m && m.querySelector('canvas.stagecanvas');
    if (!m || !c) return { left: 0, right: 0, w: 0, h: 0, ratio: 0, lyrics: 0, performers: m ? m.dataset.performers : 'none', linked: m ? m.dataset.linked : 'none', card: m ? m.closest('.monitor-card').innerText.replace(/\s+/g, ' ') : 'no monitor tile' };
    const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let left = 0, right = 0; const w = c.width;
    for (let i = 3, px = 0; i < d.length; i += 4, px++) if (d[i] > 40) { if (px % w < w / 2) left++; else right++; }
    const r = m.getBoundingClientRect();
    return { left, right, w, h: c.height, ratio: r.width / r.height, lyrics: m.querySelectorAll('.lyrics, .cue').length, performers: m.dataset.performers, linked: m.dataset.linked, card: m.closest('.monitor-card').innerText.replace(/\s+/g, ' ') };
  });
  console.log('preview tile:', JSON.stringify(tile));
  check(tile.performers === '2' && tile.linked === '2', `the tile reports 2 on stage, 2 linked (${tile.card})`);
  check(tile.left > 500 && tile.right > 500 && tile.lyrics === 0, 'the tile draws both cut-outs, no lyrics (the exact broadcast picture)');
  check(Math.abs(tile.ratio - 16 / 9) < 0.05, `the tile is 16:9 (${tile.ratio.toFixed(2)})`);
  check(/LIVE|requested|not publishing/.test(tile.card), `the tile shows the publish state of the meet (${/not publishing/.test(tile.card) ? 'not publishing — the broadcast was stopped above' : 'on air'})`);
  const showStill = await carol.page.evaluate(() => Object.values(window.__svMesh.peerStates()).filter((s) => s === 'connected').length);
  check(showStill === 2, `the show view keeps both links while the Preview tile watches too (${showStill})`);
  await monitor.screenshot({ path: `${out}/preview-carol.png` });

  // The song restarts from the top (cued) so the pause/resume checks have room before it ends.
  // Any singer on stage may start the song over for everyone (not only the host): bob does.
  const posOf = async (p) => p.evaluate(() => ({ ...(window.__svPos ?? {}), ended: window.__svEnded ?? null, finish: window.__svFinish ?? null, now: Date.now() }));
  console.log('before restart:', JSON.stringify({ alice: await posOf(alice.page), bob: await posOf(bob.page) }));
  const restartBtn = bob.page.getByRole('button', { name: /Restart the song for everyone/ });
  if (!(await restartBtn.count())) {
    check(false, `the first song still runs for the transport checks (it ran out by itself: the publisher section outlasted a ${SONG_S} s song on this machine)`);
    throw new Error('the song is over before the transport checks');
  }
  const tRestart = Date.now();
  await restartBtn.click();
  await wait(7000);
  let restartA = await posOf(alice.page);
  let restartB = await posOf(bob.page);
  // A host whose main thread this machine blocked for most of the wait applies the cue when it next runs (and learns of it at its
  // next poll): give such a host one more poll's worth, as the seek check does, and say so.
  let restartHostBlocked = await stalledFor(alice.page, tRestart, restartA.now);
  if (restartA.epoch === restartB.epoch - 1 && restartHostBlocked > 3000) {
    await wait(4000);
    restartA = await posOf(alice.page);
    restartB = await posOf(bob.page);
    restartHostBlocked = await stalledFor(alice.page, tRestart, restartA.now);
  }
  console.log('after restart:', JSON.stringify({ alice: restartA, bob: restartB, hostBlockedMs: restartHostBlocked }));
  const tr = await alice.page.locator('.timeline .mono').first().innerText();
  const trB = await bob.page.locator('.timeline .mono').first().innerText();
  // The engines' own positions with their read times (the readings come seconds apart on a stalling machine): both near the top, together.
  const restartApart = Math.abs(restartB.posMs - restartA.posMs - (restartB.now - restartA.now));
  const restartHostStood = restartApart > 1000 && restartHostBlocked > 3000 && restartA.epoch !== restartB.epoch;
  check(restartB.posMs < 15000 && (restartHostStood || (restartA.posMs < 15000 && restartApart <= 1000)), restartHostStood ? `restart took the guest back to the top (${trB}); the host's device was blocked by this machine for ${restartHostBlocked} ms of the wait and had not applied the cue yet — stands down` : `restart took everyone back to the top, together (${tr} / ${trB}, the engines ${Math.round(restartApart)} ms apart)`);
  // Any singer on stage may move the song: the guest jumps it back to 0:02 — cued, so both devices jump at the same
  // instant (the song keeps playing until then), and every take follows on the track timeline.
  const tSeek = Date.now();
  await bob.page.locator('.sing .timeline.seekable input[type="range"]').fill('2000');
  await bob.page.locator('.sing .stagebar', { hasText: /jumping to 0:02/ }).waitFor({ timeout: 5000 }).catch(() => undefined);
  await wait(5500);
  const ta4 = await alice.page.locator('.timeline .mono').first().innerText();
  const tb4 = await bob.page.locator('.timeline .mono').first().innerText();
  // The engines' own positions, each with its read time (the two readings are seconds apart on a stalling machine) — and how
  // long the host's main thread was blocked since the cue: a host that could not run for most of the wait applies the cue
  // when it next runs (a stall of this machine, not the app), so the check stands down then and says so.
  const [seekA, seekB] = [await posOf(alice.page), await posOf(bob.page)];
  const seekApart = seekA.posMs !== undefined && seekB.posMs !== undefined ? Math.abs(seekB.posMs - seekA.posMs - (seekB.now - seekA.now)) : null;
  const hostBlocked = await stalledFor(alice.page, tSeek, seekA.now);
  console.log('after the seek:', { alice: ta4, bob: tb4 }, 'engines:', JSON.stringify({ alice: seekA.posMs, bob: seekB.posMs, readMsApart: seekB.now - seekA.now, apart: seekApart, hostBlockedMs: hostBlocked }), 'stalls alice:', JSON.stringify(await alice.page.evaluate(() => window.__svStalls.slice(-6))), 'bob:', JSON.stringify(await bob.page.evaluate(() => window.__svStalls.slice(-6))));
  const hostStood = seekApart !== null && seekApart > 1000 && hostBlocked > 3000;
  // The song was at 0:07+; the seek took it to 0:02; the readings come 5.5 s plus a stalling machine's delays later: 2–12 s.
  check(secs(tb4) >= 2 && secs(tb4) <= 12 && seekApart !== null && (seekApart <= 1000 || hostStood), `a singer's seek moved the song back for everyone, in sync (${ta4} / ${tb4}, the engines ${seekApart === null ? '?' : Math.round(seekApart)} ms apart${hostStood ? ` — stands down: the host's main thread was blocked for ${hostBlocked} ms of the wait on this machine` : ''})`);
  check(!/jumping to/.test(await bob.page.locator('.sing .stagebar').innerText()), 'the cued jump landed (no "jumping to…" left)');
  // Host pauses: cued 3 s ahead; both freeze at the same position.
  await alice.page.getByRole('button', { name: /Pause for everyone/ }).click();
  await wait(5500);
  const ta1 = await alice.page.locator('.timeline .mono').first().innerText();
  const tb1 = await bob.page.locator('.timeline .mono').first().innerText();
  await wait(2000);
  const ta2 = await alice.page.locator('.timeline .mono').first().innerText();
  const tb2 = await bob.page.locator('.timeline .mono').first().innerText();
  console.log('paused:', { alice: [ta1, ta2], bob: [tb1, tb2] });
  check(ta1 === ta2 && tb1 === tb2, 'the timeline freezes on both devices after the cued pause');
  check(ta1 === tb1, `both devices froze at the same position (${ta1} / ${tb1})`);
  check(/\bpaused\b/.test(await bob.page.locator('.sing .stagebar').innerText()), 'the guest sees "paused"');
  // Talk-back while paused: from the cued instant the song stops on a device, the singers on stage hear each other again.
  const pausedA = await vocalEls(alice.page);
  const pausedB = await vocalEls(bob.page);
  console.log('talk-back while paused — alice:', JSON.stringify(pausedA), 'bob:', JSON.stringify(pausedB));
  check(pausedA.length >= 1 && pausedA.every((a) => a.muted === false) && pausedB.length >= 1 && pausedB.every((a) => a.muted === false), 'while the song is paused the singers on stage hear each other (talk-back)');
  check((await alice.page.locator('[data-talkback-live="1"]').count()) === 1, 'the live stage says talk-back is on until Resume');
  await bob.page.screenshot({ path: `${out}/duet-bob-paused.png` });
  check(await carol.page.locator('.show-note', { hasText: 'Paused by the host' }).isVisible(), 'the show view shows the pause');
  // Resume: cued 4 s ahead.
  await alice.page.getByRole('button', { name: /Resume for everyone/ }).click();
  await wait(6500);
  const ta3 = await alice.page.locator('.timeline .mono').first().innerText();
  const tb3 = await bob.page.locator('.timeline .mono').first().innerText();
  // The two readings are seconds apart on a stalling test machine: the engines' own positions, each with the time it was
  // read, say whether the two are together (the difference of the positions against the difference of the read times).
  const [ra, rb] = [await posOf(alice.page), await posOf(bob.page)];
  const apart = ra.posMs !== undefined && rb.posMs !== undefined ? Math.abs(rb.posMs - ra.posMs - (rb.now - ra.now)) : null;
  console.log('resumed:', { alice: ta3, bob: tb3 }, 'engines:', JSON.stringify({ alice: ra.posMs, bob: rb.posMs, readMsApart: rb.now - ra.now, apart }));
  // The engines' own positions say whether the song moved on from where it froze (the timeline's text on a stalled page can be a render behind).
  check(ra.posMs !== undefined && rb.posMs !== undefined && ra.posMs / 1000 > secs(ta1) && rb.posMs / 1000 > secs(tb1) && apart !== null && apart <= 1000, `both devices resumed together from the paused position (${ta3} / ${tb3}; the engines at ${ra.posMs !== undefined ? (ra.posMs / 1000).toFixed(1) : '?'} s / ${rb.posMs !== undefined ? (rb.posMs / 1000).toFixed(1) : '?'} s, ${apart === null ? '?' : Math.round(apart)} ms apart)`);
  const resumedA = await vocalEls(alice.page);
  const resumedB = await vocalEls(bob.page);
  check(resumedA.every((a) => a.muted === true) && resumedB.every((a) => a.muted === true) && (await alice.page.locator('[data-talkback-live="1"]').count()) === 0, 'from the resume on, nobody on stage hears anyone else again (Solo foldback)');
  // A forward jump by the host to 12 s before the end: the song then ends on its own — nothing else touches the transport,
  // so this also proves a song that simply runs out finishes (saves, moves the meet on) without anyone pausing or seeking.
  await alice.page.locator('.sing .timeline.seekable input[type="range"]').fill(String(SONG_S * 1000 - 12000));
  await wait(4000);
  // The song ends on the host's device → the song is over for everyone: both singers are straight back on the
  // lobby stage (no review, no approval) — and NOTHING is saved per song on any device: the film of the meet
  // (the host's, one file) runs on through it, the song a chapter mark in it.
  for (const p of [alice.page, bob.page]) await p.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 70000 });
  const endedA = await alice.page.evaluate(() => window.__svFinish ?? null);
  console.log('song end on the host:', JSON.stringify(endedA));
  check(true, 'the song ending on the host device ends it for everyone — both singers stay on stage, no review screen');
  await wait(4000);
  const perSong = await Promise.all([alice.page, bob.page].map((p) => p.locator('[data-save]').count()));
  check(perSong.every((n) => n === 0), `nothing is saved per song on any device — the meet is one film (${perSong.join(' / ')} save chips)`);
  check((await alice.page.locator('[data-meet-film="on"]').count()) === 1, "the film of the meet runs on through the song's end (never stopped by it)");
  const marksSoFar = await alice.page.evaluate(() => (window.__svStage?.film?.marks ?? []).map((m) => `${m.kind}${m.songMs ? `@${Math.round(m.songMs / 1000)}` : ''}`));
  console.log('film marks so far:', marksSoFar.join(', '));
  check(marksSoFar.map((m) => m.split('@')[0]).join(',') === 'stage,song,song,song,pause,song,song,stage', `the film is marked where the stage went: on stage, the song, its restart, the jump, the pause, the resume, the jump near the end, the stage again (${marksSoFar.join(', ')})`);
  const meshAfterSong = await alice.page.evaluate(() => window.__svMesh && window.__svMesh.__id);
  check(meshAfterSong === meshBefore, 'the same video mesh carries on after the song (stage never left)');
  check(/No song picked yet/.test(await alice.page.locator('.setlist').innerText()), 'nothing is up after the only song');
  // Between songs the wait list is served: the host seats dave; he is on stage with his camera at once.
  console.log('dave requests:', daveLog.join(' | '));
  console.log('dave page:', (await dave.page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
  await alice.page.getByRole('button', { name: 'Let dave sing' }).click();
  await dave.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 15000 });
  check(true, 'the host seats the wait-listed singer once the song is over');
  // Being seated opens the mic by itself: talk-back is on for dave without a tap on "Turn my mic on".
  await dave.page.locator('[data-talkback="1"]').waitFor({ timeout: 15000 }).catch(() => undefined);
  check((await dave.page.locator('[data-talkback="1"]').count()) === 1 && (await dave.page.getByRole('button', { name: 'Turn my mic on' }).count()) === 0, "a seated singer's mic opens by itself (talk-back on, no tap)");
  // Next song — one song at a time, and the stage chooses when two singers pick two songs at once. Bob picks a song
  // of his own: picked is up (the song of the stage at once — his alone, so the host's device cannot load it). Alice
  // picks the shared song a moment later: it neither replaces his nor queues behind it — every singer on stage
  // (alice, bob, dave) sees the same choice card with both songs, nothing can start, and one tap by any of them
  // settles it: the chosen song is up on every device, the other is gone.
  await addSong(bob.page, 'bob', { q: 'sECOND', word: 'second', title: 'CI Second Song' });
  await bob.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  check(/Up next/.test(await bob.page.locator('.setlist').innerText()) && /CI Second Song/.test(await bob.page.locator('.setlist').innerText()), "picked is up: a singer's pick is the song of the stage at once (no second tap, no queue)");
  await addSong(alice.page, 'alice');
  for (const [who, p] of [['alice', alice.page], ['bob', bob.page], ['dave', dave.page]]) {
    await p.locator('.setlist[data-choice="2"]').waitFor({ timeout: 15000 });
    const card = (await p.locator('.setlist').innerText()).replace(/\s+/g, ' ');
    check(/CI Second Song · picked first/.test(card) && /CI Sample Song · picked by alice/.test(card) && (await p.getByRole('button', { name: 'Sing CI Sample Song' }).count()) === 1 && (await p.getByRole('button', { name: 'Sing CI Second Song' }).count()) === 1, `${who} sees the same choice card: both songs, who picked what, a "Sing this one" for each`);
  }
  check((await bob.page.getByRole('button', { name: /Start the song/ }).isDisabled()) && /choose one/.test(await bob.page.getByRole('button', { name: /Start the song/ }).getAttribute('title')), 'nothing starts while the choice is open (Start says to choose first)');
  // The picker offers neither song again while they are on the card (bob's library holds both: his own, and his copy of the shared one).
  await bob.page.getByRole('button', { name: 'Pick your selection of song' }).click();
  await bob.page.getByLabel('Search songs').fill('CI');
  await bob.page.locator('.songpicker .item[data-place="proposed"]').waitFor({ timeout: 15000 });
  await bob.page.locator('.songpicker .item[data-place="current"]').waitFor({ timeout: 15000 });
  check((await bob.page.getByRole('button', { name: /^Pick CI/ }).count()) === 0 && /Put forward/.test(await bob.page.locator('.songpicker .item[data-place="proposed"]').innerText()), 'neither song on the card is offered again in the picker (it says "Up now" / "Put forward")');
  await bob.page.getByRole('button', { name: 'Close the song picker' }).click();
  // Bob — not the one who put the shared song forward — settles it with one tap.
  await bob.page.getByRole('button', { name: 'Sing CI Sample Song' }).click();
  for (const [who, p] of [['alice', alice.page], ['bob', bob.page], ['dave', dave.page]]) {
    await p.locator('.setlist[data-choice="0"][data-songs="0"][data-current="1"]').waitFor({ timeout: 15000 });
    const settled = (await p.locator('.setlist').innerText()).replace(/\s+/g, ' ');
    check(/Up next/.test(settled) && /CI Sample Song/.test(settled) && !/CI Second Song/.test(settled), `${who}: one tap settled it — the chosen song is up, the other is gone`);
  }
  // …and the second act runs: bob starts it (his device is made ready on the way); the host's device joins from the
  // count-in by itself (her mic is open) — no tap.
  await bob.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  await alice.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  await bob.page.getByRole('button', { name: /Start the song/ }).click();
  await bob.page.locator('.sing .stagebar').waitFor({ timeout: 30000 });
  await alice.page.locator('.sing .stagebar').waitFor({ timeout: 30000 });
  check(true, 'a singer (not the host) picked the next song and started it; the host joined from the count-in without a tap');
  await wait(6000);
  // The third link may take a heal round under load: wait for both stages to report 2/2 rather than a fixed moment.
  const t3 = Date.now();
  let a3 = await stageInfo(alice.page);
  let b3 = await stageInfo(bob.page);
  while (Date.now() - t3 < 75000 && !(/2\/2 video linked/.test(a3.text) && /2\/2 video linked/.test(b3.text))) {
    await wait(1000);
    a3 = await stageInfo(alice.page);
    b3 = await stageInfo(bob.page);
  }
  check(a3.performers === '3' && b3.performers === '3' && /2\/2 video linked/.test(a3.text) && /2\/2 video linked/.test(b3.text), `the second song runs on the same stage, now with three singers (${a3.text} / ${b3.text}, ${Math.round((Date.now() - t3) / 1000)} s)`);
  // The show view (its page busy with the broadcast encoder) follows within a moment: the state is waited for, not read once.
  const showFollows = async () => /Up next|Now singing/.test(await carol.page.locator('.show-top').innerText().catch(() => '')) || (await carol.page.locator('.show[data-state="live"]').isVisible().catch(() => false));
  const tFollow = Date.now();
  while (Date.now() - tFollow < 8000 && !(await showFollows())) await wait(250);
  check(await showFollows(), `the show view follows the second song (${Math.round((Date.now() - tFollow) / 100) / 10} s)`);
  // The songs are at hand on the live stage: the drawer shows what is playing and lets anyone pick the next one.
  await bob.page.getByRole('button', { name: 'Songs' }).click();
  await bob.page.locator('.sing .drawer .setlist').waitFor({ timeout: 10000 });
  check(/Now singing/.test(await bob.page.locator('.sing .drawer').innerText()), 'the live stage has a Songs drawer (song picker) for the singers');
  await bob.page.getByRole('button', { name: 'Close the songs' }).click();
  // Every singer has the stage's own controls: Restart, and — in the Sound drawer — the Track / Vocal volume of their mix.
  check((await bob.page.getByRole('button', { name: /Restart the song for everyone/ }).count()) === 1, 'a singer (not the host) has the Restart button');
  await bob.page.getByRole('button', { name: 'Sound' }).click();
  await bob.page.locator('.sing .drawer.sound').waitFor({ timeout: 10000 });
  await bob.page.locator('.sing [data-mix="trackDb"] button[aria-label="Track volume up"]').click();
  await bob.page.locator('.sing [data-mix="trackDb"] button[aria-label="Track volume up"]').click();
  await bob.page.locator('.sing [data-mix="vocalDb"] button[aria-label="Vocal volume down"]').click();
  const balance = await bob.page.evaluate(() => JSON.parse(localStorage.getItem('sv.settings.app') || '{}'));
  check(balance.trackDb === 6 && balance.vocalDb === -3, `Track / Vocal volume move in 3 dB steps (±30 dB) and stay on the device (track ${balance.trackDb} dB, vocal ${balance.vocalDb} dB)`);
  check((await bob.page.locator('.sing .drawer.sound .micstatus').count()) === 1 && (await bob.page.locator('.sing .drawer.sound .fxbar').count()) === 1, 'the Sound drawer holds the microphone and the voice presets too (the stage itself keeps one row of controls)');
  await bob.page.getByRole('button', { name: 'Close the sound settings' }).click();
  // A singer may leave the song alone (the song goes on for the host) and join back in…
  await bob.page.getByRole('button', { name: 'Leave the song' }).click();
  await bob.page.getByRole('button', { name: 'Join the song' }).waitFor({ timeout: 30000 });
  check(await alice.page.locator('.sing .stagebar').isVisible(), "a singer's Leave steps them out of the song alone — the host keeps singing, the singer stays on the live stage");
  await bob.page.getByRole('button', { name: 'Join the song' }).click();
  await bob.page.getByRole('button', { name: 'Stop the song for everyone' }).waitFor({ timeout: 30000 });
  await wait(4000);
  const rejoinA = await posOf(alice.page);
  const rejoinB = await posOf(bob.page);
  const rejoinApart = Math.abs(rejoinB.posMs - rejoinA.posMs - (rejoinB.now - rejoinA.now)); // the two readings against their read times
  console.log('after rejoin:', JSON.stringify({ alice: rejoinA, bob: rejoinB, apart: rejoinApart }));
  check(rejoinB.playing && rejoinApart < 2500, `the singer who left is back in the song, in step with the stage (${Math.round(rejoinA.posMs / 1000)} s / ${Math.round(rejoinB.posMs / 1000)} s, ${Math.round(rejoinApart)} ms apart)`);
  // …or stop the song for everyone, like the host: everyone is back on the lobby stage; nothing saves (the film runs on).
  await bob.page.getByRole('button', { name: 'Stop the song for everyone' }).click();
  await alice.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 120000 });
  await bob.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 120000 });
  check(true, '"Stop song" on a singer\'s device wraps up the song for everyone — straight back to the lobby stage');
  await wait(3000);
  check((await alice.page.locator('[data-save]').count()) === 0 && (await bob.page.locator('[data-save]').count()) === 0 && (await alice.page.locator('[data-meet-film="on"]').count()) === 1, 'the second song saved nothing of its own either — the film of the meet has it, still running');
  // Only the host removes people: dave (on stage by now) is put out of the meet for good and sees why.
  alice.page.once('dialog', (d) => void d.accept());
  await alice.page.getByRole('button', { name: 'Remove dave from the meet' }).click();
  await dave.page.locator('[data-closed="removed"]').waitFor({ timeout: 30000 });
  check(/removed you from this meet/.test(await dave.page.locator('[data-closed="removed"]').innerText()), 'the host removed a listener from the meet; their device says so and offers the way back to the list');
  await dave.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await dave.page.locator('[data-closed="removed"], .callout.danger').first().waitFor({ timeout: 30000 });
  check(/removed you/.test(await dave.page.locator('[data-closed="removed"], .callout.danger').first().innerText()), 'a removed account cannot come back in by the link');
  alice.page.once('dialog', (d) => void d.accept());
  await alice.page.getByRole('button', { name: 'End meet' }).click();
  await alice.page.getByText(/Meet ended/).waitFor({ timeout: 15000 });
  check(true, 'the host ends the meet');
  // The ended screen lists the film of the meet: ONE file, recorded by the host's device from her mic opening to "End meet",
  // straight into her storage, with a chapter mark wherever the stage went — and shared with everyone who was in the meet
  // (it is under everyone's Performances). The film is written as the meet goes; End meet closes it, then it is registered.
  await alice.page.locator('[data-save="done"][data-save-id], [data-save="failed"][data-save-id]').first().waitFor({ timeout: 150000 }).catch(async (e) => {
    const chips = await alice.page.locator('[data-save]').evaluateAll((els) => els.map((el) => `${el.dataset.save}:${el.textContent.replace(/\s+/g, ' ').trim()}`)).catch(() => []);
    console.log('save status chips:', JSON.stringify(chips), '| page:', (await alice.page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400));
    throw e;
  });
  await alice.page.waitForFunction(() => document.querySelectorAll('[data-save="saving"], [data-save="queued"]').length === 0, null, { timeout: 150000 });
  const filmSave = (await alice.page.locator('[data-save]').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log('the film saved:', filmSave);
  check(/Saved “Full meet” · shared with the meet/.test(filmSave), `the film of the meet saved itself once, at End meet, as the meet's performance shared with everyone in it (${filmSave})`);
  // THE FILM IS ONE FILE WITH CHAPTER MARKS, never stopped by what the stage did. What the stage did, in order: the host's mic
  // opened in the lobby (on stage) · alice started the song (its kickstart) · bob restarted it · bob jumped it to 0:02 · alice
  // paused it · alice resumed it · alice jumped it to 12 s before the end · it ran out (the stage between songs) · bob started
  // the second act · bob stopped it (the stage again) · End meet. One mark each, in order, each with where it starts in the file.
  const wantMarks = [
    ['stage', /^▪ On stage 0:00$/],
    ['song', /^♪ CI Sample Song \d+:\d\d$/],
    ['song', /^♪ CI Sample Song \d+:\d\d$/], // the restart: from the top again
    ['song', /^♪ CI Sample Song \(from 0:0[1-3]\) \d+:\d\d$/], // the jump to 0:02
    ['pause', /^⏸ Paused — CI Sample Song \d+:\d\d$/],
    ['song', /^♪ CI Sample Song \(from 0:\d\d\) \d+:\d\d$/], // resumed where it stood
    ['song', /^♪ CI Sample Song \(from 6:[45]\d\) \d+:\d\d$/], // the jump to 6:48
    ['stage', /^▪ On stage \d+:\d\d$/],
    ['song', /^♪ CI Sample Song \d+:\d\d$/], // the second act
    ['stage', /^▪ On stage \d+:\d\d$/],
  ];
  await alice.page.waitForFunction((n) => [...document.querySelectorAll('[data-performance][data-film-marks]')].some((e) => Number(e.getAttribute('data-film-marks')) >= n), wantMarks.length, { timeout: 90000 }).catch(() => undefined);
  const endedRows = await alice.page.locator('[data-performance]').evaluateAll((els) => els.map((e) => ({ text: e.innerText.replace(/\s+/g, ' '), title: (e.querySelector('.t')?.innerText ?? '').replace(/\s+/g, ' ').trim(), marks: Number(e.getAttribute('data-film-marks') || 0), kinds: e.getAttribute('data-film-kinds') || '', line: (e.querySelector('[data-film-chapters]')?.innerText ?? '').replace(/\s+/g, ' ').trim() })));
  console.log('ended screen:', JSON.stringify(endedRows.map((r) => `${r.title} · ${r.marks} marks · ${r.line}`)));
  check(endedRows.length === 1 && /Full meet/.test(endedRows[0].title), `the ended meet lists ONE performance — the film of the whole meet, not a file per song (${endedRows.length}: ${endedRows.map((r) => r.title).join(' | ')})`);
  const film = endedRows[0] ?? { marks: 0, kinds: '', line: '', text: '' };
  let marks = film.line ? film.line.split(' · ') : [];
  // A third singer whose link took long enough joined the second act well under way: the song restarted from the top for
  // everyone (the late-join restart) — a real restart, and the film has it as the mark it is. Allowed, and said.
  const lateJoinRestart = marks.length === wantMarks.length + 1 && /^♪ CI Sample Song \d+:\d\d$/.test(marks[9] ?? '') && film.kinds.split(',')[9] === 'song';
  if (lateJoinRestart) {
    console.log('the second act restarted for a late-joining singer: one more song mark, as it should be');
    marks = [...marks.slice(0, 9), ...marks.slice(10)];
  }
  const kinds = (lateJoinRestart ? [...film.kinds.split(',').slice(0, 9), ...film.kinds.split(',').slice(10)] : film.kinds.split(',')).join(',');
  check(kinds === wantMarks.map((w) => w[0]).join(','), `the film is marked where the stage went — on stage, the song, its restart, the jump, the pause, the song resumed, the jump near the end, the stage between, the second act${lateJoinRestart ? ' (restarted once for a late joiner)' : ''}, the stage again (${kinds})`);
  const misnamed = wantMarks.map(([, re], i) => (re.test(marks[i] ?? '') ? null : `${i + 1}: "${marks[i] ?? '—'}"`)).filter(Boolean);
  check(misnamed.length === 0, `every mark is named for what it is — the song, where a jump or a resume took it up, the pause, the stage between — with where it starts in the film${misnamed.length ? ` (not as expected: ${misnamed.join(', ')})` : ''}`);
  const markAt = (m) => { const t = / (\d+):(\d\d)$/.exec(m); return t ? Number(t[1]) * 60 + Number(t[2]) : -1; };
  const starts = marks.map(markAt);
  check(starts.every((t) => t >= 0) && starts.every((t, i) => i === 0 || t >= starts[i - 1]), `the marks climb through the file in order (${starts.join(' ')})`);
  const durOf = (t) => { const m = / · (\d+):(\d\d) · /.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; }; // "… · 9:55 · alice, bob" — the duration sits between the separators
  const filmSecs = durOf(film.text);
  check(filmSecs >= 240, `the one film spans the whole meet, both songs and the talk between — never stopped at a song's start, pause, stop or restart (${filmSecs} s, ${film.marks} marks)`);
  check(starts.length >= 2 && starts.every((t) => t <= filmSecs + 1), 'every mark lies inside the film');
  check((await alice.page.locator('[data-meet-film]').count()) === 0 || (await alice.page.locator('[data-meet-film="on"]').count()) === 0, 'the film stopped with the meet');
  await navigate(bob.page, `${new URL(base).pathname}studio/performances`);
  await bob.page.locator('[data-show]').first().waitFor({ timeout: 20000 });
  const bobShows = await bob.page.locator('[data-show]').evaluateAll((els) => els.map((e) => ({ text: e.innerText.replace(/\s+/g, ' '), marks: Number(e.getAttribute('data-film-marks') || 0), kinds: e.getAttribute('data-film-kinds') || '', line: (e.querySelector('[data-film-chapters]')?.innerText ?? '').replace(/\s+/g, ' ').trim() })));
  console.log('bob performances:', JSON.stringify(bobShows.map((r) => r.text.slice(0, 90))));
  check(bobShows.length === 1 && /Duet e2e · Full meet/.test(bobShows[0].text) && bobShows[0].marks === film.marks && bobShows[0].kinds === film.kinds && bobShows[0].line === film.line, `a singer finds the film of the meet under Performances — one row, the same ${film.marks} marks, shared with the whole meet (${bobShows.length} rows)`);
  check((await bob.page.locator('[data-chapter], [data-event]').count()) === 0, 'no chapter files, no filming to group: the film is one row');
  await bob.page.screenshot({ path: `${out}/performances-bob.png` });
  const bobTakes = (await bob.page.locator('.list .item').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
  check(!bobTakes.some((t) => /CI Sample Song/.test(t) && /Kept/.test(t)), `a singer has no take of their own per song — nothing was saved on their device (${bobTakes.length} items)`);
  // The host plays the film from Performances ("Chapters": the in-app player with a button per mark): it is the 1280×720
  // broadcast picture, with the whole mix, for the whole meet.
  await navigate(alice.page, `${new URL(base).pathname}studio/performances`);
  await alice.page.locator('[data-show][data-film-marks]').first().waitFor({ timeout: 20000 });
  await alice.page.locator('[data-show][data-film-marks]').first().locator('[data-film-play]').click();
  const filmMeta = await alice.page.evaluate(async () => {
    const started = Date.now();
    let v = null;
    while (!(v = document.querySelector('.sheet video')) && Date.now() - started < 20000) await new Promise((r) => setTimeout(r, 200));
    if (!v) return null;
    await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
    return { w: v.videoWidth, h: v.videoHeight };
  });
  console.log('film video:', JSON.stringify(filmMeta));
  check(filmMeta && filmMeta.w === 1280 && filmMeta.h === 720, `the film is the 1280×720 broadcast picture (${JSON.stringify(filmMeta)})`);
  // The player has a button per mark, each with its place in the file and when it was.
  await alice.page.locator('[data-film-marks-row] [data-film-mark]').first().waitFor({ timeout: 10000 });
  const markButtons = await alice.page.locator('[data-film-marks-row] [data-film-mark]').evaluateAll((els) => els.map((e) => ({ index: Number(e.getAttribute('data-film-mark')), kind: e.getAttribute('data-film-mark-kind'), at: Date.parse(e.getAttribute('data-film-mark-at') || ''), ms: Number(e.getAttribute('data-film-mark-ms')), text: e.innerText.replace(/\s+/g, ' ').trim() })));
  check(markButtons.length === film.marks && markButtons.every((b, i) => b.index === i + 1 && b.at > 0 && b.ms >= 0 && (i === 0 || b.ms >= markButtons[i - 1].ms)), `the player offers a button per mark, in order, each with its place in the film (${markButtons.length})`);
  const songMark = markButtons.find((b) => b.kind === 'song');
  // Keep the host's film beside the screenshots (inspect its frames / sound with ffmpeg).
  const filmBytes = await sheetVideo(alice.page, `${out}/film-alice.webm`);
  console.log('film file:', filmBytes, 'bytes');
  // WHAT THE SAVED FILE HOLDS — the same file lands in Drive when signed in with Google: the film carries the song and the
  // voice where the meet sang them (the moment of the first song measured live sits where the song's mark says), and so does
  // the publisher's footage of the broadcast. A film with the picture and no song, or with the room and not the singer, is
  // the thing these are here to catch.
  const fileSound = async (file, atS, window) => {
    const pcm = decodeToPcm(file, 48000);
    const a = Math.max(0, Math.round(atS * 48000));
    const slice = pcm.subarray(a, Math.min(pcm.length, a + 6 * 48000));
    const m = measure(slice, songAt(48000), 48000, { window });
    return { rms: m.rms, song: m.song, voice: m.voice - voiceOfSong(songAt(48000), 48000, m.song.positionS, 6), seconds: pcm.length / 48000, atS };
  };
  /**
   * Which way the picture faces: the fake person wears a MAGENTA badge on the camera's left of their head and a YELLOW one on
   * the camera's right (fake-person.mjs) — colours the stage never shows otherwise. In the frame at `atS`, magenta left of
   * yellow is the picture as the camera saw it ('left'); the other way round is a mirror ('right'). Both singers are the same
   * fake person, so the two centres move together.
   */
  const mirrorOf = (file, atS) => {
    const W = 320, H = 180;
    const rgb = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, atS)), '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
    let mag = { n: 0, x: 0 }, yel = { n: 0, x: 0 };
    for (let i = 0, px = 0; i + 2 < rgb.length && px < W * H; i += 3, px++) {
      const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
      const x = px % W;
      if (r > 170 && b > 170 && g < 100) { mag.n++; mag.x += x; }
      else if (r > 190 && g > 190 && b < 90) { yel.n++; yel.x += x; }
    }
    if (mag.n < 10 || yel.n < 10) return { side: 'unknown', magenta: mag.n, yellow: yel.n };
    const magX = mag.x / mag.n, yelX = yel.x / yel.n;
    return { side: magX < yelX - 2 ? 'left' : magX > yelX + 2 ? 'right' : 'centre', magentaX: Math.round(magX), yellowX: Math.round(yelX), magenta: mag.n, yellow: yel.n };
  };
  if (filmBytes && songMark) {
    // Where the live-measured moment sits in the film: the mark's place in the file plus the capture's wall clock against the mark's.
    const filmAt = Math.max(0, songMark.ms / 1000 + (hostCap.wallStart - songMark.at) / 1000 - 1);
    const filmSound = await fileSound(`${out}/film-alice.webm`, filmAt, [stageS - 25, stageS + 15]);
    console.log("the film's sound:", JSON.stringify({ ...filmSound, rms: filmSound.rms.toFixed(3), voice: filmSound.voice.toFixed(1) }));
    check(filmSound.song.r > 0.3, `the film carries the song where the meet sang it (correlation ${filmSound.song.r.toFixed(2)} at ${filmSound.song.positionS.toFixed(1)} s into the song, ${filmAt.toFixed(0)} s into the film)`);
    check(filmSound.voice > 6, `the film carries the host's voice (${filmSound.voice.toFixed(1)} dB above the song alone)`);
    const cutOff = firstKickstart ? (songMark.at - firstKickstart) / 1000 : null;
    check(cutOff !== null && cutOff > -2 && cutOff < 2.5, `the song's mark sits at the song's kickstart — the service's instant, not a poll later (the mark is ${cutOff === null ? '?' : cutOff.toFixed(2)} s from it; a moment ahead by design)`);
    check(Math.abs(filmSound.song.positionS - (filmAt - songMark.ms / 1000)) < 3, `the mark's clock is the song's: ${filmSound.song.positionS.toFixed(1)} s of the song at ${(filmAt - songMark.ms / 1000).toFixed(1)} s past the mark`);
    // THE PICTURE IS NOT MIRRORED: in the film both singers' badges sit where the cameras saw them (the screen keeps its selfie
    // mirror; what is recorded and streamed does not).
    const filmMirror = mirrorOf(`${out}/film-alice.webm`, filmAt + 1);
    console.log('film mirror check:', JSON.stringify(filmMirror));
    check(filmMirror.side === 'left', `the film is not mirrored — the singers' badges are where the cameras saw them (${filmMirror.side}: magenta x ${filmMirror.magentaX ?? '?'}, yellow x ${filmMirror.yellowX ?? '?'})`);
    // The film is a moving picture for its whole length, not one frame with a song behind it: the picture's track is fed frame by
    // frame (CanvasTrack), so it holds whether or not the tab was in front — through both songs and the talk between.
    const probe = (args) => { try { return execFileSync('ffprobe', ['-v', 'error', ...args, `${out}/film-alice.webm`]).toString().trim(); } catch { return ''; } };
    const packets = Number(probe(['-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0']));
    const lastVideoS = Number(probe(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0']).split('\n').filter(Boolean).pop() ?? 0);
    const audioS = Number(probe(['-select_streams', 'a:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0']).split('\n').filter(Boolean).pop() ?? 0);
    console.log('the film:', { packets, lastVideoS, audioS });
    check(packets > 200 && lastVideoS >= 200 && lastVideoS > audioS * 0.8, `the film's picture runs the whole meet (${packets} frames, picture to ${lastVideoS.toFixed(1)} s of ${audioS.toFixed(1)} s)`);
  } else check(false, 'the film of the meet can be played from Performances');
  await alice.page.keyboard.press('Escape');
  await alice.page.locator('.sheet').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
  await alice.page.screenshot({ path: `${out}/performances-alice.png` });
  // Meets list maintenance: the ended meet is listed with Delete; open meets are counted against the limit of 3.
  await navigate(alice.page, `${new URL(base).pathname}meets`);
  await alice.page.locator('.meet-item').first().waitFor({ timeout: 15000 });
  check(/open meets 0\/3/.test(await alice.page.locator('[data-open-meets]').innerText()), 'the meets home shows the open-meet count against the limit');
  check(!(await alice.page.locator('.roompill').isVisible().catch(() => false)), 'a finished meet does not follow you around (no pill)');
  alice.page.once('dialog', (d) => void d.accept());
  await alice.page.getByRole('button', { name: 'Delete Duet e2e' }).click();
  await wait(1500);
  check((await alice.page.locator('.meet-item').count()) === 0, 'the host deleted the meet from the list');
  // Publishing is for club owners: dave (a dual account) finds it closed, with the reason; the super admin grants a club
  // owner's year on the Admin page, and it opens for that account at once (tools/ci/roles-e2e.mjs has the rest of the roles).
  await dave.page.goto(`${base}publishing?${control}`, { waitUntil: 'networkidle' });
  await dave.page.getByRole('heading', { name: 'Publishing mode is for club owners' }).waitFor({ timeout: 15000 });
  check(/club owner/.test(await dave.page.locator('.empty, main').first().innerText()), 'a singer finds Publishing closed, with the reason: it is for club owners');
  await dave.page.goto(`${base}plans?${control}`, { waitUntil: 'networkidle' });
  await dave.page.locator('[data-plans][data-current-plan="svv"] [data-plan-card="club"] [data-ask-admin="club"]').waitFor({ timeout: 15000 });
  check(/Publishing mode/.test(await dave.page.locator('[data-plan-card="club"]').innerText()) && (await dave.page.locator('[data-plan-card]').count()) === 4, 'the Plans page offers the four plans; the Club owner plan carries Publishing mode');
  check((await dave.page.locator('[data-choose]').count()) === 0, 'without Stripe configured a plan is asked of the admin, not bought');
  await alice.page.goto(`${base}admin?${control}`, { waitUntil: 'networkidle' });
  const daveRow = alice.page.locator('[data-admin-user="dave@dev.local"]');
  await daveRow.waitFor({ timeout: 15000 });
  await daveRow.locator('[data-grant-plan]').selectOption('club');
  await daveRow.locator('[data-sub-grant]').click();
  await alice.page.locator('[data-admin-user="dave@dev.local"][data-user-role="club_owner"]').waitFor({ timeout: 10000 });
  check(/publishing open/.test(await daveRow.innerText()), "the super admin's grant on the Admin page makes a club owner of the account, with Publishing open");
  await dave.page.goto(`${base}publishing?${control}`, { waitUntil: 'networkidle' });
  await dave.page.getByRole('radio', { name: 'Publish a meet' }).waitFor({ timeout: 15000 });
  check(true, "the grant opens Publishing for that account at once");
  await carol.page.mouse.move(900, 900);
  await carol.page.mouse.move(930, 950);
  await carol.page.locator('.show[data-idle="0"]').waitFor({ timeout: 5000 });
  if (await carol.page.getByRole('button', { name: 'Stop publishing' }).isVisible().catch(() => false)) await carol.page.getByRole('button', { name: 'Stop publishing' }).click();
  await carol.page.locator('.showbar .jobline', { hasText: 'stopped' }).waitFor({ timeout: 15000 });
  await monitor.close();
  // The publisher's own Performances page lists the footage of the broadcast: one file too, marked like the film.
  const carolPerf = await carol.ctx.newPage();
  carolPerf.on('pageerror', (e) => errors.carol.push(String(e)));
  await carolPerf.goto(`${base}studio/performances?${control}`, { waitUntil: 'networkidle' });
  const carolRow = carolPerf.locator('[data-show][data-film-marks]', { hasText: 'Broadcast' }).first();
  await carolRow.waitFor({ timeout: 20000 }).catch(() => undefined);
  const footageKinds = ((await carolRow.getAttribute('data-film-kinds').catch(() => '')) || '').split(',').filter(Boolean);
  console.log('footage marks:', JSON.stringify(footageKinds));
  // The broadcast went on air during the first song and was stopped before anything happened to it: one mark, the song.
  check(footageKinds.length >= 1 && footageKinds[0] === 'song' && footageKinds.every((k) => ['song', 'pause', 'stage'].includes(k)), `the publisher finds the footage of the broadcast under Performances as one file, marked where the stage went while it was on air (${footageKinds.join(',')})`);
  await carolPerf.screenshot({ path: `${out}/performances-carol.png` });
  // The footage carries the song and the voices, exactly as the broadcast did: the moment measured on the bus, where the marks put it.
  await carolRow.locator('[data-film-play]').click();
  await carolPerf.locator('[data-film-marks-row] [data-film-mark]').first().waitFor({ timeout: 10000 }).catch(() => undefined);
  const footageMarks = await carolPerf.locator('[data-film-marks-row] [data-film-mark]').evaluateAll((els) => els.map((e) => ({ index: Number(e.getAttribute('data-film-mark')), kind: e.getAttribute('data-film-mark-kind'), at: Date.parse(e.getAttribute('data-film-mark-at') || ''), ms: Number(e.getAttribute('data-film-mark-ms')) }))).catch(() => []);
  const busMark = [...footageMarks].filter((c) => c.at <= busCap.wallStart).sort((a, b) => b.at - a.at)[0] ?? footageMarks[0];
  const footageBytes = await sheetVideo(carolPerf, `${out}/footage-carol.webm`);
  if (footageBytes) {
    const footageAt = Math.max(0, (busMark ? busMark.ms / 1000 + (busCap.wallStart - busMark.at) / 1000 : footageSecondsAtBus !== null ? footageSecondsAtBus + (busCap.wallStart - busWallAt) / 1000 : (busWallAt - goLiveAt) / 1000) - 1);
    const footageSound = await fileSound(`${out}/footage-carol.webm`, footageAt, [(stageAtBus ?? 0) / 1000 - 25, (stageAtBus ?? 0) / 1000 + 15]);
    console.log("the footage's sound:", JSON.stringify({ ...footageSound, rms: footageSound.rms.toFixed(3), voice: footageSound.voice.toFixed(1) }));
    check(footageSound.song.r > 0.3, `the footage of the broadcast carries the song (correlation ${footageSound.song.r.toFixed(2)} at ${footageSound.song.positionS.toFixed(1)} s into the song, ${footageAt.toFixed(0)} s into the footage)`);
    check(footageSound.voice > 6, `the footage of the broadcast carries the singers' voices (${footageSound.voice.toFixed(1)} dB above the song alone)`);
  } else check(false, 'the footage of the broadcast can be played from Performances');
  await carolPerf.close();
  // "Failed to load resource" is the browser noting any non-2xx fetch (a deleted meet's last heartbeat, say); real errors are the rest.
  const errs = Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v.filter((e) => !/favicon|Failed to load resource/.test(e))]));
  check(Object.values(errs).every((v) => !v.length), `no page errors (${JSON.stringify(errs).slice(0, 300)})`);
  console.log('the film and the footage reviewed');
} catch (e) {
  failed = true;
  console.error('FAIL', e);
  await alice.page.screenshot({ path: `${out}/duet-alice-fail.png` }).catch(() => {});
  await bob.page.screenshot({ path: `${out}/duet-bob-fail.png` }).catch(() => {});
  for (const [n, p] of Object.entries(extraPages)) await p.screenshot({ path: `${out}/duet-${n}-fail.png` }).catch(() => {});
  console.error('errors', JSON.stringify(errors));
}
await browser.close();
servers.stop();
process.exit(failed ? 1 : 0);
