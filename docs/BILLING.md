# Billing — the Publisher plan

Publishing mode (the show view, destinations, going live to YouTube and the in-house watch page) is
part of the **Publisher plan**. Singing, hosting and joining meets stay free. An **admin** account
(the first account ever seen, plus `PRIVILEGED_EMAILS`) publishes without a plan and can put any
account on the plan by email from the Plans page.

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

1. **Create the product and price** — Stripe Dashboard → Product catalog → *Add product*: name
   `SingersVoice Publisher`, recurring, monthly, your price (the doc "SingersVoice — the big
   picture" suggests $14.99). Save, open the price and copy its id (`price_…`).
2. **API key** — Developers → API keys → *Secret key* (`sk_live_…`; use `sk_test_…` and a test
   price first if you want to try it with Stripe's test cards, 4242 4242 4242 4242).
3. **Webhook** — Developers → Webhooks → *Add endpoint*: URL
   `https://sv-control.singersvoice.workers.dev/billing/webhook`, events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Save and copy the *Signing secret* (`whsec_…`).
4. **Customer portal** — Settings → Billing → Customer portal → *Activate* (allow cancelling and
   updating the payment method).
5. **Give the service the secrets** (never in the repo). In `services/control`:

   ```
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put STRIPE_PRICE_PUBLISHER
   npx wrangler secret put APP_URL          # https://singersvoice.github.io/SingersVoice
   ```

   Each command asks for the value and stores it on the Worker. The next request after the last
   one shows the price on the Plans page and turns *Request the plan* into *Subscribe*.
6. **Try it**: open the app with a second Google account → More → Plans → Subscribe → pay with a
   test card → you land back on Plans and, within seconds (the webhook), the plan shows
   *Publisher* and the Publishing portal opens.

Until step 5 is done, the Plans page still works: it shows both plans, says payments are not set
up, and an admin grants the plan by email.

## What the service does

- `GET /billing` — the account's plan, until when, whether checkout and the portal are available,
  the Publisher price (read from the Stripe Price, cached an hour).
- `POST /billing/checkout` — a Checkout Session (subscription mode, the account's id as
  `client_reference_id`, promotion codes allowed) → the page to send the browser to.
- `POST /billing/portal` — a Customer Portal session for the account's Stripe customer.
- `POST /billing/webhook` — no sign-in; the `Stripe-Signature` header (HMAC-SHA256 of
  `t.body` with the signing secret, 5-minute tolerance) is checked, and each event id is handled
  once. `checkout.session.completed` ties the Stripe customer to the account and opens the plan;
  `customer.subscription.*` set the plan and its period end (`active`, `trialing` and `past_due`
  keep it; `canceled` / `deleted` close it; a day of grace covers a renewal on its way).
- `POST /admin/plan` — admin only: `{ email, plan, until? }`.

Rows: `subscriptions (user_id, plan, plan_until, customer_id, subscription_id, source, updated_at)`
and `billing_events (event_id)`. `/me` carries `plan`, `planUntil` and `canPublish`; every
publishing route and the publisher join check `canPublish`.
