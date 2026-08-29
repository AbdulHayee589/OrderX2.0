# OrderX AI Knowledge Base

Generated from the repository source code on 2026-04-07.

This file is a product-and-system knowledge pack for training or grounding a OrderX AI assistant.

Important limits:

- This is built from source code, not from live production databases.
- It does not include secrets, access tokens, PINs, API keys, or customer/shop private data.
- It describes current app behavior, data models, plans, flows, and terminology as implemented in the repo.

## 1. What OrderX is

OrderX is a Shopify app focused on WhatsApp automation for cash-on-delivery workflows.

Its core purpose is to help merchants:

- send WhatsApp order confirmation messages
- collect confirm/cancel responses
- reduce failed COD orders
- optionally process change requests from customers
- send selected post-purchase order updates on WhatsApp
- operate either on the OrderX-managed number or on the merchant's own WhatsApp number through Meta BYON

OrderX is an embedded Shopify app with:

- a React Router frontend in `builderdev/`
- an Express + MongoDB backend in `server/`
- Shopify Admin integration
- WhatsApp/Meta integration
- Shopify billing integration
- background jobs through Agenda

## 2. Product positioning

OrderX is a merchant operations tool for stores that rely on COD orders and want automated WhatsApp confirmation and update workflows.

Primary value props:

- reduce fake or abandoned COD orders
- improve confirmation rates through WhatsApp
- centralize confirmation analytics and attempt history
- allow merchants to use either:
  - OrderX's managed sender number
  - or their own WhatsApp Business number (BYON)
- support country-based pricing and sender-mode-based billing

## 3. Core product concepts

### 3.1 Sender modes

OrderX has two sender modes:

- `orderx_number`
- `own_number`

`orderx_number` means OrderX sends using the shared OrderX WhatsApp sender.

`own_number` means the merchant connects their own WhatsApp Business App / Cloud API-capable number through Meta. In the current app, this uses the Meta feature type:

- `whatsapp_business_app_onboarding`

### 3.2 Main merchant workflows

Main workflows implemented in the app:

- install app in Shopify
- authenticate Shopify shop
- choose a sender mode / plan
- configure confirmation settings
- automatically schedule COD confirmation attempts
- send WhatsApp confirmation messages
- process confirm/cancel outcomes
- optionally process customer change requests
- optionally send Shopify order updates:
  - dispatched
  - tracking updated
  - cancelled
- review analytics, attempts, billing, diagnostics, and sender status

### 3.3 COD attempt lifecycle

A `CodAttempt` represents one order-confirmation workflow.

Main statuses:

- `pending`
- `scheduled`
- `skipped`
- `wa_sent`
- `confirmed`
- `cancelled`
- `expired`
- `failed`

Main stages:

- `pre_dispatch`
- `post_failed_delivery`

Each attempt tracks:

- order identity
- customer phone
- sender mode and sender phone number id
- scheduled time
- WhatsApp message id
- change-request state
- retry count
- token expiry for confirm/cancel links
- error history

## 4. Current plans and billing

Defined in `server/services/plans.js` and mirrored in Shopify billing setup in `builderdev/app/shopify.server.js`.

### 4.1 Public/current plans

1. `orderx_free_5`

- Name: `OrderX Free`
- Price: free
- Sender mode: `orderx_number`
- Billing type: `free_cap`
- Includes: `10` confirmation/template messages total by default

2. `orderx_metered_4`

- Name: `OrderX Growth`
- Price: `$2.99/month`
- Sender mode: `orderx_number`
- Billing type: `shopify_metered`
- Usage: country-based price per outbound WhatsApp message
- Usage cap: calculated from configured capped amount

3. `own_number_flat_8`

- Name: `Your Own Number 1000`
- Price: `$8/month`
- Sender mode: `own_number`
- Billing type: `shopify_flat`
- Includes: `1000` template messages per billing cycle inside OrderX's own cap logic
- Meta usage costs remain on merchant/Meta side

4. `own_number_unlimited_15`

- Name: `Your Own Number Unlimited`
- Price: `$15/month`
- Sender mode: `own_number`
- Billing type: `shopify_flat`
- Includes: unlimited OrderX template allowance per billing cycle
- Meta usage costs remain on merchant/Meta side

### 4.2 Legacy/hidden plans still defined for backward compatibility

Hidden plans still exist in code so already-active subscriptions can sync correctly:

- `lite_20`
- `basic_50`
- `starter_100`
- `medium_200`
- `growth_300`
- `plus_400`
- `pro_500`
- `scale_1000`
- `enterprise_2000`

These are not the current public pricing plans.

### 4.3 Trial and free limits

Important billing/trial facts from code:

- `TRIAL_DAYS = 3`
- free plan default confirmation cap = `10`
- Growth metered usage base amount defaults to `$0.01`

### 4.4 Country pricing defaults

Defined in `server/services/countryPricing.js`.

Current default country message rates:

- Pakistan (`PK`):
  - Growth: `$0.01`
  - BYON utility template estimate: `$0.01`
- India (`IN`):
  - Growth: `$0.01`
  - BYON utility template estimate: `$0.0014`
- Egypt (`EG`):
  - Growth: `$0.01`
  - BYON utility template estimate: `$0.0036`
- Saudi Arabia (`SA`):
  - Growth: `$0.02`
  - BYON utility template estimate: `$0.0107`
- UAE (`AE`):
  - Growth: `$0.02`
  - BYON utility template estimate: `$0.0157`
- Malaysia (`MY`):
  - Growth: `$0.02`
  - BYON utility template estimate: `$0.014`
- Indonesia (`ID`):
  - Growth: `$0.03`
  - BYON utility template estimate: `$0.025`

Pricing logic notes:

- Growth pricing is recipient-country-based
- plan UI shows store-country baseline for planning, but actual billing follows recipient-country rates
- BYON pricing is a flat OrderX package plus Meta-billed usage on the merchant side
- Pakistan Growth usage no longer batches two messages into one charge when the per-message rate is already `$0.01`
- after the latest pricing update, Pakistan outbound Growth messages are charged individually at `$0.01`

## 5. Core merchant-facing pages

Frontend routes are in `builderdev/app/routes/`.

### 5.1 Dashboard

File: `builderdev/app/routes/app._index.jsx`

Purpose:

- main overview page
- performance snapshot
- usage summary
- analytics
- BYON live test area
- recent attempts
- plan cards when billing is inactive or setup is incomplete

### 5.2 Main app shell

File: `builderdev/app/routes/app.jsx`

Purpose:

- app layout
- global banners/warnings such as:
  - free plan limit reached
  - trial cap reached
  - Growth active
  - Meta templates pending approval
  - reconnect Meta sender
  - BYON cap warnings
  - billing cycle limit warnings

### 5.3 Plans & billing

File: `builderdev/app/routes/app.plans.jsx`

Purpose:

- choose and manage OrderX plans
- show plan cards, status, billing history, usage
- switch between OrderX Number and Your Own Number
- continue to Shopify billing
- run/continue BYON onboarding steps inside the pricing flow

### 5.4 Settings

File: `builderdev/app/routes/app.settings.jsx`

Purpose:

- configure confirmation flow
- support WhatsApp number
- automation rules
- BYON connection area
- initiated-conversation limit for BYON
- Smart order updates settings
- blocklist management
- activity/audit log

### 5.5 Attempts explorer

File: `builderdev/app/routes/app.attempts.jsx`

Purpose:

- view and filter attempt history
- search by customer/order/status
- inspect usage and analytics over time

### 5.6 Billing confirm route

File: `builderdev/app/routes/app.billing.confirm.jsx`

Purpose:

- handle return flow from Shopify billing confirmation

### 5.7 BYON Meta callback route

File: `builderdev/app/routes/byon.meta.callback.jsx`

Purpose:

- compatibility/fallback callback page for Meta BYON flow
- main happy path now stays in the app via SDK-driven flow and direct finalize handling

## 6. BYON (Bring Your Own Number) flow

Main implementation files:

- `builderdev/app/components/ByonOnboardingFlow.jsx`
- `builderdev/app/server/byonActions.server.js`
- `server/routes/api.js`
- `server/services/metaByonAuth.js`
- `server/services/ownNumberRegistration.js`
- `server/services/whatsapp.js`

### 6.1 Current BYON steps

The BYON flow is modeled as a guided multi-step onboarding:

1. Meta connect
2. payment method confirmation in Meta
3. choose BYON plan
4. template setup / template sync / template approval
5. Cloud-connected readiness and test/send validation

### 6.2 Meta flow used

Current Meta feature type used in code:

- `whatsapp_business_app_onboarding`

This corresponds to the existing WhatsApp Business App / coexistence-style onboarding path rather than a manually constructed Meta URL flow.

### 6.3 BYON readiness summary

A merchant own-number sender becomes truly ready when the app has enough evidence that:

- Meta connection is complete
- a usable `wabaId` exists
- a usable `phoneNumberId` exists
- access token exists and is not expired
- required English templates are approved
- webhook subscription is confirmed
- phone metadata indicates Cloud-connected readiness for sending

Current registration/readiness logic treats phone metadata as authoritative when:

- `platformType === "CLOUD_API"`
- `status === "CONNECTED"`

`codeVerificationStatus` is treated as informational, not as an automatic hard failure.

### 6.4 Required BYON templates

The app currently expects an English template pack built around these keys/names:

- `cod_confirm_new`
- `cod_order_dispatched`
- `cod_tracking_updated`
- `cod_order_cancelled`
- `cod_order_update_generic`

The app tracks template states per template:

- `missing`
- `pending`
- `approved`
- `rejected`

### 6.5 BYON sync behavior

Important operational behavior:

- template sync calls Meta and saves merged state into MongoDB
- in-flight template sync is deduped per shop
- approved template packs are now throttled so Meta is queried at most once per hour after approval, even if refresh is requested repeatedly
- webhook ensure is also cooled down to avoid repeated Meta calls

## 7. Main backend routes and responsibilities

The backend is an Express app in `server/index.js`.

### 7.1 Route groups

Mounted route groups:

- `/auth`
- `/admin`
- `/internal`
- `/api/billing`
- `/api`
- `/wa`
- `/debug`
- `/whatsapp`

### 7.2 Key public/internal backend endpoints

Key `/api` routes in `server/routes/api.js`:

- `GET /api/usage`
- `GET /api/settings`
- `GET /api/sender`
- `GET /api/sender/byon/meta-config`
- `POST /api/sender/byon/meta-connect/begin`
- `POST /api/sender/byon/payment-method/confirm`
- `POST /api/sender/select-mode`
- `POST /api/sender/byon/start`
- `POST /api/sender/byon/details`
- `POST /api/sender/byon/meta-connect/finalize`
- `POST /api/sender/byon/templates/provision`
- `POST /api/sender/byon/templates/sync`
- `POST /api/sender/byon/reset`
- `POST /api/sender/byon/test-send`
- `POST /api/sender/byon/test-status/check`
- `POST /api/sender/byon/webhook-test/start`
- `POST /api/sender/byon/webhook-test/check`
- `POST /api/sender/byon/retry-now`
- `GET /api/diagnostics`
- `POST /api/diagnostics/run`
- `GET /api/audit`
- `POST /api/settings`
- `GET /api/attempts`
- `POST /api/attempts/trigger`
- `GET /api/metrics`

### 7.3 Billing routes

In `server/routes/billing.js`:

- `GET /api/billing/status`
- `POST /api/billing/subscribe`
- `POST /api/billing/activate`
- `POST /api/billing/sync`
- `POST /api/billing/deactivate-free`
- `POST /api/billing/hard-stop`
- `POST /api/billing/usage-cap`
- `POST /api/billing/validate-change`
- `GET /api/billing/history`

### 7.4 Internal routes

In `server/routes/internal.js`:

- `POST /internal/sync`
- `GET /internal/health`
- `POST /internal/uninstall`
- `POST /internal/shopify-order-update`
- privacy/compliance endpoints for Shopify data requests/redaction

### 7.5 WhatsApp routes

In `server/routes/whatsappWebhook.js`:

- `GET /whatsapp/webhook`
- `POST /whatsapp/webhook`

In `server/routes/waLinks.js`:

- `GET /wa/confirm`
- `GET /wa/cancel`

## 8. Shopify integration

### 8.1 Shopify app config

From `builderdev/shopify.app.toml`:

- app name: `OrderX`
- application URL: `https://app.orderxapp.com`
- backend API URL: `https://api.orderxapp.com`
- embedded app: yes
- auth callback: `https://app.orderxapp.com/app-auth/callback`

Configured Shopify app webhooks:

- `app/uninstalled`
- `app/scopes_update`
- `fulfillments/create`
- `fulfillments/update`
- `orders/cancelled`
- compliance topics

Configured access scopes:

- `read_fulfillments`
- `read_customers`
- `write_order_edits`
- `read_order_edits`
- `read_orders`
- `write_orders`

### 8.2 Important Shopify behavior

Important comment in `server/index.js` and `server/services/codFlow.js`:

- order detection is polling-based for MVP because protected customer data restrictions can limit full webhook use for order creation/update flows
- fulfillment and cancelled-order webhooks are used for Smart order updates

## 9. WhatsApp capabilities

Main WhatsApp service file:

- `server/services/whatsapp.js`

Supported WhatsApp behaviors in code:

- send confirmation templates
- send delivery failed / re-deliver style templates
- send order update templates:
  - dispatched
  - tracking updated
  - cancelled
  - generic order update
- send freeform text where permitted
- write outbound/inbound message logs
- track sender mode and phone number id used
- store estimated Meta cost and usage pricing basis in message logs

## 10. Smart order updates

Main service:

- `server/services/orderUpdates.js`

Supported event types:

- dispatched
- tracking updated
- cancelled

Characteristics:

- deduplicated with `OrderUpdateDispatch`
- can use template or freeform channel depending on conditions
- checks recent inbound/session state when needed
- links each dispatch back to attempts/order/phone where possible

## 11. Background jobs

Main job definitions:

- `server/jobs/definitions.js`

Responsibilities include:

- attempt COD confirmation jobs
- billing sync jobs
- retry/backoff scheduling
- BYON token refresh orchestration
- queue release logic after attempts resolve
- auto-expiration / auto-cancel windows

Important constants/behavior from code:

- retry backoff is progressive
- send locks exist to reduce duplicate sending
- billing sync TTL exists
- BYON token refresh has lead/cooldown controls

## 12. Data model summary

### 12.1 `Shop`

Main store-level record. Tracks:

- Shopify shop domain
- Shopify offline access token
- store country/currency context
- merchant settings
- billing state
- diagnostics state
- sender configuration and own-number onboarding data

### 12.2 `CodAttempt`

Main confirmation attempt record. Tracks:

- order identity
- customer phone
- scheduling
- WhatsApp send state
- sender mode
- duplicate and phone-queue orchestration
- change request flow
- errors and retries
- secure confirm/cancel token hashes

### 12.3 `WaMessageLog`

Stores WhatsApp message activity. Tracks:

- outbound/inbound direction
- phone number and sender mode
- template names
- Meta and billing metadata
- attempt and order linkage

### 12.4 `BillingUsageCharge`

Stores metered Shopify usage charge records. Tracks:

- usage charge amount
- pricing basis
- billing cycle
- idempotency key
- status such as pending/settled/failed/skipped

### 12.5 `Metric`

Daily merchant metrics. Tracks:

- WhatsApp messages sent
- template messages sent
- saved orders
- saved revenue

### 12.6 `ConversationInitiation`

Tracks 24-hour initiation/session usage scope by sender mode.

### 12.7 `OrderUpdateDispatch`

Deduped ledger for Smart order updates.

### 12.8 `PlanPurchase`

Historical subscription records synced from Shopify billing.

### 12.9 `BlockedContact`

Per-shop blocklist for opted-out or blocked numbers.

### 12.10 `AuditLog`

Activity and audit trail for actions like settings saves, billing events, and BYON flow updates.

### 12.11 `CountryMessageRate`

Country-by-country pricing source for Growth and BYON estimates.

### 12.12 `AppRuntimeConfig`

Singleton runtime config for app-level limits like initiated conversation allowances.

## 13. Important business rules

These are especially useful for an AI assistant.

### 13.1 Sender-mode enforcement

- sender ownership is enforced by billing plan and merchant preference
- when billing is active, plan sender mode is authoritative
- when billing is inactive, merchant preference can drive onboarding/test state

### 13.2 BYON template cap behavior

- BYON 1000 plan has a hard cap of `1000` template messages per billing cycle
- unlimited BYON has no OrderX-side template cap
- when near cap or at cap, UI prompts the merchant to upgrade

### 13.3 Growth usage behavior

- Growth uses Shopify metered billing
- charges are per outbound message
- recipient-country pricing applies
- store-country baseline is used in UI for planning
- usage cap is enforced

### 13.4 Free plan behavior

- free plan includes a fixed limited number of template messages
- when cap is reached, sending is blocked until upgrade

### 13.5 Working-hours and scheduling behavior

- attempts are delayed according to merchant settings
- attempts are constrained by merchant work window
- old orders can be skipped based on max attempt age

### 13.6 Queueing and deduplication

- duplicate-order handling exists
- same-phone sequential queueing exists
- order update deduplication exists
- billing usage charge idempotency exists

### 13.7 BYON readiness should not be inferred from code verification alone

Current readiness logic reflects the recent registration fixes:

- if phone metadata says the number is Cloud-connected, the app should not claim registration failed just because `codeVerificationStatus` is `NOT_VERIFIED`
- actual Graph register errors are stored separately
- approved templates + webhook readiness + connected Cloud metadata are used for readiness

## 14. Admin and diagnostics surface

Admin routes exist for:

- auth/session
- dashboard summary
- stores list and store details
- message logs
- attempts
- billing charges and purchases
- billing overview
- OrderX operations
- BYON status
- order updates
- audit logs
- blocked contacts
- conversation initiations
- country pricing
- runtime config

Diagnostics available in merchant UI/backend include:

- Shopify access checks
- order access blocked signals
- sender diagnostics
- audit feed

## 15. Security and operational controls

Visible protections from source code:

- security headers middleware
- CORS allowlist builder
- suspicious payload rejection
- JSON body size limit
- IP rate limiting for global/auth/internal/public webhook routes
- internal routes protected with internal auth
- webhook verification logic exists for WhatsApp and Twilio-specific flows
- app disables `x-powered-by`
- trust proxy enabled for production deployments behind proxies/CDNs

## 16. Current stack

### Frontend

- React 18
- React Router 7
- Shopify App Bridge React
- Shopify app React Router package
- Prisma session storage
- Vite
- TypeScript tooling

### Backend

- Express 5
- MongoDB / Mongoose
- Agenda jobs
- Axios and node-fetch
- Shopify API package
- Twilio package present

## 17. Key service modules and what they do

- `server/services/plans.js`
  - plan catalog, sender modes, billing types, trial constants
- `server/services/billing.js`
  - billing status and plan resolution
- `server/services/shopifyBillingSync.js`
  - sync billing data from Shopify into local state
- `server/services/shopifyUsageBilling.js`
  - create Shopify usage charges for metered Growth plan
- `server/services/countryPricing.js`
  - country-level Growth and BYON pricing rules
- `server/services/usage.js`
  - enforce sending allowance, usage caps, conversation-window usage
- `server/services/metaByonAuth.js`
  - Meta BYON auth/token flows
- `server/services/ownNumberRegistration.js`
  - BYON Cloud registration readiness helpers
- `server/services/whatsapp.js`
  - send WhatsApp templates/text and resolve runtime sender config
- `server/services/orderUpdates.js`
  - Smart order update sending and dedupe
- `server/services/attemptActions.js`
  - attempt-side actions and outcomes
- `server/services/attemptQueueRelease.js`
  - queue release after resolution
- `server/services/waSessionWindow.js`
  - recent inbound/session-window logic
- `server/services/shopifyAdmin.js`
  - Shopify Admin API helpers
- `server/services/adminAnalytics.js`
  - admin-side analytics datasets
- `server/services/adminExplorers.js`
  - admin explorer and analytics helpers

## 18. Suggested assistant behavior for a OrderX AI assistant

An assistant trained on OrderX should know how to help merchants with:

- choosing between OrderX Number and Your Own Number
- understanding plans and pricing
- explaining why a sender is blocked or not ready
- explaining template approval state
- explaining Growth metered billing and country pricing
- explaining BYON template caps and upgrade path
- explaining order confirmation attempt statuses
- explaining Smart order updates
- interpreting diagnostics and sender-state badges

Recommended tone:

- operational, simple, merchant-friendly
- no deep developer jargon unless the user is technical
- explain current sender mode, current plan, current blocker, and next step

Recommended guardrails:

- never expose secrets, tokens, PINs, or hidden env vars
- never invent live billing totals or template statuses without data
- distinguish between:
  - OrderX charges
  - Meta charges
  - Shopify subscription state
- avoid claiming BYON is ready unless sender data confirms it

## 19. Useful glossary for the AI assistant

- `COD`: cash on delivery
- `BYON`: Bring Your Own Number
- `WABA`: WhatsApp Business Account
- `phone_number_id`: Meta/WhatsApp Cloud phone number identifier
- `sender mode`: whether OrderX sends through its own number or the merchant's number
- `template sync`: refresh the template approval state from Meta
- `webhook test`: validate inbound message/webhook loop for merchant own number
- `Growth`: OrderX managed-number metered plan
- `ready`: sender can be used for live automation
- `templates_pending`: Meta templates exist but are not all approved
- `registration_pending`: Cloud-side sender setup is incomplete or unresolved
- `reauth_required`: Meta token missing or expired; merchant must reconnect

## 20. What is not included in this knowledge pack

This file does not include:

- live merchant/customer databases
- Shopify tokens
- Meta access tokens
- registration PINs
- actual production logs
- exact environment variable values

If a future training pipeline needs those, they must be pulled separately and handled securely.

## 21. Best next training artifacts to build

If you want to improve an internal OrderX AI assistant further, the best follow-up assets would be:

- a FAQ dataset built from real merchant support questions
- a sender-status playbook mapping each status to the exact next action
- a plan/pricing JSON export for direct retrieval
- a route/endpoint schema export for technical support use
- a glossary of Shopify + Meta + OrderX terms
- anonymized examples of real attempt histories and error resolutions
