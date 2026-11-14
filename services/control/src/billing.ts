/**
 * Billing — the Publisher plan, paid through Stripe.
 *
 * Stripe does the money: its hosted Checkout page takes the card (we never see it), its Customer
 * Portal lets a subscriber change or cancel, and a signed webhook tells us when a subscription
 * starts, renews, lapses or ends. We keep one row per user: the plan and until when. Nothing here
 * needs the Stripe SDK — three REST calls and one HMAC — so it runs unchanged on Node and on the
 * Cloudflare Worker.
 *
 * Secrets (never in the repo): STRIPE_SECRET_KEY (sk_live_… / sk_test_…), STRIPE_WEBHOOK_SECRET
 * (whsec_…), STRIPE_PRICE_PUBLISHER (price_…), APP_URL (where Checkout sends people back).
 */
import type { PlanId } from '@singersvoice/protocol';

export interface BillingConfig {
  secretKey?: string;
  webhookSecret?: string;
  pricePublisher?: string;
  /** The app's URL, for Checkout's success / cancel pages (default: the GitHub Pages site). */
  appUrl: string;
  fetchImpl?: typeof fetch;
}

export const STRIPE_API = 'https://api.stripe.com/v1';

/** The plans a user can be on; `publisher` unlocks Publishing mode (the show view, destinations, going live). */
export const PLANS: Record<PlanId, { title: string; blurb: string }> = {
  free: { title: 'Free', blurb: 'Sing in the Studio, host and join live meets, keep every take in your own Drive.' },
  publisher: { title: 'Publisher', blurb: 'Everything in Free, plus Publishing mode: the show view, YouTube and in-house live streams, destinations and the watch page.' },
};

/** Checkout and the portal exist only when a key and a price are configured. */
export const checkoutConfigured = (b: BillingConfig): boolean => Boolean(b.secretKey && b.pricePublisher);

function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

async function stripe<T>(b: BillingConfig, path: string, init: { method?: 'GET' | 'POST'; body?: Record<string, string> } = {}): Promise<T> {
  if (!b.secretKey) throw new Error('Stripe is not configured');
  const fetchImpl = b.fetchImpl ?? fetch;
  const r = await fetchImpl(`${STRIPE_API}${path}`, {
    method: init.method ?? 'POST',
    headers: { Authorization: `Bearer ${b.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: init.body ? form(init.body) : undefined,
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new Error(json.error?.message ?? `Stripe answered ${r.status}`);
  return json;
}

/** A Checkout Session for the Publisher subscription; Stripe hosts the page and sends the user back to the app. */
export async function createCheckoutSession(b: BillingConfig, who: { userId: string; email: string; customerId?: string | null }): Promise<{ url: string }> {
  if (!checkoutConfigured(b)) throw new Error('Checkout is not configured on the service');
  const back = b.appUrl.replace(/\/$/, '');
  const body: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': b.pricePublisher!,
    'line_items[0][quantity]': '1',
    success_url: `${back}/plans?billing=success`,
    cancel_url: `${back}/plans?billing=cancel`,
    client_reference_id: who.userId,
    'metadata[userId]': who.userId,
    'subscription_data[metadata][userId]': who.userId,
    allow_promotion_codes: 'true',
  };
  if (who.customerId) body.customer = who.customerId;
  else body.customer_email = who.email;
  const s = await stripe<{ url?: string }>(b, '/checkout/sessions', { body });
  if (!s.url) throw new Error('Stripe gave no checkout page');
  return { url: s.url };
}

/** The Customer Portal (change card, cancel, invoices) for an existing Stripe customer. */
export async function createPortalSession(b: BillingConfig, customerId: string): Promise<{ url: string }> {
  const back = b.appUrl.replace(/\/$/, '');
  const s = await stripe<{ url?: string }>(b, '/billing_portal/sessions', { body: { customer: customerId, return_url: `${back}/plans` } });
  if (!s.url) throw new Error('Stripe gave no portal page');
  return { url: s.url };
}

export interface PriceInfo {
  amount: number;
  currency: string;
  interval: 'day' | 'week' | 'month' | 'year';
}

let priceCache: { at: number; price: PriceInfo | null } | null = null;

/** What the Publisher plan costs, from the Stripe Price itself (cached an hour), so the app never hard-codes a number. */
export async function fetchPublisherPrice(b: BillingConfig): Promise<PriceInfo | null> {
  if (!checkoutConfigured(b)) return null;
  if (priceCache && Date.now() - priceCache.at < 3600_000) return priceCache.price;
  try {
    const p = await stripe<{ unit_amount?: number | null; currency?: string; recurring?: { interval?: PriceInfo['interval'] } }>(b, `/prices/${encodeURIComponent(b.pricePublisher!)}`, { method: 'GET' });
    const price = typeof p.unit_amount === 'number' && p.currency ? { amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval ?? 'month' } : null;
    priceCache = { at: Date.now(), price };
    return price;
  } catch {
    return priceCache?.price ?? null;
  }
}

/** Tests: forget the cached price. */
export function resetPriceCache(): void {
  priceCache = null;
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

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: { userId?: string };
}

/**
 * The plan a Stripe subscription grants: active and trialing subscriptions are Publisher until the
 * end of the period they paid for (a cancelled one stays active until then — Stripe keeps the
 * status `active` with `cancel_at_period_end`); anything else is Free.
 */
export function planFromSubscription(sub: Pick<StripeSubscription, 'status' | 'current_period_end'>): { plan: PlanId; until: string | null } {
  const paid = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
  if (!paid) return { plan: 'free', until: null };
  return { plan: 'publisher', until: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null };
}

/** Is a plan in force right now? */
export function planActive(plan: PlanId, until: string | null, now = Date.now()): boolean {
  if (plan === 'free') return false;
  return until === null || Date.parse(until) + 24 * 3600_000 > now; // a day of grace for a renewal that is on its way
}
