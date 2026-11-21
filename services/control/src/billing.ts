/**
 * Billing — the plans, paid through Stripe.
 *
 * Stripe does the money: its hosted Checkout page takes the payment (the card, the UPI app, the
 * wallet — nothing of it touches the app or the service), its Customer Portal lets a subscriber change
 * the card or cancel, and a signed webhook tells us what became of every payment. We keep one
 * subscription row per account (the plan and until when), an order per Checkout started, and a
 * payment per Stripe charge. Nothing here needs the Stripe SDK — a handful of REST calls and one HMAC
 * — so it runs unchanged on Node and on the Cloudflare Worker.
 *
 * Prices are the admin's (plans.ts, per currency): every Checkout carries its price inline
 * (`price_data`), so no Stripe product or price object has to exist. Which payment methods Checkout
 * shows is Stripe's call from what the Dashboard enables and the session's currency and country —
 * cards and wallets everywhere they are eligible, UPI for a session in INR when the account has it
 * (docs/stripe-setup.md); the service never names a method.
 *
 * Secrets (never in the repo): STRIPE_SECRET_KEY (sk_live_… / sk_test_…), STRIPE_WEBHOOK_SECRET
 * (whsec_…), APP_URL (where Checkout sends people back).
 */
import type { PlanId, PlanInterval } from '@singersvoice/protocol';

export interface BillingConfig {
  secretKey?: string;
  webhookSecret?: string;
  /** The app's URL, for Checkout's success / cancel pages (default: the GitHub Pages site). */
  appUrl: string;
  fetchImpl?: typeof fetch;
}

export const STRIPE_API = 'https://api.stripe.com/v1';

/** Stripe is configured: Checkout, the portal, refunds and reconciliation can be asked of it. */
export const stripeConfigured = (b: BillingConfig): boolean => Boolean(b.secretKey);

function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

async function stripe<T>(b: BillingConfig, path: string, init: { method?: 'GET' | 'POST'; body?: Record<string, string>; idempotencyKey?: string } = {}): Promise<T> {
  if (!b.secretKey) throw new Error('Stripe is not configured');
  const fetchImpl = b.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${b.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  const r = await fetchImpl(`${STRIPE_API}${path}`, { method: init.method ?? 'POST', headers, body: init.body ? form(init.body) : undefined });
  const json = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new Error(json.error?.message ?? `Stripe answered ${r.status}`);
  return json;
}

export interface CheckoutLine {
  plan: PlanId;
  planTitle: string;
  currency: string;
  /** The price of one period, in the currency's minor unit. */
  amountCents: number;
  interval: PlanInterval;
  intervalCount: number;
  /** Our order's id: on the session's metadata, and the idempotency key (a retried request opens no second session). */
  orderId: string;
  /** The offer chosen (offers.ts), for the session's metadata. */
  offerId?: string | null;
  /** A Stripe coupon (made by `ensureCoupon` for a promo code) applied to the subscription, and the code itself for the metadata. */
  couponId?: string | null;
  promoCode?: string;
}

/**
 * A Checkout Session for a plan: a subscription of the admin's price (inline `price_data`), the singer's id and our
 * order on the session, Stripe's own page, and the way back to the app with the session id on the URL (the return
 * page asks the service what became of it — the webhook's word, never the URL's). Which payment methods the page
 * shows is Stripe's call (dynamic payment methods: the Dashboard's enabled methods that fit the currency).
 */
export async function createCheckoutSession(b: BillingConfig, who: { userId: string; email: string; customerId?: string | null }, line: CheckoutLine): Promise<{ url: string; sessionId: string }> {
  if (!stripeConfigured(b)) throw new Error('Checkout is not configured on the service');
  const back = b.appUrl.replace(/\/$/, '');
  const body: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price_data][currency]': line.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(Math.round(line.amountCents)),
    'line_items[0][price_data][recurring][interval]': line.interval,
    'line_items[0][price_data][recurring][interval_count]': String(Math.max(1, Math.round(line.intervalCount))),
    'line_items[0][price_data][product_data][name]': `SingersVoice ${line.planTitle}`,
    'line_items[0][quantity]': '1',
    success_url: `${back}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${back}/plans?billing=cancel`,
    client_reference_id: who.userId,
    'metadata[userId]': who.userId,
    'metadata[planId]': line.plan,
    'metadata[orderId]': line.orderId,
    'subscription_data[metadata][userId]': who.userId,
    'subscription_data[metadata][planId]': line.plan,
  };
  if (line.offerId) body['metadata[offerId]'] = line.offerId;
  if (line.promoCode) body['metadata[promo]'] = line.promoCode;
  // A coupon of ours on the session, or Stripe's own promotion-code field (Stripe allows one or the other, not both).
  if (line.couponId) body['discounts[0][coupon]'] = line.couponId;
  else body.allow_promotion_codes = 'true';
  if (who.customerId) body.customer = who.customerId;
  else body.customer_email = who.email;
  const s = await stripe<{ id?: string; url?: string }>(b, '/checkout/sessions', { body, idempotencyKey: `checkout-${line.orderId}` });
  if (!s.url || !s.id) throw new Error('Stripe gave no checkout page');
  return { url: s.url, sessionId: s.id };
}

/**
 * A Stripe coupon for a promo code (offers.ts): a percentage off, or an amount off in one currency, on the first
 * payment or on every one. Made once per code and kept by its id; the code itself is the idempotency key, so a
 * retried request makes no second coupon.
 */
export async function createCoupon(b: BillingConfig, promo: { code: string; kind: 'percent' | 'amount'; value: number; currency: string | null; duration: 'once' | 'forever' }): Promise<{ id: string }> {
  const body: Record<string, string> = { name: `SingersVoice ${promo.code}`, duration: promo.duration, 'metadata[code]': promo.code };
  if (promo.kind === 'percent') body.percent_off = String(Math.min(100, Math.max(1, promo.value)));
  else {
    body.amount_off = String(Math.max(1, Math.round(promo.value)));
    body.currency = (promo.currency ?? 'usd').toLowerCase();
  }
  const c = await stripe<{ id?: string }>(b, '/coupons', { body, idempotencyKey: `coupon-${promo.code}-${promo.kind}-${promo.value}-${promo.currency ?? ''}-${promo.duration}` });
  if (!c.id) throw new Error('Stripe gave no coupon');
  return { id: c.id };
}

/** The Customer Portal (change card, cancel, invoices) for an existing Stripe customer. */
export async function createPortalSession(b: BillingConfig, customerId: string, backTo = '/plans'): Promise<{ url: string }> {
  const back = b.appUrl.replace(/\/$/, '');
  const s = await stripe<{ url?: string }>(b, '/billing_portal/sessions', { body: { customer: customerId, return_url: `${back}${backTo}` } });
  if (!s.url) throw new Error('Stripe gave no portal page');
  return { url: s.url };
}

/** A Checkout Session as Stripe has it now (reconciliation: a webhook that never came, or not yet). */
export interface StripeCheckoutSession {
  id: string;
  status?: 'open' | 'complete' | 'expired';
  payment_status?: 'paid' | 'unpaid' | 'no_payment_required';
  customer?: string | null;
  subscription?: string | null;
  payment_intent?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
}

export async function retrieveCheckoutSession(b: BillingConfig, sessionId: string): Promise<StripeCheckoutSession> {
  return stripe<StripeCheckoutSession>(b, `/checkout/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_start?: number;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: { userId?: string; planId?: string };
}

export async function retrieveSubscription(b: BillingConfig, subscriptionId: string): Promise<StripeSubscription> {
  return stripe<StripeSubscription>(b, `/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'GET' });
}

/** What Stripe kept of a payment and the ids behind it, from the charge's balance transaction (best effort: null when unknown). */
export interface ChargeFacts {
  paymentIntentId: string | null;
  chargeId: string | null;
  feeCents: number | null;
  netCents: number | null;
}

export async function chargeFacts(b: BillingConfig, ids: { paymentIntent?: string | null; charge?: string | null }): Promise<ChargeFacts | null> {
  try {
    if (ids.charge) {
      const ch = await stripe<{ id: string; payment_intent?: string | null; balance_transaction?: { fee?: number; net?: number } | string | null }>(b, `/charges/${encodeURIComponent(ids.charge)}?expand[]=balance_transaction`, { method: 'GET' });
      const bt = typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;
      return { paymentIntentId: ch.payment_intent ?? ids.paymentIntent ?? null, chargeId: ch.id, feeCents: typeof bt?.fee === 'number' ? bt.fee : null, netCents: typeof bt?.net === 'number' ? bt.net : null };
    }
    if (ids.paymentIntent) {
      const pi = await stripe<{ id: string; latest_charge?: { id?: string; balance_transaction?: { fee?: number; net?: number } | string | null } | string | null }>(b, `/payment_intents/${encodeURIComponent(ids.paymentIntent)}?expand[]=latest_charge.balance_transaction`, { method: 'GET' });
      const ch = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
      const bt = ch && typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;
      return { paymentIntentId: pi.id, chargeId: ch?.id ?? (typeof pi.latest_charge === 'string' ? pi.latest_charge : null), feeCents: typeof bt?.fee === 'number' ? bt.fee : null, netCents: typeof bt?.net === 'number' ? bt.net : null };
    }
  } catch {
    /* the payment stands without its fee */
  }
  return null;
}

/** A refund through Stripe (the whole payment, or `amountCents` of it), once per key. */
export async function createRefund(b: BillingConfig, ids: { paymentIntent?: string | null; charge?: string | null }, amountCents: number | undefined, idempotencyKey: string): Promise<{ id: string; amount: number; status: string }> {
  const body: Record<string, string> = {};
  if (ids.paymentIntent) body.payment_intent = ids.paymentIntent;
  else if (ids.charge) body.charge = ids.charge;
  else throw new Error('Nothing of Stripe to refund: the payment carries no payment intent or charge id');
  if (amountCents !== undefined) body.amount = String(Math.round(amountCents));
  const r = await stripe<{ id?: string; amount?: number; status?: string }>(b, '/refunds', { body, idempotencyKey });
  if (!r.id) throw new Error('Stripe gave no refund');
  return { id: r.id, amount: r.amount ?? amountCents ?? 0, status: r.status ?? 'pending' };
}

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Stripe's signature header: `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`, the HMAC-SHA256 of `${t}.${body}` with the endpoint secret. */
export async function signStripePayload(secret: string, body: string, t: number): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

/** True when the header signs this exact body with our secret, within `toleranceS` of now (replays are refused). */
export async function verifyStripeSignature(secret: string, body: string, header: string | null, nowS = Math.floor(Date.now() / 1000), toleranceS = 300): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith('t='))?.slice(2));
  const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowS - t) > toleranceS) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return sigs.some((s) => equalHex(s, expected));
}

/**
 * What a Stripe subscription's status means for the plan: active and trialing subscriptions (and one past due, while
 * Stripe retries the card) keep the plan until the end of the period paid for — a cancelled one stays active until
 * then (Stripe keeps the status `active` with `cancel_at_period_end`); anything else closes it.
 */
export function subscriptionKeepsPlan(sub: Pick<StripeSubscription, 'status'>): boolean {
  return sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
}

export const unixIso = (s: number | undefined | null): string | null => (typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);
