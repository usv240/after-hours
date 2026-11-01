/**
 * Who each school brief should go to: New York City Council district boundaries (NYC Open Data,
 * 872g-cjhh) and the member for each district, read from the district's page on council.nyc.gov.
 * Public officials, public pages.
 */
import { resolve } from "node:path";
import { RAW, getJson, writeJson } from "./paths.ts";

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .trim();

async function main() {
  const districts = await getJson<{ features: unknown[] }>("https://data.cityofnewyork.us/resource/872g-cjhh.geojson?$limit=100");
  writeJson(resolve(RAW, "nyc_council_districts.geojson"), districts);
  console.log(`Council districts: ${districts.features.length}`);

  const members: Record<string, string | null> = {};
  for (let d = 1; d <= 51; d++) {
    const html = await (await fetch(`https://council.nyc.gov/district-${d}/`)).text();
    // The page's member heading, or its title ("District 16 - Althea Stevens"; the Speaker's reads "Home - …").
    const m = /class="[^"]*district-member[^"]*"[^>]*>\s*([^<]+?)\s*</i.exec(html) ?? /<title>[^<]*?[-–]\s*([^<]+?)\s*<\/title>/i.exec(html);
    members[d] = m ? decode(m[1]) : null;
  }
  writeJson(resolve(RAW, "nyc_council_members.json"), members);
  console.log(`Members found: ${Object.values(members).filter(Boolean).length} of 51`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
