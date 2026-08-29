# OrderX Full Flow Audit (Shopify2.0)

Date: 2026-03-04

## Summary
This audit maps all major user-visible flows and validates branch behavior from code paths in:
- `server/jobs/pollCodOrders.js`
- `server/jobs/definitions.js`
- `server/routes/whatsappWebhook.js`
- `server/services/orderUpdates.js`
- `server/services/usage.js`
- `server/routes/api.js`
- `server/routes/billing.js`
- `server/services/shopifyBillingSync.js`

### Critical fixes applied during this audit
1. Queue-age fairness fix:
- `server/jobs/definitions.js`
- Max-age checks now use effective age (attempt age minus time spent in queue), so queued attempts are not unfairly skipped.

2. Expiry race/idempotency fix:
- `server/jobs/definitions.js`
- Expiry/tag-sync terminal transitions are now atomic (`findOneAndUpdate` with `status: "wa_sent"`) to prevent overwriting concurrent confirm/cancel actions.

3. Uninstall hard-stop consistency:
- `server/routes/internal.js`
- Uninstall now also stamps `billing.hardStoppedAt`, and clears renewal state.

## A) End-to-end flow map

### A1) COD confirmation flow (pre-dispatch + failed-delivery re-confirm)
1. Trigger: polling job finds eligible COD order
- Source: `poll_cod_orders`
- File: `server/jobs/pollCodOrders.js`
2. Attempt creation:
- Creates `CodAttempt` with stage (`pre_dispatch` or `post_failed_delivery`)
- Applies duplicate queue + phone queue role
3. Scheduled send execution:
- Job: `attempt_cod_confirmation`
- File: `server/jobs/definitions.js`
- Performs gates (billing, working hours, blocklist, queue lock, age, sender runtime)
4. WhatsApp send:
- Prefers freeform only when valid 23h session exists for same sender
- Otherwise uses template
- File: `server/jobs/definitions.js`, `server/services/whatsapp.js`
5. Customer action intake:
- Webhook receives interactive button/list/free text
- Resolves attempt by payload/context/sender/phone
- File: `server/routes/whatsappWebhook.js`
6. Terminal outcomes:
- `confirmed` / `cancelled` / `expired` / `failed` / `skipped`
- Queue release for next waiting attempt

### A2) Request-changes subflows
1. Trigger:
- User presses `Request Changes` quick reply
2. Type selector:
- list options: address, name, quantity, back
3. Detail capture:
- Free-text capture for selected kind
- Qty flow supports item selection for multi-line orders
4. Reconfirm:
- Rebuilds order summary with proposed changes
- Sends confirm/cancel/request changes buttons again
5. Resolution:
- Confirm => optional Shopify order edit apply (if enabled)
- Cancel => cancellation path

### A3) Duplicate/spam/queue/conversation safety
1. Duplicate fingerprinting:
- strict fingerprint: name+phone+email+currency+products+amount+address
- File: `server/jobs/pollCodOrders.js`
2. Duplicate queue:
- `duplicateRole` primary/queued
- released on terminal resolution
3. Phone queue (sender-scoped):
- `phoneQueueGroupId` is keyed by shop + phone + senderQueueKey
- senderQueueKey includes sender mode + sender phone identity
- prevents cross-sender queue collisions
4. Conversation and billing gates:
- `canSendWhatsApp` checks billing active/trial, BYON readiness, initiation limits
- BYON: initiated unique conversations / 24h limit (merchant configurable)
- OrderX number: global initiated/24h + monthly plan caps

### A4) Tracking/order update flow
1. Trigger:
- Shopify webhooks: `fulfillments/create`, `fulfillments/update`, `orders/cancelled`
- Forwarded to backend `/internal/shopify-order-update`
2. Dedupe:
- `OrderUpdateDispatch` dedupe key by event shape/fingerprint
3. Send channel decision:
- If 23h session exists for same sender -> freeform
- Else -> template update message
4. Terminal:
- Dispatch status `sent` or `failed` with structured metadata

### A5) Onboarding and sender modes

#### OrderX managed number
- Default mode for OrderX plans
- Uses shared env sender credentials
- Monthly plan + global initiation limit gates

#### BYON (own number)
1. Step 1: merchant details
2. Step 2: Meta connect (embedded signup finalize)
3. Step 3: template provisioning/sync
4. Live test + webhook reply verification
5. onboarding complete -> BYON package purchase allowed

Server actions primarily in `server/routes/api.js`:
- `/sender/byon/start`
- `/sender/byon/details`
- `/sender/byon/meta-connect/begin`
- `/sender/byon/meta-connect/finalize`
- `/sender/byon/templates/provision`
- `/sender/byon/templates/sync`
- `/sender/byon/test-send`
- `/sender/byon/test-status/check`
- `/sender/byon/webhook-test/check`

## B) Per-flow branch model

### B1) COD confirmation
Trigger(s):
- `poll_cod_orders` creates attempt and schedules job
- manual retry `/api/attempts/trigger`

Required preconditions:
- Shop has access token
- Billing active/trial
- WhatsApp enabled
- Not blocked by tag/country/blocklist
- Attempt not terminal

State transitions:
- `scheduled -> pending -> wa_sent -> confirmed/cancelled/expired`
- Failure/retry: `pending -> scheduled` (backoff)
- hard failure: `pending -> failed`
- gating failure: `pending -> scheduled` or `pending -> skipped`

Branches:
- Session window open -> freeform buttons
- Session window closed -> template
- Queue blocked by older attempt -> `phone_queued`
- Duplicate candidate -> duplicate queue behavior

External dependencies + failure behavior:
- Shopify Admin GraphQL (order details/tags): logs and continues where safe
- Meta send API: retries with backoff; BYON sender can be paused after error streak
- Agenda scheduling: reschedules retry path

### B2) Request changes
Trigger(s):
- interactive payload `request_changes:*`
- typed fallback (`Request Changes`)

Required preconditions:
- Attempt exists, sender+phone match, non-terminal

State transitions:
- `none -> choose_type -> awaiting_details -> reconfirm_sent -> (confirmed|cancelled)`

Branches:
- address/name path
- qty single-item path
- qty multi-item select path
- invalid qty path (re-prompt)
- back path (returns to confirmation buttons)

External failure behavior:
- Shopify fetch failure -> fallback list prompt and continue
- WhatsApp send failure -> logs and does not crash webhook pipeline

### B3) Duplicate + queue safety
Trigger(s):
- new polled order candidate creation

Preconditions:
- matching fingerprint for duplicate branch
- same phone + same sender queue key for phone queue branch

State transitions:
- `duplicateRole: none/primary/queued`
- `phoneQueueRole: none/primary/queued`
- queued attempts released on source terminal state

Branches:
- existing open duplicate primary
- recent resolved duplicate reference
- new duplicate group
- no duplicate

External failure behavior:
- Shopify tag add failures are non-fatal (logged)

### B4) Tracking/order updates
Trigger(s):
- internal forwarded webhooks

Preconditions:
- updates enabled globally and event-specific toggle enabled
- matching cod attempt with phone
- billing + usage gate pass

State transitions:
- `OrderUpdateDispatch: processing -> sent|skipped|failed`

Branches:
- dispatched/tracking/cancelled template variants
- freeform vs template based on session window
- dedupe key already seen -> ignored

External failure behavior:
- send failure marks dispatch failed with error meta

### B5) Onboarding/billing mode switching
Trigger(s):
- app UI actions from `app._index`, `app.plans`, `app.settings`

Preconditions:
- BYON purchase guarded by onboarding complete checks
- sender mode enforced by active billing plan

State transitions:
- ownNumber statuses: `not_started -> meta_connect_pending -> templates_pending -> ready -> reauth_required`
- billing statuses: `TRIAL/ACTIVE/NONE` + `cancelAtPeriodEnd` + `hardStoppedAt`

Branches:
- billing active: plan sender mode is source of truth
- billing inactive: preference mode drives onboarding UI
- hard stop: immediate blocked state

External failure behavior:
- Shopify billing check/request exceptions surfaced to UI
- Meta token refresh failures mark reauth-required path where needed

## C) Logic bugs + risk areas

### Fixed
1. Queued-attempt unfair skip bug
- Fixed by effective age calculation excluding queue wait windows.

2. Expiry race condition
- Fixed by atomic transition guards during tag-sync and expiry transitions.

3. Uninstall consistency
- Hard stop timestamp now set on uninstall to keep billing state deterministic.

### Remaining risk areas to monitor
1. Webhook action ambiguity in free-text without context
- Current mitigation exists (ambiguous prompt), but still dependent on user tapping correct thread.

2. Time-window assumptions
- Session-window behavior depends on inbound logs and webhook delivery integrity; monitor missing inbound webhook cases.

3. External API partial failure
- Some send paths continue after Shopify fetch/tag failures by design; ensure this matches product expectations.

4. High debug log volume
- Worker paths still contain heavy `console.log` traces; can obscure production incident triage.

## D) Minimal branch-complete test matrix

Use 3 shops:
- `shop_orderx_active`
- `shop_byon_ready`
- `shop_byon_onboarding`

Use 3 customer phones:
- `A` same-number repeated orders
- `B` no inbound session
- `C` inbound session exists

### D1) Core confirmation matrix
1. New COD order, no session, billing active -> template send, `wa_sent`
2. New COD order, session exists for same sender -> freeform send
3. Billing inactive -> attempt not created/sent
4. Blocklisted phone -> skipped
5. Outside working hours -> scheduled to next window
6. Send transient error -> retry scheduled with backoff
7. Send permanent auth error BYON -> reauth-required path

### D2) Queue + duplicate matrix
8. Same phone, two orders, first unresolved -> second queued
9. First resolved -> second auto-released and sent
10. First expires after 48h -> second still eligible if only queue time made it old
11. Duplicate fingerprint pair -> primary+queued tags/roles correct
12. Duplicate queued release after primary resolve
13. Same customer phone replies to two different sender numbers -> correct attempt only (sender ID match)

### D3) Request changes matrix
14. Request changes -> choose type list sent
15. Change address -> reconfirm content reflects new address
16. Change name -> reconfirm reflects new name
17. Qty single-item -> numeric capture + amount recalculation
18. Qty multi-item -> selection then numeric capture
19. Invalid qty (non-digit/out-of-range) -> invalid prompt loop
20. Back action -> returns to confirmation buttons

### D4) Tracking update matrix
21. fulfillment/create dedupe first event -> sent once
22. duplicate fulfillment/create webhook -> deduped, no second send
23. fulfillment/update with tracking fingerprint changes -> tracking updated send
24. orders/cancelled -> cancel update send
25. order updates disabled -> skipped dispatch status

### D5) BYON onboarding + billing matrix
26. BYON start/details/meta finalize with waba+phone success path
27. Templates provision -> in_review/approved sync mapping
28. Live test send success updates `testMessageStatus`
29. Reply on same thread updates `webhookTestStatus=received`
30. Onboarding complete only when delivery success + webhook reply success
31. BYON plan purchase blocked when onboarding incomplete
32. BYON plan purchase success then sender mode enforced as own_number
33. Cancel renewal then hard stop -> immediate blocked sending
34. Uninstall webhook -> hard stop + no token + no sending

## E) Fixtures/mocks and assertions

### Required mocks
- Shopify Admin GraphQL responses:
  - recent orders poll
  - order details/tags fetch
  - tag append/order edit
- Meta API responses:
  - template send success/failure
  - status callbacks (sent/delivered/read/failed)
  - registration needed/rate-limited/transient
- Webhook payload fixtures:
  - interactive button/list replies
  - free-text replies
  - status events with receiver phone id

### Assertions
- DB state:
  - `CodAttempt` status transitions and timestamps
  - queue fields (`phoneQueueRole`, `phoneQueuedAt`, `phoneReleasedAt`, `senderQueueKey`)
  - `Shop.whatsappSender.ownNumber` progress/error fields
  - `OrderUpdateDispatch` dedupe + final status
  - `WaMessageLog` inbound/outbound sender scoping
- Side effects:
  - Agenda jobs scheduled count and target time
  - Shopify tags appended exactly once per event
  - usage counters increment only on successful sends

## F) Testability architecture improvements

1. Introduce explicit state machines (pure transition reducers)
- `CodAttempt` lifecycle machine in `server/services/attemptStateMachine.js`
- BYON onboarding machine in `server/services/byonStateMachine.js`
- Use guards + transition tests independent of DB.

2. Isolate side effects behind ports
- Create adapters:
  - `ports/metaClient`
  - `ports/shopifyClient`
  - `ports/jobScheduler`
  - `ports/repository`
- Business logic then runs as pure orchestration functions.

3. Add correlation IDs and structured logs
- Add `traceId` per inbound webhook/job execution and persist in:
  - audit log entries
  - WaMessageLog meta
  - dispatch/attempt error meta
- Emit JSON logs with stable keys (`flow`, `attemptId`, `shop`, `senderPhoneNumberId`, `eventType`, `traceId`).

4. Add deterministic clock injection
- Replace direct `Date.now()` usage in transition-heavy logic with injected clock helpers.
- Enables stable unit tests for 23h and 48h windows.

5. Add branch-focused integration tests
- Focus first on:
  - queue fairness
  - expiry races
  - sender-scoped inbound matching
  - BYON completion gating
