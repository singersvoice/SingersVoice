// Roles e2e: the Admin page and what every role comes to. alice (the first account ever) is the super
// admin; bob signs in as a plain singer (dual): no Publishing and no Admin anywhere in his menus, the
// Club owner page in their place. alice sets the price of a club owner year on the Admin page's club
// owner portal; bob's Club owner page shows it and says to ask her (no Stripe on the test service).
// alice makes him audio only (no camera on stage, on his device and in the room), then a club owner
// with a year (Publishing opens, appears in his menu; the grant is a payment of 0 on record; the
// overview has him active with the days left), sets the year to one that has expired (Publishing
// closes by itself, with the date; the overview flags him expired, first), renews it, revokes it; she
// cannot demote the last super admin; and a singer's instrument input (a second USB input) is picked
// beside the mic. Every change is read back from the service (the SVT DB), not from the page that made it.
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/roles-e2e.mjs [outDir]
// Exits 1 when any assertion fails. Needs playwright (local install or /opt/npm-tools).
import { createRequire } from 'node:module';
import { startServers } from './servers.mjs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/' });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
// A fake camera and microphone, as in live-duet.mjs: the meet room opens them when a singer takes the stage.
const clip = path.join(tmpdir(), 'sv-fake-person.y4m');
execFileSync('node', [new URL('./fake-person.mjs', import.meta.url).pathname, clip], { stdio: 'inherit' });
const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };
const errors = { alice: [], bob: [] };
/** The service as a signed-in account sees it (DEV_AUTH: the X-Dev-User header is the account). */
const asUser = async (who, method, route, body) => {
  const r = await fetch(`${servers.controlUrl}${route}`, { method, headers: { 'X-Dev-User': who, 'X-Dev-Name': who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const userRow = async (who, email) => (await asUser(who, 'GET', '/admin/users')).json?.users?.find((u) => u.email === email) ?? null;

async function person(name, viewport) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'], deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors[name].push(m.text()));
  await page.goto(base + '?' + control, { waitUntil: 'networkidle' });
  await page.evaluate((n) => localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: '', picture: '', mode: 'local' })), name);
  await page.evaluate(() => { localStorage.setItem('sv.mode', 'local'); localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true })); });
  await page.goto(base + 'home?' + control, { waitUntil: 'networkidle' }); // signed in as this account: the service sees it now
  return { ctx, page };
}
const alice = await person('alice', { width: 1280, height: 800 });
const bob = await person('bob', { width: 390, height: 844 });
const dates = (daysFromNow) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

try {
  // ---- Who is who, by the service: the first account is the super admin; everyone after starts dual ----
  const aliceRow = await userRow('alice', 'alice@dev.local');
  const bobRow0 = await userRow('alice', 'bob@dev.local');
  check(aliceRow?.role === 'super_admin' && aliceRow?.canPublish === true, `the first account ever is the super admin, Publishing open (${aliceRow?.role})`);
  check(bobRow0?.role === 'dual' && bobRow0?.canPublish === false && bobRow0?.media === 'dual', `a new account is dual — camera on stage, no Publishing (${bobRow0?.role}, ${bobRow0?.media})`);
  check((await asUser('bob', 'GET', '/admin/users')).status === 403, 'the service refuses the account list to anyone but a super admin');
  check((await asUser('bob', 'PATCH', '/admin/users/alice', { role: 'dual' })).status === 403, 'the service refuses a role change from anyone but a super admin');
  const dualClosed = await asUser('bob', 'GET', '/publishing/destinations');
  check(dualClosed.status === 403 && dualClosed.json?.code === 'publishing_closed', `Publishing mode is closed to a dual account on the service itself, not only on the page (${dualClosed.status} ${dualClosed.json?.code})`);

  // ---- The Admin page: the super admin's; everyone else is turned away ----
  await alice.page.goto(`${base}settings?${control}`, { waitUntil: 'networkidle' });
  check(await alice.page.locator('.navbar a', { hasText: 'Admin' }).isVisible(), 'the super admin finds Admin under Settings in the side menu');
  await alice.page.goto(`${base}admin?${control}`, { waitUntil: 'networkidle' });
  const bobRowEl = alice.page.locator('[data-admin-user="bob@dev.local"]');
  await bobRowEl.waitFor();
  check((await alice.page.locator('[data-admin-user]').count()) >= 2 && /Super admin: 1/.test(await alice.page.locator('[data-role-count="super_admin"]').innerText()) && /Dual \(audio \+ video\): 1/.test(await alice.page.locator('[data-role-count="dual"]').innerText()), 'the Admin page lists every account with a count per role');
  await alice.page.screenshot({ path: `${out}/admin-alice.png`, fullPage: true });
  await bob.page.goto(`${base}admin?${control}`, { waitUntil: 'networkidle' });
  check(await bob.page.getByText('Super admins only').isVisible(), 'a singer who opens /admin is told it is for super admins');
  check(!(await bob.page.locator('.navbar a', { hasText: 'Admin' }).isVisible().catch(() => false)), 'a singer has no Admin entry in the menu');

  // ---- Publishing and Admin are not on a singer's menus at all; the Club owner page is ----
  await bob.page.getByRole('button', { name: 'More' }).click();
  const more = await bob.page.locator('.navmore').innerText();
  check(!/Publishing/.test(more) && !/Admin/.test(more) && /Club owner/.test(more), `a singer's More panel has no Publishing and no Admin — the Club owner page instead (${more.replace(/\s+/g, ' ').trim()})`);
  await bob.page.locator('.navmore').getByRole('button', { name: 'Close' }).click();
  await bob.page.goto(`${base}home?${control}`, { waitUntil: 'networkidle' });
  check((await bob.page.locator('[data-home-club-owner]').count()) === 1 && (await bob.page.locator('[data-home-publishing]').count()) === 0, "a singer's Home has the Club owner card where Publishing would be");
  check(await alice.page.locator('.navbar a', { hasText: 'Publishing' }).isVisible(), "the super admin's side menu has Publishing");
  check((await alice.page.locator('.navbar a', { hasText: 'Club owner' }).count()) === 0, 'the super admin has no Club owner page of her own (the Admin page has the club owners)');
  await bob.page.goto(`${base}publishing?${control}`, { waitUntil: 'networkidle' });
  await bob.page.getByRole('heading', { name: 'Publishing mode is for club owners' }).waitFor();
  check(await bob.page.getByRole('link', { name: 'Become a club owner' }).isVisible(), 'the Publishing gate, typed in by hand, points a singer at the Club owner page');

  // ---- The super admin's club owner portal: the price of a year, a note; the singer's Club owner page shows them ----
  await alice.page.goto(`${base}admin?${control}`, { waitUntil: 'networkidle' });
  await alice.page.locator('[data-co-settings]').waitFor();
  check(/Stripe not set up/.test(await alice.page.locator('[data-stripe]').innerText()), 'the portal says Stripe is not set up on this service — years are granted here');
  await alice.page.locator('[data-co-price]').fill('49');
  await alice.page.locator('[data-co-note]').fill('Run your club night on SingersVoice — a year of Publishing mode.');
  await alice.page.locator('[data-co-save]').click();
  await alice.page.locator('.toast', { hasText: /\$49\.00|49\.00/ }).waitFor();
  const settings = (await asUser('alice', 'GET', '/admin/club-owners')).json?.settings;
  check(settings?.priceCents === 4900 && settings?.currency === 'usd' && /club night/.test(settings?.note ?? ''), `the price and the note are kept on the service (${settings?.priceCents} ${settings?.currency})`);
  check((await asUser('bob', 'PUT', '/admin/club-owners/settings', { priceCents: 1 })).status === 403 && (await asUser('bob', 'GET', '/admin/club-owners')).status === 403, 'the service refuses the club owner portal to anyone but a super admin');
  await bob.page.goto(`${base}club-owner?${control}`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-club-owner][data-standing="none"] [data-price]').waitFor();
  const offer = await bob.page.locator('[data-offer]').innerText();
  check(/49\.00/.test(offer) && /year/.test(offer) && /club night/.test(offer), `the singer's Club owner page shows the year at the admin's price with her note (${(await bob.page.locator('[data-price]').innerText()).trim()})`);
  check(await bob.page.locator('[data-ask-admin]').isVisible() && (await bob.page.locator('[data-pay]').count()) === 0, 'without Stripe on the service there is no Pay button: the page says to ask the SingersVoice admin');
  await bob.page.screenshot({ path: `${out}/club-owner-bob.png`, fullPage: true });

  // ---- Audio only: no camera on stage, on the singer's own device and in the room ----
  await bobRowEl.locator('[data-role-select]').selectOption('audio');
  await alice.page.locator('[data-admin-user="bob@dev.local"][data-user-role="audio"]').waitFor();
  await alice.page.reload({ waitUntil: 'networkidle' });
  await alice.page.locator('[data-admin-user="bob@dev.local"][data-user-role="audio"]').waitFor();
  const bobRow1 = await userRow('alice', 'bob@dev.local');
  check(bobRow1?.role === 'audio' && bobRow1?.media === 'audio', `the role is kept in the SVT DB and read back (${bobRow1?.role} / ${bobRow1?.media})`);
  await bob.page.goto(`${base}settings?${control}`, { waitUntil: 'networkidle' });
  const camSwitch = bob.page.locator('label.switch', { hasText: 'Camera on stage' }).locator('input');
  check(await camSwitch.isDisabled() && /audio only/.test(await bob.page.locator('label.switch', { hasText: 'Camera on stage' }).innerText()), 'an audio-only account finds "Camera on stage" off and locked in Settings, with the reason');
  check(/audio only/.test(await bob.page.locator('main').innerText()), "the account's standing says audio only");
  // In a meet: bob takes a slot on alice's open stage; his room shows the audio-only chip, the camera control is locked.
  await alice.page.goto(`${base}meets?${control}`, { waitUntil: 'networkidle' });
  await alice.page.getByPlaceholder('Sunday SV music meet').fill('Roles e2e');
  await alice.page.getByRole('button', { name: 'Create meet' }).click();
  await alice.page.waitForURL(/\/meet\//);
  const meetUrl = alice.page.url();
  const meetId = /\/meet\/([^/?#]+)/.exec(meetUrl)[1];
  await bob.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await bob.page.getByRole('button', { name: 'Take a stage slot' }).click();
  await bob.page.locator('.stagestrip[data-onstage="1"]').waitFor();
  await bob.page.locator('[data-audio-only]').waitFor();
  check(/audio only · no camera/.test(await bob.page.locator('[data-audio-only]').innerText()), 'on stage, an audio-only singer sees "audio only · no camera"');
  const snap = (await asUser('alice', 'GET', `/meets/${meetId}`)).json;
  const bobInRoom = snap?.participants?.find((p) => p.displayName === 'bob');
  check(bobInRoom?.media === 'audio' && bobInRoom?.slot !== null, `the room carries his permission to every device — audio only, on slot ${bobInRoom?.slot} (so nobody draws his picture, whatever his device sends)`);
  await bob.page.screenshot({ path: `${out}/roles-bob-audio-only.png` });

  // ---- Club owner: a year granted on the Admin page opens Publishing; the account is club owner now ----
  await bob.page.goto(`${base}publishing?${control}`, { waitUntil: 'networkidle' });
  await bob.page.getByRole('heading', { name: 'Publishing mode is for club owners' }).waitFor();
  check(true, 'a singer finds Publishing closed: it is for club owners');
  await alice.page.goto(`${base}admin?${control}`, { waitUntil: 'networkidle' });
  await bobRowEl.locator('[data-sub-grant]').click();
  await alice.page.locator('[data-admin-user="bob@dev.local"][data-user-role="club_owner"] [data-subscription="active"]').waitFor();
  await alice.page.locator('[data-co-row="bob@dev.local"][data-co-standing="active"]').waitFor();
  const bobOverview = await alice.page.locator('[data-co-row="bob@dev.local"]').innerText();
  check(/active · 36\d days left/.test(bobOverview) && /granted/.test(bobOverview), `the club owner overview has him active with the days left and the grant as his last payment (${bobOverview.replace(/\s+/g, ' ').trim().slice(0, 160)})`);
  check(/granted/.test(await alice.page.locator('[data-co-payments]').innerText()), 'the year granted is on the payments record (amount 0)');
  const bobRow2 = await userRow('alice', 'bob@dev.local');
  const yearOn = bobRow2?.subscription?.expiresAt ? (Date.parse(bobRow2.subscription.expiresAt) - Date.now()) / 86_400_000 : 0;
  check(bobRow2?.role === 'club_owner' && bobRow2?.canPublish === true && bobRow2?.subscription?.status === 'active' && yearOn > 360 && yearOn < 370 && Boolean(bobRow2?.subscription?.startedAt), `the grant makes a club owner with a year (starts ${bobRow2?.subscription?.startedAt?.slice(0, 10)}, ends ${bobRow2?.subscription?.expiresAt?.slice(0, 10)}), Publishing open`);
  check((await asUser('bob', 'GET', '/publishing/destinations')).status === 200, 'the service opens Publishing mode to the club owner at once');
  await bob.page.goto(`${base}publishing?${control}`, { waitUntil: 'networkidle' });
  await bob.page.getByRole('radio', { name: 'Publish a meet' }).waitFor();
  check(true, 'the club owner opens Publishing mode on his device');
  await bob.page.goto(`${base}club-owner?${control}`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-club-owner][data-standing="active"]').waitFor();
  const mine = await bob.page.locator('main').innerText();
  check(/club owner/i.test(mine) && /until/.test(mine) && /days left/.test(mine) && /granted by the SingersVoice admin/.test(mine), 'his Club owner page shows the year, its end, the days left, and that the admin granted it');
  check(await bob.page.locator('[data-payments] [data-payment-source="grant"]').isVisible(), 'his payments list has the granted year');
  await bob.page.goto(`${base}home?${control}`, { waitUntil: 'networkidle' });
  check((await bob.page.locator('[data-home-publishing]').count()) === 1, "with the year, Publishing is on the club owner's Home");
  await bob.page.getByRole('button', { name: 'More' }).click();
  check(/Publishing/.test(await bob.page.locator('.navmore').innerText()), 'and in his More panel');
  await bob.page.locator('.navmore').getByRole('button', { name: 'Close' }).click();

  // ---- The year runs out: Publishing closes by itself, with the date; a renewal opens it again ----
  const bobSub = bobRowEl.locator('[data-subscription]');
  await bobSub.getByLabel('Start date').fill(dates(-400));
  await bobSub.getByLabel('Expiry date').fill(dates(-35));
  await bobSub.locator('[data-sub-set]').click();
  await alice.page.locator('[data-admin-user="bob@dev.local"] [data-subscription="expired"]').waitFor();
  await alice.page.locator('[data-co-row="bob@dev.local"][data-co-standing="expired"]').waitFor();
  check(/expired · 3\d days ago/.test(await alice.page.locator('[data-co-row="bob@dev.local"] [data-co-standing-label]').innerText()) && (await alice.page.locator('[data-co-row]').first().getAttribute('data-co-row')) === 'bob@dev.local', 'the overview flags the year expired, with how long ago, at the top of the list');
  const bobRow3 = await userRow('alice', 'bob@dev.local');
  check(bobRow3?.subscription?.status === 'expired' && bobRow3?.canPublish === false && bobRow3?.role === 'club_owner', `with the dates set to a year that has run out the subscription stands expired and Publishing is closed (${bobRow3?.subscription?.status}, publish ${bobRow3?.canPublish})`);
  const closed = await asUser('bob', 'GET', '/publishing/destinations');
  check(closed.status === 403 && /expired on \d{4}-\d{2}-\d{2}/.test(closed.json?.error ?? ''), `the service says why: "${closed.json?.error}"`);
  await bob.page.goto(`${base}publishing?${control}`, { waitUntil: 'networkidle' });
  await bob.page.getByRole('heading', { name: 'Publishing mode is for club owners' }).waitFor();
  check(/expired on/.test(await bob.page.locator('.empty').innerText()), 'his device shows Publishing closed, with the expiry date');
  await alice.page.locator('[data-co-row="bob@dev.local"] [data-co-grant]').click(); // from the overview this time
  await alice.page.locator('[data-admin-user="bob@dev.local"] [data-subscription="active"]').waitFor();
  await alice.page.locator('[data-co-row="bob@dev.local"][data-co-standing="active"]').waitFor();
  const bobRow4 = await userRow('alice', 'bob@dev.local');
  const renewedOn = bobRow4?.subscription?.expiresAt ? (Date.parse(bobRow4.subscription.expiresAt) - Date.now()) / 86_400_000 : 0;
  check(bobRow4?.canPublish === true && renewedOn > 360 && renewedOn < 370, `a year granted again from the overview runs from today when the last one has run out (ends ${bobRow4?.subscription?.expiresAt?.slice(0, 10)})`);
  await alice.page.locator('[data-co-row="bob@dev.local"] [data-co-renew]').click();
  await alice.page.locator('.toast', { hasText: /renewed/ }).waitFor();
  const bobRow4b = await userRow('alice', 'bob@dev.local');
  const renewedTwice = bobRow4b?.subscription?.expiresAt ? (Date.parse(bobRow4b.subscription.expiresAt) - Date.now()) / 86_400_000 : 0;
  check(renewedTwice > 725 && renewedTwice < 735, `Renew on the overview adds a year to the end of the current one (ends ${bobRow4b?.subscription?.expiresAt?.slice(0, 10)})`);
  check((await asUser('bob', 'GET', '/publishing/destinations')).status === 200, 'Publishing is open again on the service');

  // ---- Revoked: closed at once, and told so ----
  alice.page.once('dialog', (d) => void d.accept());
  await bobSub.locator('[data-sub-revoke]').click();
  await alice.page.locator('[data-admin-user="bob@dev.local"] [data-subscription="revoked"]').waitFor();
  await alice.page.locator('[data-co-row="bob@dev.local"][data-co-standing="revoked"]').waitFor();
  const revoked = await asUser('bob', 'GET', '/publishing/destinations');
  check(revoked.status === 403 && /revoked/.test(revoked.json?.error ?? ''), `revoked: Publishing closes at once, and the service says so ("${revoked.json?.error}")`);
  await alice.page.screenshot({ path: `${out}/admin-alice-revoked.png`, fullPage: true });

  // ---- The last super admin stays one ----
  const aliceRowEl = alice.page.locator('[data-admin-user="alice@dev.local"]');
  await aliceRowEl.locator('[data-role-select]').selectOption('dual');
  await alice.page.locator('.toast', { hasText: /last super admin/ }).waitFor();
  check((await userRow('alice', 'alice@dev.local'))?.role === 'super_admin', 'the last super admin cannot be demoted — the service refuses and says to make another one first');
  await bobRowEl.locator('[data-role-select]').selectOption('super_admin');
  await alice.page.locator('[data-admin-user="bob@dev.local"][data-user-role="super_admin"]').waitFor();
  check((await asUser('bob', 'GET', '/admin/users')).status === 200 && (await userRow('bob', 'bob@dev.local'))?.canPublish === true, 'a second super admin, made on the page, has the Admin page and Publishing on the service at once');
  await bob.page.goto(`${base}admin?${control}`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-admin]').waitFor();
  check(true, 'the new super admin opens the Admin page');

  // ---- The instrument: a second input (a USB interface) picked beside the microphone ----
  await alice.page.goto(`${base}settings?${control}`, { waitUntil: 'networkidle' });
  await alice.page.locator('label.switch', { hasText: 'Instrument' }).locator('input').check();
  await alice.page.locator('[data-instrument-input]').waitFor();
  const inputs = await alice.page.locator('[data-instrument-input] option').allInnerTexts();
  check(inputs.length >= 2, `Instrument ticked: the input to pick appears, listing the audio inputs (${inputs.slice(1).join(' · ')})`);
  await alice.page.locator('[data-instrument-input]').selectOption({ index: 1 });
  await alice.page.locator('[data-instrument-level]').selectOption('3');
  const saved = await alice.page.evaluate(() => JSON.parse(localStorage.getItem('sv.settings.app') || '{}'));
  check(saved.instrumentOn === true && saved.instrumentDeviceId && saved.instrumentDb === 3, 'the instrument input and its level are kept on the device');
  // In the meet room the host's mic opens by itself as she is seated (a tap where the browser wants one): the instrument
  // opens with the microphone, and the mic status says which input it is.
  await alice.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await alice.page.locator('.stagestrip[data-onstage="1"]').waitFor();
  // The mic opens by itself a moment after the seat; a browser that wanted a tap leaves the button enabled — then it is tapped.
  await alice.page.locator('.micstatus').waitFor({ timeout: 20000 }).catch(() => undefined);
  if (!(await alice.page.locator('.micstatus').isVisible().catch(() => false))) {
    await alice.page.getByRole('button', { name: 'Turn my mic on' }).click();
    await alice.page.locator('.micstatus').waitFor();
  }
  await alice.page.locator('[data-instrument="on"]').waitFor();
  const instLabel = await alice.page.locator('[data-instrument-label]').innerText();
  check(/Instrument/.test(instLabel) && instLabel.replace(/\s+/g, ' ').length > 'Instrument'.length + 2, `the instrument input is open beside the mic, named on the mic status (${instLabel.replace(/\s+/g, ' ')})`);
  check(await alice.page.locator('[data-instrument-level]').isVisible() && (await alice.page.locator('[data-instrument-level]').inputValue()) === '3', 'its level sits on the stage too, as saved');
  await alice.page.locator('[data-instrument-toggle]').uncheck();
  await alice.page.locator('[data-instrument="off"]').waitFor();
  check(true, 'unticking Instrument closes the input; the mic carries on');
  await alice.page.screenshot({ path: `${out}/roles-alice-instrument.png` });

  const errs = Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v.filter((e) => !/favicon|Failed to load resource/.test(e))]));
  check(Object.values(errs).every((v) => !v.length), `no page errors (${JSON.stringify(errs).slice(0, 300)})`);
} catch (e) {
  failed = true;
  console.error('FAIL', e);
  await alice.page.screenshot({ path: `${out}/roles-alice-fail.png` }).catch(() => {});
  await bob.page.screenshot({ path: `${out}/roles-bob-fail.png` }).catch(() => {});
  console.error('errors', JSON.stringify(errors));
}
await browser.close();
servers.stop();
process.exit(failed ? 1 : 0);
