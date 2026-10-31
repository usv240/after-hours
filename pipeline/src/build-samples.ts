/**
 * Sample files for the "Your data" page, cut from the real presets so every row is genuine:
 *  - nyc-sample.csv: 40 NYC AED venues with coordinates and opening hours.
 *  - nyc-addresses.csv: 12 venues with a street address and hours but no coordinates,
 *    to show Amazon Location Service geocoding on upload.
 *  - paris-sample.geojson: 60 Paris AEDs with owner-declared hours, OpenStreetMap-style.
 *  - template.csv: the empty shape.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CACHE, OUT, RAW, readJson } from "./paths.ts";
import type { PipelineSite } from "./sites.ts";

const dir = resolve(OUT, "../samples");
mkdirSync(dir, { recursive: true });
const q = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const nyc = readJson<PipelineSite[]>(resolve(CACHE, "nyc_sites.json"));
const withHours = nyc.filter((s) => s.hoursSource === "places");
const pick = <T>(arr: T[], n: number) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);

const sample = [...pick(withHours, 30), ...pick(nyc.filter((s) => s.hoursSource === "calendar"), 10)];
writeFileSync(
  resolve(dir, "nyc-sample.csv"),
  ["name,latitude,longitude,opening_hours,category", ...sample.map((s) => [s.name, s.lat, s.lon, s.hours, s.group].map(q).join(","))].join("\n"),
);

const raw = readJson<Record<string, string>[]>(resolve(RAW, "nyc_aed.json"));
const addr = new Map(raw.map((r) => [`${(r.entity_name ?? "").trim()}|${Number(r.latitude).toFixed(5)}`, r]));
const addressed = pick(withHours, 60)
  .map((s) => ({ s, r: addr.get(`${s.name}|${s.lat.toFixed(5)}`) }))
  .filter((x) => x.r?.address && x.r?.zip)
  .slice(0, 12);
writeFileSync(
  resolve(dir, "nyc-addresses.csv"),
  ["name,address,opening_hours", ...addressed.map(({ s, r }) => [s.name, `${r!.address}, ${r!.borough ?? "New York"}, NY ${r!.zip}`, s.hours].map(q).join(","))].join("\n"),
);

const paris = readJson<PipelineSite[]>(resolve(CACHE, "paris_sites.json")).filter((s) => s.hours);
writeFileSync(
  resolve(dir, "paris-sample.geojson"),
  JSON.stringify({
    type: "FeatureCollection",
    features: pick(paris, 60).map((s) => ({
      type: "Feature",
      properties: { name: `${s.name}, ${s.area}`, opening_hours: s.hours, emergency: "defibrillator" },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    })),
  }),
);

writeFileSync(resolve(dir, "template.csv"), "name,latitude,longitude,address,opening_hours\nExample gym,40.7128,-74.0060,,Mo-Fr 06:00-22:00; Sa,Su 08:00-20:00\nExample office,,,\"350 5th Ave, New York, NY 10118\",Mo-Fr 09:00-17:00\nExample hospital,40.7900,-73.9530,,24/7\n");
console.log(`samples: ${sample.length} NYC, ${addressed.length} addressed, Paris ${Math.min(60, paris.length)}`);
