import { DateTime } from "luxon";
import ct from "countries-and-timezones";

// MVP: choose first timezone of the country.
// Later: override by shop setting / address region.
export function resolveTimezoneFromCountry(countryCode) {
  if (!countryCode) return "UTC";
  const c = ct.getCountry(countryCode.toUpperCase());
  if (!c || !c.timezones || c.timezones.length === 0) return "UTC";
  return c.timezones[0];
}

function safeNowInZone(tz) {
  const zoned = DateTime.now().setZone(String(tz || "UTC"));
  return zoned.isValid ? zoned : DateTime.now().setZone("UTC");
}

function clampHour(v, fallback) {
  let n = Number(v);
  if (!Number.isFinite(n) && typeof v === "string") {
    const m = String(v)
      .trim()
      .match(/^(\d{1,2})(?::\d{1,2})?$/);
    if (m) n = Number(m[1]);
  }
  if (!Number.isFinite(n)) return fallback;
  return Math.min(23, Math.max(0, Math.floor(n)));
}

function isFullDayWindow(startHour, endHour) {
  return startHour === 0 && endHour === 23;
}

function isWithinWindowHour(hour, startHour, endHour) {
  if (isFullDayWindow(startHour, endHour)) return true;
  if (startHour <= endHour) return hour >= startHour && hour <= endHour;
  // Overnight window, e.g. 22 -> 6
  return hour >= startHour || hour <= endHour;
}

export function nextAllowedTimeUTC(tz, delayMin, startHour = 9, endHour = 21) {
  const now = safeNowInZone(tz);
  const safeDelay = Number.isFinite(Number(delayMin))
    ? Math.max(0, Number(delayMin))
    : 0;
  const start = clampHour(startHour, 9);
  const end = clampHour(endHour, 21);
  let target = now.plus({ minutes: safeDelay });

  if (isWithinWindowHour(target.hour, start, end)) {
    return target.toUTC().toJSDate();
  }

  if (start <= end) {
    // Same-day window (e.g. 9 -> 21, inclusive).
    if (target.hour < start) {
      target = target.set({ hour: start, minute: 0, second: 0, millisecond: 0 });
    } else {
      target = target
        .plus({ days: 1 })
        .set({ hour: start, minute: 0, second: 0, millisecond: 0 });
    }
  } else {
    // Overnight window (e.g. 22 -> 6).
    target = target.set({ hour: start, minute: 0, second: 0, millisecond: 0 });
    if (target < now) {
      target = target.plus({ days: 1 });
    }
  }

  return target.toUTC().toJSDate();
}

export function isWithinWorkingHours(tz, startHour = 9, endHour = 21) {
  const now = safeNowInZone(tz);
  const start = clampHour(startHour, 9);
  const end = clampHour(endHour, 21);
  return isWithinWindowHour(now.hour, start, end);
}
