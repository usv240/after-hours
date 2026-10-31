import { hourOfWeekFromWall, seasonOfMonth, stateIndex, type WallTime } from "@after-hours/engine";

export const ZONES: Record<string, string> = { nyc: "America/New_York", paris: "Europe/Paris" };

/** Wall-clock time in a zone, from an ISO instant or "now". */
export function wallTimeIn(zone: string, at?: string | null): WallTime {
  const d = at ? new Date(at) : new Date();
  if (Number.isNaN(d.getTime())) throw Object.assign(new Error(`"at" must be an ISO 8601 date-time, got "${at}".`), { status: 400 });
  // A bare local time ("2026-11-01T03:00") already is wall-clock time in the preset's zone.
  if (at && !/[zZ]|[+-]\d\d:?\d\d$/.test(at)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
    if (m) return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour % 24, minute: +parts.minute };
}

export function stateFor(t: WallTime): number {
  return stateIndex(seasonOfMonth(t.month), hourOfWeekFromWall(t));
}

export function describe(t: WallTime): string {
  const d = new Date(t.year, t.month - 1, t.day, t.hour, t.minute);
  return d.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}
