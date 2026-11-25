// Load and chaos e2e for a live meet: N singers (default 7) on one stage in the built app against the real sv-control,
// each a headless Chromium context with a fake camera (a synthetic person the real cut-out model cuts out) and a fake
// microphone (a voice). What is measured and checked:
//
//   1. Every singer's link to every other comes up, and carries sound and a picture both ways — read from the links'
//      own statistics (peers.ts `links()`), never taken from a connection's state alone.
//   2. What the mesh costs: each page's uplink (bytes sent on every link), the browser's CPU seconds over the sample
//      (every Chromium process, from /proc), the service's rows written (/health) — for N singers; run with N=2 and
//      N=7 and compare: the mesh's cost per device grows with N (an SFU would not).
//   3. Chaos — the service goes away for 20 s and comes back (a redeploy, a crash): every room says so, the stage
//      keeps running on its links (sound still arrives), and once the service is back every singer is still seated.
//   4. Chaos — a singer's tab closes without a word: their slot is cleared on every other device in seconds (the
//      beacon on the way out), and every other link stays as it was.
//   5. The host ends the meet: every device shows it over, the service holds nothing of it in memory, and End twice
//      changes nothing.
//
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/load-e2e.mjs [outDir] [N]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServers } from './servers.mjs';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/npm-tools/node_modules/playwright');
}
const out = process.argv[2] ?? 'screenshots';
const N = Math.max(2, Math.min(10, Number(process.argv[3] ?? 7) || 7));
mkdirSync(out, { recursive: true });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000, every = 500) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(every);
  }
};
const work = path.join(tmpdir(), `sv-load-e2e-${process.pid}`);
mkdirSync(work, { recursive: true });

const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/', controlDb: path.join(work, 'control.sqlite') });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;

// The fake camera (a synthetic person) and the fake microphone (a voice), as live-duet.mjs.
const clip = path.join(tmpdir(), 'sv-fake-person.y4m');
execFileSync('node', [new URL('./fake-person.mjs', import.meta.url).pathname, clip], { stdio: 'inherit' });
const voice = path.join(tmpdir(), 'sv-fake-voice.wav');
const vib = (h) => `sin(2*PI*${h * 180}*t+${((h * 0.012 * 180) / 5.5).toFixed(4)}*sin(2*PI*5.5*t))`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='0.25*(0.55+0.45*sin(2*PI*0.7*t))*(${vib(1)}+0.5*${vib(2)}+0.33*${vib(3)}+0.25*${vib(4)}+0.2*${vib(5)})':s=48000:d=30`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', voice]);
const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, `--use-file-for-fake-audio-capture=${voice}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

/** CPU seconds used so far by every Chromium process (utime + stime from /proc), or null where /proc is not there. */
function browserCpuSeconds() {
  try {
    const hz = 100;
    let ticks = 0;
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      let cmd = '';
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {
        continue;
      }
      if (!/chrom|headless_shell/i.test(cmd)) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ticks += Number(fields[11]) + Number(fields[12]);
    }
    return ticks / hz;
  } catch {
    return null;
  }
}

const errors = {};
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, permissions: ['microphone', 'camera'], deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60000);
  errors[name] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors[name].push(m.text()));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base + '?' + control, { waitUntil: 'networkidle' });
  await page.evaluate((n) => {
    localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: '', picture: '', mode: 'local' }));
    localStorage.setItem('sv.mode', 'local');
    localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true, cameraOn: true, socialOffer: false }));
  }, name);
  return { ctx, page, name };
}

/** Every link of a page as the mesh reads it (peers.ts `links()`), and its RTP counters. */
const linksOf = (page) => page.evaluate(async () => (window.__svMesh ? { links: window.__svMesh.links(), stats: await window.__svMesh.stats() } : null)).catch(() => null);
const noticesOf = (page) => page.evaluate(() => [...document.querySelectorAll('[data-notice]')].map((n) => `${n.dataset.noticeSeverity}:${n.dataset.notice}`)).catch(() => []);
const worstOf = (page) => page.evaluate(() => document.querySelector('[data-notices-worst]')?.getAttribute('data-notices-worst') ?? null).catch(() => null);
const onStageOf = (page) => page.evaluate(() => Number(document.querySelector('.stagestrip')?.dataset.performers ?? 0)).catch(() => 0);
const health = async () => (await fetch(`${servers.controlUrl}/health`)).json();

const names = Array.from({ length: N }, (_, i) => (i === 0 ? 'alice' : `singer${i + 1}`));
const people = [];
const report = { n: N, startedAt: new Date().toISOString(), phases: {} };
try {
  // ---- 1. the stage fills: the host, then every singer by the link ----
  const t0 = Date.now();
  const alice = await person('alice');
  people.push(alice);
  await alice.page.goto(base + 'meets', { waitUntil: 'networkidle' });
  await alice.page.getByPlaceholder('Sunday SV music meet').fill(`Load e2e · ${N}`);
  await alice.page.getByRole('button', { name: 'Create meet' }).click();
  await alice.page.waitForURL(/\/meet\//);
  const meetUrl = alice.page.url();
  const meetId = /\/meet\/([^/?#]+)/.exec(meetUrl)[1];
  await alice.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 20000 });
  const h0 = await health();
  for (const name of names.slice(1)) {
    const p = await person(name);
    people.push(p);
    // A free account sings with sound alone in a live meet (the plan's rule): the admin grants each singer SVV so the picture is on — the mesh's full cost.
    await fetch(`${servers.controlUrl}/me`, { headers: { 'X-Dev-User': name, 'X-Dev-Name': name } }); // the account exists from its first sign-in
    const grant = await fetch(`${servers.controlUrl}/admin/users/dev-${name}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Dev-User': 'alice', 'X-Dev-Name': 'alice' }, body: JSON.stringify({ subscription: { action: 'grant', plan: 'svv' } }) });
    if (grant.status !== 200) console.log(`grant to ${name}: HTTP ${grant.status} ${await grant.text()}`);
    await p.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
    await p.page.getByRole('button', { name: 'Take a stage slot' }).click();
    await p.page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 20000 });
    console.log(`${name} on stage (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  const seated = await until(async () => (await Promise.all(people.map((p) => onStageOf(p.page)))).every((n) => n === N), 30000);
  check(seated !== null, `every device shows ${N} on stage`);

  // ---- 2. every link up, sound and a picture arriving on each ----
  const allUp = async () => {
    const all = await Promise.all(people.map((p) => linksOf(p.page)));
    const ok = all.every((r) => r && r.links.filter((l) => l.wanted).length === N - 1 && r.links.filter((l) => l.wanted).every((l) => l.state === 'connected'));
    return ok ? all : null;
  };
  const tLinks = Date.now();
  const up = await until(allUp, 90000, 1000);
  const linkS = Math.round((Date.now() - tLinks) / 1000);
  check(up !== null, `every singer is linked to every other (${N * (N - 1)} links) within ${linkS} s`);
  const media = await until(
    async () => {
      const all = await Promise.all(people.map((p) => linksOf(p.page)));
      const ok = all.every((r) => r && r.links.filter((l) => l.wanted).every((l) => l.audioIn && l.micOpen === true && l.camOn === true && l.videoIn));
      return ok ? all : null;
    },
    120000,
    2000,
  );
  check(media !== null, 'every link says the other side’s mic is open and camera on, and sound and a picture arrive on it (from the links’ own counters)');
  if (!media) {
    const all = await Promise.all(people.map((p) => linksOf(p.page)));
    for (const [i, r] of all.entries()) console.log(`  ${names[i]}: ${JSON.stringify(r?.links.map((l) => ({ id: l.id.slice(-6), s: l.state, a: l.audioIn, v: l.videoIn, mic: l.micOpen, cam: l.camOn, path: l.path, lim: l.limited })))}`);
  }
  const silentOrBlind = (await Promise.all(people.map((p) => linksOf(p.page)))).flatMap((r, i) => (r?.links ?? []).filter((l) => l.silent || l.blind).map((l) => `${names[i]}←${l.id.slice(-6)}`));
  check(silentOrBlind.length === 0, `no link is marked silent or blind while everyone sends (${silentOrBlind.join(', ') || 'none'})`);
  await alice.page.screenshot({ path: `${out}/load-alice-${N}.png` });

  // ---- the cost of the mesh: a 30 s sample ----
  const SAMPLE_S = 30;
  const cpu0 = browserCpuSeconds();
  const h1 = await health();
  const before = await Promise.all(people.map((p) => linksOf(p.page)));
  const tSample = Date.now();
  await wait(SAMPLE_S * 1000);
  const after = await Promise.all(people.map((p) => linksOf(p.page)));
  const cpu1 = browserCpuSeconds();
  const h2 = await health();
  // The sample as long as it really was: on a starved machine the pages answer late, and the rates are per real second.
  const sampleS = Math.max(SAMPLE_S, (Date.now() - tSample) / 1000);
  const perPage = people.map((p, i) => {
    const b = before[i]?.stats ?? {};
    const a = after[i]?.stats ?? {};
    let sent = 0;
    let recv = 0;
    let audioSent = 0;
    for (const id of Object.keys(a)) {
      sent += (a[id].bytesSent ?? 0) - (b[id]?.bytesSent ?? 0);
      recv += (a[id].bytesReceived ?? 0) - (b[id]?.bytesReceived ?? 0);
      audioSent += (a[id].audioBytesSent ?? 0) - (b[id]?.audioBytesSent ?? 0);
    }
    const links = after[i]?.links ?? [];
    return { name: p.name, upKbps: Math.round((sent * 8) / sampleS / 1000), audioUpKbps: Math.round((audioSent * 8) / sampleS / 1000), downKbps: Math.round((recv * 8) / sampleS / 1000), limited: links.map((l) => l.limited).filter((x) => x !== 'none'), loss: Math.max(0, ...links.map((l) => l.lossPct ?? 0)), rtt: Math.max(0, ...links.map((l) => l.rttMs ?? 0)), relay: links.filter((l) => l.path === 'relay').length };
  });
  const cpuS = cpu0 !== null && cpu1 !== null ? cpu1 - cpu0 : null;
  report.phases.steady = { sampleS: Number(sampleS.toFixed(1)), linkS, perPage, browserCpuSeconds: cpuS, cpuPerPagePerSecond: cpuS === null ? null : Number((cpuS / sampleS / N).toFixed(2)), rowsWrittenDuringSample: h2.storage.rowsWritten - h1.storage.rowsWritten, rowsWrittenSinceStart: h2.storage.rowsWritten - h0.storage.rowsWritten, live: h2.storage.live };
  console.log(`steady state, ${N} singers, ${SAMPLE_S} s: ${JSON.stringify(report.phases.steady, null, 1)}`);
  const avgUp = Math.round(perPage.reduce((s, x) => s + x.upKbps, 0) / N);
  check(avgUp > 0, `each device sends to ${N - 1} others: ${avgUp} kbps up on average (${perPage.map((x) => x.upKbps).join('/')})`);
  check(report.phases.steady.rowsWrittenDuringSample <= 10, `the service wrote ${report.phases.steady.rowsWrittenDuringSample} rows in ${SAMPLE_S} s of a ${N}-singer stage (heartbeats, signals, the mix: none of them a row)`);

  // ---- 3. chaos: the service goes away for 20 s, and comes back ----
  console.log('chaos: killing the service for 20 s');
  const tDown = Date.now();
  const restarted = servers.restartControl(20000);
  const said = await until(async () => (await Promise.all(people.map((p) => worstOf(p.page)))).every((w) => w === 'link'), 45000, 1000);
  check(said !== null, `every room says the service does not answer (within ${Math.round((Date.now() - tDown) / 1000)} s)`);
  const stillUp = (await Promise.all(people.map((p) => linksOf(p.page)))).every((r) => r && r.links.filter((l) => l.wanted).every((l) => l.state === 'connected' && l.audioIn));
  check(stillUp, 'with the service down the stage runs on: every link still up, sound still arriving');
  await restarted;
  const hRestart = await health(); // the counters start over with the process: the meet's total below adds the two runs
  report.phases.outage = { downMs: 20000, rowsWrittenBeforeOutage: hRestart.storage.rowsWritten };
  const back = await until(async () => (await Promise.all(people.map((p) => worstOf(p.page)))).every((w) => w !== 'link'), 60000, 1000);
  check(back !== null, `once the service is back every room drops the notice (within ${Math.round((Date.now() - tDown) / 1000)} s)`);
  const seatedAfter = await until(async () => (await Promise.all(people.map((p) => onStageOf(p.page)))).every((n) => n === N), 30000);
  check(seatedAfter !== null, `after the restart every device still shows ${N} on stage (the service recovered the meet from its rows, nobody lost a slot)`);
  const linksAfter = (await Promise.all(people.map((p) => linksOf(p.page)))).every((r) => r && r.links.filter((l) => l.wanted).length === N - 1 && r.links.filter((l) => l.wanted).every((l) => l.state === 'connected'));
  check(linksAfter, 'the links were never touched by the outage');

  // ---- 4. chaos: a singer's tab closes without a word ----
  const gone = people[N - 1];
  const idsBefore = new Set(((await linksOf(alice.page))?.links ?? []).map((l) => l.id));
  console.log(`chaos: ${gone.name}'s tab closes`);
  const tClose = Date.now();
  // The page is torn down the way a closed tab is (pagehide, no unmount): the way out runs, then the context goes.
  await gone.page.goto('about:blank').catch(() => undefined);
  await wait(1500); // the beacon is the browser's to finish; a real browser stays up after a tab closes
  await gone.ctx.close();
  people.pop();
  const cleared = await until(async () => (await Promise.all(people.map((p) => onStageOf(p.page)))).every((n) => n === N - 1), 30000, 500);
  const clearS = Math.round((Date.now() - tClose) / 1000);
  check(cleared !== null, `the closed tab's slot is cleared on every other device in ${clearS} s (the beacon on the way out, not the minute of silence)`);
  check(clearS <= 20, `…and within 20 s (${clearS} s)`);
  const dropped = await until(async () => {
    const r = await linksOf(alice.page);
    return r && r.links.filter((l) => l.wanted).length === N - 2 ? r : null;
  }, 20000);
  check(dropped !== null, `the host's mesh forgot the link to ${gone.name} (${N - 2} links remain)`);
  const idsAfter = new Set((dropped?.links ?? []).map((l) => l.id));
  check([...idsAfter].every((id) => idsBefore.has(id)) && (dropped?.links ?? []).every((l) => l.state === 'connected'), 'every other link stayed as it was');
  report.phases.tabClosed = { clearS };

  // ---- 5. the host ends the meet ----
  await alice.page.getByRole('button', { name: 'End meet' }).click();
  const over = await until(async () => (await Promise.all(people.map((p) => p.page.locator('[data-closed]').count().catch(() => 0)))).every((n) => n === 1), 30000);
  check(over !== null, 'End meet: every device shows the meet is over');
  const h3 = await health();
  check(h3.storage.live.meets === 0 && h3.storage.live.participants === 0 && h3.storage.live.signals === 0, `the service holds nothing of the meet in memory (${JSON.stringify(h3.storage.live)})`);
  const again = await fetch(`${servers.controlUrl}/meets/${meetId}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-User': 'alice', 'X-Dev-Name': 'alice' }, body: JSON.stringify({ resumeToken: 'stale' }) });
  check(again.status < 500, `ending it again is no error (${again.status})`);
  report.phases.end = { rowsWrittenTotal: h2.storage.rowsWritten - h0.storage.rowsWritten + (h3.storage.rowsWritten - hRestart.storage.rowsWritten) };
  console.log(`rows written by the whole meet of ${N}: ${report.phases.end.rowsWrittenTotal}`);

  for (const [name, errs] of Object.entries(errors)) {
    const real = errs.filter((e) => !/ResizeObserver|favicon|net::ERR_|Failed to fetch|NetworkError|Load failed|The SingersVoice service/i.test(e));
    // Chromium's intermittent note about a VideoFrame collected before close() (a stage's picture, cosmetic): listed, not counted — as every e2e does.
    const notes = real.filter((e) => /VideoFrame was garbage collected/.test(e));
    const relevant = real.filter((e) => !/VideoFrame was garbage collected/.test(e));
    if (notes.length) console.log(`info ${name}: ${notes.length} VideoFrame note(s) from Chromium (listed, not counted)`);
    check(relevant.length === 0, `${name}: no page errors (${relevant.slice(0, 3).join(' | ') || 'none'})`);
  }
} catch (e) {
  failed = true;
  console.log('FAIL', e);
  for (const p of people) await p.page.screenshot({ path: `${out}/load-fail-${p.name}.png` }).catch(() => undefined);
} finally {
  writeFileSync(path.join(out, `load-${N}.json`), JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  servers.stop();
}
console.log(failed ? 'LOAD E2E FAILED' : 'LOAD E2E OK');
process.exit(failed ? 1 : 0);
