# Payments — the test plan

What is automated runs on every push (`npm test`, the e2es); what needs Stripe's own pages is a
checklist in test mode. The automated side fakes Stripe's REST answers and signs the webhook events
itself (`services/control/test/app.test.ts`: "plans" and "payments through Stripe").

## Automated

| Scenario | Where | Outcome asserted |
| --- | --- | --- |
| The four plans with the asked-for defaults; the admin's prices (USD and INR), period, hours, seats, self-service; bounds | protocol `plans.test.ts`, control "plans" | `GET /plans` shows them; `PUT /admin/billing/settings` super admin only, merged by plan, kept within bounds |
| A free account in a live meet | control "plans", roles e2e | `media: audio`, the voice alone on stage, the reason on the chip, the way to the plans |
| A plan granted (period, months), the picture, the hours | control "plans", roles e2e | `media: dual`, 36 000 s left; the chip's hours; the service counts seconds on stage |
| Hours used up mid-meet | control "plans", roles e2e | the next heartbeat takes the picture away with the reason; the room carries `audio`; hours back, it returns |
| A club: members by email, seats, the pool, precedence | control "plans", roles e2e | a member has the club's picture and hours, no Publishing; the pool counts every member's stage time; seats refused past the limit; an own plan beats the club; removed → free |
| Checkout in the chosen currency, server-trusted price | control "payments" | `price_data` carries the admin's price and currency, `mode: subscription`, no `payment_method_types`, our order on the session, `Idempotency-Key` |
| A tampered or wrong currency / a plan not for sale / a super admin | control "payments" | `400 bad_currency`, `409 self_service_off`, `409 super_admin` |
| The browser's return opens nothing | control "payments" | the order stays pending until the webhook |
| Invalid or stale webhook signature | control "payments" | `400`, nothing changed |
| Asynchronous method (UPI): completed-but-unpaid, then succeeded | control "payments" | order `processing` and no plan; then paid, the plan open, the payment on record with Stripe's fee |
| Duplicate webhook deliveries | control "payments" | `{seen: true}`, one payment, one state change |
| The first invoice is not a second payment; a renewal is | control "payments" | one payment after Checkout; `invoice.paid` (cycle) adds one and extends the period |
| Failed async payment / expired checkout | control "payments" | orders `failed` / `expired`, nothing opened, listed for the admin |
| Missed webhook reconciled | control "payments" | the return page's poll asks Stripe; a paid session opens the plan |
| Refund (full, partial), Dashboard refund | control "payments" | Stripe asked with an idempotency key; the record `refunded` / `partly_refunded`; `charge.refunded` updates it; a grant refuses |
| Cancellation on Stripe's side | control "payments" | `customer.subscription.deleted` closes the plan |
| The Club owner plan paid: a club owner, Publishing | control "payments" | role `club_owner`, `canPublish`, the period from the subscription event |
| Publishing with and without the club plan; grace days | control "roles", protocol `roles.test.ts` | `403 publishing_closed` with the reason; grace keeps a late renewal open |
| Who sees what (menus, Home, Settings) | web `navGating.test.ts`, roles e2e | Publishing for those it is open to, Admin for super admins, Plans for the rest, My club for club owners |
| Two performers with video and a third joining late (SVV granted) | live e2e | the whole live meet, with the plans in force |

## By hand, in Stripe test mode (docs/stripe-setup.md §7)

| Scenario | How | Expected |
| --- | --- | --- |
| US card, USD | Pay in USD → Choose SVV → `4242 4242 4242 4242` | the return page: "Thank you — your SVV plan is open"; the Admin page lists the payment with the fee; Publishing stays closed (SVV) |
| International card | a non-US test card (Stripe's list) in USD | works; the fee on the record shows the international add-on |
| Card declined | `4000 0000 0000 0002` | Checkout shows the decline; no order paid; the Plans page unchanged |
| 3-D Secure | `4000 0025 0000 3155` | the challenge is Stripe's; paid after it |
| UPI in INR (when the account has it) | Pay in INR → Choose SVV → UPI on Checkout | Stripe's simulated UPI confirms after a moment; the return page waits, then opens the plan |
| India without UPI | the same, with UPI not enabled | Checkout offers cards in INR; the plan opens on payment |
| Wallets | Apple Pay / Google Pay on a device and domain that allow them | shown by Checkout only there |
| The Checkout page closed | close the tab, revisit the Plans page | nothing charged; after 24 h the order shows *expired* on the Admin page |
| Cancel from the portal | Manage subscription → cancel | the plan runs to the period's end, then closes (`customer.subscription.deleted`) |
| Renewal | advance the test clock on the subscription (Dashboard → Billing → Test clocks) | a renewal payment on record, the period extended |
| Refund from the Dashboard | Payments → Refund | the Admin page shows the payment refunded within seconds |
| Refund from the Admin page | Plans & payments → Refund | Stripe shows the refund; the record says so |
| Webhook retry | Developers → Webhooks → Resend | `{seen: true}`, nothing doubled |
| Phone and desktop | the Plans page at 390 px and 1280 px; keyboard through the buttons | readable; every control reachable with the keyboard; UPI on a phone hands off to the app, on a desktop shows a QR (Stripe's page) |
| Live mode | the three live secrets, one real payment of the cheapest plan, refunded | paid, refunded, nothing else charged |
