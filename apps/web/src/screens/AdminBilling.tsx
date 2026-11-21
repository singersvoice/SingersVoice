/**
 * The super admin's billing portal — a section of the Admin page: the four plans with what the admin
 * decides (the price in USD and in INR — a price in INR takes UPI through Stripe —, the period: a month
 * or a year, the video hours a month, the seats of a club, for sale on the Plans page or granted here),
 * a note for the Plans page, the margins (expiring soon, grace days); every subscriber by standing —
 * expired first, then expiring with the days left, then active — with the plan, the hours used this
 * month, the last payment and Grant / Renew / Revoke in the row; every payment on record (a Refund
 * button on Stripe's); the Checkouts that did not end in a payment. Between the plans and the
 * subscribers: the offers (the ways to pay for a plan) and the promo codes (AdminOffers.tsx).
 */
import { hoursLabel, moneyLabel, type AdminBillingOverview, type PlanDef, type PlanId, type SubscriberRow, type SubscriptionStanding } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Spinner, Switch } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { errorText, toast } from '../lib/toast.ts';
import { AdminOffers } from './AdminOffers.tsx';
import { PaymentLine } from './Plans.tsx';

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '—');

interface PlanForm {
  id: PlanId;
  usd: string;
  inr: string;
  interval: 'month' | 'year';
  videoHours: string;
  seats: string;
  selfService: boolean;
}
interface Form {
  plans: PlanForm[];
  note: string;
  expiringSoonDays: string;
  graceDays: string;
}
const money = (cents: number | undefined) => (cents ? (cents / 100).toFixed(2) : '');
const formOf = (s: AdminBillingOverview['settings']): Form => ({
  plans: s.plans.map((p) => ({ id: p.id, usd: money(p.prices.usd), inr: money(p.prices.inr), interval: p.interval, videoHours: String(p.videoHours), seats: String(p.seats), selfService: p.selfService })),
  note: s.note,
  expiringSoonDays: String(s.expiringSoonDays),
  graceDays: String(s.graceDays),
});
const cents = (v: string): number => {
  const n = Math.round(Number(v.replace(',', '.')) * 100);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The standing in words, with the days: "active · 212 days left", "expiring · 9 days left", "expired · 40 days ago". */
export function standingLabel(r: Pick<SubscriberRow, 'standing' | 'daysLeft'>): string {
  const d = r.daysLeft;
  if (r.standing === 'none') return 'no plan';
  if (r.standing === 'revoked') return 'revoked';
  if (r.standing === 'expired') return d === null ? 'expired' : `expired · ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago`;
  if (d === null) return `${r.standing} · no end date`;
  if (d < 0) return `${r.standing} · ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} past, in the grace days`;
  return `${r.standing} · ${d} day${d === 1 ? '' : 's'} left`;
}
const chipClass: Record<SubscriptionStanding, string> = { active: 'ok', expiring: 'warn', expired: 'warn', revoked: '', none: '' };

/** `tick` changes when the Accounts list below changed a subscription: the overview follows. */
export function AdminBilling(props: { onChanged?: () => void; tick?: number }) {
  const [view, setView] = useState<AdminBillingOverview | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [allPayments, setAllPayments] = useState(false);

  const load = async () => {
    try {
      const v = await api.get('GET /admin/billing', '/admin/billing');
      setView(v);
      setForm((f) => f ?? formOf(v.settings));
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    }
  };
  useEffect(() => void load(), [props.tick ?? 0]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const plans: Partial<PlanDef>[] = form.plans.map((p) => {
        const prices: Record<string, number> = {};
        if (cents(p.usd)) prices.usd = cents(p.usd);
        if (cents(p.inr)) prices.inr = cents(p.inr);
        return { id: p.id, prices, interval: p.interval, intervalCount: 1, videoHours: Number(p.videoHours) || 0, seats: Number(p.seats) || 0, selfService: p.selfService };
      });
      const r = await api.put('PUT /admin/billing/settings', '/admin/billing/settings', { plans: plans as PlanDef[], note: form.note.trim(), expiringSoonDays: Number(form.expiringSoonDays) || 0, graceDays: Number(form.graceDays) || 0 });
      setForm(formOf(r.settings));
      setView((v) => (v ? { ...v, settings: r.settings } : v));
      toast('Plans saved', 'ok');
      void load();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setSaving(false);
    }
  };
  const setPlan = (id: PlanId, patch: Partial<PlanForm>) => setForm((f) => (f ? { ...f, plans: f.plans.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : f));

  const act = async (r: SubscriberRow, action: 'grant' | 'renew' | 'revoke', done: string) => {
    setBusy(r.user.userId);
    try {
      await api.patch('PATCH /admin/users/:id', `/admin/users/${encodeURIComponent(r.user.userId)}`, { subscription: { action, plan: action === 'revoke' ? undefined : r.user.subscription?.plan && r.user.subscription.plan !== 'free' ? (r.user.subscription.plan as PlanId) : 'club' } });
      toast(`${r.user.name || r.user.email}: ${done}`, 'ok');
      await load();
      props.onChanged?.();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };
  const refund = async (id: string, who: string, amount: string) => {
    if (!confirm(`Refund ${amount} to ${who} through Stripe? This cannot be undone.`)) return;
    setBusy(id);
    try {
      await api.post('POST /admin/payments/:id/refund', `/admin/payments/${encodeURIComponent(id)}/refund`, {});
      toast(`${amount} refunded to ${who}`, 'ok');
      await load();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  const payments = view?.payments ?? [];
  const who = (userId: string) => {
    const u = view?.subscribers.find((o) => o.user.userId === userId)?.user;
    return u ? u.name || u.email : userId;
  };

  return (
    <section class="card stack pad-sm" id="billing" data-billing>
      <div class="row between wrap">
        <div>
          <h3 style="margin:0">Plans &amp; payments</h3>
          <div class="small muted">What each plan costs and gives; every subscriber by standing — the expired and the expiring first; the payments.</div>
        </div>
        {view && <span class={`chip ${view.stripe ? 'ok' : 'warn'}`} data-stripe={view.stripe ? 'on' : 'off'}>{view.stripe ? 'Stripe connected — singers pay on the Plans page' : 'Stripe not set up (STRIPE_SECRET_KEY) — plans are granted here'}</span>}
      </div>
      {!view && (
        <div class="row">
          <Spinner /> Loading…
        </div>
      )}

      {form && (
        <div class="stack" style="gap:10px" data-plan-settings>
          <div class="row wrap small muted" style="gap:12px">
            <span style="min-width:7em">Plan</span>
            <span style="width:7em">Price USD</span>
            <span style="width:7em">Price INR</span>
            <span style="width:7em">Period</span>
            <span style="width:6em">Video h/mo</span>
            <span style="width:5em">Seats</span>
            <span>For sale</span>
          </div>
          {form.plans.map((p) => (
            <div class="row wrap" style="gap:12px;align-items:center" key={p.id} data-plan-row={p.id}>
              <b style="min-width:7em">{view?.settings.plans.find((x) => x.id === p.id)?.title ?? p.id}</b>
              <input class="input" type="number" min="0" step="0.01" style="width:7em" value={p.usd} disabled={p.id === 'free'} aria-label={`${p.id} price in USD`} data-price-usd onInput={(e) => setPlan(p.id, { usd: (e.currentTarget as HTMLInputElement).value })} />
              <input class="input" type="number" min="0" step="0.01" style="width:7em" value={p.inr} disabled={p.id === 'free'} aria-label={`${p.id} price in INR`} data-price-inr onInput={(e) => setPlan(p.id, { inr: (e.currentTarget as HTMLInputElement).value })} />
              <select class="input" style="width:7em" value={p.interval} disabled={p.id === 'free'} aria-label={`${p.id} period`} data-interval onChange={(e) => setPlan(p.id, { interval: (e.currentTarget as HTMLSelectElement).value as 'month' | 'year' })}>
                <option value="month">a month</option>
                <option value="year">a year</option>
              </select>
              <input class="input" type="number" min="0" style="width:6em" value={p.videoHours} aria-label={`${p.id} video hours a month`} data-video-hours onInput={(e) => setPlan(p.id, { videoHours: (e.currentTarget as HTMLInputElement).value })} />
              <input class="input" type="number" min="0" style="width:5em" value={p.seats} aria-label={`${p.id} seats`} data-seats onInput={(e) => setPlan(p.id, { seats: (e.currentTarget as HTMLInputElement).value })} />
              <label class="switch" style="margin:0">
                <input type="checkbox" checked={p.selfService} disabled={p.id === 'free'} data-self-service onChange={(e) => setPlan(p.id, { selfService: (e.currentTarget as HTMLInputElement).checked })} />
                <span>
                  <div class="small">{p.id === 'free' ? '—' : p.selfService ? 'on the Plans page' : 'granted here only'}</div>
                </span>
              </label>
            </div>
          ))}
          <div class="small faint">A price of 0.00 = not for sale in that currency. A price in INR lets singers in India pay with UPI through Stripe (docs/stripe-setup.md). Video hours count by the calendar month while a singer is on stage with the picture on; a club's members share the club's hours.</div>
          <div class="row wrap" style="gap:12px;align-items:flex-end">
            <div class="field" style="margin:0;flex:1;min-width:16em">
              <label>A note on the Plans page</label>
              <input class="input" value={form.note} placeholder="How to reach you, what is coming…" maxLength={500} data-billing-note onInput={(e) => setForm((f) => (f ? { ...f, note: (e.currentTarget as HTMLInputElement).value } : f))} />
            </div>
            <div class="field" style="margin:0">
              <label>Expiring soon (days)</label>
              <input class="input" type="number" min="0" max="365" style="width:7em" value={form.expiringSoonDays} data-expiring onInput={(e) => setForm((f) => (f ? { ...f, expiringSoonDays: (e.currentTarget as HTMLInputElement).value } : f))} />
            </div>
            <div class="field" style="margin:0">
              <label>Grace days after expiry</label>
              <input class="input" type="number" min="0" max="90" style="width:7em" value={form.graceDays} data-grace onInput={(e) => setForm((f) => (f ? { ...f, graceDays: (e.currentTarget as HTMLInputElement).value } : f))} />
            </div>
            <button class="btn primary" disabled={saving} data-billing-save onClick={() => void save()}>
              {saving ? <Spinner /> : null} Save
            </button>
          </div>
        </div>
      )}

      {view && <AdminOffers view={view} reload={load} />}

      {view && (
        <div class="stack" style="gap:6px" data-subscribers>
          <b>Who has a plan</b>
          {!view.subscribers.length && <div class="muted small">Nobody yet — grant a plan to an account below, or let singers pay on the Plans page.</div>}
          {view.subscribers.map((r) => {
            const u = r.user;
            const sub = u.subscription;
            const e = u.entitlement;
            const working = busy === u.userId;
            return (
              <div class="row wrap" style="gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line, #ddd)" key={u.userId} data-subscriber={u.email} data-standing={r.standing} data-plan={sub?.plan ?? ''}>
                <div style="min-width:12em">
                  <b>{u.name || u.email}</b>
                  <div class="small muted">{u.email}</div>
                </div>
                <span class="chip">{view.settings.plans.find((p) => p.id === sub?.plan)?.title ?? sub?.plan}</span>
                <span class={`chip ${chipClass[r.standing]}`} data-standing-label>
                  {standingLabel(r)}
                </span>
                <span class="small muted">
                  {sub?.startedAt ? `from ${day(sub.startedAt)}` : ''}
                  {sub?.expiresAt ? ` until ${day(sub.expiresAt)}` : sub && r.standing === 'active' ? ' · no end date' : ''}
                </span>
                {sub && <span class="chip">{sub.source === 'stripe' ? 'Stripe' : 'granted'}</span>}
                <span class="small muted" data-video-used={e.videoUsedSeconds}>
                  video this month {hoursLabel(e.videoUsedSeconds)}
                  {e.videoLeftSeconds !== null ? ` of ${e.videoHours} h` : ''}
                  {e.seats > 0 ? ` · ${e.seatsUsed}/${e.seats} members` : ''}
                </span>
                <span class="small muted" data-last-payment>
                  {r.lastPayment ? `last payment ${r.lastPayment.source === 'grant' ? 'granted' : moneyLabel(r.lastPayment.amountCents, r.lastPayment.currency)} on ${day(r.lastPayment.paidAt)}` : 'no payment on record'}
                </span>
                <span class="row" style="gap:6px;margin-left:auto">
                  {(r.standing === 'expired' || r.standing === 'revoked') && (
                    <button class="btn sm primary" disabled={working} data-sub-grant-again onClick={() => void act(r, 'grant', `${sub?.plan ?? 'plan'} granted again`)}>
                      Grant again
                    </button>
                  )}
                  {(r.standing === 'active' || r.standing === 'expiring') && (
                    <button class="btn sm accent" disabled={working} data-sub-renew-row onClick={() => void act(r, 'renew', 'renewed for a period')}>
                      Renew
                    </button>
                  )}
                  {sub && r.standing !== 'revoked' && (
                    <button class="btn sm danger" disabled={working} data-sub-revoke-row onClick={() => confirm(`Revoke ${u.name || u.email}'s plan? Their picture on stage (and Publishing, for a club owner) closes at once.`) && void act(r, 'revoke', 'revoked')}>
                      Revoke
                    </button>
                  )}
                  {working && <Spinner />}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {view && payments.length > 0 && (
        <div class="stack" style="gap:4px" data-payments-admin>
          <b>Payments</b>
          {(allPayments ? payments : payments.slice(0, 12)).map((p) => (
            <PaymentLine
              key={p.id}
              p={p}
              who={who(p.userId)}
              action={
                p.source === 'stripe' && p.status !== 'refunded' && view.stripe ? (
                  <button class="btn sm" disabled={busy === p.id} data-refund onClick={() => void refund(p.id, who(p.userId), moneyLabel(p.amountCents - p.refundedCents, p.currency))}>
                    Refund
                  </button>
                ) : null
              }
            />
          ))}
          {payments.length > 12 && (
            <button class="btn sm" style="align-self:flex-start" onClick={() => setAllPayments((v) => !v)}>
              {allPayments ? 'Fewer' : `All ${payments.length}`}
            </button>
          )}
        </div>
      )}

      {view && view.orders.length > 0 && (
        <div class="stack" style="gap:4px" data-orders>
          <b>Checkouts without a payment</b>
          {view.orders.map((o) => (
            <div class="row wrap small" style="gap:8px;align-items:center" key={o.orderId} data-order={o.orderId} data-order-status={o.status}>
              <span class="muted" style="min-width:6em">{day(o.createdAt)}</span>
              <b>{who(o.userId)}</b>
              <span class="chip">{o.plan}</span>
              <span>{moneyLabel(o.amountCents, o.currency)}</span>
              {o.promoCode && <span class="chip">{o.promoCode}{o.discountCents ? ` −${moneyLabel(o.discountCents, o.currency)}` : ''}</span>}
              <span class={`chip ${o.status === 'processing' || o.status === 'pending' ? 'warn' : ''}`}>{o.status}</span>
              {o.note && <span class="faint">{o.note}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
