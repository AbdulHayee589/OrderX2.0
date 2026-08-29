# OrderX

OrderX is an embedded Shopify app for WhatsApp cash-on-delivery confirmation
and order automation.

## Launch availability

- OrderX Number and Your Own Number (BYON) are both available.
- OrderX Free includes 10 template messages.
- OrderX Growth is USD 2.99 per month plus country-based outbound usage.
- BYON includes in-app Meta onboarding, a free trial, paid packages, template
  setup, and sending through the merchant's own WhatsApp Business number.

BYON Meta onboarding requires `META_APP_ID`, `META_APP_SECRET`, and
`META_EMBEDDED_SIGNUP_CONFIG_ID` in `server/.env`.

OrderX uses WhatsApp Business App coexistence through
`META_EMBEDDED_SIGNUP_FEATURE_TYPE=whatsapp_business_app_onboarding`. The Meta
app must have the advanced WhatsApp management and messaging permissions that
Meta requires for coexistence onboarding.

## Project structure

- `builderdev/`: embedded Shopify frontend and web process.
- `server/`: API, billing, automation, jobs, and WhatsApp backend.
- `docs/`: architecture and QA notes.

The Shopify app configuration uses client ID
`7e3384419f778351adcc91535750b652`. Copy each `.env.example` to `.env` and
provide the environment-specific secrets before running locally or deploying.
The production frontend is `https://app.orderxapp.com` and the internal API
backend is `https://api.orderxapp.com`.
# OrderX2.0
