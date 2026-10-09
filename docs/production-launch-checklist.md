# OrderX production launch checklist

Updated: 2026-10-02

OrderX is code-ready only after every external gate below is complete. A local
green build cannot approve the Shopify app, Meta app, billing plans, WhatsApp
templates, domains, or production credentials.

## 1. Secrets and infrastructure

- Rotate every credential that has ever appeared in a file, comment, terminal
  transcript, or shared screenshot. The local `.env` files contain commented
  credential-shaped values and must not be treated as a secure vault.
- Store production secrets in the hosting provider, never in Git or the image.
- Use Node 24 LTS for both services. Node 20 is end-of-life and must not be used
  for production deployment.
- Use HTTPS for `https://app.orderxapp.com` and `https://api.orderxapp.com`.
- Use an authenticated MongoDB replica set. The frontend and backend must share
  the same `SHOPIFY_SESSION_MONGO_URI`, database, and collection.
- Use a long, random `INTERNAL_SYNC_SECRET`, `WA_TOKEN_SECRET`, admin JWT secret,
  webhook verification token, and salted admin password/second-factor hashes.
- Keep `ALLOW_UNAUTH_INTERNAL=false` and `ALLOW_UNSIGNED_WA_WEBHOOK=false`.
- Run `cd server && npm run db:ensure-indexes` once for each production database
  before accepting traffic.

## 2. Shopify launch gates

- Deploy the current app configuration with `cd builderdev && npm run deploy`.
- Confirm application URL, redirect URL, and every webhook URL in the Dev
  Dashboard resolve to the production frontend.
- Request protected customer data level 2 access for the order/customer fields
  used by COD confirmation: name, phone, email, and address.
- Confirm mandatory compliance webhook delivery and HMAC rejection for
  `customers/data_request`, `customers/redact`, and `shop/redact`.
- Configure and test every public pricing plan. This code currently uses the
  Shopify Billing API. If the app is enrolled in Shopify App Pricing, migrate
  subscriptions and usage reporting before launch; do not mix the two systems.
- Verify upgrades, downgrades, cancellation, reinstall, declined charges,
  frozen shops, Growth usage cap increases, and usage-charge idempotency.
- Provide a public privacy policy, terms, support contact, reviewer test store,
  and exact review instructions.

References: [Shopify App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements),
[protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data),
[privacy webhooks](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance),
and [API versioning](https://shopify.dev/docs/api/usage/versioning).

## 3. Growth plan and countries

- In the OrderX admin country-rate screen, enter and activate only the countries
  where the managed OrderX number is operational. An active row is the Growth
  allowlist; an inactive or missing row blocks purchase for that store country.
- Verify the store country detected from Shopify before purchasing Growth.
- Verify each recipient-country price, the store-baseline cap calculation, and
  the merchant-facing wording against the live commercial rate card.
- The plan must be exactly the same in frontend and backend environment values:
  base price, usage currency, cap, included/free allowance, and country rates.
- Run `cd server && npm run qa:plan-flows` to validate the catalog without
  touching a shop. Run it with `-- --shop store.myshopify.com` only against an
  authorized test store.

## 4. BYON and Meta gates

- Put the Meta app in Live mode and finish business verification/App Review.
- Obtain Advanced Access for the permissions required by Embedded Signup and
  WhatsApp management/messaging. Confirm the coexistence configuration uses
  `whatsapp_business_app_onboarding`.
- Verify token exchange/refresh, WABA subscription, phone registration, payment
  method confirmation, template provisioning, template approval, live send,
  inbound reply, and reauthorization.
- Recheck all displayed Meta estimates against the current country/category
  rate card. Meta rates are merchant-paid and can change; OrderX must label them
  as estimates, not guaranteed prices.
- As of October 1, 2026, Meta pricing/terms changed again. Validate service,
  utility, authentication, and marketing behavior in the merchant's WABA before
  launch. See [official WhatsApp pricing](https://whatsappbusiness.com/products/platform-pricing/).

## 5. Release commands

```sh
cd server
npm ci
npm test
npm audit --omit=dev
npm run qa:plan-flows
npm run qa:agent-policy

cd ../builderdev
npm ci
npm test
npm run lint
npm run typecheck
npm run build
npm audit --omit=dev
```

Then test the full checklist in `docs/qa/billing-byon-flow-checklist.md` on a
development store before submitting the exact production build for review.
