import opening_hours from "opening_hours";

/** Where a site's opening hours came from. Shown on every site so no guess passes as fact. */
export type HoursSource = "declared" | "places" | "calendar" | "ai" | "assumed" | "unknown";

export type Availability = "open" | "closed" | "unknown";

/**
 * A moment in the city's own local time. Lambda runs in UTC and browsers run anywhere,
 * so evaluation always goes through wall-clock fields, never through a Date's own zone.
 */
export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
}

const OH_OPTIONS = { address: { country_code: "us", state: "New York" } };
const OH_MODE = 0; // plain opening_hours, no "points in time"
const cache = new Map<string, opening_hours | Error>();

/** Spellings people actually type, mapped to the OpenStreetMap opening_hours syntax. */
const ALIASES: Record<string, string> = {
  "24/7": "24/7",
  "24x7": "24/7",
  "24h": "24/7",
  "24 hours": "24/7",
  "24hrs": "24/7",
  always: "24/7",
  "always open": "24/7",
  "open 24 hours": "24/7",
};

export function normaliseHours(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const alias = ALIASES[s.toLowerCase()];
  if (alias) return alias;
  // Géo'DAE uses "Mo-Su off" as its form default, which means "never declared", not "always shut".
  if (/^mo-su off$/i.test(s)) return null;
  return s;
}

function parsed(hours: string): opening_hours | Error {
  let oh = cache.get(hours);
  if (!oh) {
    try {
      oh = new opening_hours(hours, OH_OPTIONS as never, OH_MODE);
    } catch (e) {
      oh = e instanceof Error ? e : new Error(String(e));
    }
    cache.set(hours, oh);
  }
  return oh;
}

/** Returns null when the hours are valid, or a readable reason when they are not. */
export function validateHours(hours: string): string | null {
  const oh = parsed(hours);
  return oh instanceof Error ? oh.message.split("\n")[0] : null;
}

export function toLocalDate(t: WallTime): Date {
  return new Date(t.year, t.month - 1, t.day, t.hour, t.minute, 0, 0);
}

export function availability(hours: string | null, t: WallTime): Availability {
  if (!hours) return "unknown";
  const oh = parsed(hours);
  if (oh instanceof Error) return "unknown";
  const d = toLocalDate(t);
  if (oh.getUnknown(d)) return "unknown";
  return oh.getState(d) ? "open" : "closed";
}

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/**
 * Converts Amazon Location Places `OpeningHours.Components` (iCalendar-style recurrences)
 * into OpenStreetMap opening_hours syntax, so every source ends up in one evaluable language.
 */
export function componentsToOsm(
  components: { OpenTime?: string; OpenDuration?: string; Recurrence?: string }[] | undefined,
): string | null {
  if (!components?.length) return null;
  const rules: string[] = [];
  for (const c of components) {
    const open = /^T(\d{2})(\d{2})/.exec(c.OpenTime ?? "");
    const dur = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(c.OpenDuration ?? "");
    if (!open || !dur) continue;
    const start = Number(open[1]) * 60 + Number(open[2]);
    const minutes = Number(dur[1] ?? 0) * 60 + Number(dur[2] ?? 0);
    const byday = /BYDAY:([A-Z,]+)/.exec(c.Recurrence ?? "")?.[1];
    const days = byday
      ? byday.split(",").map((d) => d.charAt(0) + d.charAt(1).toLowerCase()).filter((d) => DAYS.includes(d))
      : DAYS;
    if (minutes >= 24 * 60) {
      rules.push(`${days.join(",")} 00:00-24:00`);
      continue;
    }
    const end = start + minutes;
    const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    // opening_hours accepts end times past midnight written as 24:00+ (e.g. 22:00-26:00).
    rules.push(`${days.join(",")} ${fmt(start)}-${fmt(end)}`);
  }
  if (!rules.length) return null;
  const merged = rules.join(", ");
  return merged === "Mo,Tu,We,Th,Fr,Sa,Su 00:00-24:00" ? "24/7" : merged;
}

/**
 * NYC public-school building hours as an assumption the visitor can move:
 * weekdays from 07:00 to `closeHour`, September to June, closed in July and August.
 */
export function schoolHours(closeHour = 18): string {
  const close = `${String(closeHour).padStart(2, "0")}:00`;
  return `Jan-Jun,Sep-Dec Mo-Fr 07:00-${close}; PH off`;
}
