const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const dateTimeFormatterCache = new Map();

function getDateTimeFormatter(timeZone = "UTC") {
  const tz = String(timeZone || "UTC").trim() || "UTC";
  if (dateTimeFormatterCache.has(tz)) return dateTimeFormatterCache.get(tz);

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  dateTimeFormatterCache.set(tz, formatter);
  return formatter;
}

export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  return numberFormatter.format(n);
}

export function formatDateTime(value, timeZone = "PKT") {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return getDateTimeFormatter(timeZone).format(date);
}
