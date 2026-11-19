// Latency probe: where the time goes between a tap and what the stage shows — on the device that tapped and on the
// others — and what the main thread does when a song starts. Two performers (host alice on a desktop, bob on a phone)
// and one audience device (dave); the local control service. Prints a table; no verdicts.
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/latency-probe.mjs [outDir]
import { createRequire } from 'node:module';
import { startServers } from './servers.mjs';
import { makeSong } from './e2e-song.mjs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const out = process.argv[2] ?? 'probe';
mkdirSync(out, { recursive: true });
const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/' });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
const clip = path.join(tmpdir(), 'sv-fake-person.y4m');
const SONG_S = 240;
const longSong = makeSong(path.join(tmpdir(), 'sv-probe-song.mp3'), SONG_S);
const longTrack = path.join(tmpdir(), 'sv-probe-song.track.json');
{
  const t = JSON.parse(readFileSync('apps/web/test/fixtures/sample.track.json', 'utf8'));
  t.durationMs = SONG_S * 1000;
  writeFileSync(longTrack, JSON.stringify(t));
}
execFileSync('node', [new URL('./fake-person.mjs', import.meta.url).pathname, clip], { stdio: 'inherit' });
const voice = path.join(tmpdir(), 'sv-fake-voice.wav');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=30`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', voice]);
const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, `--use-file-for-fake-audio-capture=${voice}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = {};
const rows = [];
const row = (what, ms, note = '') => { rows.push({ what, ms: Math.round(ms), note }); console.log(`${what.padEnd(64)} ${String(Math.round(ms)).padStart(6)} ms  ${note}`); };

async function person(name, viewport, { track = true } = {}) {
  errors[name] = [];
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'], deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60000);
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__svStalls = [];
    let last = Date.now();
    setInterval(() => { const now = Date.now(); if (now - last > 150) window.__svStalls.push({ at: last, ms: now - last }); last = now; }, 50);
    window.__svLong = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__svLong.push({ at: performance.timeOrigin + e.startTime, ms: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] }); } catch { /* no longtask here */ }
  });
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors[name].push(m.text()));
  await page.goto(base + '?' + control, { waitUntil: 'networkidle' });
  await page.evaluate((n) => localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: '', picture: '', mode: 'local' })), name);
  await page.evaluate(() => { localStorage.setItem('sv.mode', 'local'); localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true })); });
  if (!track) return { ctx, page, trackId: null, name };
  await page.goto(base + 'tracks?' + control, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.locator('input[type=file][accept*=".json"]').setInputFiles(longTrack);
  await page.locator('input[type=file][accept*="audio"]').setInputFiles(longSong);
  await page.getByRole('button', { name: /^Import$/ }).last().click();
  await page.getByText(/^Imported/).waitFor({ timeout: 30000 });
  const trackId = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('singersvoice'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('tracks'); const q = tx.objectStore('tracks').getAllKeys(); q.onsuccess = () => res(q.result[0]); }; }));
  return { ctx, page, trackId, name };
}
/** The moment (this machine's clock) a page first shows `selector` (a MutationObserver inside the page; null after `ms`). */
const seenAt = (p, selector, ms = 20000) => p.evaluate(({ sel, ms }) => new Promise((res) => {
  const t0 = Date.now();
  if (document.querySelector(sel)) return res(Date.now());
  const mo = new MutationObserver(() => { if (document.querySelector(sel)) { mo.disconnect(); res(Date.now()); } });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  setTimeout(() => { mo.disconnect(); res(null); }, ms);
}), { sel: selector, ms });
/** The moment a page's text first matches `re`. */
const textAt = (p, re, ms = 20000) => p.evaluate(({ src, flags, ms }) => new Promise((res) => {
  const r = new RegExp(src, flags);
  const has = () => r.test(document.body.innerText);
  if (has()) return res(Date.now());
  const mo = new MutationObserver(() => { if (has()) { mo.disconnect(); res(Date.now()); } });
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  setTimeout(() => { mo.disconnect(); res(null); }, ms);
}), { src: re.source, flags: re.flags, ms });
/** Click and note the click's own moment on the page's clock (dispatched inside the page). */
const clickAt = async (loc) => {
  const p = loc.page();
  await p.evaluate(() => { window.__svClickAt = null; document.addEventListener('click', () => { window.__svClickAt ??= Date.now(); }, { capture: true, once: true }); });
  await loc.click();
  return p.evaluate(() => window.__svClickAt);
};
const stallsSince = (p, t) => p.evaluate((t) => ({ stalls: window.__svStalls.filter((s) => s.at >= t - 500), long: window.__svLong.filter((l) => l.at >= t - 500) }), t);
/** A CPU profile of the page over `fn`: the hottest functions by self time. */
async function profiled(page, fn) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const r = await fn();
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.detach();
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const f = n.callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url ? path.basename(f.url.split('?')[0]) : ''}:${f.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${Math.round(v)} ms ${k}`);
  return { r, total: Math.round(total), top };
}

const alice = await person('alice', { width: 1280, height: 800 });
const bob = await person('bob', { width: 390, height: 844 });
const grantPlan = async (who, plan) => {
  const h = (u) => ({ 'X-Dev-User': u, 'X-Dev-Name': u, 'Content-Type': 'application/json' });
  const me = await (await fetch(`${servers.controlUrl}/me`, { headers: h(who) })).json();
  await fetch(`${servers.controlUrl}/admin/users/${me.user.userId}`, { method: 'PATCH', headers: h('alice'), body: JSON.stringify({ subscription: { action: 'grant', plan } }) });
};
await grantPlan('bob', 'svv');
await bob.page.evaluate(([from, to]) => new Promise((res) => { const r = indexedDB.open('singersvoice'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('tracks', 'readwrite'); const st = tx.objectStore('tracks'); const g = st.get(from); g.onsuccess = () => { const rec = g.result; rec.track.trackId = to; st.put(rec, to); st.delete(from); }; tx.oncomplete = () => res(); }; }), [bob.trackId, `${alice.trackId}-copy-bob`]);

try {
  await alice.page.goto(base + 'meets', { waitUntil: 'networkidle' });
  await alice.page.getByPlaceholder('Sunday SV music meet').fill('Probe');
  await alice.page.getByRole('button', { name: 'Create meet' }).click();
  await alice.page.waitForURL(/\/meet\//);
  const meetUrl = alice.page.url();
  await alice.page.locator('.setlist[data-current="0"]').waitFor({ timeout: 15000 });
  await alice.page.getByRole('button', { name: 'Pick your selection of song' }).click();
  await alice.page.getByLabel('Search songs').fill('sample');
  await alice.page.getByRole('button', { name: 'Pick CI Sample Song' }).click();
  await alice.page.getByText(/is up —|is put forward/).waitFor({ timeout: 15000 });
  await alice.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  await alice.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 15000 });
  // bob joins and takes a slot (the stage is open).
  await bob.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await bob.page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
  // ---- a tap on the device itself, and what the host sees: "Take a stage slot" ----
  {
    const hostSees = textAt(alice.page, /2 on stage/, 20000);
    const t = await clickAt(bob.page.getByRole('button', { name: 'Take a stage slot' }));
    const local = await seenAt(bob.page, '.stagestrip[data-onstage="1"]');
    const remote = await hostSees;
    row('bob taps "Take a stage slot" → bob is on stage', local - t);
    row('  → the host sees 2 on stage', remote - t, '(the other device: mesh poke or the next poll)');
  }
  const stripLinked = (p) => p.evaluate(() => document.querySelector('.stagestrip')?.dataset.linked ?? '0');
  const tLink = Date.now();
  while (Date.now() - tLink < 45000 && ((await stripLinked(alice.page)) !== '1' || (await stripLinked(bob.page)) !== '1')) await wait(500);
  row('video links up both ways (lobby)', Date.now() - tLink);
  // The audience device.
  const dave = await person('dave', { width: 412, height: 915 }, { track: false });
  await dave.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await dave.page.getByText(/Host alice/).waitFor({ timeout: 30000 });
  // ---- "I'm ready" on bob's phone ----
  {
    const hostSees = seenAt(alice.page, '.slot-card:not(.mine) .chip.ok', 20000);
    const t = await clickAt(bob.page.getByRole('button', { name: /I'm ready/ }));
    const local = await seenAt(bob.page, '.slot-card.mine .chip.ok', 20000);
    const remote = await hostSees;
    row('bob taps "I\'m ready" → bob\'s own screen says ready', local - t, '(mic + track decode on the way)');
    row('  → the host sees bob ready', remote - t);
    const { stalls, long } = await stallsSince(bob.page, t);
    console.log('   bob stalls during ready:', JSON.stringify(stalls.slice(0, 8)), 'long tasks:', JSON.stringify(long.slice(0, 8)));
  }
  await wait(1500);
  // ---- chat: alice → bob ----
  {
    for (const p of [alice.page, bob.page]) await p.getByRole('radio', { name: /^Chat/ }).click();
    await alice.page.getByPlaceholder('Message everyone').fill('probe hello');
    const bobSees = textAt(bob.page, /probe hello/, 20000);
    const t = await clickAt(alice.page.getByRole('button', { name: 'Send' }));
    const local = await textAt(alice.page, /probe hello/, 20000);
    row('alice sends a chat line → on her own screen', local - t);
    row('  → on bob\'s screen', (await bobSees) - t);
  }
  // ---- Start the song: what each device does, and the main thread around the kickstart ----
  {
    for (const p of [alice.page, bob.page]) await p.getByRole('radio', { name: /^Stage/ }).click();
    const bobSees = seenAt(bob.page, '.sing .stagebar', 30000);
    const daveSees = textAt(dave.page, /Starting in|Live now/, 30000);
    const prof = await profiled(alice.page, async () => {
      const t = await clickAt(alice.page.getByRole('button', { name: /Start the song/ }));
      const local = await seenAt(alice.page, '.sing .stagebar', 30000);
      const remote = await bobSees;
      const aud = await daveSees;
      row('alice taps "Start the song" → her singing screen is up', local - t);
      row('  → bob\'s singing screen is up', remote - t);
      row('  → the audience sees "Starting in"', aud - t);
      // The kickstart itself: 8 s after the start, on the service's clock.
      const kick = await alice.page.evaluate(() => window.__svPos?.kickstartEpochMs ?? null);
      await wait(11500); // past the kickstart (8 s) and the first beats
      const kickLocal = (await alice.page.evaluate(() => { const k = (window.__svPos && window.__svPos.kickstartEpochMs) || null; return k; })) ?? kick;
      return { t, kickLocal };
    });
    console.log('   alice CPU (click → +11.5 s): total self', prof.total, 'ms\n     ' + prof.top.join('\n     '));
    const sinceStart = await stallsSince(alice.page, prof.r.t);
    const sinceStartBob = await stallsSince(bob.page, prof.r.t);
    const fmt = (t0, list) => list.map((s) => `+${((s.at - t0) / 1000).toFixed(1)}s:${s.ms}`).join(' ');
    console.log('   alice main-thread stalls (>150 ms) since the tap:', fmt(prof.r.t, sinceStart.stalls), '| long tasks:', fmt(prof.r.t, sinceStart.long));
    console.log('   bob   main-thread stalls (>150 ms) since the tap:', fmt(prof.r.t, sinceStartBob.stalls), '| long tasks:', fmt(prof.r.t, sinceStartBob.long));
    const firstLyric = await alice.page.evaluate(() => ({ lyric: document.querySelector('.sing .lyric')?.innerText?.slice(0, 40) ?? null, lines: document.querySelectorAll('.sing .lyric').length, panel: document.querySelector('.lyrics') ? getComputedStyle(document.querySelector('.lyrics')).display : null }));
    console.log('   alice lyrics at +11.5 s:', JSON.stringify(firstLyric));
    const bobLyric = await bob.page.evaluate(() => ({ lines: document.querySelectorAll('.sing .lyric').length, panelH: document.querySelector('.lyrics')?.getBoundingClientRect().height ?? null, stageH: document.querySelector('.sing canvas.stagecanvas')?.getBoundingClientRect().height ?? null, viewportH: innerHeight }));
    console.log('   bob lyrics at +11.5 s (phone):', JSON.stringify(bobLyric));
    await bob.page.screenshot({ path: `${out}/bob-singing.png` });
    await alice.page.screenshot({ path: `${out}/alice-singing.png` });
  }
  // ---- Pause ----
  {
    const bobSees = textAt(bob.page, /Paused|paused/, 20000);
    const t = await clickAt(alice.page.getByRole('button', { name: 'Pause for everyone' }));
    const local = await textAt(alice.page, /Paused|paused|Resume/, 20000);
    row('alice taps Pause → her screen says paused', local - t, '(the pause itself is cued 3 s ahead)');
    row('  → bob\'s screen says paused', (await bobSees) - t);
  }
  await wait(4500);
  // ---- Resume ----
  {
    // The singer's screen shows the resume as the lyrics countdown (and the Pause button back in place of Resume).
    const bobSees = seenAt(bob.page, 'button[aria-label="Pause for everyone"]', 20000);
    const t = await clickAt(alice.page.getByRole('button', { name: 'Resume for everyone' }));
    const local = await seenAt(alice.page, 'button[aria-label="Pause for everyone"]', 20000);
    row('alice taps Resume → her screen shows the resume', local - t);
    row('  → bob\'s screen shows the resume', (await bobSees) - t);
  }
  await wait(6000);
  // ---- the poll cadence seen from the service: heartbeats per device in the last 10 s ----
  const hb = await alice.page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /heartbeat/.test(r.name) && r.startTime > performance.now() - 10000).map((r) => Math.round(r.duration)));
  console.log('   alice heartbeat round trips in the last 10 s (ms):', hb.join(' '), `(${hb.length} polls)`);
  const acts = await alice.page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /\/meets\/.*\/(pause|resume|start|ready|slot|chat|songs)/.test(r.name)).map((r) => `${r.name.split('/').pop()}:${Math.round(r.duration)}`));
  console.log('   alice action round trips (ms):', acts.join(' '));
  writeFileSync(`${out}/rows.json`, JSON.stringify(rows, null, 2));
  console.log('errors:', JSON.stringify(errors));
} finally {
  await browser.close();
  await servers.stop();
}
