function isValidIanaTimeZone(value) {
  const tz = String(value || "").trim();
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function getMerchantTimezone(admin) {
  if (!admin || typeof admin.graphql !== "function") return "PKT";

  try {
    const response = await admin.graphql(`
      #graphql
      query OrderXShopTimezone {
        shop {
          ianaTimezone
        }
      }
    `);
    const json = await response.json();
    const tz = json?.data?.shop?.ianaTimezone;
    if (isValidIanaTimeZone(tz)) return String(tz).trim();
  } catch {
    // Fallback to UTC if timezone lookup fails. We avoid throwing because this
    // should never break dashboard/settings loads.
  }

  return "PKT";
}
