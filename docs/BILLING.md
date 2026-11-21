# Billing — the plans

Four plans, priced by the super admin (Admin → **Plans & payments**) and paid through Stripe
(docs/stripe-setup.md; the architecture in docs/global-payments-architecture.md; the test plan in
docs/payments-test-plan.md). The defaults, which the super admin can change at any time — the
prices (in USD, and in INR for UPI), the period (a month or a year), the video hours, the seats,
whether a plan is for sale on the Plans page or granted by hand:

| Plan | Default price | Live meets | More |
| --- | --- | --- | --- |
| **Free** | — | with the voice (no picture on stage) | the Studio with the camera, Track Maker, every take in your own Drive |
| **SVV** | $5.00 / month | your picture on stage, **10 hours** a calendar month | |
| **SVVPro** | $50.00 / month | your picture on stage, **100 hours** a month | |
| **Club owner** | $250.00 / month | **300 hours** a month shared by the owner and up to **15 members** the owner names by email | **Publishing mode** (the show view, YouTube and the in-house watch page) |

What an account may do is computed on the service on every request (`entitlementOf`,
`packages/protocol/src/plans.ts`): the plan in force is the account's own active subscription, else
the club it is a member of (by email) while that club's plan is active, else Free; a super admin has
everything without limit. **Video hours** count while a singer is on stage with the picture on, by the
calendar month (UTC), into the account's own pool or the club's; at the limit the next heartbeat takes
the picture away (every device draws the name card) with the reason on the chip, and the first of the
month starts the count again. An *audio only* role has no picture whatever the plan. A member's own
paid plan takes precedence over the club's; members never get Publishing mode.

**Who sees what.** Publishing and Admin are not on a plain singer's menus at all: the side menu, the
phone's More panel, the Home cards and Settings list Publishing only for the accounts it is open to (a
club owner with an active plan, a super admin) and Admin for super admins alone; a singer finds
**Plans** in their place, and a club owner **My club** beside it. The service enforces the same on
every request whatever a device shows (`403 publishing_closed`, `403 not_super_admin`, `403 no_club`).

## The Plans page — self-service (`/plans`)

Every account that is not a super admin has it (More › Plans, the Home card, Settings): where the
account stands (the plan in force, the video hours used and left this month, when they start again,
Publishing), the four plans at the admin's prices with **Choose** on each — in the currency the singer
picks when plans are priced in more than one (**Pay in USD / INR**; a price in INR takes UPI through
Stripe) — Stripe's own page for the payment, and the **return page** that waits for Stripe's word
(paid at once, or *Waiting for the bank's confirmation* for UPI and some wallets, or failed/expired
with the way back). **Manage subscription** opens Stripe's portal (the card, the invoices,
cancelling); the account's payments are listed. When Stripe is not configured, or a plan is not for
sale, the page says to ask the SingersVoice admin, and a plan granted on the Admin page shows there
the same way.

When the admin made **offers** for a plan (below), the plan's card shows them as its buttons instead
of the one price — *Choose SVV — A year · $50.00 / year*, *Choose SVV — Launch price · $4.00 / month ·
until 31 Dec* — in the currency picked. A **Have a code?** box above the plans takes a **promo
code**: *Apply* checks it with the service and says what it gives (*SAVE20: 20% off your first
payment — for SVV, SVVPro*); the buttons then show the discounted price (*$4.00 / month (was $5.00,
first payment)*), and the code goes on the payment. A **fee-void** code turns the button into *Get SVV
free — Three months*: the plan opens at once, with no Stripe page at all, and the payments list shows
*free with a code* with the code on it. A code is once per account; a code for other plans, expired,
used up or already used says so in the box.

## My club (`/club`)

A club owner names the members (Google email addresses) who share the club's video hours: a plain
box and **Add**, **Remove** on each, the seats used (up to the plan's 15), the club's hours used and
left this month. Whoever signs in with a named address has the club's picture on stage from their
next visit. A member of several clubs draws on the first club (by the date named) whose plan is
active.

## The super admin's portal (Admin → Plans & payments)

The top of the Admin page: every plan's **price in USD and in INR** (0.00 = not for sale in that
currency), its **period** (a month or a year), its **video hours** a month, its **seats**, and
whether it is **for sale** on the Plans page or granted here only; a **note** for the Plans page; the
**expiring-soon** margin and the **grace days** after an expiry during which the plan stays open.
Under it, **who has a plan**: every subscriber sorted by what needs doing — *expired* first, then
*expiring* with the days left, then *active*, then *revoked* — with the plan, the dates, the source
(Stripe or granted), the video hours used this month (and the members, for a club), the last payment,
and *Grant again* / *Renew* / *Revoke* in the row; then the **payments** (every Stripe payment with
the fee Stripe kept, every period granted; a **Refund** button on Stripe's) and the **Checkouts
without a payment** (processing, failed, expired). On every account's row below, a **Grant** of a
plan for its own period or for a number of months, *Renew*, *Set dates*, *Revoke*.

Between the plans and the subscribers, two tables of their own:

- **Offers — the ways to pay for a plan.** *Add an offer*: the plan, a title (*Monthly*, *A year*,
  *Launch price*), the period (so many months or years), the prices in USD and INR, the dates it is
  **on sale** (*from*, *until* — the end of that day, UTC; either may be empty) and an on/off switch;
  *Save* / *Remove* on each row, and a chip saying *on sale*, *not now* (outside its dates) or *off*.
  A plan with offers on sale sells by them on the Plans page; a plan with none sells at the one price
  above. Singers who paid for an offer keep what they paid for when it is removed.
- **Promo codes.** *Add a code*: the code (letters and digits; typed with spaces or dashes it still
  matches), what it gives — **% off**, an **amount off** in USD or INR, or the **fee voided** for so
  many periods of the offer chosen —, on the **first payment** or **every payment** (for % and
  amount), the **plans** it is for (none ticked = every plan), the **uses** allowed (0 = no limit; the
  uses so far are shown), a last day (**until**), a note for you, and an on/off switch. The chip on
  the row says what the code gives, or *expired* / *used up* / *off*. A % or amount code becomes a
  Stripe coupon the first time a singer pays with it (made by the service; nothing to do in the
  Dashboard; changing the code's terms makes a new coupon at the next use). A fee-void code never
  reaches Stripe: the service grants the plan and records a payment of 0 with the code — so it works
  before Stripe is set up too. Every code is **once per account**: a Checkout left open holds the
  use; one that expires or fails gives it back. The *Checkouts without a payment* list shows the
  code and the discount on each order.

## How money is collected: Stripe

Stripe Checkout takes the payment on Stripe's own page — the card, the wallet, or the UPI app for a
singer in India paying in INR; nothing of it touches the app or the service —, Stripe's Customer
Portal lets a subscriber change the card or cancel, and a signed webhook tells sv-control what became
of every payment. The service keeps one subscription row per account (the plan and until when), an
order per Checkout started, and a payment per Stripe charge with the fee Stripe kept. Which payment
methods Checkout shows is Stripe's call from what the Dashboard enables and the session's currency
(dynamic payment methods); the app never names a method and never claims every country.

Why Stripe and not the alternatives, for SingersVoice today:

| Option | Fees (indicative — verify) | Handles sales tax / VAT for you | Fit |
| --- | --- | --- | --- |
| **Stripe** (Checkout + Billing) | 2.9 % + 30¢ US cards; + 1.5 % international; + 1 % conversion; UPI at Stripe's rate | No (Stripe Tax adds a per-transaction fee when you want it) | The default: hosted pages, subscriptions, portal, webhooks, UPI for India — set up in an afternoon (docs/stripe-setup.md) |
| Lemon Squeezy / Paddle (merchant of record) | ~5 % + 50¢ | **Yes** — they are the seller, they file the taxes worldwide | Worth it once subscribers come from many countries and tax filings become a chore |
| Razorpay (India) | ~2 % | No | Only if Stripe cannot offer UPI to the account; the webhook pattern is the same (a second processor would sit behind a feature flag — never to route around a refusal) |
| App-store subscriptions | 15–30 % | Yes | Not needed: SingersVoice is a web app, no store in between |

Setting it up — the Dashboard checklist, the webhook events, the secrets, the test cards, UPI's
caveats — is docs/stripe-setup.md.

## What the service does

- `GET /plans` — the plans as priced, the currencies, whether Checkout and the portal are available,
  the account's entitlement and subscription, its payments.
- `POST /plans/checkout` `{ planId, currency }` — a Checkout Session for a plan priced in that
  currency (the price is the admin's, never the browser's; a super admin has nothing to buy; a plan
  not for sale answers `409 self_service_off`; no Stripe answers `409 billing_unconfigured`): an
  order is opened first (pending), its id goes on the session's metadata and on the `Idempotency-Key`;
  the session is a subscription of the plan's period with the price inline (`price_data`), back to
  `/billing/return?session_id=…` or `/plans?billing=cancel`.
- `GET /billing/session/:id` — the order's status (the webhook's word); while pending or processing
  the service also asks Stripe for the session itself and opens a paid one (a missed webhook).
- `POST /billing/portal` — a Customer Portal session for the account's Stripe customer.
- `POST /billing/webhook` — no sign-in; `Stripe-Signature` (HMAC-SHA256 of `t.body`, 5-minute
  tolerance) checked; each event id handled once. `checkout.session.completed` /
  `async_payment_succeeded` with `payment_status: paid` open the plan (the subscription row with
  Stripe's ids, the period's end from Stripe's subscription, the role, the order paid, the payment on
  record once with the fee); `unpaid` marks the order processing; `async_payment_failed` /
  `expired` close the order; `invoice.paid` (not the first invoice) records a renewal and extends the
  period; `invoice.payment_failed` is noted; `customer.subscription.updated/deleted` set the period's
  end or close the plan; `charge.refunded` lands on the payment.
- `GET /club`, `POST /club/members` `{ email }`, `DELETE /club/members/:email` — the owner's club.
- `GET /admin/billing`, `PUT /admin/billing/settings` (`plans` merged by id, `note`,
  `expiringSoonDays`, `graceDays`; kept within bounds), `POST /admin/payments/:id/refund`
  `{ amountCents? }` — super admin only.
- `POST /admin/plan` `{ email, plan, until? }` (older clients) and `PATCH /admin/users/:id`
  (`{ role }`, `{ subscription: { action: grant | renew | set | revoke, plan?, months?, startedAt?,
  expiresAt? } }`) — the Admin page's; a grant, a renewal and dates set by hand go on the payments
  record (amount 0, `ref: admin:<user id>`). `PUT /admin/users/:id/video-usage` `{ seconds }` sets
  the month's count (tests, and an admin's correction).

Rows: `users (…, role)`, `subscriptions`, `orders`, `payments`, `billing_events`, `settings`
(`billing`), `club_members`, `video_usage` — docs/global-payments-architecture.md has the columns.
`/me` carries `role`, `media` (the picture in a live meet right now), `entitlement`, `subscription`,
`canPublish` and `publishingNote`; every publishing route, the publisher join and every meet
heartbeat go by them on the service.
