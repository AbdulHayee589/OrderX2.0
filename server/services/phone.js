import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Best-effort E.164 normalization.
 * - rawPhone can be +92..., 03..., etc.
 * - countryCode should be ISO2 (PK, US, CA, etc) if available.
 */
export function normalizePhoneE164(rawPhone, countryCode) {
  try {
    if (!rawPhone) return null;

    const cleaned = String(rawPhone).trim();
    if (!cleaned) return null;

    const parsed = parsePhoneNumberFromString(
      cleaned,
      countryCode || undefined
    );
    if (!parsed) return null;

    if (!parsed.isValid()) return null;

    return parsed.number; // E.164
  } catch {
    return null;
  }
}

export function inferCountryCodeFromE164(rawPhone) {
  try {
    if (!rawPhone) return null;
    const parsed = parsePhoneNumberFromString(String(rawPhone).trim());
    const countryCode = String(parsed?.country || "").trim().toUpperCase();
    return countryCode || null;
  } catch {
    return null;
  }
}
