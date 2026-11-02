/**
 * One printable brief per ranked school: the facts a principal, a council office or a facilities
 * manager needs to decide on a 24/7 cabinet, and a print-ready map from Amazon Location Service
 * (GetStaticMap with a GeoJSON overlay of the routed two-minute walking area).
 *
 * Reads the published presets, so run it after build-presets (and precompute-debates, if used).
 * Writes web/public/data/nyc/briefs.json and web/public/briefs/{id}.png.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GeoMapsClient, GetStaticMapCommand } from "@aws-sdk/client-geo-maps";
import { HOURS_IN_WEEK, distanceMeters, inMultiPolygon, stateIndex, type MultiPolygon } from "@after-hours/engine";
import { OUT, RAW, readJson, readJsonOr, writeJson } from "./paths.ts";

const dir = resolve(OUT, "nyc");
const imgDir = resolve(OUT, "..", "briefs");
mkdirSync(imgDir, { recursive: true });

type Row = [string, string, string, number, number, string, number, number, number, number | null, string, string | null, string];
const sites = readJson<{ rows: Row[]; patterns: string[]; schoolPattern: Record<string, number> }>(resolve(dir, "sites.json"));
const relocation = readJson<
  { rank: number; id: string; name: string; zip: string; area: string; lon: number; lat: number; expectedCallsPerYear: number; altHost: { name: string; category: string; meters: number; lon: number; lat: number } | null }[]
>(resolve(dir, "relocation.json"));
const catchments = readJson<{ features: { id: number; geometry: { type: string; coordinates: number[][][][] } }[] }>(resolve(dir, "catchments.geojson"));
const regions = readJson<{ regions: { id: string; calls: string | null }[] }>(resolve(dir, "region-stats.json"));

const patterns = sites.patterns.map((p) => Uint8Array.from(Buffer.from(p, "base64")));
const schoolWeek = patterns[sites.schoolPattern["18"]];
const patternOf = (r: Row) => (r[8] === -1 ? schoolWeek : patterns[r[8]]);
const catchmentOf = new Map(catchments.features.map((f) => [f.id, f.geometry]));
const zipCalls = new Map(
  regions.regions.map((r) => [r.id, r.calls ? Buffer.from(r.calls, "base64").reduce((a, b) => a + b, 0) : 0]),
);
const SUN_9PM = stateIndex("school", 6 * 24 + 21);

// Who to bring each brief to: the City Council district the school sits in, and its member (npm run council).
const councilShapes = readJsonOr<{ features: { properties: { coundist: string }; geometry: { type: string; coordinates: unknown } }[] }>(
  resolve(RAW, "nyc_council_districts.geojson"),
  { features: [] },
).features.map((f) => ({
  district: Number(f.properties.coundist),
  shape: (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as MultiPolygon,
}));
const councilMembers = readJsonOr<Record<string, string | null>>(resolve(RAW, "nyc_council_members.json"), {});
const councilOf = (lon: number, lat: number) => {
  const d = councilShapes.find((c) => inMultiPolygon([lon, lat], c.shape))?.district;
  return d ? { district: d, member: councilMembers[d] ?? null, url: `https://council.nyc.gov/district-${d}/` } : null;
};
const count = (p: Uint8Array, from: number) => p.slice(from, from + HOURS_IN_WEEK).filter((v) => v === 1).length;

const geo = new GeoMapsClient({ region: process.env.AWS_REGION ?? "us-east-1" });

async function staticMap(file: string, overlay: object, positions: [number, number][]) {
  // Maps are kept as WebP (scripts/briefs-webp.py) to cut 44 MB of PNG to about 7 MB.
  if ((existsSync(file) || existsSync(file.replace(/\.png$/, ".webp"))) && !process.argv.includes("--force")) return;
  const r = await geo.send(
    new GetStaticMapCommand({
      FileName: "map",
      BoundedPositions: positions.map((p) => p.map((v) => v.toFixed(6)).join(",")).join(","),
      Padding: 70,
      Width: 960,
      Height: 540,
      Style: "Standard",
      ColorScheme: "Light",
      PointsOfInterests: "Disabled",
      ScaleBarUnit: "MilesKilometers",
      GeoJsonOverlay: JSON.stringify(overlay),
    }),
  );
  writeFileSync(file, r.Blob!);
}

const briefs = [];
for (const r of relocation) {
  const i = sites.rows.findIndex((row) => row[0] === r.id);
  const row = sites.rows[i];
  const near = sites.rows
    .map((o, j) => ({ o, j, m: distanceMeters([r.lon, r.lat], [o[3], o[4]]) }))
    .filter((x) => x.j !== i && x.m <= 400);
  const always = near.filter((x) => count(patternOf(x.o), 0) === HOURS_IN_WEEK && count(patternOf(x.o), HOURS_IN_WEEK) === HOURS_IN_WEEK);
  const openSun9 = near.filter((x) => patternOf(x.o)[SUN_9PM] === 1);
  const debateFile = resolve(dir, "debates", `${r.id}.json`);
  const debate = existsSync(debateFile)
    ? (JSON.parse(readFileSync(debateFile, "utf8")) as { verdict: { verdict: string; summary: string; nextStep: string; strongestFor: string; strongestAgainst: string } }).verdict
    : null;

  // GetStaticMap takes the overlay in the query string (6 KB max): thin the walking area's rings
  // and round to ~1 m so it fits, and draw at most the 25 closest neighbours.
  const full = catchmentOf.get(i);
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  const thin = (ring: number[][]) => {
    const step = Math.max(1, Math.ceil(ring.length / 48));
    const out = ring.filter((_, k) => k % step === 0).map((p) => [r5(p[0]), r5(p[1])]);
    out.push(out[0]);
    return out;
  };
  const area = full && {
    type: "MultiPolygon",
    coordinates: full.coordinates
      .map((poly) => [thin(poly[0])])
      .filter((poly) => poly[0].length >= 4)
      .slice(0, 3),
  };
  near.sort((a, b) => a.m - b.m);
  const features: object[] = [];
  if (area) features.push({ type: "Feature", properties: { color: "#3ee08f73", "outline-color": "#0b7a4b", "outline-width": 2 }, geometry: area });
  for (const x of near.slice(0, 25)) features.push({ type: "Feature", properties: { color: patternOf(x.o)[SUN_9PM] === 1 ? "#0b7a4b" : "#8c8c8c", size: "small" }, geometry: { type: "Point", coordinates: [x.o[3], x.o[4]] } });
  // Two labels are drawn into the image, so the Spanish brief gets its own map (same view, same overlay).
  const label = (f: object[], host: string, school: string) => {
    const out = [...f];
    if (r.altHost) out.push({ type: "Feature", properties: { color: "#1e4bd7", size: "large", label: host }, geometry: { type: "Point", coordinates: [r.altHost.lon, r.altHost.lat] } });
    out.push({ type: "Feature", properties: { color: "#c81e1e", size: "large", label: school }, geometry: { type: "Point", coordinates: [r.lon, r.lat] } });
    return out;
  };
  const base = [...features];
  features.splice(0, features.length, ...label(base, "24/7 host", "School AED"));
  const pts = [[r.lon, r.lat], ...(r.altHost ? [[r.altHost.lon, r.altHost.lat]] : []), ...(area ? area.coordinates.flat(2) : [])] as number[][];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const pad = 0.0012;
  const bounds: [number, number][] = [
    [Math.min(...xs) - pad, Math.min(...ys) - pad],
    [Math.max(...xs) + pad, Math.max(...ys) + pad],
  ];
  await staticMap(resolve(imgDir, `${r.id}.png`), { type: "FeatureCollection", features }, bounds);
  await staticMap(resolve(imgDir, `${r.id}.es.png`), { type: "FeatureCollection", features: label(base, "Abierto 24 h", "DEA escolar") }, bounds);

  briefs.push({
    rank: r.rank,
    id: r.id,
    name: r.name,
    zip: r.zip,
    area: r.area,
    lon: r.lon,
    lat: r.lat,
    where: row[10],
    aeds: row[6],
    hoursNote: row[12],
    expectedCallsPerYear: r.expectedCallsPerYear,
    zipCalls2025: zipCalls.get(r.zip) ?? 0,
    openHours: { schoolWeek: count(schoolWeek, 0), summerWeek: count(schoolWeek, HOURS_IN_WEEK) },
    nearby: { within400m: near.length, open247: always.length, openSunday9pm: openSun9.length },
    altHost: r.altHost,
    council: councilOf(r.lon, r.lat),
    debate,
    map: `/briefs/${r.id}.webp`,
  });
  process.stdout.write(".");
}
writeJson(resolve(dir, "briefs.json"), { schoolWeek: Buffer.from(schoolWeek).toString("base64"), briefs });
console.log(`\n${briefs.length} briefs, maps in ${imgDir}`);
