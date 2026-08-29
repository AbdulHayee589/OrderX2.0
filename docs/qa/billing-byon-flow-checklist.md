# OrderX QA Checklist (BYON + OrderX Number)

## Preconditions
- Backend is running on public HTTPS URL.
- Embedded app is running and can call backend.
- Meta app webhook callback URL and verify token are set.
- Fresh test shop is installed.

## 1) Fresh BYON (billing inactive)
1. Go to `Plans` and switch to **Your Own Number** mode.
2. Complete Step 1 (Meta connect).
3. Complete Step 2 (Meta payment method confirmation).
4. Purchase a BYON package.
5. Run the template provisioning/sync step.
6. Confirm dashboard access is available even while templates are still `pending`/`in review`.

Expected:
- BYON package buttons become available after Meta connect + payment step
- dashboard remains accessible while templates are pending
- warning banner explains that automation starts after template approval
- once Meta approves the full required template pack, `ownNumber.status = ready`

## 2) BYON purchase guardrails
1. Reset BYON setup.
2. Attempt BYON package purchase directly (UI + API path).
3. Confirm purchase is blocked with onboarding-incomplete error.
4. Complete Meta connect + payment step and retry.

Expected:
- Before completion: blocked (`BYON_ONBOARDING_INCOMPLETE`)
- After completion: purchase flow allowed

## 3) BYON usage model
1. Activate BYON package.
2. Confirm no monthly OrderX cap blocking.
3. Set BYON 24h initiated cap in Settings (default 1000).
4. Send template messages to new unique numbers and verify cap decreases.
5. Send multiple messages to same number within 24h and verify it does not consume a new initiation.

Expected:
- BYON limit enforced by unique initiated conversations in 24h only
- no monthly cap rejection for BYON

## 4) OrderX number behavior
1. Switch to OrderX package.
2. Confirm existing monthly plan behavior remains.
3. Validate OrderX global initiated-24h cap (2000 default) works on template sends.

Expected:
- monthly + global initiated cap checks apply on OrderX mode

## 5) Webhook round-trip (merchant replies)
1. Confirm merchant WABA is app-subscribed (`webhookSubscribedAt` exists in sender payload).
2. Send an outbound message from merchant sender.
3. Reply from recipient WhatsApp.
4. Verify backend receives webhook event and updates attempt/message logs.

Expected:
- inbound webhook hits `/whatsapp/webhook`
- action handling triggers (confirm/cancel/request changes) where applicable

## 6) Regression checks
1. Billing inactive + BYON started should show BYON as current setup (not stale OrderX).
2. Cancelling a paid plan should stop access immediately.
3. Settings save should persist `byonMaxInitiatedConversations24h`.
