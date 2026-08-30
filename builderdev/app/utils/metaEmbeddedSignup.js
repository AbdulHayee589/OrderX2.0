export const META_COEXISTENCE_FEATURE_TYPE = "whatsapp_business_app_onboarding";
export const META_SESSION_INFO_VERSION = "3";
const META_POPUP_NAME = "orderx_meta_embedded_signup";
const META_POPUP_FEATURES =
  "popup=1,width=600,height=679,scrollbars=1,resizable=1";

export function reserveMetaEmbeddedSignupPopup(browserWindow) {
  const hostWindow = browserWindow;
  if (typeof hostWindow?.open !== "function") return null;

  const popup = hostWindow.open(
    "about:blank",
    META_POPUP_NAME,
    META_POPUP_FEATURES,
  );
  if (!popup) return null;

  try {
    popup.document.title = "Opening Meta";
    popup.document.body.style.cssText =
      "margin:0;min-height:100vh;display:grid;place-items:center;" +
      "font:600 16px system-ui,sans-serif;color:#344054;background:#fff";
    popup.document.body.textContent = "Opening Meta Embedded Signup…";
    popup.focus?.();
  } catch {
    // The popup can become cross-origin immediately in some browsers.
  }

  return popup;
}

export function runMetaLoginInReservedPopup({
  browserWindow,
  popupWindow,
  openLogin,
}) {
  const hostWindow = browserWindow;
  if (typeof openLogin !== "function") {
    throw new Error("Meta login is not ready");
  }
  if (!popupWindow || popupWindow.closed) {
    throw new Error(
      "The Meta popup was closed before signup could start. Click the button again.",
    );
  }

  const nativeOpen = hostWindow?.open;
  if (typeof nativeOpen !== "function") {
    throw new Error("This browser cannot open the Meta signup popup");
  }

  let popupClaimed = false;
  const claimReservedPopup = (url, target, features) => {
    if (popupClaimed) {
      return nativeOpen.call(hostWindow, url, target, features);
    }

    popupClaimed = true;
    try {
      if (target) popupWindow.name = target;
      if (url && url !== "about:blank") {
        if (typeof popupWindow.location?.replace === "function") {
          popupWindow.location.replace(url);
        } else {
          popupWindow.location.href = url;
        }
      }
      popupWindow.focus?.();
    } catch {
      // Returning the reserved window still lets the SDK navigate it.
    }
    return popupWindow;
  };

  try {
    hostWindow.open = claimReservedPopup;
    openLogin();
  } finally {
    if (hostWindow.open === claimReservedPopup) {
      hostWindow.open = nativeOpen;
    }
  }

  if (!popupClaimed) {
    throw new Error("Meta did not create the Embedded Signup popup");
  }
}

export function normalizeMetaFeatureType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === META_COEXISTENCE_FEATURE_TYPE
    ? META_COEXISTENCE_FEATURE_TYPE
    : "";
}

export function buildMetaEmbeddedSignupOptions({
  configId,
  featureType,
  solutionId,
} = {}) {
  const normalizedConfigId = String(configId || "").trim();
  if (!normalizedConfigId) {
    throw new Error("Meta Embedded Signup config ID is missing");
  }

  const extras = { setup: {} };
  const normalizedFeatureType = normalizeMetaFeatureType(featureType);
  if (normalizedFeatureType) {
    extras.featureType = normalizedFeatureType;
    // Meta's Embedded Signup v3 launch examples use the string value "3".
    // Keeping the type exact matters because Meta reads this opaque object.
    extras.sessionInfoVersion = META_SESSION_INFO_VERSION;
  }

  const normalizedSolutionId = String(solutionId || "").trim();
  if (normalizedSolutionId) {
    extras.setup.solutionID = normalizedSolutionId;
  }

  return {
    config_id: normalizedConfigId,
    auth_type: "rerequest",
    response_type: "code",
    override_default_response_type: true,
    extras,
  };
}
