// Roles and plans e2e: the Admin page and what every role and plan comes to. alice (the first account
// ever) is the super admin; bob signs in as a plain singer (dual, free): no Publishing and no Admin
// anywhere in his menus, the Plans page in their place. On alice's open stage bob is seated with the
// voice alone (a free account has no picture in a live meet), with the reason and the way to the
// plans; alice grants him SVV through the service and his picture comes on where he sits, with the
// hours left on the chip; the month's hours used up (set outright by the admin, as the service counts
// them on stage) take the picture away again on the next heartbeat, with the reason; hours back, it
// returns. alice prices the plans on the Admin page (the club year a year); bob's Plans page shows the
// four and says to ask her (no Stripe on the test service). alice makes him audio only (no camera
// anywhere, on his device and in the room), then a club owner (the Club owner plan: Publishing opens,
// appears in his menu with My club; he names a member and the seats count; the grant is a payment of 0
// on record; the overview has him active with the days left), sets the plan to one that has expired
// (Publishing closes by itself, with the date; the overview flags him expired, first), grants again,
// renews, revokes; she cannot demote the last super admin; and a singer's instrument input (a second
// USB input) is picked beside the mic. Every change is read back from the service (the SVT DB), not
// from the page that made it.
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ---- Who is who, by the service: the first account is the super admin; everyone after starts dual ----
  const aliceRow = await userRow('alice', 'alice@dev.local');
  const bobRow0 = await userRow('alice', 'bob@dev.local');
  check(aliceRow?.role === 'super_admin' && aliceRow?.canPublish === true, `the first account ever is the super admin, Publishing open (${aliceRow?.role})`);
  check(bobRow0?.role === 'dual' && bobRow0?.canPublish === false && bobRow0?.media === 'audio' && bobRow0?.entitlement?.plan === 'free' && bobRow0?.entitlement?.video === false, `a new account is dual by role and on the Free plan: the voice alone in a live meet, no Publishing (${bobRow0?.role}, ${bobRow0?.entitlement?.plan}, ${bobRow0?.media})`);
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

  // ---- Publishing and Admin are not on a singer's menus at all; the Plans page is ----
  await bob.page.getByRole('button', { name: 'More' }).click();
  const more = await bob.page.locator('.navmore').innerText();
  check(!/Publishing/.test(more) && !/Admin/.test(more) && !/My club/.test(more) && /Plans/.test(more), `a singer's More panel has no Publishing, no Admin, no club — the Plans page instead (${more.replace(/\s+/g, ' ').trim()})`);
  await bob.page.locator('.navmore').getByRole('button', { name: 'Close' }).click();
  await bob.page.goto(`${base}home?${control}`, { waitUntil: 'networkidle' });
  check((await bob.page.locator('[data-home-plans]').count()) === 1 && (await bob.page.locator('[data-home-publishing]').count()) === 0, "a singer's Home has the Plans card where Publishing would be");
  check(await alice.page.locator('.navbar a', { hasText: 'Publishing' }).isVisible(), "the super admin's side menu has Publishing");
  check((await alice.page.locator('.navbar a', { hasText: 'Plans' }).count()) === 0, 'the super admin has no Plans page of her own (the Admin page has the plans)');
  await bob.page.goto(`${base}publishing?${control}`, { waitUntil: 'networkidle' });
  await bob.page.getByRole('heading', { name: 'Publishing mode is for club owners' }).waitFor();
  check(await bob.page.getByRole('link', { name: 'See the plans' }).isVisible(), 'the Publishing gate, typed in by hand, points a singer at the Plans page');

  // ---- The picture on stage comes with a plan: a free singer is seated with the voice alone; SVV granted, the picture comes on; the hours used up, it goes; hours back, it returns ----
  await alice.page.goto(`${base}meets?${control}`, { waitUntil: 'networkidle' });
  await alice.page.getByPlaceholder('Sunday SV music meet').fill('Roles e2e');
  await alice.page.getByRole('button', { name: 'Create meet' }).click();
  await alice.page.waitForURL(/\/meet\//);
  const meetUrl = alice.page.url();
  const meetId = /\/meet\/([^/?#]+)/.exec(meetUrl)[1];
  await bob.page.goto(meetUrl + (meetUrl.includes('?') ? '&' : '?') + control, { waitUntil: 'networkidle' });
  await bob.page.getByRole('button', { name: 'Take a stage slot' }).click();
  await bob.page.locator('.stagestrip[data-onstage="1"]').waitFor();
  await bob.page.locator('[data-audio-only][data-video-note="plan"]').waitFor();
  check(/voice alone|comes with a plan/.test(await bob.page.locator('[data-video-reason]').innerText()), 'a free singer on stage has the voice alone, and the chip says a picture comes with a plan');
  const bobSeat = (await asUser('alice', 'GET', `/meets/${meetId}`)).json?.participants?.find((p) => p.displayName === 'bob');
  check(bobSeat?.media === 'audio' && bobSeat?.slot !== null, `the room carries "audio" for him to every device (slot ${bobSeat?.slot})`);
  const bobId0 = (await userRow('alice', 'bob@dev.local'))?.userId;
  const svv = await asUser('alice', 'PATCH', `/admin/users/${bobId0}`, { subscription: { action: 'grant', plan: 'svv' } });
  check(svv.status === 200 && svv.json?.user?.entitlement?.plan === 'svv' && svv.json?.user?.media === 'dual' && svv.json?.user?.entitlement?.videoLeftSeconds === 36000, `SVV granted through the service: the picture, ten hours (${svv.json?.user?.entitlement?.plan}, ${svv.json?.user?.media}, ${svv.json?.user?.entitlement?.videoLeftSeconds} s)`);
  await bob.page.locator('[data-video-left]').waitFor({ timeout: 20000 });
  const leftChip = (await bob.page.locator('[data-video-left]').innerText()).trim();
  check(/video · (10 h 0 m|9 h 5\d m) left this month/.test(leftChip), `his seat gets the picture on the next heartbeat, the chip the hours left (${leftChip})`);
  await bob.page.locator('.stagestrip[data-onstage="1"] .showpic video, .stagestrip[data-onstage="1"] canvas').first().waitFor({ timeout: 20000 }).catch(() => undefined);
  await wait(4000); // on stage with the picture on: the seconds count on the service
  const usedOnStage = (await asUser('bob', 'GET', '/me')).json?.user?.entitlement?.videoUsedSeconds ?? 0;
  check(usedOnStage >= 2 && usedOnStage < 120, `the service counts his time on stage with the picture on (${usedOnStage} s so far)`);
  check((await asUser('alice', 'PUT', `/admin/users/${bobId0}/video-usage`, { seconds: 36000 })).status === 200, "the admin sets his month's hours to the limit (what the stage clock would reach)");
  await bob.page.locator('[data-audio-only][data-video-note="hours"]').waitFor({ timeout: 20000 });
  check(/used up/.test(await bob.page.locator('[data-video-reason]').innerText()) && (await bob.page.locator('[data-video-left]').count()) === 0, `the hours used up: the picture goes on the next heartbeat, the chip says why (${(await bob.page.locator('[data-video-reason]').innerText()).trim().slice(0, 80)})`);
  const bobSeat2 = (await asUser('alice', 'GET', `/meets/${meetId}`)).json?.participants?.find((p) => p.displayName === 'bob');
  check(bobSeat2?.media === 'audio', 'the room carries "audio" for him again — nobody draws his picture');
  await bob.page.screenshot({ path: `${out}/plans-bob-hours-used-up.png` });
  await asUser('alice', 'PUT', `/admin/users/${bobId0}/video-usage`, { seconds: 0 });
  await bob.page.locator('[data-video-left]').waitFor({ timeout: 20000 });
  check(true, 'hours back (a new month): the picture returns');
  await asUser('alice', 'PATCH', `/admin/users/${bobId0}`, { subscription: { action: 'revoke' } });
  await bob.page.locator('[data-audio-only][data-video-note="plan"]').waitFor({ timeout: 20000 });
  check((await asUser('bob', 'GET', '/me')).json?.user?.entitlement?.plan === 'free', 'the plan revoked: the voice alone again, the Free plan');
  await bob.page.getByRole('button', { name: 'Leave stage' }).click();
  await bob.page.locator('.stagestrip[data-onstage="0"]').waitFor();

  // ---- The super admin's plans: the prices, the club year a year, a note; the singer's Plans page shows them ----
  await alice.page.goto(`${base}admin?${control}`, { waitUntil: 'networkidle' });
  await alice.page.locator('[data-plan-settings]').waitFor();
  check(/Stripe not set up/.test(await alice.page.locator('[data-stripe]').innerText()), 'the portal says Stripe is not set up on this service — plans are granted here');
  check((await alice.page.locator('[data-plan-row]').count()) === 4 && (await alice.page.locator('[data-plan-row="svv"] [data-price-usd]').inputValue()) === '5.00' && (await alice.page.locator('[data-plan-row="svvpro"] [data-price-usd]').inputValue()) === '50.00' && (await alice.page.locator('[data-plan-row="club"] [data-video-hours]').inputValue()) === '300' && (await alice.page.locator('[data-plan-row="club"] [data-seats]').inputValue()) === '15', 'the four plans are on the Admin page with the prices, hours and seats asked for (SVV $5, SVVPro $50, the club 300 h and 15 seats)');
  await alice.page.locator('[data-plan-row="club"] [data-price-usd]').fill('250');
  await alice.page.locator('[data-plan-row="club"] [data-price-inr]').fill('21000');
  await alice.page.locator('[data-plan-row="club"] [data-interval]').selectOption('year');
  await alice.page.locator('[data-billing-note]').fill('Run your club night on SingersVoice.');
  await alice.page.locator('[data-billing-save]').click();
  await alice.page.locator('.toast', { hasText: /Plans saved/ }).waitFor();
  const settings = (await asUser('alice', 'GET', '/admin/billing')).json?.settings;
  const clubPlan = settings?.plans?.find((p) => p.id === 'club');
  check(clubPlan?.prices?.usd === 25000 && clubPlan?.prices?.inr === 2100000 && clubPlan?.interval === 'year' && /club night/.test(settings?.note ?? ''), `the prices (USD and INR), the period and the note are kept on the service (${JSON.stringify(clubPlan?.prices)} / ${clubPlan?.interval})`);
  check((await asUser('bob', 'PUT', '/admin/billing/settings', { note: 'x' })).status === 403 && (await asUser('bob', 'GET', '/admin/billing')).status === 403, 'the service refuses the billing portal to anyone but a super admin');
  await bob.page.goto(`${base}plans?${control}`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-plans][data-current-plan="free"] [data-plan-card="club"] [data-price]').waitFor();
  check((await bob.page.locator('[data-plan-card]').count()) === 4 && /250\.00/.test(await bob.page.locator('[data-plan-card="club"] [data-price]').innerText()) && /year/.test(await bob.page.locator('[data-plan-card="club"] [data-price]').innerText()), `the singer's Plans page shows the four plans, the club at the admin's price (${(await bob.page.locator('[data-plan-card="club"] [data-price]').innerText()).trim()})`);
  check(/5\.00/.test(await bob.page.locator('[data-plan-card="svv"] [data-price]').innerText()) && /10 hours a month/.test(await bob.page.locator('[data-plan-card="svv"]').innerText()) && /100 hours a month/.test(await bob.page.locator('[data-plan-card="svvpro"]').innerText()), 'SVV at $5 with 10 hours, SVVPro with 100');
  check(/club night/.test(await bob.page.locator('[data-admin-note]').innerText()), "the admin's note is on the page");
  check((await bob.page.locator('[data-currency-picker] [data-currency="inr"]').count()) === 1, 'a price in INR: the page offers to pay in INR (UPI, cards)');
  check((await bob.page.locator('[data-ask-admin]').count()) >= 3 && (await bob.page.locator('[data-choose]').count()) === 0, 'without Stripe on the service there is no Choose button: the page says to ask the SingersVoice admin');
  await bob.page.screenshot({ path: `${out}/plans-bob.png`, fullPage: true });

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
  await bobRowEl.locator('[data-grant-plan]').selectOption('club');
  await bobRowEl.locator('[data-sub-grant]').click();
  await alice.page.locator('[data-admin-user="bob@dev.local"][data-user-role="club_owner"] [data-subscription="active"][data-subscription-plan="club"]').waitFor();
  await alice.page.locator('[data-subscriber="bob@dev.local"][data-standing="active"][data-plan="club"]').waitFor();
  const bobOverview = await alice.page.locator('[data-subscriber="bob@dev.local"]').innerText();
  check(/active · 36\d days left/.test(bobOverview) && /granted/.test(bobOverview) && /0\/15 members/.test(bobOverview), `the subscribers overview has him on the Club owner plan, active with the days left, no members yet, the grant as his last payment (${bobOverview.replace(/\s+/g, ' ').trim().slice(0, 200)})`);
  check(/granted/.test(await alice.page.locator('[data-payments-admin]').innerText()), 'the period granted is on the payments record (amount 0)');
  const bobRow2 = await userRow('alice', 'bob@dev.local');
  const yearOn = bobRow2?.subscription?.expiresAt ? (Date.parse(bobRow2.subscription.expiresAt) - Date.now()) / 86_400_000 : 0;
  check(bobRow2?.role === 'club_owner' && bobRow2?.canPublish === true && bobRow2?.subscription?.status === 'active' && yearOn > 360 && yearOn < 370 && Boolean(bobRow2?.subscription?.startedAt), `the grant makes a club owner with a year (starts ${bobRow2?.subscription?.startedAt?.slice(0, 10)}, ends ${bobRow2?.subscription?.expiresAt?.slice(0, 10)}), Publishing open`);
  check((await asUser('bob', 'GET', '/publishing/destinations')).status === 200, 'the service opens Publishing mode to the club owner at once');
  await bob.page.goto(`${base}publishing?${control}`, { waitUntil: 'networkidle' });
  await bob.page.getByRole('radio', { name: 'Publish a meet' }).waitFor();
  check(true, 'the club owner opens Publishing mode on his device');
  await bob.page.goto(`${base}plans?${control}`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-plans][data-current-plan="club"][data-via="own"]').waitFor();
  const mine = await bob.page.locator('[data-standing]').innerText();
  check(/Club owner/.test(mine) && /until/.test(mine) && /of 300 h left/.test(mine) && /Publishing mode is open/.test(mine) && /0 of 15 members/.test(mine), `his Plans page shows the Club owner plan, its end, the club's hours, Publishing open, the seats (${mine.replace(/\s+/g, ' ').trim().slice(0, 160)})`);
  check((await bob.page.locator('[data-plan-card="club"][data-mine="1"]').count()) === 1 && (await bob.page.locator('[data-plan-card="club"] [data-club-link]').count()) === 1, 'the club card is marked his, with the way to My club');
  check(await bob.page.locator('[data-payments] [data-payment-source="grant"]').first().isVisible(), 'his payments list has the granted periods');
  await bob.page.goto(`${base}home?${control}`, { waitUntil: 'networkidle' });
  check((await bob.page.locator('[data-home-publishing]').count()) === 1 && (await bob.page.locator('[data-home-club]').count()) === 1, "with the plan, Publishing and My club are on the club owner's Home");
  await bob.page.getByRole('button', { name: 'More' }).click();
  const more2 = await bob.page.locator('.navmore').innerText();
  check(/Publishing/.test(more2) && /My club/.test(more2), 'and in his More panel');
  await bob.page.locator('.navmore').getByRole('button', { name: 'Close' }).click();
  // ---- His club: a member named by email shares the club's hours; the seats are counted ----
  await bob.page.goto(`${base}club?${control}`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-club-members]').waitFor();
  await bob.page.locator('[data-club-email]').fill('dave@dev.local');
  await bob.page.locator('[data-club-add]').click();
  await bob.page.locator('[data-club-member="dave@dev.local"]').waitFor();
  check(/not signed in yet/.test(await bob.page.locator('[data-club-member="dave@dev.local"]').innerText()) && /1 of 15 members/.test(await bob.page.locator('[data-club-pool]').innerText()), 'a member named by email is listed (not signed in yet) and the seats count');
  const daveMe = await asUser('dave', 'GET', '/me');
  check(daveMe.json?.user?.entitlement?.via === 'club' && daveMe.json?.user?.media === 'dual' && daveMe.json?.user?.entitlement?.clubOwner?.name === 'bob' && daveMe.json?.user?.canPublish === false, `the member signs in: the club's picture and hours, bob's club, no Publishing (${daveMe.json?.user?.entitlement?.via}, ${daveMe.json?.user?.media})`);
  await bob.page.reload({ waitUntil: 'networkidle' });
  await bob.page.locator('[data-club-member="dave@dev.local"]').waitFor();
  check(/signed in/.test(await bob.page.locator('[data-club-member="dave@dev.local"]').innerText()) && !/not signed in/.test(await bob.page.locator('[data-club-member="dave@dev.local"]').innerText()), 'the list names her once she has');
  check((await asUser('dave', 'POST', '/club/members', { email: 'x@dev.local' })).status === 403, 'a member has no club of their own to add to');
  bob.page.once('dialog', (d) => void d.accept());
  await bob.page.locator('[data-club-member="dave@dev.local"] [data-club-remove]').click();
  await bob.page.locator('[data-club-member="dave@dev.local"]').waitFor({ state: 'detached' });
  check((await asUser('dave', 'GET', '/me')).json?.user?.entitlement?.plan === 'free', 'removed from the club, she is on the Free plan again');
  await bob.page.screenshot({ path: `${out}/club-bob.png`, fullPage: true });

  // ---- The year runs out: Publishing closes by itself, with the date; a renewal opens it again ----
  const bobSub = bobRowEl.locator('[data-subscription]');
  await bobSub.getByLabel('Start date').fill(dates(-400));
  await bobSub.getByLabel('Expiry date').fill(dates(-35));
  await bobSub.locator('[data-sub-set]').click();
  await alice.page.locator('[data-admin-user="bob@dev.local"] [data-subscription="expired"]').waitFor();
  await alice.page.locator('[data-subscriber="bob@dev.local"][data-standing="expired"]').waitFor();
  check(/expired · 3\d days ago/.test(await alice.page.locator('[data-subscriber="bob@dev.local"] [data-standing-label]').innerText()) && (await alice.page.locator('[data-subscriber]').first().getAttribute('data-subscriber')) === 'bob@dev.local', 'the overview flags the plan expired, with how long ago, at the top of the list');
  const bobRow3 = await userRow('alice', 'bob@dev.local');
  check(bobRow3?.subscription?.status === 'expired' && bobRow3?.canPublish === false && bobRow3?.role === 'club_owner', `with the dates set to a year that has run out the subscription stands expired and Publishing is closed (${bobRow3?.subscription?.status}, publish ${bobRow3?.canPublish})`);
  const closed = await asUser('bob', 'GET', '/publishing/destinations');
  check(closed.status === 403 && /expired on \d{4}-\d{2}-\d{2}/.test(closed.json?.error ?? ''), `the service says why: "${closed.json?.error}"`);
  await bob.page.goto(`${base}publishing?${control}`, { waitUntil: 'networkidle' });
  await bob.page.getByRole('heading', { name: 'Publishing mode is for club owners' }).waitFor();
  check(/expired on/.test(await bob.page.locator('.empty').innerText()), 'his device shows Publishing closed, with the expiry date');
  await alice.page.locator('[data-subscriber="bob@dev.local"] [data-sub-grant-again]').click(); // from the overview this time
  await alice.page.locator('[data-admin-user="bob@dev.local"] [data-subscription="active"]').waitFor();
  await alice.page.locator('[data-subscriber="bob@dev.local"][data-standing="active"]').waitFor();
  const bobRow4 = await userRow('alice', 'bob@dev.local');
  const renewedOn = bobRow4?.subscription?.expiresAt ? (Date.parse(bobRow4.subscription.expiresAt) - Date.now()) / 86_400_000 : 0;
  check(bobRow4?.canPublish === true && renewedOn > 360 && renewedOn < 370, `the plan granted again from the overview runs a year from today when the last period has run out (ends ${bobRow4?.subscription?.expiresAt?.slice(0, 10)})`);
  await alice.page.locator('[data-subscriber="bob@dev.local"] [data-sub-renew-row]').click();
  await alice.page.locator('.toast', { hasText: /renewed/ }).waitFor();
  const bobRow4b = await userRow('alice', 'bob@dev.local');
  const renewedTwice = bobRow4b?.subscription?.expiresAt ? (Date.parse(bobRow4b.subscription.expiresAt) - Date.now()) / 86_400_000 : 0;
  check(renewedTwice > 725 && renewedTwice < 735, `Renew on the overview adds the plan's period (a year) to the end of the current one (ends ${bobRow4b?.subscription?.expiresAt?.slice(0, 10)})`);
  check((await asUser('bob', 'GET', '/publishing/destinations')).status === 200, 'Publishing is open again on the service');

  // ---- Revoked: closed at once, and told so ----
  alice.page.once('dialog', (d) => void d.accept());
  await bobSub.locator('[data-sub-revoke]').click();
  await alice.page.locator('[data-admin-user="bob@dev.local"] [data-subscription="revoked"]').waitFor();
  await alice.page.locator('[data-subscriber="bob@dev.local"][data-standing="revoked"]').waitFor();
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
