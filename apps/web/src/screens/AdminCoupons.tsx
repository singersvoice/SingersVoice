/**
 * Coupons (/admin/coupons) — the super admin's gate on who may use SingersVoice (coupons.ts): the
 * requirement itself (a switch), a plain form — email address, coupon code (or Generate), expiry date,
 * a note — and the list of coupons issued: who holds the address and whether they are in, the days
 * left, Edit (a new code or date — the holder is out until they enter the new code), Delete. The
 * service checks every request, so a change here takes effect on the holder's next tap.
 */
import { couponDaysLeft, displayCode, newCouponCode, type AdminCouponsResponse, type CouponRow } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Shell.tsx';
import { Empty, Spinner, Switch } from '../components/ui.tsx';
import { api, controlConfigured, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isSuperAdmin } from '../state/session.ts';

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '—');
const dateInput = (iso: string): string => iso.slice(0, 10);
/** The expiry as sent: the end of the day picked (UTC). */
const endOfDay = (d: string): string => `${d}T23:59:59Z`;
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export function AdminCoupons() {
  const [view, setView] = useState<AdminCouponsResponse | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', code: '', expires: inDays(30), note: '' });
  const [edits, setEdits] = useState<Record<string, { code: string; expires: string }>>({});

  const load = async () => {
    try {
      setView(await api.get('GET /admin/coupons', '/admin/coupons'));
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    }
  };
  useEffect(() => {
    if (!controlConfigured.value) {
      setChecked(true);
      return;
    }
    void refreshAccount().finally(() => setChecked(true));
  }, []);
  useEffect(() => {
    if (checked && isSuperAdmin.value && controlConfigured.value) void load();
  }, [checked, isSuperAdmin.value]);

  const setRequired = async (required: boolean) => {
    setBusy('settings');
    try {
      const r = await api.put('PUT /admin/coupons/settings', '/admin/coupons/settings', { required });
      setView((v) => (v ? { ...v, settings: r.settings } : v));
      toast(required ? 'Coupons required: singers without a valid coupon are out from their next tap' : 'Coupons not required: everyone is in', 'ok', 6000);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };
  const issue = async (email: string, code: string, expires: string, note: string, done: string) => {
    setBusy(email || 'new');
    try {
      const r = await api.put('PUT /admin/coupons', '/admin/coupons', { email, code: code.trim() || undefined, expiresAt: endOfDay(expires), note });
      toast(`${r.coupon.email}: ${done} — ${displayCode(r.coupon.code)}, until ${day(r.coupon.expiresAt)}`, 'ok', 7000);
      setForm({ email: '', code: '', expires: inDays(30), note: '' });
      setEdits((x) => {
        const { [r.coupon.email]: _gone, ...rest } = x;
        return rest;
      });
      await load();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (row: CouponRow) => {
    if (!confirm(`Delete the coupon for ${row.coupon.email}? ${row.user ? `${row.user.name || row.coupon.email} is out from their next tap.` : ''}`)) return;
    setBusy(row.coupon.email);
    try {
      await api.del('DELETE /admin/coupons/:email', `/admin/coupons/${encodeURIComponent(row.coupon.email)}`);
      toast(`${row.coupon.email}: coupon deleted`, 'ok');
      await load();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  if (!checked)
    return (
      <Page title="Coupons">
        <div class="row">
          <Spinner /> Checking your account…
        </div>
      </Page>
    );
  if (!isSuperAdmin.value)
    return (
      <Page title="Coupons">
        <Empty title="Super admins only" body="This page issues the coupons singers need to use SingersVoice.">
          <a class="btn" href={href('/home')}>
            Home
          </a>
        </Empty>
      </Page>
    );
  if (!controlConfigured.value)
    return (
      <Page title="Coupons">
        <div class="callout warn">The SingersVoice service is not configured for this build (VITE_CONTROL_URL) — coupons live there.</div>
      </Page>
    );
  const required = view?.settings.required ?? true;
  return (
    <Page title="Coupons">
      <div class="stack" data-admin-coupons>
        <section class="card stack pad-sm">
          <div class="row between wrap">
            <div>
              <h3 style="margin:0">Who may use SingersVoice</h3>
              <div class="small muted">A singer signs in with Google and is asked for the coupon issued to their email address — before anything else. The service checks it on every request: a code or date changed here puts the holder out until they enter the new code; a deleted coupon puts them out for good. Super admins are always in.</div>
            </div>
          </div>
          {view && <Switch checked={required} disabled={busy === 'settings'} onChange={(v) => void setRequired(v)} label={required ? 'Coupons required — only singers with a valid coupon are in' : 'Coupons not required — everyone who signs in is in'} hint="Switch off to let everyone in without a coupon; the coupons issued stay as they are." />}
          {!view && (
            <div class="row">
              <Spinner /> Loading…
            </div>
          )}
        </section>

        <section class="card stack pad-sm" data-coupon-form>
          <h3 style="margin:0">Issue a coupon</h3>
          <form
            class="row wrap"
            style="gap:10px;align-items:flex-end"
            onSubmit={(e) => {
              e.preventDefault();
              void issue(form.email.trim().toLowerCase(), form.code, form.expires, form.note.trim(), 'coupon issued');
            }}
          >
            <div class="field" style="margin:0;flex:1;min-width:14em">
              <label>Email address</label>
              <input class="input" type="email" required placeholder="singer@gmail.com" value={form.email} data-coupon-email onInput={(e) => setForm((f) => ({ ...f, email: (e.currentTarget as HTMLInputElement).value }))} />
            </div>
            <div class="field" style="margin:0">
              <label>Coupon code</label>
              <div class="row" style="gap:6px">
                <input class="input mono" style="width:11em;text-transform:uppercase" placeholder="leave empty to generate" value={form.code} data-coupon-new-code onInput={(e) => setForm((f) => ({ ...f, code: (e.currentTarget as HTMLInputElement).value }))} />
                <button class="btn sm" type="button" data-coupon-generate onClick={() => setForm((f) => ({ ...f, code: newCouponCode() }))}>
                  Generate
                </button>
              </div>
            </div>
            <div class="field" style="margin:0">
              <label>Expires on</label>
              <input class="input" type="date" required value={form.expires} data-coupon-expires onInput={(e) => setForm((f) => ({ ...f, expires: (e.currentTarget as HTMLInputElement).value }))} />
            </div>
            <div class="field" style="margin:0;flex:1;min-width:12em">
              <label>Note (yours)</label>
              <input class="input" placeholder="who they are, what for" maxLength={200} value={form.note} data-coupon-note onInput={(e) => setForm((f) => ({ ...f, note: (e.currentTarget as HTMLInputElement).value }))} />
            </div>
            <button class="btn primary" type="submit" disabled={busy !== null || !form.email.trim() || !form.expires} data-coupon-issue>
              {busy === 'new' ? <Spinner /> : null} Issue
            </button>
          </form>
          <div class="small faint">Issuing a coupon for an address that has one replaces it: the holder enters the new code next time. Give the singer the code as it shows here (dashes and case do not matter when they type it).</div>
        </section>

        <section class="card stack pad-sm" data-coupon-list>
          <h3 style="margin:0">Coupons issued</h3>
          {view && !view.coupons.length && <div class="muted small">None yet.</div>}
          <div class="list">
            {(view?.coupons ?? []).map((row) => {
              const c = row.coupon;
              const e = edits[c.email] ?? { code: displayCode(c.code), expires: dateInput(c.expiresAt) };
              const working = busy === c.email;
              const left = couponDaysLeft(c);
              return (
                <div class="item wide-actions" key={c.email} data-coupon={c.email} data-coupon-state={row.standing} data-coupon-in={row.user?.ok ? '1' : '0'}>
                  <div class="thumb" style="overflow:hidden">
                    {row.user?.picture ? <img src={row.user.picture} alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover" /> : <span>{c.email.slice(0, 1).toUpperCase()}</span>}
                  </div>
                  <div class="meta">
                    <div class="t">
                      {row.user?.name || c.email} <span class="chip mono" data-coupon-code>{displayCode(c.code)}</span>{' '}
                      <span class={`chip ${row.standing === 'active' ? 'ok' : 'warn'}`} data-coupon-standing>
                        {row.standing === 'expired' ? `expired ${Math.abs(left)} day${Math.abs(left) === 1 ? '' : 's'} ago` : row.standing === 'expiring' ? `expiring · ${left} day${left === 1 ? '' : 's'} left` : `until ${day(c.expiresAt)} · ${left} days left`}
                      </span>{' '}
                      {row.user ? row.user.ok ? <span class="chip ok" data-coupon-holder="in">in</span> : <span class="chip warn" data-coupon-holder="out">{row.user.entered ? 'out — entered another code' : 'out — no code entered yet'}</span> : <span class="chip" data-coupon-holder="none">not signed in yet</span>}
                    </div>
                    <div class="s">
                      {c.email} · issued {day(c.createdAt)}
                      {c.updatedAt !== c.createdAt ? ` · changed ${day(c.updatedAt)}` : ''}
                      {row.user?.lastSeenAt ? ` · last seen ${day(row.user.lastSeenAt)}` : ''}
                      {c.note ? ` · ${c.note}` : ''}
                    </div>
                    <div class="row wrap" style="gap:6px;margin-top:6px;align-items:center">
                      <input class="input mono" style="width:11em;text-transform:uppercase" value={e.code} disabled={working} aria-label={`Code for ${c.email}`} data-coupon-edit-code onInput={(ev) => setEdits((x) => ({ ...x, [c.email]: { ...e, code: (ev.currentTarget as HTMLInputElement).value } }))} />
                      <input class="input" type="date" style="width:auto" value={e.expires} disabled={working} aria-label={`Expiry for ${c.email}`} data-coupon-edit-expires onInput={(ev) => setEdits((x) => ({ ...x, [c.email]: { ...e, expires: (ev.currentTarget as HTMLInputElement).value } }))} />
                      <button class="btn sm" disabled={working || !e.expires || !e.code.trim()} data-coupon-save onClick={() => void issue(c.email, e.code, e.expires, c.note, 'coupon changed')}>
                        Save
                      </button>
                      <button class="btn sm" type="button" disabled={working} data-coupon-regenerate onClick={() => setEdits((x) => ({ ...x, [c.email]: { ...e, code: newCouponCode() } }))}>
                        New code
                      </button>
                      <button class="btn sm danger" disabled={working} data-coupon-delete onClick={() => void remove(row)}>
                        Delete
                      </button>
                      {working && <Spinner />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </Page>
  );
}
