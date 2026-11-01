/**
 * A picture for each sample on the "Your data" page: the sample's own places on an Amazon Location
 * static map (GetStaticMap), coloured by whether each is open at 9 PM on a Sunday. Addresses
 * without coordinates are geocoded with Amazon Location Places first, as the page itself does.
 * Writes web/public/samples/{name}.png and web/public/samples/maps.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GeoMapsClient, GetStaticMapCommand } from "@aws-sdk/client-geo-maps";
import { GeoPlacesClient, GeocodeCommand } from "@aws-sdk/client-geo-places";
import { availability, parseCsvSites, parseGeoJsonSites, wallTimeFor } from "@after-hours/engine";
import { ROOT } from "./paths.ts";

const dir = resolve(ROOT, "web/public/samples");
const region = process.env.AWS_REGION ?? "us-east-1";
const maps = new GeoMapsClient({ region });
const places = new GeoPlacesClient({ region });
const SUN_9PM = 6 * 24 + 21;

const samples = [
  { file: "nyc-sample.csv", bias: [-73.95, 40.7] },
  { file: "nyc-addresses.csv", bias: [-73.95, 40.7] },
  { file: "paris-sample.geojson", bias: [2.35, 48.86] },
];

const out: Record<string, { open: number; total: number; map: string }> = {};
for (const s of samples) {
  const text = readFileSync(resolve(dir, s.file), "utf8");
  const parsed = s.file.endsWith(".geojson") ? parseGeoJsonSites(JSON.parse(text)) : parseCsvSites(text);
  const pts: { at: number[]; open: boolean }[] = [];
  const when = wallTimeFor("school", SUN_9PM);
  for (const site of parsed.sites) pts.push({ at: [site.lon, site.lat], open: availability(site.hours, when) === "open" });
  for (const row of parsed.needsGeocoding) {
    const r = await places.send(new GeocodeCommand({ QueryText: row.address, BiasPosition: s.bias, MaxResults: 1, IntendedUse: "SingleUse" }));
    const at = r.ResultItems?.[0]?.Position;
    if (at) pts.push({ at, open: availability(row.hours, when) === "open" });
  }
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  // Compact overlay keeps forty points inside GetStaticMap's 6 KB request limit.
  const overlay = pts.map((p) => `point:${p.at.map(r5).join(",")};color=${p.open ? "#0b7a4b" : "#c81e1e"};size=small`).join("|");
  const xs = pts.map((p) => p.at[0]), ys = pts.map((p) => p.at[1]);
  const pad = 0.01;
  const name = s.file.replace(/\.\w+$/, "");
  const res = await maps.send(
    new GetStaticMapCommand({
      FileName: "map",
      BoundingBox: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad].map(r5).join(","),
      Width: 640,
      Height: 400,
      Style: "Standard",
      ColorScheme: "Light",
      PointsOfInterests: "Disabled",
      CompactOverlay: overlay,
    }),
  );
  writeFileSync(resolve(dir, `${name}.png`), res.Blob!);
  out[name] = { open: pts.filter((p) => p.open).length, total: pts.length, map: `/samples/${name}.webp` };
  console.log(name, out[name]);
}
writeFileSync(resolve(dir, "maps.json"), JSON.stringify(out, null, 2));
