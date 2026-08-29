export const META_COEXISTENCE_FEATURE_TYPE = "whatsapp_business_app_onboarding";
export const META_SESSION_INFO_VERSION = "3";

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
    response_type: "code",
    override_default_response_type: true,
    extras,
  };
}
