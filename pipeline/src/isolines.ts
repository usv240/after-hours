/**
 * Routes a two-minute walking catchment around every AED location with Amazon Location
 * Service (Routes v2 CalculateIsolines, TravelMode Pedestrian). Real street networks:
 * rivers, highways and long blocks shrink the area a straight-line circle would claim.
 */
import { resolve } from "node:path";
import { GeoRoutesClient, CalculateIsolinesCommand } from "@aws-sdk/client-geo-routes";
import type { MultiPolygon } from "@after-hours/engine";
import { CACHE, readJson, readJsonOr, writeJson } from "./paths.ts";
import type { PipelineSite } from "./sites.ts";

export const WALK_SECONDS = 120;
const client = new GeoRoutesClient({ region: "us-east-1" });
const CONCURRENCY = 3;

export async function isoline(lon: number, lat: number, seconds = WALK_SECONDS): Promise<MultiPolygon | null> {
  const res = await client.send(
    new CalculateIsolinesCommand({
      Origin: [lon, lat],
      Thresholds: { Time: [seconds] },
      TravelMode: "Pedestrian",
      IsolineGeometryFormat: "Simple",
    }),
  );
  const geoms = res.Isolines?.[0]?.Geometries ?? [];
  const mp = geoms.map((g) => g.Polygon as unknown as MultiPolygon[number]).filter((p) => p?.length);
  return mp.length ? mp : null;
}

async function main() {
  const preset = process.argv[2] ?? "nyc";
  const sites = readJson<PipelineSite[]>(resolve(CACHE, `${preset}_sites.json`));
  const file = resolve(CACHE, `${preset}_isolines.json`);
  const cache = readJsonOr<Record<string, MultiPolygon | null>>(file, {});
  // Locations at the same spot share one isoline.
  const byPoint = new Map<string, PipelineSite[]>();
  for (const s of sites) {
    const k = `${s.lon.toFixed(5)},${s.lat.toFixed(5)}`;
    (byPoint.get(k) ?? byPoint.set(k, []).get(k)!).push(s);
  }
  const todo = [...byPoint.values()].filter((group) => !cache[group[0].id]);
  console.log(`${sites.length} sites at ${byPoint.size} points, ${todo.length} isolines to route`);
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let g = todo.shift(); g; g = todo.shift()) {
        try {
          const iso = await isoline(g[0].lon, g[0].lat);
          for (const s of g) cache[s.id] = iso;
        } catch (e) {
          const err = e as { name?: string };
          if (err.name === "ThrottlingException" || err.name === "TooManyRequestsException") {
            todo.push(g);
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            console.warn(g[0].name, err.name);
            for (const s of g) cache[s.id] = null;
          }
        }
        if (++done % 250 === 0) {
          writeJson(file, cache);
          console.log(done);
        }
      }
    }),
  );
  writeJson(file, cache);
  console.log({ routed: Object.values(cache).filter(Boolean).length, failed: Object.values(cache).filter((v) => !v).length });
}

if (process.argv[1]?.endsWith("isolines.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
