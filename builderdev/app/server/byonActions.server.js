import { backendPost } from "./backend.server";

const toObject = (v) => (v && typeof v === "object" ? v : {});
const META_FEATURE_TYPE_WABA_APP = "whatsapp_business_app_onboarding";

function normalizeMetaFeatureType(value) {
  const normalized = String(value || "").trim();
  return normalized === META_FEATURE_TYPE_WABA_APP
    ? META_FEATURE_TYPE_WABA_APP
    : "";
}

function buildMetaConnectLaunchPayload(begin, options = {}) {
  const meta = toObject(begin?.meta);
  const appId = String(meta?.appId || "").trim();
  const configId = String(meta?.configId || "").trim();
  const solutionId = String(meta?.solutionId || "").trim();
  const apiVersion = String(meta?.apiVersion || "v25.0").trim();
  const state = String(begin?.state || "").trim();
  if (!appId || !configId || !state) {
    return {
      ok: false,
      error: "Meta Embedded Signup is not configured correctly",
    };
  }

  const featureType = normalizeMetaFeatureType(
    meta?.featureType ?? options.featureType,
  );

  return {
    ok: true,
    metaConnect: {
      appId,
      configId,
      solutionId,
      apiVersion,
      state,
      expiresAt: begin?.expiresAt || null,
      featureType,
      redirectUri: "",
    },
  };
}

export async function handleByonRouteAction({
  intent,
  form,
  shop,
  requestUrl,
}) {
  if (!String(intent || "").startsWith("byon_")) return null;

  if (intent === "byon_start") {
    try {
      const resp = await backendPost("/api/sender/byon/start", shop, {});
      return { ok: true, intent, sender: resp?.sender || null };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to start own-number setup",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_save_details") {
    const payload = {
      businessName: String(form.get("byonBusinessName") || "").trim(),
      contactName: String(form.get("byonContactName") || "").trim(),
      contactEmail: String(form.get("byonContactEmail") || "").trim(),
      requestedPhoneNumber: String(
        form.get("byonRequestedPhoneNumber") || "",
      ).trim(),
    };
    try {
      const resp = await backendPost("/api/sender/byon/details", shop, payload);
      return { ok: true, intent, sender: resp?.sender || null };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to save own-number setup details",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_reset") {
    try {
      const resp = await backendPost("/api/sender/byon/reset", shop, {});
      return { ok: true, intent, sender: resp?.sender || null };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to reset own-number setup",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_templates_provision") {
    try {
      const resp = await backendPost(
        "/api/sender/byon/templates/provision",
        shop,
        {},
      );
      return {
        ok: true,
        intent,
        sender: resp?.sender || null,
        note: resp?.note || null,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to prepare template provisioning",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_templates_sync") {
    try {
      const resp = await backendPost(
        "/api/sender/byon/templates/sync",
        shop,
        {},
      );
      return { ok: true, intent, sender: resp?.sender || null };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to sync template statuses",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_confirm_payment_method") {
    try {
      const registrationPin = String(form.get("registrationPin") || "").trim();
      const resp = await backendPost(
        "/api/sender/byon/payment-method/confirm",
        shop,
        { registrationPin },
      );
      return { ok: true, intent, sender: resp?.sender || null };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to save Meta payment confirmation",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_meta_connect_begin") {
    try {
      const begin = await backendPost(
        "/api/sender/byon/meta-connect/begin",
        shop,
        {
          featureType: String(form.get("metaFeatureType") || "").trim(),
        },
      );
      const prepared = buildMetaConnectLaunchPayload(begin, {
        featureType: form.get("metaFeatureType"),
        requestUrl,
      });
      if (!prepared.ok) {
        return { ok: false, intent, error: prepared.error };
      }
      return {
        ok: true,
        intent,
        metaConnect: prepared.metaConnect,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to start Meta connect",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_meta_connect_session_prepare") {
    try {
      const begin = await backendPost(
        "/api/sender/byon/meta-connect/prepare",
        shop,
        {
          featureType: String(form.get("metaFeatureType") || "").trim(),
        },
      );
      const prepared = buildMetaConnectLaunchPayload(begin, {
        featureType: form.get("metaFeatureType"),
        requestUrl,
      });
      if (!prepared.ok) {
        return { ok: false, intent, error: prepared.error };
      }
      return {
        ok: true,
        intent,
        metaConnect: prepared.metaConnect,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to prepare Meta connect session",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_meta_connect_prepare") {
    const payload = {
      businessName: String(form.get("byonBusinessName") || "").trim(),
      contactName: String(form.get("byonContactName") || "").trim(),
      contactEmail: String(form.get("byonContactEmail") || "").trim(),
      requestedPhoneNumber: String(
        form.get("byonRequestedPhoneNumber") || "",
      ).trim(),
    };
    try {
      await backendPost("/api/sender/byon/details", shop, payload);
      const begin = await backendPost(
        "/api/sender/byon/meta-connect/begin",
        shop,
        {
          featureType: String(form.get("metaFeatureType") || "").trim(),
        },
      );
      const prepared = buildMetaConnectLaunchPayload(begin, {
        featureType: form.get("metaFeatureType"),
        requestUrl,
      });
      if (!prepared.ok) {
        return { ok: false, intent, error: prepared.error };
      }
      return {
        ok: true,
        intent,
        metaConnect: prepared.metaConnect,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to prepare Meta connect",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_meta_connect_finalize") {
    const payload = {
      state: String(form.get("state") || "").trim(),
      code: String(form.get("code") || "").trim(),
      redirectUri: String(form.get("redirectUri") || "").trim(),
      wabaId: String(form.get("wabaId") || "").trim(),
      phoneNumberId: String(form.get("phoneNumberId") || "").trim(),
      metaBusinessId: String(form.get("metaBusinessId") || "").trim(),
      displayPhoneNumber: String(form.get("displayPhoneNumber") || "").trim(),
      error: String(form.get("metaError") || "").trim(),
      errorDescription: String(form.get("metaErrorDescription") || "").trim(),
    };
    try {
      const resp = await backendPost(
        "/api/sender/byon/meta-connect/finalize",
        shop,
        payload,
      );
      return {
        ok: true,
        intent,
        sender: resp?.sender || null,
        hasAccessToken: !!resp?.hasAccessToken,
        waitingForIds: !!resp?.waitingForIds,
        hasWaba: !!resp?.hasWaba,
        hasPhone: !!resp?.hasPhone,
        resolvedViaGraph: !!resp?.resolvedViaGraph,
        registrationReady: !!resp?.registrationReady,
        registrationError: resp?.registrationError || null,
        webhookSubscribed: !!resp?.webhookSubscribed,
        webhookSubscriptionError: resp?.webhookSubscriptionError || null,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to finalize Meta connect",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "byon_test_send") {
    const payload = {
      to: String(form.get("byonTestPhone") || "").trim(),
      customerName: String(form.get("byonTestCustomerName") || "").trim(),
    };
    try {
      const resp = await backendPost(
        "/api/sender/byon/test-send",
        shop,
        payload,
      );
      return {
        ok: true,
        intent,
        sender: resp?.sender || null,
        testSend: resp?.testSend || null,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to send BYON test message",
        errorData: e?.data || e?.errorData || null,
        sender: e?.data?.sender || e?.errorData?.sender || null,
      };
    }
  }

  if (intent === "byon_webhook_test_start") {
    const payload = {
      to: String(form.get("byonWebhookTestPhone") || "").trim(),
    };
    try {
      const resp = await backendPost(
        "/api/sender/byon/webhook-test/start",
        shop,
        payload,
      );
      return {
        ok: true,
        intent,
        sender: resp?.sender || null,
        webhookTest: resp?.webhookTest || null,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to start webhook reply test",
        errorData: e?.data || e?.errorData || null,
        sender: e?.data?.sender || e?.errorData?.sender || null,
      };
    }
  }

  if (intent === "byon_webhook_test_check") {
    try {
      const resp = await backendPost(
        "/api/sender/byon/webhook-test/check",
        shop,
        {},
      );
      return {
        ok: true,
        intent,
        sender: resp?.sender || null,
        webhookTest: resp?.webhookTest || null,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to check webhook reply test",
        errorData: e?.data || e?.errorData || null,
        sender: e?.data?.sender || e?.errorData?.sender || null,
      };
    }
  }

  if (intent === "byon_webhook_simulate") {
    const payload = {
      fromE164: String(form.get("byonWebhookSimFromE164") || "").trim(),
      text: String(form.get("byonWebhookSimText") || "").trim(),
    };
    try {
      const resp = await backendPost(
        "/api/sender/byon/webhook-simulate",
        shop,
        payload,
      );
      return {
        ok: true,
        intent,
        sender: resp?.sender || null,
        webhookSimulation: resp?.webhookSimulation || null,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to simulate webhook reply",
        errorData: e?.data || e?.errorData || null,
        sender: e?.data?.sender || e?.errorData?.sender || null,
      };
    }
  }

  if (intent === "byon_test_status_check") {
    try {
      const resp = await backendPost(
        "/api/sender/byon/test-status/check",
        shop,
        {},
      );
      return {
        ok: true,
        intent,
        sender: resp?.sender || null,
        testMessage: resp?.testMessage || null,
        webhookTest: resp?.webhookTest || null,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to check test delivery status",
        errorData: e?.data || e?.errorData || null,
        sender: e?.data?.sender || e?.errorData?.sender || null,
      };
    }
  }

  if (intent === "byon_retry_now") {
    try {
      const resp = await backendPost("/api/sender/byon/retry-now", shop, {});
      return {
        ok: true,
        intent,
        sender: resp?.sender || null,
        retryNow: resp?.retryNow || null,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to resume BYON sending",
        errorData: e?.data || e?.errorData || null,
        sender: e?.data?.sender || e?.errorData?.sender || null,
      };
    }
  }

  return null;
}
