/**
 * Plans — Free and Publisher, and the way to pay. Checkout and the subscription itself live at
 * Stripe (hosted pages; no card ever touches the app or the service). The service tells this
 * page what the account is on, what the plan costs and whether payments are set up; an admin can
 * put an account on the plan by email from here (a comp, a tester, a payment taken elsewhere).
 */
import type { BillingStatus } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Shell.tsx';
import { Field, Spinner } from '../components/ui.tsx';
import { api, ApiError, controlConfigured, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { privileged } from '../state/session.ts';

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
  const [grantEmail, setGrantEmail] = useState('');
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
    if (back === 'success' && status?.plan === 'publisher') toast('Welcome to the Publisher plan — Publishing mode is open', 'ok', 6000);
  }, [status?.plan]);

  const checkout = async () => {
    setBusy(true);
    try {
      const { url } = await api.post('POST /billing/checkout', '/billing/checkout', {});
      window.location.assign(url);
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'billing_unconfigured' ? 'Payments are not set up yet — ask the admin to put you on the Publisher plan' : errorText(e), 'warn', 7000);
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
  const grant = async (plan: 'publisher' | 'free') => {
    const email = grantEmail.trim();
    if (!email) return;
    try {
      const { user } = await api.post('POST /admin/plan', '/admin/plan', { email, plan });
      toast(`${user.name || email} is on the ${plan === 'publisher' ? 'Publisher' : 'Free'} plan`, 'ok');
      setGrantEmail('');
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };

  if (!controlConfigured.value)
    return (
      <Page title="Plans">
        <div class="callout warn">Plans need the SingersVoice service (VITE_CONTROL_URL).</div>
      </Page>
    );
  const publisher = status?.plan === 'publisher';
  const until = status?.planUntil ? new Date(status.planUntil) : null;
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
          <section class="card stack pad-sm" data-plan={status.plan}>
            <div class="row between">
              <div>
                <div class="small muted">Your plan</div>
                <b style="font-size:1.2em">{status.plans[status.plan].title}</b>
                {status.privileged && <span class="chip ok" style="margin-left:8px">admin</span>}
              </div>
              <div class="small muted" style="text-align:right">
                {publisher && until && (
                  <div>
                    {until.getTime() > Date.now() ? 'Renews or ends' : 'Ended'} {until.toLocaleDateString()}
                  </div>
                )}
                {status.canPublish ? <div>Publishing mode is open</div> : <div>Publishing mode is closed</div>}
              </div>
            </div>
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
            <h3>Publisher</h3>
            <div class="muted">{status?.plans.publisher.blurb ?? 'Everything in Free, plus Publishing mode.'}</div>
            <ul class="small muted">
              <li>The show view: the broadcast picture of a meet</li>
              <li>Go live to YouTube and the in-house watch page</li>
              <li>Destinations, stream keys kept sealed on the service</li>
            </ul>
            <b>{status?.price ? priceLabel(status.price) : status?.checkout ? 'see checkout' : 'ask the admin'}</b>
            <div class="row" style="gap:8px">
              {!publisher && (
                <button class="btn primary" disabled={busy || !status} onClick={() => void checkout()}>
                  {busy ? <Spinner /> : null} {status?.checkout ? 'Subscribe' : 'Request the plan'}
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

        {privileged.value && (
          <section class="card stack" data-admin-grant>
            <h3>Admin: put an account on a plan</h3>
            <div class="small muted">For a comp, a tester or a payment taken outside Stripe. The account must have signed in once.</div>
            <Field label="Google account email">
              <input class="input" type="email" value={grantEmail} placeholder="singer@gmail.com" onInput={(e) => setGrantEmail((e.currentTarget as HTMLInputElement).value)} />
            </Field>
            <div class="row" style="gap:8px">
              <button class="btn primary" disabled={!grantEmail.trim()} onClick={() => void grant('publisher')}>
                Grant Publisher
              </button>
              <button class="btn" disabled={!grantEmail.trim()} onClick={() => void grant('free')}>
                Back to Free
              </button>
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}
