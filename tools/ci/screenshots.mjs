// Viewport matrix screenshots of the built app (device mode, no Google), using Playwright.
//   npm run build && node tools/ci/screenshots.mjs [outDir]
// Starts sv-control + `vite preview` on free ports, walks Welcome → Setup → Home → Library → Track Maker → Sing → Meets → Settings.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Playwright is resolved at runtime so the repo doesn't pin a browser build: a local install
// (devDependency or global) or the agent image's /opt/npm-tools copy both work.
const require = createRequire(import.meta.url);
import { startServers } from './servers.mjs';
const pw = (() => {
  for (const spec of ['playwright', '/opt/npm-tools/node_modules/playwright']) {
    try {
      return require(spec);
    } catch {
      /* try next */
    }
  }
  throw new Error('playwright not found — run: npm i -D playwright && npx playwright install chromium');
})();
const { chromium, devices } = pw;

const out = process.argv[2] ?? 'screenshots';
// Optional end-to-end stage run: SV_E2E_JSON + SV_E2E_AUDIO point at a trackmaker/track JSON and its audio.
const e2eJson = process.env.SV_E2E_JSON;
const e2eAudio = process.env.SV_E2E_AUDIO;
const base = process.env.BASE_PATH ?? '/SingersVoice/';
const servers = await startServers({ base });
const { port, controlPort } = servers;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const matrix = [
  { name: 'iphone-se-320x568', viewport: { width: 320, height: 568 }, mobile: true },
  { name: 'android-360x640', viewport: { width: 360, height: 640 }, mobile: true },
  { name: 'iphone-390x844', viewport: { width: 390, height: 844 }, mobile: true, ua: devices['iPhone 13'].userAgent, e2e: true },
  { name: 'pixel-412x915', viewport: { width: 412, height: 915 }, mobile: true, ua: devices['Pixel 5'].userAgent },
  { name: 'ipad-820x1180', viewport: { width: 820, height: 1180 }, mobile: true },
  { name: 'desktop-1280x800', viewport: { width: 1280, height: 800 }, mobile: false, e2e: true },
];

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
let failures = 0;
for (const m of matrix) {
  const ctx = await browser.newContext({
    viewport: m.viewport,
    isMobile: m.mobile,
    hasTouch: m.mobile,
    deviceScaleFactor: 2,
    userAgent: m.ua,
    permissions: ['microphone', 'camera'],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  const url = (p) => `http://localhost:${port}${base}${p.replace(/^\//, '')}`;
  const shot = (name) => page.screenshot({ path: path.join(out, `${m.name}--${name}.png`) });
  try {
    await page.goto(`${url('/')}?control=http://localhost:${controlPort}`, { waitUntil: 'networkidle' });
    await shot('01-welcome');
    await page.getByRole('button', { name: /Developer preview|Try it on this/ }).click();
    await page.waitForURL(/\/setup/);
    await wait(600);
    await shot('02-setup');
    await page.getByRole('button', { name: 'Go to my stage' }).click();
    await page.waitForURL(/\/home/);
    await wait(500);
    await shot('03-home');
    await page.goto(url('/tracks'), { waitUntil: 'networkidle' });
    await shot('04-tracks');
    await page.goto(url('/studio'), { waitUntil: 'networkidle' });
    await shot('05-studio');
    await page.goto(url('/studio/trackmaker'), { waitUntil: 'networkidle' });
    await shot('05b-trackmaker');
    await page.goto(url('/meets'), { waitUntil: 'networkidle' });
    await wait(800);
    await shot('07-meets');
    await page.goto(url('/publishing'), { waitUntil: 'networkidle' });
    await wait(800);
    await shot('08-publishing');
    await page.goto(url('/settings'), { waitUntil: 'networkidle' });
    await shot('09-settings');

    if (e2eJson && e2eAudio && m.e2e) {
      // Import the sample track, open the stage, sing 9 s with the fake mic, finish, review.
      await page.goto(url('/tracks'), { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Import' }).first().click();
      await page.locator('input[type=file][accept*=".json"]').setInputFiles(e2eJson);
      await page.locator('input[type=file][accept*="audio"]').setInputFiles(e2eAudio);
      await page.getByRole('button', { name: /^Import$/ }).last().click();
      await page.getByText(/^Imported/).waitFor({ timeout: 30000 });
      await wait(800);
      await shot('10-library-imported');
      await page.locator('.item').first().getByRole('link', { name: 'Sing' }).click();
      await page.waitForURL(/\/sing\//);
      await wait(1200);
      await shot('11-sing-ready');
      await page.getByRole('button', { name: 'Start singing' }).click();
      await wait(1500);
      await shot('12-sing-countdown');
      await wait(7500);
      await shot('13-sing-playing');
      await page.getByRole('button', { name: /Voice FX/ }).click();
      await wait(400);
      await shot('14-sing-fx');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Finish' }).click();
      await page.getByText('Your take').waitFor({ timeout: 30000 });
      await wait(1500);
      await shot('15-review');
      await page.getByRole('button', { name: 'Keep' }).click();
      await page.getByText('Kept', { exact: true }).first().waitFor({ timeout: 30000 });
      await wait(500);
      await shot('16-review-kept');
      await page.goto(url('/studio/performances'), { waitUntil: 'networkidle' });
      await wait(800);
      await shot('17-performances');
      await page.goto(url('/tracks'), { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'More' }).first().click();
      await page.getByRole('button', { name: /Edit lyrics/ }).click();
      await page.waitForURL(/\/trackmaker\//);
      await wait(1000);
      await shot('18-trackmaker-lyrics');
      await page.getByRole('button', { name: /Next: timing/ }).click();
      await wait(1500);
      await shot('19-trackmaker-timing');

      // Live meet: create → take a slot → ready (pre-flight) → host starts → sing 10 s → finish → keep → end meet.
      await page.goto(url('/meets'), { waitUntil: 'networkidle' });
      await page.getByPlaceholder('Sunday SV music meet').fill('CI meet');
      await page.locator('select.input').first().selectOption({ index: 1 });
      await page.getByRole('button', { name: 'Create meet' }).click();
      await page.waitForURL(/\/meet\//);
      await page.getByText(/Track ready on this device/).waitFor({ timeout: 30000 });
      // The host is on stage the moment the meet starts (no slot to take); the lobby stage shows them at once.
      await page.locator('.stagestrip[data-onstage="1"]').waitFor({ timeout: 15000 });
      await shot('20-meet-lobby');
      await page.getByRole('button', { name: /I'm ready/ }).click();
      await page.getByText(/Ready — stage will start/).waitFor({ timeout: 30000 });
      await page.getByRole('radio', { name: /Chat/ }).click();
      await page.getByPlaceholder('Message everyone').fill('hello from CI');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.getByText('hello from CI').first().waitFor();
      await page.getByRole('radio', { name: 'Stage' }).click();
      await shot('21-meet-ready');
      await page.getByRole('button', { name: /Start the song/ }).click();
      await wait(2500);
      await shot('22-meet-countdown');
      await wait(10000);
      await shot('23-meet-live');
      // The host's "Stop song" ends the song for everyone (a singer's button is "Stop": their own take only).
      await page.getByRole('button', { name: /Stop the song for everyone/ }).click();
      // Straight back to the lobby stage; the take saves itself in the background as the meet's performance.
      await page.getByRole('button', { name: 'End meet' }).waitFor({ timeout: 30000 });
      await page.locator('[data-save="done"]').first().waitFor({ timeout: 60000 });
      await wait(600);
      await shot('24-meet-saved');
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: 'End meet' }).click();
      await page.getByText(/Meet ended/).waitFor({ timeout: 30000 });
      await wait(800);
      await shot('25-meet-ended');
      const meetId = page.url().split('/meet/')[1];
      await page.goto(url(`/watch/${meetId}`), { waitUntil: 'networkidle' });
      await wait(1500);
      await shot('26-watch');
      await page.goto(url('/publishing'), { waitUntil: 'networkidle' });
      await wait(800);
      await page.getByRole('radio', { name: 'Publish a meet' }).click();
      await wait(600);
      await shot('27-publishing-publish');
    }
  } catch (e) {
    failures++;
    console.error(`[${m.name}] ${e.message}`);
    await shot('error').catch(() => undefined);
  }
  const relevant = errors.filter((e) => !/favicon|net::ERR|accounts\.google|Failed to load resource/.test(e));
  if (relevant.length) {
    failures++;
    console.error(`[${m.name}] console errors:\n  ${relevant.join('\n  ')}`);
  } else console.log(`[${m.name}] ok`);
  await ctx.close();
}
await browser.close();
servers.stop();
if (failures) process.exit(1);
