/**
 * Plans — Free and Publisher, and the way to pay. Checkout and the subscription itself live at
 * Stripe (hosted pages; no card ever touches the app or the service). The service tells this
 * page what the account is on, what the plan costs and whether payments are set up; an admin can
 * put an account on the plan by email from here (a comp, a tester, a payment taken elsewhere).
 */
import { roleTitle, subscriptionStatus, USER_ROLES, type BillingStatus } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Shell.tsx';
import { Spinner } from '../components/ui.tsx';
import { api, ApiError, controlConfigured, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isSuperAdmin, publishingNote, role, subscription } from '../state/session.ts';

/** 1499 + 'usd' + 'month' → "$14.99 / month". */
export function priceLabel(p: BillingStatus['price']): string {
  if (!p) return '';
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency.toUpperCase() }).format(p.amount / 100);
  return `${money} / ${p.interval}`;
}

export function Plans() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = new URLSearchParams(window.location.search).get('billing');

  const load = async () => {
    try {
      setStatus(await api.get('GET /billing', '/billing'));
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
  // Back from a successful Checkout: Stripe's webhook lands within seconds — look again until the plan shows.
  useEffect(() => {
    if (back !== 'success') return;
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      void load().then(() => void refreshAccount());
      if (tries >= 10) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
  }, [back]);
  useEffect(() => {
    if (back === 'success' && status?.canPublish) toast('Welcome, club owner — Publishing mode is open', 'ok', 6000);
  }, [status?.plan]);

  const checkout = async () => {
    setBusy(true);
    try {
      const { url } = await api.post('POST /billing/checkout', '/billing/checkout', {});
      window.location.assign(url);
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'billing_unconfigured' ? 'Payments are not set up yet — ask the SingersVoice admin for a club owner year' : errorText(e), 'warn', 7000);
      setBusy(false);
    }
  };
  const portal = async () => {
    setBusy(true);
    try {
      const { url } = await api.post('POST /billing/portal', '/billing/portal', {});
      window.location.assign(url);
    } catch (e) {
      toast(errorText(e), 'warn');
      setBusy(false);
    }
  };
  if (!controlConfigured.value)
    return (
      <Page title="Plans">
        <div class="callout warn">Plans need the SingersVoice service (VITE_CONTROL_URL).</div>
      </Page>
    );
  const sub = subscription.value;
  const standing = subscriptionStatus(sub);
  const until = sub?.expiresAt ? new Date(sub.expiresAt) : status?.planUntil ? new Date(status.planUntil) : null;
  return (
    <Page title="Plans">
      <div class="stack" style="gap:18px">
        {!status && !error && (
          <div class="row">
            <Spinner /> Loading your plan…
          </div>
        )}
        {error && <div class="callout warn">{error}</div>}
        {back === 'cancel' && <div class="callout">Checkout was cancelled — nothing was charged.</div>}
        {status && (
          <section class="card stack pad-sm" data-plan={status.plan} data-role={role.value}>
            <div class="row between">
              <div>
                <div class="small muted">Your account</div>
                <b style="font-size:1.2em">{roleTitle(role.value)}</b>
                {role.value === 'super_admin' && <span class="chip ok" style="margin-left:8px">everything, always</span>}
              </div>
              <div class="small muted" style="text-align:right">
                {role.value === 'club_owner' && sub && (
                  <div data-subscription={standing}>
                    Subscription {standing}
                    {sub.startedAt ? ` · from ${new Date(sub.startedAt).toLocaleDateString()}` : ''}
                    {until ? ` · ${standing === 'active' ? 'until' : 'ended'} ${until.toLocaleDateString()}` : ''}
                  </div>
                )}
                {status.canPublish ? <div>Publishing mode is open</div> : <div>{publishingNote.value || 'Publishing mode is closed'}</div>}
              </div>
            </div>
            <div class="small faint">{USER_ROLES.find((r) => r.role === role.value)?.blurb}</div>
          </section>
        )}

        <div class="grid-2 plans">
          <section class="card stack" data-plan-card="free">
            <h3>Free</h3>
            <div class="muted">{status?.plans.free.blurb ?? 'Sing in the Studio, host and join live meets, keep every take in your own Drive.'}</div>
            <ul class="small muted">
              <li>Studio: sing, record, Track Maker, Voice FX</li>
              <li>Live meets: host or join, up to 10 on stage, audience</li>
              <li>Everything saved in your own Google Drive</li>
            </ul>
            <b>$0</b>
          </section>
          <section class="card stack accent" data-plan-card="publisher">
            <h3>Club owner (yearly)</h3>
            <div class="muted">{status?.plans.publisher.blurb ?? 'Everything in Free, plus Publishing mode for a year.'}</div>
            <ul class="small muted">
              <li>The show view: the broadcast picture of a meet</li>
              <li>Go live to YouTube and the in-house watch page</li>
              <li>Destinations, stream keys kept sealed on the service</li>
            </ul>
            <b>{status?.price ? priceLabel(status.price) : status?.checkout ? 'see checkout' : 'ask the SingersVoice admin'}</b>
            <div class="row" style="gap:8px">
              {!status?.canPublish && (
                <button class="btn primary" disabled={busy || !status} onClick={() => void checkout()}>
                  {busy ? <Spinner /> : null} {status?.checkout ? 'Subscribe for a year' : 'Ask for a club owner year'}
                </button>
              )}
              {status?.portal && (
                <button class="btn" disabled={busy} onClick={() => void portal()}>
                  Manage subscription
                </button>
              )}
              {status?.canPublish && (
                <a class="btn" href={href('/publishing')}>
                  Open Publishing
                </a>
              )}
            </div>
            <div class="small faint">Payments are handled by Stripe on its own secure page; the card never touches SingersVoice. Cancel any time from Manage subscription.</div>
          </section>
        </div>

        {isSuperAdmin.value && (
          <section class="card stack" data-admin-link>
            <h3>Admin</h3>
            <div class="small muted">Every account's role (audio only, dual, club owner, super admin) and the club owners' yearly subscriptions — granted, renewed, set and revoked — are on the Admin page.</div>
            <a class="btn primary" href={href('/admin')} style="align-self:flex-start">
              Open the Admin page
            </a>
          </section>
        )}
      </div>
    </Page>
  );
}
