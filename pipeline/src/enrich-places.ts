/**
 * Looks up each named, non-school NYC AED venue with Amazon Location Places and keeps its
 * published opening hours. IntendedUse "Storage" because the hours are kept in the dataset.
 * Results are cached per site, so the paid calls run once and a rerun resumes where it stopped.
 */
import { resolve } from "node:path";
import { GeoPlacesClient, SearchTextCommand } from "@aws-sdk/client-geo-places";
import { componentsToOsm } from "@after-hours/engine";
import { CACHE, readJson, readJsonOr, writeJson } from "./paths.ts";
import type { PipelineSite } from "./sites.ts";
import type { PlacesHit } from "./assign-hours.ts";

const client = new GeoPlacesClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const CACHE_FILE = resolve(CACHE, "nyc_places.json");
const RADIUS_M = 200;
const CONCURRENCY = 8;

const STOP = new Set(["the", "of", "and", "inc", "llc", "corp", "co", "at", "nyc", "new", "york", "ny", "center", "centre", "&", "-"]);
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t)));
}
/** Share of the registry name's words found in the place's title. Rejects "Apollo Theater" → "AMC Theatres". */
export function nameMatch(registry: string, title: string): number {
  const a = tokens(registry), b = tokens(title);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t) || [...b].some((u) => u.startsWith(t) || t.startsWith(u))) hit++;
  return hit / Math.min(a.size, b.size);
}

async function lookup(site: PipelineSite): Promise<PlacesHit | null> {
  const res = await client.send(
    new SearchTextCommand({
      QueryText: site.name.slice(0, 200),
      Filter: { Circle: { Center: [site.lon, site.lat], Radius: RADIUS_M } },
      MaxResults: 1,
      AdditionalFeatures: ["Contact"],
      IntendedUse: "Storage",
    }),
  );
  const it = res.ResultItems?.[0];
  if (!it?.Title) return null;
  const match = nameMatch(site.name, it.Title);
  const components = it.OpeningHours?.[0]?.Components;
  return {
    hours: match >= 0.5 ? componentsToOsm(components as never) : null,
    title: it.Title,
    meters: it.Distance ?? 0,
    categories: (it.Categories ?? []).map((c) => c.Id ?? "").filter(Boolean),
    ...({ match, rawHours: it.OpeningHours?.[0]?.Display ?? null } as object),
  };
}

async function main() {
  const sites = readJson<PipelineSite[]>(resolve(CACHE, "nyc_sites.json")).filter((s) => s.group !== "School");
  const cache = readJsonOr<Record<string, PlacesHit | null>>(CACHE_FILE, {});
  const todo = sites.filter((s) => !(s.id in cache));
  console.log(`${sites.length} venues, ${todo.length} still to look up`);
  let done = 0, failed = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          cache[s.id] = await lookup(s);
        } catch (e) {
          failed++;
          const err = e as { name?: string };
          if (err.name === "ThrottlingException") {
            queue.push(s);
            await new Promise((r) => setTimeout(r, 1500));
          } else console.warn(s.name, err.name);
        }
        if (++done % 200 === 0) {
          writeJson(CACHE_FILE, cache);
          console.log(`${done}/${todo.length}`);
        }
      }
    }),
  );
  writeJson(CACHE_FILE, cache);
  const vals = Object.values(cache);
  console.log({ looked_up: vals.length, found: vals.filter(Boolean).length, with_hours: vals.filter((v) => v?.hours).length, failed });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
