import mongoose from "mongoose";

const AutomationFlowSchema = new mongoose.Schema(
  {
    flowKey: { type: String, default: "" },
    enabled: { type: Boolean, default: false },
    templateId: { type: String, default: null },
    templateKey: { type: String, default: null },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const SettingsSchema = new mongoose.Schema(
  {
    confirmationDelayMin: { type: Number, default: 0 },
    confirmationMode: { type: String, default: "manual_whatsapp" }, // manual_whatsapp | whatsapp_api | ivr_call
    orderPollingScope: { type: String, default: "all_orders" }, // all_orders | cod_only
    workStartHour: { type: Number, default: 0 },
    workEndHour: { type: Number, default: 23 },

    // We are WhatsApp-only to keep costs predictable.
    enableWhatsApp: { type: Boolean, default: true },

    // Merchant support number shown to customers in messages
    // (so they can contact the store after confirming/cancelling).
    supportWhatsAppNumber: { type: String, default: "" },
    confirmReplyText: { type: String, default: "" },
    cancelReplyText: { type: String, default: "" },

    // Rules (free features)
    // Skip sending if the order contains ANY of these tags.
    skipOrderTags: { type: [String], default: [] },
    // If set: only send to these ISO2 country codes (e.g. ["US","CA"])
    includeCountries: { type: [String], default: [] },
    // Always skip these ISO2 country codes.
    excludeCountries: { type: [String], default: [] },
    // Stop retrying / sending for very old orders (prevents spam + wasted jobs).
    maxAttemptAgeHours: { type: Number, default: 72 },
    byonMaxInitiatedConversations24h: { type: Number, default: 250 },

    autoCancelUnconfirmed: { type: Boolean, default: false },
    autoTagOrders: { type: Boolean, default: true },
    applyRequestedChangesToOrder: { type: Boolean, default: false },

    // Shopify-only post-confirmation order updates (MVP)
    enableOrderUpdates: { type: Boolean, default: false },
    orderUpdatesScope: { type: String, default: "all_orders" }, // all_orders | confirmed_only
    orderUpdatesDispatched: { type: Boolean, default: true },
    orderUpdatesTrackingUpdated: { type: Boolean, default: true },
    orderUpdatesCancelled: { type: Boolean, default: true },

    // Scalable template-driven automation settings.
    automationFlows: { type: [AutomationFlowSchema], default: [] },
    reviewRequestUrl: { type: String, default: "" },
    reviewRequestDelayHours: { type: Number, default: 96 },
    reviewRequestLinkMode: { type: String, default: "store" },
    abandonedCartDelayMinutes: { type: Number, default: 90 },
  },
  { _id: false },
);

const BillingSchema = new mongoose.Schema(
  {
    planKey: { type: String, default: "orderx_free_5" },
    status: { type: String, default: "NONE" }, // NONE | TRIAL | ACTIVE | CANCELLED
    subscriptionId: { type: String, default: null },
    subscriptionTest: { type: Boolean, default: false },
    usageSubscriptionLineItemId: { type: String, default: null },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    cycleAnchorAt: { type: Date, default: null },
    trialDays: { type: Number, default: 3 },
    trialStartedAt: { type: Date, default: null },
    trialEndsAt: { type: Date, default: null },
    trialUsed: { type: Boolean, default: false },
    trialMessagesUsed: { type: Number, default: 0 },
    trialMessageCap: { type: Number, default: 10 },
    byonTrialUsed: { type: Boolean, default: false },
    byonTrialStartedAt: { type: Date, default: null },
    byonTrialEndsAt: { type: Date, default: null },
    byonTrialMessagesUsed: { type: Number, default: 0 },
    byonTrialMessageCap: { type: Number, default: 200 },
    freeConfirmationMessagesUsed: { type: Number, default: 0 },
    freeConfirmationCap: { type: Number, default: 10 },
    usageCappedAmount: { type: Number, default: null },
    usageCappedCurrencyCode: { type: String, default: null },
    usageBalanceUsedAmount: { type: Number, default: 0 },
    usageBalanceUsedCurrencyCode: { type: String, default: null },
    usageChargeLockUntil: { type: Date, default: null },
    usageChargeLockKey: { type: String, default: null },
    usageBatchLockUntil: { type: Date, default: null },
    // Legacy lock retained for already-stored documents during rollout.
    pakistanBatchLockUntil: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    hardStoppedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    forcedTestBillingAllowed: { type: Boolean, default: false },
    shopifyShopPlanName: { type: String, default: null },
    shopifyShopPlanPartnerDevelopment: { type: Boolean, default: false },
    shopifyShopPlanShopifyPlus: { type: Boolean, default: false },
  },
  { _id: false },
);

const DiagnosticsSchema = new mongoose.Schema(
  {
    // If Shopify blocks Orders/Customers access due to Protected Customer Data approval,
    // we persist that here so we can surface a clear message in the UI and avoid noisy polling logs.
    orderAccessBlocked: { type: Boolean, default: false },
    orderAccessBlockedAt: { type: Date, default: null },
    orderAccessError: { type: String, default: null },
    orderAccessErrorAt: { type: Date, default: null },

    // Manual "Run diagnostics" checks from the embedded app.
    shopifyAccessOk: { type: Boolean, default: null },
    shopifyAccessCheckedAt: { type: Date, default: null },
    shopifyAccessError: { type: String, default: null },
    shopifyAccessErrorAt: { type: Date, default: null },
  },
  { _id: false },
);

const SenderTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, default: "" },
    templateName: { type: String, default: "" },
    language: { type: String, default: "en" },
    status: { type: String, default: "missing" }, // missing | pending | approved | rejected
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { _id: false },
);

const ManagedTemplateButtonSchema = new mongoose.Schema(
  {
    type: { type: String, default: "QUICK_REPLY" },
    text: { type: String, default: "" },
    url: { type: String, default: "" },
    responseText: { type: String, default: "" },
    tag: { type: String, default: "" },
    index: { type: Number, default: 0 },
    action: { type: String, default: null },
    allowedTypes: { type: [String], default: ["QUICK_REPLY"] },
  },
  { _id: false },
);

const ManagedTemplateSchema = new mongoose.Schema(
  {
    id: { type: String, default: "" },
    flowKey: { type: String, default: "" },
    templateKey: { type: String, default: null },
    source: { type: String, default: "merchant_custom" },
    originTemplateId: { type: String, default: null },
    displayName: { type: String, default: "" },
    metaTemplateName: { type: String, default: "" },
    metaTemplateId: { type: String, default: null },
    language: { type: String, default: "en" },
    category: { type: String, default: "UTILITY" },
    headerType: { type: String, default: "TEXT" },
    headerText: { type: String, default: "" },
    sampleMediaUrl: { type: String, default: "" },
    useProductImageHeader: { type: Boolean, default: false },
    bodyText: { type: String, default: "" },
    footerText: { type: String, default: "" },
    buttons: { type: [ManagedTemplateButtonSchema], default: [] },
    buttonPolicy: { type: String, default: "none" },
    status: { type: String, default: "draft" },
    rawStatus: { type: String, default: "DRAFT" },
    rejectionReason: { type: String, default: null },
    qualityScore: { type: mongoose.Schema.Types.Mixed, default: null },
    lastSyncedAt: { type: Date, default: null },
    lastUpdatedTime: { type: Date, default: null },
    lastError: { type: String, default: null },
    testMessageTargetPhoneE164: { type: String, default: "" },
    testMessageOutboundMessageId: { type: String, default: null },
    testMessageSentAt: { type: Date, default: null },
    testMessageStatus: { type: String, default: null },
    testMessageStatusAt: { type: Date, default: null },
    testMessageLastError: { type: String, default: null },
    testMessageLastErrorAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
  },
  { _id: false, timestamps: true },
);

const OwnNumberSenderSchema = new mongoose.Schema(
  {
    status: { type: String, default: "not_started" }, // not_started | collecting_details | meta_connect_pending | templates_pending | ready | reauth_required | error
    businessName: { type: String, default: "" },
    contactName: { type: String, default: "" },
    contactEmail: { type: String, default: "" },
    requestedPhoneNumber: { type: String, default: "" },
    displayPhoneNumber: { type: String, default: "" },
    metaBusinessId: { type: String, default: null },
    wabaId: { type: String, default: null },
    phoneNumberId: { type: String, default: null },
    metaFeatureType: { type: String, default: null },
    accessToken: { type: String, default: null }, // Merchant WABA sender token (server-side only)
    accessTokenUpdatedAt: { type: Date, default: null },
    accessTokenExpiresAt: { type: Date, default: null },
    accessTokenRefreshAttemptedAt: { type: Date, default: null },
    accessTokenRefreshError: { type: String, default: null },
    accessTokenRefreshErrorAt: { type: Date, default: null },
    registrationStatus: { type: String, default: "unknown" }, // unknown | registered | failed
    registrationOutcome: { type: String, default: null }, // READY | NEED_PIN | NEED_RECONNECT | NEED_CORRECT_NUMBER | META_TEMP_ERROR | META_HARD_ERROR
    registrationPin: { type: String, default: null }, // server-only; never return to client
    registrationLastAttemptAt: { type: Date, default: null },
    registrationError: { type: String, default: null },
    registrationErrorAt: { type: Date, default: null },
    registrationRegisteredAt: { type: Date, default: null },
    registrationDisplayPhoneNumber: { type: String, default: null },
    registrationVerifiedName: { type: String, default: null },
    registrationCodeVerificationStatus: { type: String, default: null },
    registrationPlatformType: { type: String, default: null },
    registrationPhoneStatus: { type: String, default: null },
    registrationAccountMode: { type: String, default: null },
    registrationLastMetadataAt: { type: Date, default: null },
    webhookSubscribedAt: { type: Date, default: null },
    webhookSubscriptionError: { type: String, default: null },
    webhookSubscriptionErrorAt: { type: Date, default: null },
    paymentMethodConfirmedAt: { type: Date, default: null },
    webhookTestStatus: { type: String, default: "not_started" }, // not_started | waiting_reply | received | failed
    webhookTestTargetPhoneE164: { type: String, default: "" },
    webhookTestExpectedReplyCode: { type: String, default: "" },
    webhookTestSentAt: { type: Date, default: null },
    webhookTestOutboundMessageId: { type: String, default: null },
    webhookTestReplyReceivedAt: { type: Date, default: null },
    webhookTestReplyMessageId: { type: String, default: null },
    webhookTestReplyText: { type: String, default: "" },
    webhookTestLastError: { type: String, default: null },
    webhookTestLastErrorAt: { type: Date, default: null },
    sendErrorStreak: { type: Number, default: 0 },
    sendFailureEvents: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, default: "" },
            at: { type: Date, default: null },
            kind: { type: String, default: null },
            reason: { type: String, default: null },
            code: { type: Number, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    lastSendError: { type: String, default: null },
    lastSendErrorMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    lastSendErrorAt: { type: Date, default: null },
    pauseSending: { type: Boolean, default: false },
    pauseReason: { type: String, default: null },
    pauseSetAt: { type: Date, default: null },
    testMessageSentAt: { type: Date, default: null },
    testMessageTargetPhoneE164: { type: String, default: "" },
    testMessageOutboundMessageId: { type: String, default: null },
    testMessageStatus: { type: String, default: "not_started" }, // not_started | queued | sent | delivered | read | failed
    testMessageStatusAt: { type: Date, default: null },
    testMessageLastError: { type: String, default: null },
    testMessageLastErrorMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    testMessageLastErrorAt: { type: Date, default: null },
    onboardingCompletedAt: { type: Date, default: null },
    pendingConnectState: { type: String, default: null },
    pendingConnectStateExpiresAt: { type: Date, default: null },
    lastCompletedConnectStateHash: { type: String, default: null },
    lastCompletedConnectAt: { type: Date, default: null },
    templatesLastSyncedAt: { type: Date, default: null },
    templateLanguage: { type: String, default: "en" },
    templates: { type: [SenderTemplateSchema], default: [] },
    managedTemplates: { type: [ManagedTemplateSchema], default: [] },
    managedTemplatesUpdatedAt: { type: Date, default: null },
    managedTemplatesStatusRefreshedAt: { type: Date, default: null },
    campaignLibraryTemplates: { type: [ManagedTemplateSchema], default: [] },
    campaignLibraryTemplatesUpdatedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    detailsSubmittedAt: { type: Date, default: null },
    metaConnectedAt: { type: Date, default: null },
    templatesReadyAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastErrorMeta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    lastErrorAt: { type: Date, default: null },
  },
  { _id: false },
);

const WhatsAppSenderSchema = new mongoose.Schema(
  {
    preferenceMode: { type: String, default: null }, // orderx_number | own_number
    activeMode: { type: String, default: null }, // set when sender is actually used
    ownNumber: { type: OwnNumberSenderSchema, default: () => ({}) },
  },
  { _id: false },
);

const ShopSchema = new mongoose.Schema(
  {
    shop: { type: String, unique: true, index: true }, // myshop.myshopify.com
    accessToken: { type: String, default: null }, // OFFLINE token
    accessTokenType: { type: String, default: "offline" }, // offline | online
    accessTokenUpdatedAt: { type: Date, default: null },
    accessTokenExpiresAt: { type: Date, default: null },
    accessTokenRefreshToken: { type: String, default: null },
    accessTokenRefreshTokenExpiresAt: { type: Date, default: null },
    accessTokenMigratedAt: { type: Date, default: null },
    accessTokenStatus: {
      type: String,
      enum: [
        "active",
        "legacy",
        "partial",
        "refreshing",
        "reauthorization_required",
        "revoked",
        "unknown",
      ],
      default: "unknown",
      index: true,
    },
    accessTokenVersion: { type: Number, default: 0 },
    accessTokenLastError: { type: String, default: null },
    accessTokenLastErrorAt: { type: Date, default: null },
    scopes: { type: String, default: "" },
    installedAt: { type: Date, default: Date.now },
    storeCountryCode: { type: String, default: null, index: true },
    storeCountryName: { type: String, default: null },
    storeCurrencyCode: { type: String, default: null },
    storeContextSyncedAt: { type: Date, default: null },

    settings: { type: SettingsSchema, default: () => ({}) },
    billing: { type: BillingSchema, default: () => ({}) },
    diagnostics: { type: DiagnosticsSchema, default: () => ({}) },
    whatsappSender: { type: WhatsAppSenderSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export default mongoose.model("Shop", ShopSchema);
