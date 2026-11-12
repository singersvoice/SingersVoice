// Live-meet e2e: two performers (host alice on a desktop, guest bob on a phone) on ONE virtual stage.
// Fake cameras → person cut-outs → alpha-packed WebRTC through the SVT DB relay → both devices draw
// both singers; the host's cued pause/resume freezes and restarts both at the same track position.
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
const errors = { alice: [], bob: [] };

async function person(name, viewport) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors[name].push(m.text()));
  await page.goto(base + '?' + control, { waitUntil: 'networkidle' });
  // device identity for DEV_AUTH: the app sends X-Dev-User from the local profile sub
  await page.evaluate((n) => localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: '', picture: '', mode: 'local' })), name);
  await page.evaluate(() => { localStorage.setItem('sv.mode', 'local'); localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true })); });
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
  await alice.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  await alice.page.getByRole('button', { name: 'Take a stage slot' }).click();
  await alice.page.getByRole('button', { name: /I'm ready/ }).click();
  await alice.page.getByText(/Ready — stage will start/).waitFor({ timeout: 30000 });

  // Guest joins by link, takes a slot, gets ready.
  await bob.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await bob.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  await bob.page.getByRole('button', { name: 'Take a stage slot' }).click();
  await bob.page.getByRole('button', { name: /I'm ready/ }).click();
  await bob.page.getByText(/Ready — stage will start/).waitFor({ timeout: 30000 });

  await alice.page.getByRole('button', { name: /Start the song/ }).click();
  // Both land on the live stage; wait for the kickstart (8 s lead) and the mesh.
  await alice.page.locator('.stagebar').waitFor({ timeout: 30000 });
  await bob.page.locator('.stagebar').waitFor({ timeout: 30000 });
  await wait(9000);
  // Wait until the other singer's video actually carries frames on both sides (not just "connected").
  const remoteFrames = (p) => p.evaluate(async () => { const vs = [...document.querySelectorAll('video')].filter((v) => v.srcObject && v.videoWidth > 0 && v.readyState >= 2); const t = vs.map((v) => v.currentTime); await new Promise((r) => setTimeout(r, 700)); return vs.filter((v, i) => v.currentTime !== t[i]).length; });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && ((await remoteFrames(alice.page)) < 2 || (await remoteFrames(bob.page)) < 2)) await wait(500);
  const vids = (p) => p.evaluate(() => [...document.querySelectorAll('video')].map((v) => ({ w: v.videoWidth, rs: v.readyState, paused: v.paused, muted: v.srcObject ? (v.srcObject.getVideoTracks()[0] || {}).muted : null, tracks: v.srcObject ? v.srcObject.getVideoTracks().length : 0 })));
  console.log('videos alice:', JSON.stringify(await vids(alice.page)), 'bob:', JSON.stringify(await vids(bob.page)));
  const rtp = (p) => p.evaluate(async () => ({ mesh: window.__svMesh ? await window.__svMesh.stats() : null, feed: window.__svFeed ? { frame: window.__svFeed.frame, seg: window.__svFeed.segmenter.frame, mode: window.__svFeed.mode, level: window.__svFeed.level } : null }));
  console.log('rtp alice:', JSON.stringify(await rtp(alice.page)), 'bob:', JSON.stringify(await rtp(bob.page)));

  check((await remoteFrames(alice.page)) >= 2 && (await remoteFrames(bob.page)) >= 2, `remote video frames flowing on both devices (${Math.round((Date.now() - t0) / 1000)} s)`);
  await wait(1500);
  const stageInfo = async (p) => p.evaluate(() => {
    const bar = document.querySelector('.stagebar');
    const c = document.querySelector('canvas.stagecanvas');
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
  check(/paused by the host/.test(await bob.page.locator('.stagebar').innerText()), 'the guest sees "paused by the host"');
  await bob.page.screenshot({ path: `${out}/duet-bob-paused.png` });
  // Resume: cued 4 s ahead.
  await alice.page.getByRole('button', { name: /Resume for everyone/ }).click();
  await wait(6500);
  const ta3 = await alice.page.locator('.timeline .mono').first().innerText();
  const tb3 = await bob.page.locator('.timeline .mono').first().innerText();
  console.log('resumed:', { alice: ta3, bob: tb3 });
  const secs = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
  check(secs(ta3) > secs(ta1) && secs(tb3) > secs(tb1) && Math.abs(secs(ta3) - secs(tb3)) <= 1, 'both devices resumed together from the paused position');
  // Finish both (the 20 s sample may already have ended → the take review is up by itself).
  for (const p of [bob.page, alice.page]) {
    const finish = p.getByRole('button', { name: 'Finish' });
    if (await finish.isVisible().catch(() => false)) await finish.click().catch(() => undefined);
    await p.getByText('Your take').waitFor({ timeout: 30000 });
  }
  const errs = { alice: errors.alice.filter((e) => !/favicon/.test(e)), bob: errors.bob.filter((e) => !/favicon/.test(e)) };
  check(!errs.alice.length && !errs.bob.length, `no page errors (${JSON.stringify(errs).slice(0, 300)})`);
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
