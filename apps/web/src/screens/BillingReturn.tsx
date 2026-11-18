/**
 * Back from Stripe's Checkout (/billing/return?session_id=…): the page asks the service what became of
 * the order — never takes the URL's word for it. Paid: the plan is open, on to it. Processing (UPI and
 * some wallets: the bank confirms a moment later): the page keeps asking, up to ten minutes. Failed,
 * cancelled or expired: said plainly, with the way back to the plans. A payment Stripe confirmed but
 * whose webhook never came is reconciled by the service on the first ask.
 */
import { moneyLabel, type OrderRecord } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Shell.tsx';
import { Spinner } from '../components/ui.tsx';
import { api, controlConfigured, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { errorText } from '../lib/toast.ts';

const POLL_MS = 2000;
const GIVE_UP_MS = 10 * 60_000;

export function BillingReturn() {
  const sessionId = new URLSearchParams(window.location.search).get('session_id') ?? '';
  const [order, setOrder] = useState<OrderRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    if (!controlConfigured.value || !sessionId) return;
    let stop = false;
    const started = Date.now();
    const ask = async () => {
      try {
        const r = await api.get('GET /billing/session/:id', `/billing/session/${encodeURIComponent(sessionId)}`);
        if (stop) return;
        setOrder(r.order);
        setError(null);
        if (r.order.status === 'paid') void refreshAccount();
        const settled = r.order.status === 'paid' || r.order.status === 'failed' || r.order.status === 'canceled' || r.order.status === 'expired';
        if (!settled && Date.now() - started < GIVE_UP_MS) {
          setWaited(Date.now() - started);
          setTimeout(() => void ask(), POLL_MS);
        } else if (!settled) setWaited(GIVE_UP_MS);
      } catch (e) {
        if (stop) return;
        setError(errorText(e));
        if (Date.now() - started < GIVE_UP_MS) setTimeout(() => void ask(), POLL_MS * 2);
      }
    };
    void ask();
    return () => {
      stop = true;
    };
  }, [sessionId]);

  const amount = order ? moneyLabel(order.amountCents, order.currency) : '';
  return (
    <Page title="Payment">
      <div class="stack" style="gap:18px" data-billing-return data-order-status={order?.status ?? 'asking'}>
        {!sessionId && <div class="callout warn">No checkout to look at — the link carries no session.</div>}
        {sessionId && !order && !error && (
          <div class="row">
            <Spinner /> Asking Stripe what became of your payment…
          </div>
        )}
        {error && !order && <div class="callout warn">{error}</div>}
        {order && order.status === 'paid' && (
          <section class="card stack" data-paid>
            <h2 style="margin:0">Thank you — your {order.plan.toUpperCase() === 'CLUB' ? 'Club owner' : order.plan === 'svvpro' ? 'SVVPro' : order.plan === 'svv' ? 'SVV' : order.plan} plan is open</h2>
            <div class="muted">
              {amount} paid. {order.plan === 'club' ? 'Name the members of your club on the My club page; Publishing mode is open to you.' : 'Your picture is on stage in live meets from now on, for the hours of your plan.'}
            </div>
            <div class="row wrap" style="gap:8px">
              <a class="btn primary" href={href('/meets')}>
                Live Meets
              </a>
              {order.plan === 'club' && (
                <a class="btn" href={href('/club')}>
                  My club
                </a>
              )}
              <a class="btn" href={href('/plans')}>
                Plans
              </a>
            </div>
          </section>
        )}
        {order && (order.status === 'pending' || order.status === 'processing') && (
          <section class="card stack" data-processing>
            <div class="row">
              <Spinner /> <b>Waiting for the bank's confirmation…</b>
            </div>
            <div class="muted">{order.status === 'processing' ? 'UPI and some payment methods confirm a moment after the payment — this page keeps asking. The plan opens the moment Stripe says the payment went through; you can leave this page and come back to Plans.' : 'The checkout is open — finish the payment on Stripe’s page; this page keeps asking.'}</div>
            {waited >= GIVE_UP_MS && <div class="callout warn">No word from the bank yet. The plan opens by itself when the payment is confirmed; check the Plans page later, or ask the SingersVoice admin.</div>}
            <a class="btn" href={href('/plans')} style="align-self:flex-start">
              Back to Plans
            </a>
          </section>
        )}
        {order && (order.status === 'failed' || order.status === 'canceled' || order.status === 'expired') && (
          <section class="card stack" data-failed>
            <h2 style="margin:0">{order.status === 'expired' ? 'The checkout expired' : order.status === 'canceled' ? 'The checkout was cancelled' : 'The payment did not go through'}</h2>
            <div class="muted">{order.note || 'Nothing was charged.'} You can try again from the Plans page — with another card or payment method if the bank said no.</div>
            <a class="btn primary" href={href('/plans')} style="align-self:flex-start">
              Back to Plans
            </a>
          </section>
        )}
      </div>
    </Page>
  );
}
