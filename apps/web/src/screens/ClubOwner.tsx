/**
 * The Club owner page (/club-owner; /plans is the old name) — self-service: where my account stands
 * (the year, its dates, how many days are left), what a club owner year costs — the price the super
 * admin set on the Admin page — and one plain button to pay for it on Stripe's own page (the card
 * never touches the app or the service); Stripe's portal for the card, the invoices and cancelling;
 * my payments. When payments are not set up, or the super admin keeps years to themselves, the page
 * says to ask the SingersVoice admin. Publishing mode opens for the account the moment the year is
 * on record (Stripe's webhook, within seconds of paying).
 */
import { moneyLabel, roleTitle, USER_ROLES, type ClubOwnerStatus, type PaymentRecord } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Shell.tsx';
import { Spinner } from '../components/ui.tsx';
import { api, ApiError, controlConfigured, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isSuperAdmin } from '../state/session.ts';

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '');

/** "$49.00 / year" from the page's price. */
export const priceLabel = (p: ClubOwnerStatus['price']): string => (p ? `${moneyLabel(p.amount, p.currency)} / ${p.interval}` : '');

/** A payment line: the day, the amount (or "granted"), the period it covers, the note. */
export function PaymentLine(props: { p: PaymentRecord; who?: string }) {
  const { p } = props;
  return (
    <div class="row wrap small" style="gap:8px;align-items:center" data-payment={p.id} data-payment-source={p.source}>
      <span class="muted" style="min-width:6em">{day(p.paidAt)}</span>
      {props.who && <b>{props.who}</b>}
      <b>{p.source === 'grant' ? 'granted' : moneyLabel(p.amountCents, p.currency)}</b>
      <span class={`chip ${p.source === 'stripe' ? 'ok' : ''}`}>{p.source === 'stripe' ? 'Stripe' : 'admin'}</span>
      {p.periodStart || p.periodEnd ? (
        <span class="muted">
          {p.periodStart ? day(p.periodStart) : '…'} → {p.periodEnd ? day(p.periodEnd) : '…'}
        </span>
      ) : null}
      {p.note && <span class="faint">{p.note}</span>}
    </div>
  );
}

export function ClubOwner() {
  const [status, setStatus] = useState<ClubOwnerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = new URLSearchParams(window.location.search).get('billing');

  const load = async () => {
    try {
      setStatus(await api.get('GET /club-owner', '/club-owner'));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    if (!controlConfigured.value) return;
    void load();
    void refreshAccount();
  }, []);
  // Back from a successful Checkout: Stripe's webhook lands within seconds — look again until the year shows.
  useEffect(() => {
    if (back !== 'success') return;
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      void load().then(() => void refreshAccount());
      if (tries >= 15) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
  }, [back]);
  useEffect(() => {
    if (back === 'success' && status?.canPublish) toast('Welcome, club owner — Publishing mode is open', 'ok', 6000);
  }, [status?.canPublish]);

  const pay = async () => {
    setBusy(true);
    try {
      const { url } = await api.post('POST /club-owner/checkout', '/club-owner/checkout', {});
      window.location.assign(url);
    } catch (e) {
      toast(e instanceof ApiError && (e.code === 'billing_unconfigured' || e.code === 'self_service_off') ? 'Ask the SingersVoice admin for a club owner year — payments are not taken here' : errorText(e), 'warn', 7000);
      setBusy(false);
    }
  };
  const portal = async () => {
    setBusy(true);
    try {
      const { url } = await api.post('POST /club-owner/portal', '/club-owner/portal', {});
      window.location.assign(url);
    } catch (e) {
      toast(errorText(e), 'warn');
      setBusy(false);
    }
  };

  if (!controlConfigured.value)
    return (
      <Page title="Club owner">
        <div class="callout warn">The Club owner page needs the SingersVoice service (VITE_CONTROL_URL).</div>
      </Page>
    );
  const sub = status?.subscription ?? null;
  const standing = sub?.status ?? 'none';
  const left = status?.daysLeft ?? null;
  const owner = status?.role === 'club_owner';
  const superAdmin = status?.role === 'super_admin' || isSuperAdmin.value;
  // What the one button does: pay for a first year; renew one that ran out; a Stripe year renews itself (the portal has the card and the cancel).
  const wantsYear = Boolean(status && !superAdmin && (standing === 'none' || standing === 'expired'));
  const renewing = standing === 'expired';
  return (
    <Page title="Club owner">
      <div class="stack" style="gap:18px" data-club-owner data-standing={standing}>
        {!status && !error && (
          <div class="row">
            <Spinner /> Loading your account…
          </div>
        )}
        {error && <div class="callout warn">{error}</div>}
        {back === 'cancel' && <div class="callout">Checkout was cancelled — nothing was charged.</div>}
        {back === 'success' && status && !status.canPublish && (
          <div class="callout">
            <Spinner /> Thank you — waiting for Stripe to confirm the payment (a few seconds)…
          </div>
        )}

        {status && (
          <section class="card stack pad-sm" data-account>
            <div class="row between wrap">
              <div>
                <div class="small muted">Your account</div>
                <b style="font-size:1.2em">{roleTitle(status.role)}</b>
                {superAdmin && <span class="chip ok" style="margin-left:8px">everything, always</span>}
              </div>
              <div class="small" style="text-align:right">
                {sub && !superAdmin && (
                  <div data-subscription={standing}>
                    <span class={`chip ${standing === 'active' ? 'ok' : 'warn'}`}>year {standing}</span>
                    {sub.startedAt ? ` · from ${day(sub.startedAt)}` : ''}
                    {sub.expiresAt ? ` · ${standing === 'active' ? 'until' : 'ended'} ${day(sub.expiresAt)}` : ''}
                    {standing === 'active' && left !== null ? ` · ${left > 0 ? `${left} days left` : 'in the grace days'}` : ''}
                  </div>
                )}
                <div class="muted">{status.canPublish ? 'Publishing mode is open' : owner ? status.publishingNote || 'Publishing mode is closed' : 'Publishing mode is closed — a club owner year opens it'}</div>
              </div>
            </div>
            <div class="small faint">{USER_ROLES.find((r) => r.role === status.role)?.blurb}</div>
          </section>
        )}

        <section class="card stack accent" data-offer>
          <h3>A club owner year</h3>
          <div class="muted">Everything a singer has, plus Publishing mode for a year: the show view, going live to YouTube and the in-house watch page, destinations.</div>
          <ul class="small muted">
            <li>The show view: the broadcast picture of a meet, exactly what the singers see</li>
            <li>Go live to YouTube and the in-house watch page; stream keys kept sealed on the service</li>
            <li>Every show recorded in chapters, in your own Drive</li>
          </ul>
          {status?.note && <div class="callout" data-admin-note>{status.note}</div>}
          {status && <b data-price>{status.price ? priceLabel(status.price) : status.checkout ? 'see checkout' : 'price on request'}</b>}
          {status && (
            <div class="row wrap" style="gap:8px">
              {superAdmin ? (
                <a class="btn" href={href('/admin')} data-admin-link>
                  Club owners and prices — the Admin page
                </a>
              ) : wantsYear && status.checkout ? (
                <button class="btn primary" disabled={busy} data-pay onClick={() => void pay()}>
                  {busy ? <Spinner /> : null} {renewing ? 'Renew for a year' : 'Pay for a year'}
                </button>
              ) : null}
              {status.portal && !superAdmin && (
                <button class="btn" disabled={busy} data-portal onClick={() => void portal()}>
                  Manage subscription
                </button>
              )}
              {status.canPublish && (
                <a class="btn" href={href('/publishing')} data-open-publishing>
                  Open Publishing
                </a>
              )}
            </div>
          )}
          {status && !superAdmin && wantsYear && !status.checkout && (
            <div class="callout" data-ask-admin>
              {status.selfService ? 'Payments are not set up here yet — ask the SingersVoice admin for a club owner year.' : 'Club owner years are granted by the SingersVoice admin — ask them for one.'}
            </div>
          )}
          {status && owner && standing === 'active' && sub?.source === 'grant' && <div class="small faint" data-granted>Your year was granted by the SingersVoice admin{sub.expiresAt ? ` and runs until ${day(sub.expiresAt)}` : ''}.</div>}
          {status && standing === 'revoked' && <div class="callout warn">Your club owner year was revoked by the SingersVoice admin — ask them before paying for another.</div>}
          {status?.checkout && <div class="small faint">Payments are handled by Stripe on its own secure page; the card never touches SingersVoice. A paid year renews itself until cancelled from Manage subscription.</div>}
        </section>

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
      </div>
    </Page>
  );
}
