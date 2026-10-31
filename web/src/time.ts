/** Reference weeks shared with the engine: a school-year week (from Mon 19 Oct 2026) and a summer week (from Mon 13 Jul 2026). */
export type Season = "school" | "summer";
export const HOURS = 168;

const REF: Record<Season, [number, number, number]> = { school: [2026, 10, 19], summer: [2026, 7, 13] };

export function stateIndex(season: Season, day: number, hour: number): number {
  return (season === "summer" ? HOURS : 0) + day * 24 + hour;
}

/** A local wall-clock ISO string (no zone) for the API, inside the matching reference week. */
export function localIso(season: Season, day: number, hour: number): string {
  const [y, m, d] = REF[season];
  const date = new Date(Date.UTC(y, m - 1, d + day));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(hour)}:30`;
}

export function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
