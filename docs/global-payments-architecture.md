# Global payments — architecture

SingersVoice sells four plans (docs/BILLING.md has what each gives) to singers anywhere Stripe can
take their money, from a **United States** Stripe account: cards and wallets everywhere they are
eligible, and **UPI** (PhonePe, Google Pay India, Paytm and the other UPI apps) for singers in India
paying in **INR**. Stripe is the only processor; its hosted Checkout page takes every payment; its
signed webhook is the only word that opens a plan.

**What is promised, and what is not.** We accept major international cards and additional payment
methods where available; eligible customers in India may pay in INR with UPI. Nothing in the app or
these docs claims every country, every card or every UPI app: availability is Stripe's, and depends
on the account's enabled methods, the session's currency, the customer's bank, sanctions and
Stripe's own rules. Nothing routes around a refusal, and no second processor is wired in (a
feature-flagged extension point is described at the end).

## The flow

```text
Singer (any country)                       sv-control (Hono; Node or Cloudflare)              Stripe
──────────────────────                     ──────────────────────────────────────            ──────
Plans page: picks a plan and a
currency it is priced in (USD, INR, …)
   │ POST /plans/checkout {planId,currency}
   ▼
                                           the price is the ADMIN's for that currency
                                           (never the browser's); an ORDER row (pending)
                                           ──► POST /checkout/sessions ─────────────────►  Checkout Session
                                               mode=subscription, price_data inline              (subscription,
                                               (currency, unit_amount, recurring),               dynamic payment
                                               metadata: userId, planId, orderId,                methods: cards,
                                               Idempotency-Key: checkout-<orderId>               wallets, UPI for INR)
   ◄── {url, orderId} ──────────────────── the order remembers the session id
   │ the browser goes to Stripe's page
   ▼
Stripe's Checkout page ──── card / wallet / UPI app (mobile: app hand-off; desktop: QR) ────────►  Stripe
   │ back to /billing/return?session_id=cs_…
   ▼
Return page: GET /billing/session/:id      the ORDER's status — the webhook's word; while it is
every 2 s, up to 10 minutes                pending/processing the service also asks Stripe for the
                                           session itself (a webhook that never came is reconciled)
                                           ◄── POST /billing/webhook (signed) ─────────────  events:
                                               Stripe-Signature verified (HMAC-SHA256, 5 min)      checkout.session.completed
                                               event id kept (billing_events): once each          checkout.session.async_payment_succeeded/_failed
                                               paid → SUBSCRIPTION row (plan, period end from     checkout.session.expired
                                               Stripe's subscription, customer, subscription id)  invoice.paid / invoice.payment_failed
                                               + role (club owner) + PAYMENT row (amount, fee)    customer.subscription.created/updated/deleted
                                               + ORDER paid                                       charge.refunded
                                               unpaid (UPI) → ORDER processing, nothing opened
```

Every request afterwards computes the account's **entitlement** from its subscription row
(`entitlementOf`, `packages/protocol/src/plans.ts`): the plan in force, a picture in live meets and
the hours left this month, Publishing mode. Nothing of it is trusted from a device.

## Design principles (and where each lives)

| Principle | Where |
| --- | --- |
| Hosted Checkout, no card data anywhere near us (PCI SAQ-A) | `services/control/src/billing.ts` `createCheckoutSession` |
| Dynamic payment methods: Stripe picks from the Dashboard's enabled methods by currency and country; the service never names a method | no `payment_method_types` on the session (a test asserts it) |
| UPI is a rail inside Stripe, in INR only | a plan is priced per currency; a session in INR shows UPI when the account has it; USD sessions never promise it (`docs/stripe-setup.md`) |
| The customer chooses the currency; no IP geolocation | the Plans page's "Pay in" buttons, remembered on the device |
| Server-trusted prices | the client sends only `planId` and `currency`; the amount comes from the admin's settings (`PUT /admin/billing/settings`) |
| One order per Checkout, pending first | `orders` table; `metadata[orderId]` on the session; `Idempotency-Key: checkout-<orderId>` |
| The webhook is the source of truth; the return URL is informational | `/billing/return` polls `GET /billing/session/:id`; the plan opens only in the webhook (or the reconciliation of a session Stripe itself says is paid) |
| Asynchronous methods stay `processing` until authoritative | `payment_status: unpaid` on `checkout.session.completed` → order processing; `async_payment_succeeded` → paid; `async_payment_failed` → failed |
| Replay-safe, idempotent | `billing_events(event_id)`; payments keyed by Stripe's id (`pay-stripe-<session or invoice>`, INSERT OR IGNORE); subscription rows upserted |
| Out-of-order delivery | every handler reads the current subscription row and writes what the event says about the period; a `deleted` after an `updated` closes, an `updated` after a `completed` only corrects the period end |
| Renewals and dunning | `invoice.paid` (not the first invoice) extends the period and records the payment; `invoice.payment_failed` is logged, the plan runs to its period's end while Stripe retries; `customer.subscription.deleted` closes |
| Refunds with an audit trail | `POST /admin/payments/:id/refund` (super admin) → Stripe `/refunds` with `Idempotency-Key`; the payment row carries `refunded_cents`/`status`; `charge.refunded` keeps it right when the refund is made in the Dashboard |
| Fees for reconciliation | the charge's balance transaction (`fee`, `net`) is read after the fact, best effort, onto the payment row — never estimated |
| Minor units, no floats | every amount is an integer in the currency's minor unit (`amount_cents`); the Admin page converts on input |
| Secrets | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL` as Worker secrets / environment; never in the repo; the key never reaches a browser |
| Logs | hosts and ids only (order, session, event ids); no card, bank or UPI identifiers exist in the system |

## Data

```text
subscriptions   user_id (PK), plan, started_at, plan_until, status (active|revoked), customer_id,
                subscription_id, source (stripe|grant), updated_at
orders          order_id (PK), user_id, plan, currency, amount_cents, session_id, payment_intent_id,
                status (pending|processing|paid|failed|canceled|expired), note, created_at, updated_at
payments        id (PK: pay-stripe-<session|invoice> | pay-grant-…), user_id, plan, amount_cents,
                currency, paid_at, source, ref, period_start, period_end, note, payment_intent_id,
                charge_id, fee_cents, net_cents, refunded_cents, status (paid|partly_refunded|refunded)
billing_events  event_id (PK), received_at
settings        key='billing' → BillingSettings (the plans with prices per currency, note, margins)
club_members    owner_user_id, email, added_at
video_usage     pool_user_id, period (YYYY-MM, UTC), seconds
```

## Entitlements and metering

- **Free**: live meets with the voice; the Studio (solo takes, with the camera) is everyone's.
- **SVV / SVVPro**: a picture on stage in live meets for 10 / 100 hours a calendar month (UTC).
- **Club owner**: 300 hours a month shared by the owner and up to 15 members named by email, and
  Publishing mode. A member's own paid plan takes precedence over the club's.
- The service counts seconds on every heartbeat (1.5–5 s) while a singer is on stage with the picture
  on, into the pool in force (the account's own, or the club owner's), at most two minutes per gap. At
  the limit the next heartbeat takes the picture away (`you.media: audio`, every device draws the name
  card) with the reason; the first of the month starts the count again. A super admin has no limit.

## Operations

- **Reconciliation**: the return page's polling reconciles a paid session whose webhook never came;
  an admin can also open `GET /billing/session/:id` logic by having the singer revisit the return
  link. Orders that never paid are listed on the Admin page ("Checkouts without a payment").
- **Rollback**: remove the Stripe secrets from the service and the Plans page falls back to "ask the
  admin" — nothing is charged; plans already granted stand. Test mode keys (`sk_test_…`) never create
  live charges.
- **Monitoring**: the Admin page (subscribers by standing, payments with fees, open orders); Stripe's
  Dashboard (Radar, disputes, payouts); the service log notes a failed renewal.

## Not done here, by design

- A second processor for markets Stripe cannot serve: the code has one `BillingConfig` and one
  Checkout path; a second provider would be a second `createCheckoutSession` behind a feature flag in
  `AppDeps.billing`, with its own webhook route — never used to route around a refusal or a
  restriction.
- Tax: Stripe Tax can be switched on in the Dashboard (Checkout collects what the account is
  configured for); nothing here computes tax from an IP address.
- UPI AutoPay (recurring mandates in India) has its own limits and eligibility — see
  docs/stripe-setup.md; the plans are monthly subscriptions, and whether Checkout offers UPI for a
  subscription in INR is Stripe's and the account's call, not the app's.
