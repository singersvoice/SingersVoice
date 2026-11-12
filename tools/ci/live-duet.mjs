// Live-meet e2e: two performers (host alice on a desktop, guest bob on a phone) on ONE virtual stage.
// Fake cameras → person cut-outs → alpha-packed WebRTC through the SVT DB relay → both devices draw
// both singers; the host's cued pause/resume freezes and restarts both at the same track position.
// A third, privileged account (carol) opens the Publishing show view: receive-only, both performers
// drawn huge on a 1080p stage, no lyrics, and the broadcast job goes to "requested".
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/live-duet.mjs [outDir]
// Exits 1 when any assertion fails. Needs playwright (local install or /opt/npm-tools).
import { createRequire } from 'node:module';
import { startServers } from './servers.mjs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/' });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
// A synthetic person as the fake camera, so the real segmentation model has something to cut out.
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const clip = path.join(tmpdir(), 'sv-fake-person.y4m');
execFileSync('node', [new URL('./fake-person.mjs', import.meta.url).pathname, clip], { stdio: 'inherit' });
const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const out = process.argv[2] ?? 'screenshots';
import { mkdirSync } from 'node:fs';
mkdirSync(out, { recursive: true });
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
const errors = { alice: [], bob: [], carol: [] };

async function person(name, viewport, { track = true } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors[name].push(m.text()));
  await page.goto(base + '?' + control, { waitUntil: 'networkidle' });
  // device identity for DEV_AUTH: the app sends X-Dev-User from the local profile sub
  await page.evaluate((n) => localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: '', picture: '', mode: 'local' })), name);
  await page.evaluate(() => { localStorage.setItem('sv.mode', 'local'); localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true })); });
  if (!track) return { ctx, page, trackId: null };
  await page.goto(base + 'tracks?' + control, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.locator('input[type=file][accept*=".json"]').setInputFiles('apps/web/test/fixtures/sample.track.json');
  await page.locator('input[type=file][accept*="audio"]').setInputFiles('apps/web/test/fixtures/sample.mp3');
  await page.getByRole('button', { name: /^Import$/ }).last().click();
  await page.getByText(/^Imported/).waitFor({ timeout: 30000 });
  await wait(500);
  const trackId = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('singersvoice'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('tracks'); const q = tx.objectStore('tracks').getAllKeys(); q.onsuccess = () => res(q.result[0]); }; }));
  return { ctx, page, trackId };
}

const alice = await person('alice', { width: 1280, height: 800 });
const bob = await person('bob', { width: 390, height: 844 });
// Bob's copy must be recognisable as the host's track: rename his record to "<hostId>-copy-bob"
await bob.page.evaluate(([from, to]) => new Promise((res) => { const r = indexedDB.open('singersvoice'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('tracks', 'readwrite'); const st = tx.objectStore('tracks'); const g = st.get(from); g.onsuccess = () => { const rec = g.result; rec.track.trackId = to; st.put(rec, to); st.delete(from); }; tx.oncomplete = () => res(); }; }), [bob.trackId, `${alice.trackId}-copy-bob`]);

try {
  // Host creates the meet with her track.
  await alice.page.goto(base + 'meets', { waitUntil: 'networkidle' });
  await alice.page.getByPlaceholder('Sunday SV music meet').fill('Duet e2e');
  await alice.page.locator('select.input').first().selectOption({ index: 1 });
  await alice.page.getByRole('button', { name: 'Create meet' }).click();
  await alice.page.waitForURL(/\/meet\//);
  const meetUrl = alice.page.url();
  const meetId = /\/meet\/([^/?#]+)/.exec(meetUrl)[1];
  await alice.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  const remoteFrames = (p) => p.evaluate(async () => { const vs = [...document.querySelectorAll('video')].filter((v) => v.srcObject && v.videoWidth > 0 && v.readyState >= 2); const t = vs.map((v) => v.currentTime); await new Promise((r) => setTimeout(r, 700)); return vs.filter((v, i) => v.currentTime !== t[i]).length; });
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

  // Guest joins by link: audience first. He has to ask; the host lets him on.
  await bob.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await bob.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  check(!(await bob.page.getByRole('button', { name: 'Take a stage slot' }).isVisible().catch(() => false)), 'an audience member cannot just take a slot (the stage policy is "ask")');
  await bob.page.getByRole('button', { name: 'Ask to sing' }).click();
  await bob.page.getByText(/Asked to sing — waiting for/).waitFor({ timeout: 15000 });
  await alice.page.locator('.requests').waitFor({ timeout: 15000 });
  check(/bob/.test(await alice.page.locator('.requests').innerText()), 'the host sees "bob wants to join the stage"');
  await alice.page.screenshot({ path: `${out}/lobby-alice-request.png` });
  await alice.page.getByRole('button', { name: 'Let bob sing' }).click();
  await bob.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 15000 });
  check(true, 'the host let bob on stage: he is seated (slot 2) without touching anything');
  // Both performers' video links come up in the lobby (the stage runs before the song).
  const tLobby = Date.now();
  while (Date.now() - tLobby < 30000 && ((await remoteFrames(alice.page)) < 1 || (await remoteFrames(bob.page)) < 1)) await wait(500);
  await wait(1000);
  const sa2 = await stripInfo(alice.page);
  const sb2 = await stripInfo(bob.page);
  console.log('lobby stage alice:', JSON.stringify(sa2), '\nlobby stage bob:  ', JSON.stringify(sb2));
  check(sa2.performers === '2' && sb2.performers === '2', 'both lobby stages lay out 2 performers');
  check(sa2.linked === '1' && sb2.linked === '1' && /1\/1 video linked/.test(sa2.text), `video linked both ways in the lobby (${Math.round((Date.now() - tLobby) / 1000)} s)`);
  check(sa2.left > 100 && sa2.right > 100 && sb2.left > 100 && sb2.right > 100, 'both singers are drawn on both lobby stages');
  await bob.page.screenshot({ path: `${out}/lobby-bob-onstage.png` });

  // Publishing: the show is its own process — carol's show view gets both performers while the song has not started.
  const carol = await person('carol', { width: 1920, height: 1080 }, { track: false });
  await carol.page.goto(`${base}publishing/show/${meetId}?${control}`, { waitUntil: 'networkidle' });
  await carol.page.locator('.show[data-state="lobby"]').waitFor({ timeout: 30000 });
  const tShowLobby = Date.now();
  while (Date.now() - tShowLobby < 30000 && (await remoteFrames(carol.page)) < 2) await wait(500);
  check((await remoteFrames(carol.page)) >= 2, `the show view receives both performers before the song starts (${Math.round((Date.now() - tShowLobby) / 1000)} s)`);
  check(/the song has not started yet/.test(await carol.page.locator('.show-note').innerText().catch(() => '')), 'the show picture says the song has not started yet');
  await carol.page.screenshot({ path: `${out}/show-carol-lobby.png` });

  // Everyone gets ready; the host starts the song. The stage carries on — nothing reconnects.
  await alice.page.getByRole('button', { name: /I'm ready/ }).click();
  await alice.page.getByText(/Ready — stage will start/).waitFor({ timeout: 30000 });
  await bob.page.getByRole('button', { name: /I'm ready/ }).click();
  await bob.page.getByText(/Ready — stage will start/).waitFor({ timeout: 30000 });
  const meshBefore = await alice.page.evaluate(() => (window.__svMeshId = window.__svMeshId || Math.random(), window.__svMesh && (window.__svMesh.__id = window.__svMesh.__id || window.__svMeshId)));
  await alice.page.getByRole('button', { name: /Start the song/ }).click();
  // Both land on the live stage; wait for the kickstart (8 s lead).
  await alice.page.locator('.sing .stagebar').waitFor({ timeout: 30000 });
  await bob.page.locator('.sing .stagebar').waitFor({ timeout: 30000 });
  await wait(9000);
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
  const inbox = async (p, who) => { const mid = /\/meet\/([^/?#]+)/.exec(meetUrl)[1]; return p.evaluate(async ([m, w, ctl]) => { const key = Object.keys(sessionStorage).find((k) => k.startsWith(`sv.meet.${m}`) && k.endsWith('.rt')); const rt = sessionStorage.getItem(key); const r = await fetch(`${ctl}/meets/${m}/signals`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-User': w, 'X-Dev-Name': w }, body: JSON.stringify({ resumeToken: rt, since: 0 }) }); const j = await r.json(); return (j.signals || []).map((x) => `${x.seq}:${x.type}<${x.from.slice(-6)}@${x.sentAt.slice(11, 23)}`).join(' '); }, [mid, who, servers.controlUrl]); };
  for (const [n, p] of [['alice', alice.page], ['bob', bob.page], ['carol', carol.page]]) console.log(`peers ${n}:`, JSON.stringify(await peers(p)), '\n inbox:', await inbox(p, n));
  check((await remoteFrames(carol.page)) >= 2, `the show view receives both performers' video (${Math.round((Date.now() - t1) / 1000)} s)`);
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
  check(show.tiles.length === 2 && show.tiles.every((t) => t.source === 'packed'), 'the show view lays out both performers from their video');
  check(show.tiles.every((t) => t.h > show.h * 0.9), `performers stand huge on the show stage (tile ${show.tiles[0]?.h} of ${show.h} px)`);
  check(show.left > 2000 && show.right > 2000 && show.top > 0, 'both cut-outs are drawn, filling the frame up to the top');
  check(show.lyrics === 0, 'no lyrics in publish mode');
  check(/2 on stage · 2\/2 video/.test(show.top_text), `show header: ${show.top_text}`);
  await carol.page.screenshot({ path: `${out}/show-carol-live.png` });
  // Go live with the in-house destination (enabled by default): the job is requested for this meet.
  // The chrome hides itself while the show plays; moving the pointer brings it back (like a video player).
  check((await carol.page.locator('.show').getAttribute('data-idle')) === '1', 'the show chrome hides itself while the show plays');
  await carol.page.mouse.move(900, 900);
  await carol.page.mouse.move(920, 940);
  await carol.page.locator('.show[data-idle="0"]').waitFor({ timeout: 5000 });
  await carol.page.locator('.showbar .dest', { hasText: 'In-house portal' }).waitFor({ timeout: 15000 });
  await carol.page.getByRole('button', { name: 'Go live' }).click();
  await carol.page.locator('.showbar .jobline').waitFor({ timeout: 15000 });
  const jobline = await carol.page.locator('.showbar .jobline').innerText();
  check(/requested/.test(jobline) && /inhouse/.test(jobline), `publish job queued from the show view (${jobline.replace(/\s+/g, ' ')})`);
  check(await carol.page.getByRole('button', { name: 'Stop publishing' }).isVisible(), 'the show view offers Stop while the job is active');
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
  await monitor.locator('.monitor[data-state="live"]').waitFor({ timeout: 30000 });
  const t2 = Date.now();
  while (Date.now() - t2 < 25000 && (await remoteFrames(monitor)) < 2) await wait(500);
  check((await remoteFrames(monitor)) >= 2, `the Preview tile receives both performers' video (${Math.round((Date.now() - t2) / 1000)} s)`);
  await wait(1200);
  const tile = await monitor.evaluate(() => {
    const m = document.querySelector('.monitor[data-state="live"]');
    const c = m.querySelector('canvas.stagecanvas');
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
  check(/LIVE|requested/.test(tile.card), 'the tile shows the publish state of the meet');
  const showStill = await carol.page.evaluate(() => Object.values(window.__svMesh.peerStates()).filter((s) => s === 'connected').length);
  check(showStill === 2, `the show view keeps both links while the Preview tile watches too (${showStill})`);
  await monitor.screenshot({ path: `${out}/preview-carol.png` });

  // Host restarts the song from the top (cued 5 s ahead) so the 20 s sample has room for the pause/resume checks.
  await alice.page.getByRole('button', { name: /Restart the song for everyone/ }).click();
  await wait(7000);
  const tr = await alice.page.locator('.timeline .mono').first().innerText();
  check(secs(tr) < 6, `restart took everyone back to the top (${tr})`);
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
  check(/paused by the host/.test(await bob.page.locator('.sing .stagebar').innerText()), 'the guest sees "paused by the host"');
  await bob.page.screenshot({ path: `${out}/duet-bob-paused.png` });
  check(await carol.page.locator('.show-note', { hasText: 'Paused by the host' }).isVisible(), 'the show view shows the pause');
  // Resume: cued 4 s ahead.
  await alice.page.getByRole('button', { name: /Resume for everyone/ }).click();
  await wait(6500);
  const ta3 = await alice.page.locator('.timeline .mono').first().innerText();
  const tb3 = await bob.page.locator('.timeline .mono').first().innerText();
  console.log('resumed:', { alice: ta3, bob: tb3 });
  check(secs(ta3) > secs(ta1) && secs(tb3) > secs(tb1) && Math.abs(secs(ta3) - secs(tb3)) <= 1, 'both devices resumed together from the paused position');
  // Finish both (the 20 s sample may already have ended → the take review is up by itself).
  for (const p of [bob.page, alice.page]) {
    const finish = p.getByRole('button', { name: 'Finish' });
    if (await finish.isVisible().catch(() => false)) await finish.click().catch(() => undefined);
    await p.getByText('Your take').waitFor({ timeout: 30000 });
  }
  await carol.page.mouse.move(900, 900);
  await carol.page.mouse.move(930, 950);
  await carol.page.locator('.show[data-idle="0"]').waitFor({ timeout: 5000 });
  await carol.page.getByRole('button', { name: 'Stop publishing' }).click();
  await carol.page.locator('.showbar .jobline', { hasText: 'stopped' }).waitFor({ timeout: 15000 });
  await monitor.close();
  const errs = Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v.filter((e) => !/favicon/.test(e))]));
  check(Object.values(errs).every((v) => !v.length), `no page errors (${JSON.stringify(errs).slice(0, 300)})`);
  console.log('both takes reviewed');
} catch (e) {
  failed = true;
  console.error('FAIL', e);
  await alice.page.screenshot({ path: `${out}/duet-alice-fail.png` }).catch(() => {});
  await bob.page.screenshot({ path: `${out}/duet-bob-fail.png` }).catch(() => {});
  console.error('errors', JSON.stringify(errors));
}
await browser.close();
servers.stop();
process.exit(failed ? 1 : 0);
