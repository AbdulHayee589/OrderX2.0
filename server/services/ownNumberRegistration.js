function normalizeUpper(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

export function isPhoneMetadataCloudConnected(meta = {}) {
  return (
    normalizeUpper(meta?.platformType) === "CLOUD_API" &&
    normalizeUpper(meta?.status) === "CONNECTED"
  );
}

export function isStoredOwnNumberCloudConnected(own = {}) {
  const storedStatus = String(own?.registrationStatus || "")
    .trim()
    .toLowerCase();
  if (storedStatus === "registered") return true;
  return isPhoneMetadataCloudConnected({
    platformType: own?.registrationPlatformType,
    status: own?.registrationPhoneStatus,
  });
}

export function resolveOwnNumberRegistrationStatus(own = {}) {
  if (isStoredOwnNumberCloudConnected(own)) {
    return "registered";
  }
  return (
    String(own?.registrationStatus || "")
      .trim()
      .toLowerCase() || "unknown"
  );
}
