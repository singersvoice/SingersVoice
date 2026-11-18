# Billing — the club owner year

Publishing mode (the show view, destinations, going live to YouTube and the in-house watch page) is
for **club owners** with an active **yearly subscription** (and for super admins, always). Singing,
hosting and joining meets stay free. A **super admin** (the first account ever seen, plus
`PRIVILEGED_EMAILS`) runs the **Admin page** (`/admin`): every account's role (audio only, dual,
club owner, super admin) and the club owners' years — *Grant a year*, *Renew (+1 year)*, *Set
dates*, *Revoke* — kept in the SVT DB with a start date, an expiry date and a status; a year that
runs out closes Publishing by itself, with the date on the gate (docs/ARCHITECTURE.md, *Roles*).
Stripe below is the paid way to the same subscription.

**Who sees what.** Publishing and Admin are not on a plain singer's menus at all: the side menu,
the phone's More panel, the Home cards and Settings list Publishing only for the accounts it is
open to (a club owner with an active year, a super admin) and Admin for super admins alone; a
singer finds the **Club owner** card and menu entry in their place. The service enforces the same
on every request whatever a device shows (`403 publishing_closed`, `403 not_super_admin`).

## The Club owner page — self-service (`/club-owner`)

Every account that is not a super admin has it (More › Club owner, the Home card, Settings): where
the account stands (the year, its dates, the days left, why Publishing is closed), **what a year
costs** — the price the super admin set (below) — and one button, **Pay for a year** (*Renew for a
year* once one has run out), which opens Stripe's Checkout with that price; back on the page the
year shows within seconds (the webhook). A paid year renews itself until cancelled from **Manage
subscription** (Stripe's portal: the card, the invoices, cancelling). The page lists the account's
payments — Stripe's, and the years the admin granted (amount 0). When Stripe is not configured, the
admin has set no price, or self-service is off, the page says to ask the SingersVoice admin, and a
year granted on the Admin page shows there the same way.

## The super admin's club owner portal (Admin › Club owners)

The top of the Admin page: the **price of a year** and its **currency** (0.00 = not for sale: years
are granted), **self-service** on or off, a **note** shown on the Club owner page (what a club owner
gets, how to reach you), the **expiring-soon** margin (days before the end a year is flagged) and
the **grace days** after an expiry during which Publishing stays open (0 = closed on the day — a
renewal on its way is not cut off when you allow a few). Under it, **who has a year**: every club
owner (and every account that ever had a subscription) sorted by what needs doing — *expired*
first, then *expiring* with the days left, then *active*, then *revoked* — with the dates, the
source (Stripe or granted), the last payment, and *Grant a year* / *Renew (+1 year)* / *Revoke* in
the row; the standing of every subscription is the service's verdict (the grace days included), never
recomputed on a device. Then the **payments**: every Stripe payment (the first year with its Checkout
session, renewals with their invoice and the period they paid for) and every year granted, renewed
or set by hand on the Admin page (amount 0, with who did it). Everything is kept in the SVT DB
(`settings`, `payments`) and read back on every visit.

## How money is collected: Stripe

Stripe Checkout takes the card on Stripe's own page (the card never touches the app or the
service), Stripe's Customer Portal lets a subscriber change the card or cancel, and a signed webhook
tells sv-control when a subscription starts, renews or ends. The service keeps one row per account:
the plan and until when. Fees: 2.9 % + 30¢ per successful card charge in the US (Stripe's standard
pricing); no monthly fee.

Why Stripe and not the alternatives, for SingersVoice today:

| Option | Fees | Handles sales tax / VAT for you | Fit |
| --- | --- | --- | --- |
| **Stripe** (Checkout + Billing) | 2.9 % + 30¢ | No (Stripe Tax adds 0.5 % per transaction when you want it) | The default: hosted pages, subscriptions, portal, webhooks — all set up in an afternoon |
| Lemon Squeezy / Paddle (merchant of record) | ~5 % + 50¢ | **Yes** — they are the seller, they file the taxes worldwide | Worth it once subscribers come from many countries and tax filings become a chore |
| Razorpay (India) | ~2 % | No | Add later for an Indian audience paying in rupees / UPI; the webhook pattern is the same |
| App-store subscriptions | 15–30 % | Yes | Not needed: SingersVoice is a web app, no store in between |

Start with Stripe; switch to a merchant of record if international tax ever becomes the main cost
of running the business.

## Setting it up (once, about 20 minutes)

1. **The price** — set it on the Admin page (Club owners › *Price of a year*): Checkout is created
   with that price inline (a yearly subscription of that amount), so no Stripe product or price is
   needed. (A Stripe Price id in `STRIPE_PRICE_PUBLISHER` still works as the fallback when no price
   is set on the Admin page.)
2. **API key** — Developers → API keys → *Secret key* (`sk_live_…`; use `sk_test_…` first if you
   want to try it with Stripe's test cards, 4242 4242 4242 4242).
3. **Webhook** — Developers → Webhooks → *Add endpoint*: URL
   `https://sv-control.singersvoice.workers.dev/billing/webhook`, events
   `checkout.session.completed`, `invoice.paid`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Save and copy the *Signing
   secret* (`whsec_…`).
4. **Customer portal** — Settings → Billing → Customer portal → *Activate* (allow cancelling and
   updating the payment method).
5. **Give the service the secrets** (never in the repo). In `services/control`:

   ```
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put APP_URL          # https://singersvoice.github.io/SingersVoice
   ```

   Each command asks for the value and stores it on the Worker. The next request after the last
   one turns the Club owner page's *ask the SingersVoice admin* into **Pay for a year** (with the
   price from the Admin page, and self-service on).
6. **Try it**: open the app with a second Google account → More → Club owner → Pay for a year →
   pay with a test card → you land back on the Club owner page and, within seconds (the webhook),
   the account is a *club owner* with its year, the payment is on its list and on the Admin page's,
   and Publishing appears on its menus.

Until step 5 is done, the Club owner page still works: it shows the year and its price, says to
ask the SingersVoice admin, and the super admin grants the year on the Admin page.

## What the service does

- `GET /club-owner` — the Club owner page: the account's role and subscription (status as the
  service sees it, grace days included), the days left, the price (the Admin page's, else the
  Stripe Price's), whether Checkout is open to it (self-service on, a price, a Stripe key) and the
  portal (a Stripe customer), the admin's note, the account's payments.
- `POST /club-owner/checkout` — a Checkout Session (subscription mode; the admin's price as inline
  `price_data`, yearly; the account's id as `client_reference_id`; promotion codes allowed; back to
  `/club-owner?billing=success|cancel`) → the page to send the browser to. `409 self_service_off`,
  `409 billing_unconfigured`, `409 super_admin` (nothing to buy).
- `POST /club-owner/portal` — a Customer Portal session for the account's Stripe customer.
- `POST /billing/webhook` — no sign-in; the `Stripe-Signature` header (HMAC-SHA256 of
  `t.body` with the signing secret, 5-minute tolerance) is checked, and each event id is handled
  once. `checkout.session.completed` ties the Stripe customer to the account, opens the plan and
  records the first year's payment (`amount_total`); `invoice.paid` records a renewal with the
  period it paid for (the first invoice, `billing_reason: subscription_create`, is the Checkout's
  and is not counted twice); `customer.subscription.*` set the plan and its period end (`active`,
  `trialing` and `past_due` keep it; `canceled` / `deleted` close it).
- `GET /admin/club-owners` — super admin only: the settings, whether Stripe is configured, every
  club owner with their standing (`expired` / `expiring` / `active` / `revoked` / `none`, in that
  order, the days left, the last payment), the payments. `PUT /admin/club-owners/settings` —
  `{ priceCents, currency, selfService, note, expiringSoonDays, graceDays }`, any subset, kept
  within bounds (a price up to 1 000 000.00, 3-letter currency, 0–365 days, 0–90 grace days).
- `POST /admin/plan` — super admin only: `{ email, plan, until? }` (a year from now when `until`
  is left out; the account becomes a club owner). `GET /admin/users` and
  `PATCH /admin/users/:id` (`{ role }`, `{ subscription: { action: grant | renew | set | revoke,
  startedAt?, expiresAt? } }`) are the Admin page's; a grant, a renewal and dates set by hand go on
  the payments record (amount 0, `ref: admin:<user id>`).
- `GET /billing`, `POST /billing/checkout`, `POST /billing/portal` — older clients; the same
  answers, the same Checkout.

Rows: `users (…, role)`, `subscriptions (user_id, plan, started_at, plan_until, status, customer_id,
subscription_id, source, updated_at)`, `billing_events (event_id)`, `settings (key, value JSON,
updated_at)` — `club_owner` holds the price and the rules — and `payments (id, user_id,
amount_cents, currency, paid_at, source, ref, period_start, period_end, note)`, one row per Stripe
session or invoice (an id Stripe retries lands once) and per year granted. `/me` carries `role`,
`media`, `subscription` (start, expiry, status as of today — `expired` after the grace days),
`canPublish` and `publishingNote`; every publishing route and the publisher join check
`canPublish` on the service.
