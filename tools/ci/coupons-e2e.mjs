// Coupons e2e: the super admin's gate on who may use SingersVoice (coupons.ts). alice (the first account, the
// super admin) turns the requirement on from the Coupons page; bob, signed in, finds the Coupon screen in place of
// every page (no coupon issued for his address, the reason in words) and the service refuses him everything but
// his standing; alice issues him a coupon on the page (generated code, an expiry, a note) — bob enters the wrong
// code (told so), then the right one typed loosely, and is in, Home and all, and in again after a reload; alice
// changes his code on the page — bob's next tap brings the Coupon screen back (the wrong code now) until he enters
// the new one; alice moves the expiry into the past — out with the date; back a month — in; alice deletes the
// coupon — out for good; alice turns the requirement off — bob is in without a coupon. Every change is read back
// from the service, not only from the page.
//   npm run build (BASE_PATH=/SingersVoice/) && node tools/ci/coupons-e2e.mjs [outDir]
import { createRequire } from 'node:module';
import { startServers } from './servers.mjs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const servers = await startServers({ base: process.env.BASE_PATH ?? '/SingersVoice/' });
const base = servers.appUrl;
const control = `control=${servers.controlUrl}`;
const browser = await pw.chromium.launch();
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };
const errors = { alice: [], bob: [] };
const asUser = async (who, method, route, body) => {
  const r = await fetch(`${servers.controlUrl}${route}`, { method, headers: { 'X-Dev-User': who, 'X-Dev-Name': who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function person(name, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[name].push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/403/.test(m.text()) && errors[name].push(m.text()));
  await page.goto(base + '?' + control, { waitUntil: 'networkidle' });
  await page.evaluate((n) => localStorage.setItem('sv.profile', JSON.stringify({ sub: n, name: n, email: '', picture: '', mode: 'local' })), name);
  await page.evaluate(() => { localStorage.setItem('sv.mode', 'local'); localStorage.setItem('sv.settings.app', JSON.stringify({ onboarded: true })); });
  await page.goto(base + 'home?' + control, { waitUntil: 'networkidle' });
  return { ctx, page };
}
const alice = await person('alice', { width: 1280, height: 800 });
const bob = await person('bob', { width: 390, height: 844 });
const dates = (daysFromNow) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
const bobHome = async () => { await bob.page.goto(`${base}home?${control}`, { waitUntil: 'networkidle' }); };

try {
  // ---- The gate is off on the test service: bob is in; the Coupons page is the super admin's alone ----
  check((await bob.page.locator('.home-hero').count()) === 1 && (await bob.page.locator('[data-coupon-gate]').count()) === 0, 'with the gate off a singer is in: Home, no Coupon screen');
  check((await asUser('bob', 'GET', '/admin/coupons')).status === 403, 'the service refuses the coupons list to anyone but a super admin');
  await bob.page.goto(`${base}admin/coupons?${control}`, { waitUntil: 'networkidle' });
  check(await bob.page.getByText('Super admins only').isVisible(), 'a singer who opens /admin/coupons is told it is for super admins');
  check(await alice.page.locator('.navbar a', { hasText: 'Coupons' }).isVisible(), "the super admin's side menu has Coupons under Settings");

  // ---- alice turns the requirement on: bob's next page is the Coupon screen; the service refuses him everything but his standing ----
  await alice.page.goto(`${base}admin/coupons?${control}`, { waitUntil: 'networkidle' });
  await alice.page.locator('[data-coupon-form]').waitFor();
  await alice.page.locator('label.switch', { hasText: 'Coupons' }).locator('input').click(); // a controlled switch: it follows the service's answer
  await alice.page.locator('.toast', { hasText: /Coupons required/ }).waitFor();
  check((await asUser('alice', 'GET', '/admin/coupons')).json?.settings?.required === true, 'the requirement is kept on the service');
  await bobHome();
  await bob.page.locator('[data-coupon-gate][data-coupon-standing="none"]').waitFor();
  check(/No coupon is issued/.test(await bob.page.locator('[data-coupon-note]').innerText()), 'a singer without a coupon finds the Coupon screen in place of Home, told no coupon is issued for his account');
  const refused = await asUser('bob', 'GET', '/meets');
  check(refused.status === 403 && refused.json?.code === 'coupon_required', `the service refuses him every route but his standing (${refused.status} ${refused.json?.code})`);
  check((await asUser('bob', 'GET', '/me')).status === 200, '/me still answers, so the app can show the gate');
  await bob.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  check((await bob.page.locator('[data-coupon-gate]').count()) === 1, 'every page shows the Coupon screen, Tracks too');
  await bob.page.screenshot({ path: `${out}/coupon-gate-none.png` });

  // ---- alice issues bob a coupon on the page: a generated code, an expiry a month on, a note ----
  await alice.page.locator('[data-coupon-email]').fill('bob@dev.local');
  await alice.page.locator('[data-coupon-generate]').click();
  const generated = await alice.page.locator('[data-coupon-new-code]').inputValue();
  check(/^SV-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(generated), `Generate fills a code (${generated})`);
  await alice.page.locator('[data-coupon-expires]').fill(dates(30));
  await alice.page.locator('[data-coupon-note]').fill('the Sunday club');
  await alice.page.locator('[data-coupon-issue]').click();
  await alice.page.locator('[data-coupon="bob@dev.local"]').waitFor();
  const issued = (await asUser('alice', 'GET', '/admin/coupons')).json?.coupons?.find((c) => c.coupon.email === 'bob@dev.local');
  check(issued?.coupon?.code === generated && issued?.coupon?.note === 'the Sunday club' && issued?.standing === 'active' && issued?.daysLeft >= 29 && issued?.user?.name === 'bob' && issued?.user?.ok === false, `the coupon is kept on the service with its expiry and note, bob named as its holder, out until he enters it (${issued?.standing}, ${issued?.daysLeft} days)`);
  check(/out — no code entered yet/.test(await alice.page.locator('[data-coupon="bob@dev.local"]').innerText()), 'the list says he has not entered it yet');
  await alice.page.screenshot({ path: `${out}/coupons-alice.png`, fullPage: true });

  // ---- bob enters it: the wrong code is told so; the right one, typed loosely, lets him in — and in after a reload ----
  await bobHome();
  await bob.page.locator('[data-coupon-gate][data-coupon-standing="missing"]').waitFor();
  await bob.page.locator('[data-coupon-code]').fill('SV-WRONG999');
  await bob.page.locator('[data-coupon-submit]').click();
  await bob.page.locator('[data-coupon-error]').waitFor();
  check(/not the coupon issued/.test(await bob.page.locator('[data-coupon-error]').innerText()), 'the wrong code: told so, still out');
  await bob.page.locator('[data-coupon-code]').fill(` ${generated.toLowerCase().replace('-', ' ')} `);
  await bob.page.locator('[data-coupon-submit]').click();
  await bob.page.locator('.home-hero').waitFor();
  check((await bob.page.locator('[data-coupon-gate]').count()) === 0, 'the right code, typed in lower case with a space: in — Home shows');
  check((await asUser('bob', 'GET', '/meets')).status === 200, 'the service lets him through now');
  await bob.page.reload({ waitUntil: 'networkidle' });
  await bob.page.locator('.home-hero').waitFor();
  check((await bob.page.locator('[data-coupon-gate]').count()) === 0, 'and after a reload: the coupon entered is kept on the account');
  await alice.page.reload({ waitUntil: 'networkidle' });
  await alice.page.locator('[data-coupon="bob@dev.local"][data-coupon-in="1"]').waitFor();
  check(true, "the admin's list shows him in");

  // ---- alice changes his code: his next tap brings the Coupon screen back, until he enters the new one ----
  const row = alice.page.locator('[data-coupon="bob@dev.local"]');
  await row.locator('[data-coupon-regenerate]').click();
  const newCode = await row.locator('[data-coupon-edit-code]').inputValue();
  check(newCode !== generated && /^SV-/.test(newCode), `New code fills another one (${newCode})`);
  await row.locator('[data-coupon-save]').click();
  await alice.page.locator('.toast', { hasText: /coupon changed/ }).waitFor();
  check((await asUser('bob', 'GET', '/meets')).status === 403, 'the code changed: the service refuses him at once');
  await bob.page.goto(`${base}tracks?${control}`, { waitUntil: 'networkidle' });
  await bob.page.locator('[data-coupon-gate][data-coupon-standing="wrong"]').waitFor();
  check(true, 'his next page is the Coupon screen again (the code he had is the wrong one now)');
  await bob.page.locator('[data-coupon-code]').fill(newCode);
  await bob.page.locator('[data-coupon-submit]').click();
  await bob.page.locator('.tracks, [data-tracks], main').first().waitFor();
  check((await bob.page.locator('[data-coupon-gate]').count()) === 0 && (await asUser('bob', 'GET', '/meets')).status === 200, 'the new code: in again');

  // ---- The expiry moved into the past: out, with the date; moved on again: in with no new code ----
  await row.locator('[data-coupon-edit-expires]').fill(dates(-1));
  await row.locator('[data-coupon-save]').click();
  await alice.page.locator('[data-coupon="bob@dev.local"][data-coupon-state="expired"]').waitFor();
  const expired = await asUser('bob', 'GET', '/meets');
  check(expired.status === 403 && /expired on/.test(expired.json?.error ?? ''), `expired: the service refuses him with the date ("${expired.json?.error}")`);
  await bobHome();
  await bob.page.locator('[data-coupon-gate][data-coupon-standing="expired"]').waitFor();
  check(/expired on/.test(await bob.page.locator('[data-coupon-note]').innerText()), 'his Coupon screen says it expired, with the date');
  await bob.page.screenshot({ path: `${out}/coupon-gate-expired.png` });
  await row.locator('[data-coupon-edit-expires]').fill(dates(30));
  await row.locator('[data-coupon-save]').click();
  await alice.page.locator('[data-coupon="bob@dev.local"][data-coupon-state="active"]').waitFor();
  check((await asUser('bob', 'GET', '/meets')).status === 200, 'the expiry moved on: in again, with the code he has');
  await bobHome();
  await bob.page.locator('.home-hero').waitFor();
  check((await bob.page.locator('[data-coupon-gate]').count()) === 0, 'and Home shows without a word from him');

  // ---- Deleted: out for good; the requirement off: in without a coupon ----
  alice.page.once('dialog', (d) => void d.accept());
  await row.locator('[data-coupon-delete]').click();
  await alice.page.locator('[data-coupon="bob@dev.local"]').waitFor({ state: 'detached' });
  check((await asUser('bob', 'GET', '/meets')).status === 403 && (await asUser('bob', 'GET', '/me')).json?.user?.access?.standing === 'none', 'the coupon deleted: out, no coupon issued');
  await bobHome();
  await bob.page.locator('[data-coupon-gate][data-coupon-standing="none"]').waitFor();
  check(true, 'his page is the Coupon screen again');
  await alice.page.locator('label.switch', { hasText: 'Coupons' }).locator('input').click();
  await alice.page.locator('.toast', { hasText: /not required/ }).waitFor();
  check((await asUser('bob', 'GET', '/meets')).status === 200, 'the requirement off: the service lets everyone in');
  await bobHome();
  await bob.page.locator('.home-hero').waitFor();
  check((await bob.page.locator('[data-coupon-gate]').count()) === 0, 'and bob is in without a coupon');

  const errs = Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v.filter((e) => !/favicon|Failed to load resource/.test(e))]));
  check(Object.values(errs).every((v) => !v.length), `no page errors (${JSON.stringify(errs).slice(0, 300)})`);
} catch (e) {
  failed = true;
  console.error('FAIL', e);
  await alice.page.screenshot({ path: `${out}/coupons-alice-fail.png` }).catch(() => {});
  await bob.page.screenshot({ path: `${out}/coupons-bob-fail.png` }).catch(() => {});
}
await browser.close();
servers.stop();
process.exit(failed ? 1 : 0);
