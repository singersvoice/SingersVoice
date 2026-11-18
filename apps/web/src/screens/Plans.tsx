/**
 * The Plans page (/plans; /club-owner is its old name) — self-service: where the account stands (the
 * plan in force, the video hours used and left this month, when they start again), the four plans at
 * the prices the super admin set — in the currency the singer picks when a plan is priced in more
 * than one (a price in INR takes UPI through Stripe) — and one plain button on each: Choose. Stripe's
 * own page takes the payment (nothing of the card or the UPI app touches SingersVoice); back here,
 * the return page waits for Stripe's word. Manage subscription opens Stripe's portal (the card, the
 * invoices, cancelling); the account's payments are listed. When payments are not set up, or a plan
 * is not for sale, the page says to ask the SingersVoice admin.
 */
import { hoursLabel, moneyLabel, periodLabel, roleTitle, type PlanDef, type PlansResponse, type PaymentRecord } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Shell.tsx';
import { Spinner } from '../components/ui.tsx';
import { api, ApiError, controlConfigured, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isSuperAdmin } from '../state/session.ts';

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '');

/** "$5.00 / month", "₹425.00 / month", "$250.00 / year" — a plan's price in a currency. */
export function priceLabel(p: PlanDef, currency: string): string {
  const cents = p.prices[currency];
  if (!cents) return '';
  const every = p.intervalCount > 1 ? `${p.intervalCount} ${p.interval}s` : p.interval;
  return `${moneyLabel(cents, currency)} / ${every}`;
}

/** What a plan gives, in a few lines. */
export function planLines(p: PlanDef): string[] {
  const out: string[] = [];
  out.push(p.videoHours > 0 ? `Your picture on stage in live meets — ${p.videoHours} hours a month` : 'Live meets with your voice (no picture on stage)');
  if (p.seats > 0) out.push(`A club: name up to ${p.seats} members (email addresses) who share the ${p.videoHours} hours with you`);
  if (p.publishing) out.push('Publishing mode: the show view, YouTube and the in-house watch page');
  out.push('The Studio, Track Maker, every take in your own Drive');
  return out;
}

/** A payment line: the day, the amount (or "granted"), the plan, the period it covers, the note, a refund. */
export function PaymentLine(props: { p: PaymentRecord; who?: string; action?: preact.ComponentChildren }) {
  const { p } = props;
  return (
    <div class="row wrap small" style="gap:8px;align-items:center" data-payment={p.id} data-payment-source={p.source} data-payment-status={p.status}>
      <span class="muted" style="min-width:6em">{day(p.paidAt)}</span>
      {props.who && <b>{props.who}</b>}
      <b>{p.source === 'grant' ? 'granted' : moneyLabel(p.amountCents, p.currency)}</b>
      <span class="chip">{p.plan}</span>
      <span class={`chip ${p.source === 'stripe' ? 'ok' : ''}`}>{p.source === 'stripe' ? 'Stripe' : 'admin'}</span>
      {p.status !== 'paid' && <span class="chip warn">{p.status === 'refunded' ? 'refunded' : `refunded ${moneyLabel(p.refundedCents, p.currency)}`}</span>}
      {p.periodStart || p.periodEnd ? (
        <span class="muted">
          {p.periodStart ? day(p.periodStart) : '…'} → {p.periodEnd ? day(p.periodEnd) : '…'}
        </span>
      ) : null}
      {p.feeCents !== null && p.source === 'stripe' && <span class="faint">fee {moneyLabel(p.feeCents, p.currency)}</span>}
      {p.note && <span class="faint">{p.note}</span>}
      {props.action}
    </div>
  );
}

export function Plans() {
  const [status, setStatus] = useState<PlansResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string>(() => {
    try {
      return localStorage.getItem('sv.currency') || 'usd';
    } catch {
      return 'usd';
    }
  });
  const back = new URLSearchParams(window.location.search).get('billing');

  const load = async () => {
    try {
      const r = await api.get('GET /plans', '/plans');
      setStatus(r);
      setError(null);
      if (!r.currencies.includes(currency)) setCurrency(r.currencies[0] ?? 'usd');
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    if (!controlConfigured.value) return;
    void load();
    void refreshAccount();
  }, []);
  const pickCurrency = (c: string) => {
    setCurrency(c);
    try {
      localStorage.setItem('sv.currency', c);
    } catch {
      /* ignore */
    }
  };

  const choose = async (p: PlanDef) => {
    setBusy(p.id);
    try {
      const { url } = await api.post('POST /plans/checkout', '/plans/checkout', { planId: p.id, currency });
      window.location.assign(url);
    } catch (e) {
      toast(e instanceof ApiError && (e.code === 'billing_unconfigured' || e.code === 'self_service_off') ? `Ask the SingersVoice admin for the ${p.title} plan — payments are not taken here` : errorText(e), 'warn', 7000);
      setBusy(null);
    }
  };
  const portal = async () => {
    setBusy('portal');
    try {
      const { url } = await api.post('POST /billing/portal', '/billing/portal', {});
      window.location.assign(url);
    } catch (e) {
      toast(errorText(e), 'warn');
      setBusy(null);
    }
  };

  if (!controlConfigured.value)
    return (
      <Page title="Plans">
        <div class="callout warn">The Plans page needs the SingersVoice service (VITE_CONTROL_URL).</div>
      </Page>
    );
  const ent = status?.entitlement ?? null;
  const sub = status?.subscription ?? null;
  const superAdmin = ent?.via === 'super_admin' || isSuperAdmin.value;
  const current = ent?.via === 'own' ? ent.plan : ent?.via === 'club' ? 'club' : 'free';
  return (
    <Page title="Plans">
      <div class="stack" style="gap:18px" data-plans data-current-plan={current} data-via={ent?.via ?? ''}>
        {!status && !error && (
          <div class="row">
            <Spinner /> Loading the plans…
          </div>
        )}
        {error && <div class="callout warn">{error}</div>}
        {back === 'cancel' && <div class="callout">Checkout was cancelled — nothing was charged.</div>}

        {status && ent && (
          <section class="card stack pad-sm" data-standing>
            <div class="row between wrap">
              <div>
                <div class="small muted">Your plan</div>
                <b style="font-size:1.2em" data-plan-title>
                  {ent.via === 'super_admin' ? 'Super admin — everything, always' : ent.via === 'club' ? `${ent.planTitle} · a member of ${ent.clubOwner?.name ?? 'a club'}'s club` : ent.planTitle}
                </b>
                {ent.via === 'own' && sub && (
                  <div class="small muted" data-subscription={sub.status}>
                    {sub.status === 'active' ? 'Active' : sub.status}
                    {sub.startedAt ? ` · from ${day(sub.startedAt)}` : ''}
                    {sub.expiresAt ? ` · ${sub.status === 'active' ? (sub.source === 'stripe' ? 'renews' : 'until') : 'ended'} ${day(sub.expiresAt)}` : ''}
                  </div>
                )}
              </div>
              <div class="small" style="text-align:right">
                {ent.videoLeftSeconds === null ? (
                  <div>Video in live meets: without limit</div>
                ) : ent.videoHours > 0 ? (
                  <div data-video-left={ent.videoLeftSeconds}>
                    Video this month: <b>{hoursLabel(ent.videoLeftSeconds)}</b> of {ent.videoHours} h left · starts again on {ent.resetsAt.slice(0, 10)}
                  </div>
                ) : (
                  <div data-video-left="0">Live meets with your voice — no picture on stage</div>
                )}
                <div class="muted">{ent.publishing ? 'Publishing mode is open' : 'Publishing mode comes with the Club owner plan'}</div>
                {ent.via === 'own' && ent.seats > 0 && (
                  <div class="muted">
                    Your club: {ent.seatsUsed} of {ent.seats} members —{' '}
                    <a href={href('/club')} data-club-link>
                      My club
                    </a>
                  </div>
                )}
              </div>
            </div>
            {!ent.video && ent.videoNote && ent.via !== 'super_admin' && (
              <div class="small faint" data-video-note>
                {ent.videoNote}
              </div>
            )}
            <div class="small faint">Signed in as {roleTitle(ent.via === 'super_admin' ? 'super_admin' : ent.plan === 'club' && ent.via === 'own' ? 'club_owner' : 'dual')}; video hours count while you are on stage with the picture on, by the calendar month (UTC).</div>
          </section>
        )}

        {status && status.currencies.length > 1 && (
          <div class="row wrap" style="gap:8px;align-items:center" data-currency-picker>
            <span class="small muted">Pay in</span>
            {status.currencies.map((c) => (
              <button key={c} type="button" class={`btn sm ${currency === c ? 'primary' : ''}`} data-currency={c} aria-pressed={currency === c} onClick={() => pickCurrency(c)}>
                {c.toUpperCase()}
                {c === 'inr' ? ' · UPI, cards' : ''}
              </button>
            ))}
          </div>
        )}

        {status && (
          <div class="grid-2 plans">
            {status.plans.map((p) => {
              const mine = current === p.id && ent?.via !== 'super_admin';
              const price = priceLabel(p, currency);
              const buyable = p.id !== 'free' && p.selfService && status.checkout && Boolean(p.prices[currency]);
              const otherCurrency = p.id !== 'free' && p.selfService && status.checkout && !p.prices[currency] && Object.keys(p.prices).length > 0;
              return (
                <section class={`card stack ${p.id === 'club' ? 'accent' : ''}`} key={p.id} data-plan-card={p.id} data-mine={mine ? '1' : '0'}>
                  <div class="row between">
                    <h3 style="margin:0">{p.title}</h3>
                    {mine && <span class="chip ok">your plan</span>}
                  </div>
                  <div class="muted">{p.blurb}</div>
                  <ul class="small muted">
                    {planLines(p).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                  <b data-price>{p.id === 'free' ? 'Free' : price || (otherCurrency ? `priced in ${Object.keys(p.prices).map((c) => c.toUpperCase()).join(', ')}` : 'ask the SingersVoice admin')}</b>
                  <div class="row wrap" style="gap:8px">
                    {superAdmin ? null : mine && ent?.via === 'own' && status.portal ? (
                      <button class="btn" disabled={busy !== null} data-portal onClick={() => void portal()}>
                        Manage subscription
                      </button>
                    ) : mine ? null : buyable ? (
                      <button class="btn primary" disabled={busy !== null} data-choose={p.id} onClick={() => void choose(p)}>
                        {busy === p.id ? <Spinner /> : null} Choose {p.title}
                      </button>
                    ) : p.id === 'free' ? null : (
                      <span class="small faint" data-ask-admin={p.id}>
                        {!p.selfService ? `${p.title} is granted by the SingersVoice admin — ask them.` : !status.checkout ? 'Payments are not set up here yet — ask the SingersVoice admin.' : ''}
                      </span>
                    )}
                    {p.id === 'club' && mine && (
                      <a class="btn" href={href('/club')} data-club-link>
                        My club
                      </a>
                    )}
                    {p.publishing && ent?.publishing && (
                      <a class="btn" href={href('/publishing')}>
                        Open Publishing
                      </a>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {status?.note && <div class="callout" data-admin-note>{status.note}</div>}
        {status?.checkout && <div class="small faint">Payments are handled by Stripe on its own secure page — we accept major international cards and additional payment methods where available; eligible customers in India may pay in INR with UPI. A plan renews itself each period until cancelled from Manage subscription.</div>}

        {status && status.payments.length > 0 && (
          <section class="card stack" data-payments>
            <h3>Your payments</h3>
            <div class="stack" style="gap:4px">
              {status.payments.map((p) => (
                <PaymentLine key={p.id} p={p} />
              ))}
            </div>
          </section>
        )}

        {superAdmin && (
          <section class="card stack" data-admin-link>
            <div class="small muted">The prices, the periods, the hours and the seats of every plan — and every subscriber and payment — are on the Admin page.</div>
            <a class="btn primary" href={href('/admin')} style="align-self:flex-start">
              Open the Admin page
            </a>
          </section>
        )}
      </div>
    </Page>
  );
}
