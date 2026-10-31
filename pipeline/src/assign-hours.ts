/**
 * Gives every NYC AED site its best-known opening hours, and says where each came from.
 * Order of trust: Amazon Location Places hours for the named venue, then the public-school
 * calendar, then an Amazon Bedrock estimate (which may abstain), then "unknown".
 * Unknown is never drawn as open.
 */
import { resolve } from "node:path";
import { schoolHours } from "@after-hours/engine";
import { CACHE, RAW, readJson, readJsonOr, writeJson } from "./paths.ts";
import { nycGroup, stableId, type PipelineSite } from "./sites.ts";

export interface PlacesHit {
  hours: string | null;
  title: string;
  meters: number;
  categories: string[];
}
export interface AiGuess {
  hours: string | null;
  confidence: "high" | "medium" | "low" | "abstain";
  reason: string;
}

type Row = Record<string, string | undefined>;

function main() {
  const rows = readJson<Row[]>(resolve(RAW, "nyc_aed.json"));
  const places = readJsonOr<Record<string, PlacesHit | null>>(resolve(CACHE, "nyc_places.json"), {});
  const ai = readJsonOr<Record<string, AiGuess>>(resolve(CACHE, "nyc_ai_hours.json"), {});
  const counts: Record<string, number> = {};
  const sites: PipelineSite[] = [];
  const byId = new Map<string, PipelineSite>();
  const seenRows = new Set<string>();
  let registryRows = 0;
  for (const r of rows) {
    // The registry lists each AED unit as its own row (one per floor); exact repeats are dropped.
    const rowKey = JSON.stringify(r, Object.keys(r).sort());
    if (seenRows.has(rowKey)) continue;
    seenRows.add(rowKey);
    registryRows++;
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 40.4 || lat > 41 || lon < -74.3 || lon > -73.6) continue;
    const name = (r.entity_name ?? "").trim() || "Unnamed site";
    const group = nycGroup(r.location_type ?? "");
    const id = stableId(name, r.address, lat.toFixed(6), lon.toFixed(6));
    const units = Math.max(1, Math.round(Number(r.aednumaeds ?? 1)) || 1);
    const floor = (r.floor ?? "").replace(/^-$/, "").trim();
    const existing = byId.get(id);
    if (existing) {
      existing.aeds += units;
      if (floor && !existing.where.includes(floor) && existing.where.length < 160) existing.where = existing.where ? `${existing.where}; ${floor}` : floor;
      continue;
    }
    const site: PipelineSite = {
      id,
      name,
      group,
      rawCategory: r.location_type ?? "",
      lat,
      lon,
      zip: (r.zip ?? "").slice(0, 5),
      area: (r.borough ?? "").replace(/^new york$/i, "Manhattan").replace(/\b\w/g, (c) => c.toUpperCase()),
      aeds: units,
      where: floor,
      outdoor: null,
      hours: null,
      hoursSource: "unknown",
      hoursNote: "No hours published for this site.",
    };
    const hit = places[id];
    if (group === "School") {
      site.hours = schoolHours(18);
      site.hoursSource = "calendar";
      site.hoursNote = "School building assumed open 7 AM to 6 PM on school days, September to June. Move the school-hours control to test other closing times.";
    } else if (hit?.hours) {
      site.hours = hit.hours;
      site.hoursSource = "places";
      site.hoursNote = `Opening hours of "${hit.title}" from Amazon Location Service, ${Math.round(hit.meters)} m from the registered position.`;
    } else if (ai[id] && ai[id].confidence !== "abstain" && ai[id].hours) {
      site.hours = ai[id].hours;
      site.hoursSource = "ai";
      site.hoursNote = `Estimated by Amazon Bedrock (${ai[id].confidence} confidence): ${ai[id].reason}`;
    }
    counts[site.hoursSource] = (counts[site.hoursSource] ?? 0) + 1;
    sites.push(site);
    byId.set(id, site);
  }
  writeJson(resolve(CACHE, "nyc_sites.json"), sites);
  writeJson(resolve(CACHE, "nyc_registry_stats.json"), { registryRows: rows.length, uniqueRows: registryRows, locations: sites.length, hoursSources: counts }, true);
  console.log(`NYC: ${rows.length} registry rows → ${sites.length} locations`, counts);
}

main();
