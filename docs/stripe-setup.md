# Stripe setup — the Dashboard, step by step

Everything below is done once, in the Stripe Dashboard and on the service; nothing of it goes in the
repo. Steps marked **(verify)** depend on the Stripe account itself — its country, verification,
business category and what Stripe has enabled for it — and must be checked in the Dashboard, not
assumed from these notes. Official docs: <https://docs.stripe.com/payments/checkout>,
<https://docs.stripe.com/payments/payment-methods/overview>, <https://docs.stripe.com/payments/upi>,
<https://docs.stripe.com/webhooks>, <https://docs.stripe.com/billing/subscriptions/overview>.

## 1. The account (United States)

1. **Activate the account**: Dashboard → *Activate payments* — the business details, the
   representative, and a **US business bank account** for payouts. Until it is activated, only test
   mode works (which is fine for everything below).
2. **Settings → Business → Public details**: the business name, support email and phone, the
   website (`https://singersvoice.github.io/SingersVoice`), and the **statement descriptor** (what
   singers see on their statement, e.g. `SINGERSVOICE`).
3. **Settings → Payments → Disputes**, **Radar** (fraud rules — the defaults are sensible), and the
   **payout schedule** (Settings → Payouts).

## 2. Payment methods (verify)

Settings → Payments → **Payment methods**. Turn on:

- **Cards** (Visa, Mastercard, American Express, Discover and the other networks the account offers).
- **Link**, **Apple Pay**, **Google Pay** — wallets show in Checkout where the device and the domain
  allow: register the app's domain under Settings → Payments → Payment method domains
  (`singersvoice.github.io`).
- **UPI** — listed under the India section *if Stripe offers it to this account* **(verify)**: a US
  account has to be eligible and the method enabled by Stripe for it; the business category matters.
  If UPI is not listed, ask Stripe support whether the account can have it. Until then singers in
  India pay by card (in INR or USD).
- Other local methods (Pix, Alipay, WeChat Pay, iDEAL, …) only where the Dashboard lists them for the
  account **(verify)**. Checkout shows each one only when the session's currency and the customer fit.

Nothing in the app names a method: Checkout picks from what is enabled here for the session's
currency (dynamic payment methods). The app never claims "all countries".

## 3. Prices — on the Admin page, not in Stripe

The plans' prices are set in SingersVoice (**Admin → Plans & payments**): a price in **USD** for
everyone, and a price in **INR** for singers in India (UPI pays in INR only — a USD session never
shows UPI). Checkout is created with the price inline (`price_data`), so **no Stripe product or
price object is needed**. Set the period (a month or a year), the video hours, the seats, and
whether the plan is for sale on the Plans page.

Currency notes: INR amounts are whole paise (₹425.00 = 42500); Stripe settles INR to the US bank
account in USD at Stripe's rate, and adds its conversion fee — see pricing below.

## 4. The webhook

Developers → **Webhooks** → *Add endpoint*:

- URL: `https://sv-control.singersvoice.workers.dev/billing/webhook` (the service's URL).
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`, `invoice.paid`,
  `invoice.payment_failed`, `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `charge.refunded`.
- Copy the **Signing secret** (`whsec_…`).

Do it once in **test mode** and once in **live mode** — each mode has its own endpoint and secret.

## 5. The Customer Portal

Settings → Billing → **Customer portal** → *Activate*: allow updating the payment method and
cancelling. The Plans page's **Manage subscription** opens it.

## 6. The secrets on the service

Never in the repo. For the Cloudflare Worker (`services/control`):

```
npx wrangler secret put STRIPE_SECRET_KEY        # sk_test_… first, sk_live_… when going live
npx wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_… of the endpoint above (test, then live)
npx wrangler secret put APP_URL                  # https://singersvoice.github.io/SingersVoice
```

For Node (`services/control` on a VM or Fly), the same three as environment variables
(`services/control/.env.example`). Prefer a **restricted key** (Developers → API keys → *Create
restricted key*) with write access to Checkout Sessions, Customers, Subscriptions, Refunds and the
Billing Portal, and read access to Charges, Payment Intents, Balance transactions and Subscriptions.

## 7. Try it in test mode

1. Admin → Plans & payments: a USD and an INR price on SVV; Save.
2. A second Google account → More → **Plans** → *Pay in USD* → **Choose SVV** → Stripe's test
   card `4242 4242 4242 4242`, any future date, any CVC → back on the app's return page: *Thank you —
   your SVV plan is open*; the Admin page lists the payment with Stripe's fee.
3. *Pay in INR* → **Choose SVV** → Checkout shows UPI when the account has it **(verify)**; Stripe's
   test UPI flow confirms after a moment: the return page says *Waiting for the bank's confirmation*,
   then opens the plan (the `async_payment_succeeded` event).
4. Developers → Webhooks → the endpoint → *Send test event* `charge.refunded` with a charge id of a
   test payment: the payment shows refunded on the Admin page. Or press **Refund** there.
5. Developers → Events: every event the service answered `200` once; a retried one answers
   `{seen: true}`.

## 8. Going live

Swap the three secrets for the live ones, add the live webhook endpoint, and make one real payment
with a real card for the cheapest plan (refund it from the Admin page). Watch Developers → Events for
the first week.

## Pricing (indicative — verify against the account's agreement before relying on it)

| What | Indicative Stripe US pricing |
| --- | --- |
| US cards | 2.9 % + $0.30 |
| International cards | + 1.5 % |
| Currency conversion (an INR payment settled in USD) | + 1 % |
| UPI | Stripe lists its own rate for the method (verify in the Dashboard's pricing page) |
| Checkout, Billing (subscriptions), Customer Portal | included with payments; Stripe Billing may add a percentage on recurring revenue (verify) |
| Setup / monthly fee | none |

The service reads the real fee of every charge from its balance transaction onto the payment record
(Admin → Plans & payments), so reconciliation uses Stripe's numbers, never these.

## UPI — what to know (verify current limits in Stripe's docs)

- A payment method through Stripe, used by PhonePe, Google Pay India, Paytm and the other UPI apps;
  not a PhonePe integration of its own.
- INR only. The customer picks *Pay in INR* on the Plans page; the app never forces a currency.
- Stripe has documented one-time and recurring (UPI AutoPay) limits and mandate rules; whether
  Checkout offers UPI for a monthly **subscription** is the account's eligibility, not the app's
  promise. If UPI is not offered for a session, Checkout shows cards (and anything else enabled) —
  the singer is never stuck.
- The confirmation can arrive a moment after the payment: the app's return page keeps asking and the
  plan opens on Stripe's word.
