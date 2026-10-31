import { availability, type Availability, type WallTime } from "./hours.ts";

/** Hour-of-week index: 0 = Monday 00:00, 167 = Sunday 23:00. */
export const HOURS_IN_WEEK = 168;
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type Season = "school" | "summer";
export const SEASONS: Season[] = ["school", "summer"];

/**
 * Two ordinary weeks stand in for the year: a school-year week with no public holiday
 * and a summer week when schools are shut. Both are Mondays.
 */
const REFERENCE_MONDAY: Record<Season, { year: number; month: number; day: number }> = {
  school: { year: 2026, month: 10, day: 19 },
  summer: { year: 2026, month: 7, day: 13 },
};

export function seasonOfMonth(month: number): Season {
  return month === 7 || month === 8 ? "summer" : "school";
}

export function wallTimeFor(season: Season, hourOfWeek: number, minute = 30): WallTime {
  const ref = REFERENCE_MONDAY[season];
  const d = new Date(ref.year, ref.month - 1, ref.day + Math.floor(hourOfWeek / 24));
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: hourOfWeek % 24, minute };
}

/** Monday-first day index (0..6) for a JS Date's local weekday. */
export function mondayIndex(jsDay: number): number {
  return (jsDay + 6) % 7;
}

export function hourOfWeekFromWall(t: WallTime): number {
  const jsDay = new Date(t.year, t.month - 1, t.day).getDay();
  return mondayIndex(jsDay) * 24 + t.hour;
}

export const STATE_CODE: Record<Availability, number> = { closed: 0, open: 1, unknown: 2 };

/**
 * One byte per hour of the reference week for each season (336 bytes per site):
 * 0 closed, 1 open, 2 unknown. Evaluated once, then every map frame is a lookup.
 */
export function weekStates(hours: string | null): Uint8Array {
  const out = new Uint8Array(HOURS_IN_WEEK * 2);
  SEASONS.forEach((season, s) => {
    for (let h = 0; h < HOURS_IN_WEEK; h++) {
      out[s * HOURS_IN_WEEK + h] = STATE_CODE[availability(hours, wallTimeFor(season, h))];
    }
  });
  return out;
}

export function stateIndex(season: Season, hourOfWeek: number): number {
  return (season === "summer" ? HOURS_IN_WEEK : 0) + hourOfWeek;
}

export function formatHourOfWeek(hourOfWeek: number): string {
  const day = DAY_NAMES[Math.floor(hourOfWeek / 24)];
  const h = hourOfWeek % 24;
  const label = h === 0 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h} AM` : `${h - 12} PM`;
  return `${day}, ${label}`;
}

export interface WeekCounts {
  open: number[];
  closed: number[];
  unknown: number[];
}

/** How many sites are open, closed and unknown at every hour of the week, for one season. */
export function weekCounts(states: Uint8Array[], season: Season): WeekCounts {
  const base = season === "summer" ? HOURS_IN_WEEK : 0;
  const out: WeekCounts = {
    open: new Array(HOURS_IN_WEEK).fill(0),
    closed: new Array(HOURS_IN_WEEK).fill(0),
    unknown: new Array(HOURS_IN_WEEK).fill(0),
  };
  for (const st of states) {
    for (let h = 0; h < HOURS_IN_WEEK; h++) {
      const v = st[base + h];
      if (v === 1) out.open[h]++;
      else if (v === 0) out.closed[h]++;
      else out.unknown[h]++;
    }
  }
  return out;
}
