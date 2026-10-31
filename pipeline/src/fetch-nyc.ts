/**
 * Downloads the three NYC Open Data sets After Hours is built on. All public, no key needed.
 *  - AED Inventory (2er2-jqsx): every registered public-access defibrillator site.
 *  - EMS Incident Dispatch Data (76xm-jjuj): 2025 cardiac-arrest dispatches, already
 *    aggregated by the API to ZIP x weekday x hour x month, so no incident leaves NYC's servers.
 *  - Modified ZCTA polygons (pri4-ifjk): ZIP-level areas with population estimates.
 */
import { resolve } from "node:path";
import { RAW, getJson, writeJson } from "./paths.ts";

const SOCRATA = "https://data.cityofnewyork.us/resource";
const YEAR_WHERE = "incident_datetime>='2025-01-01T00:00:00' AND incident_datetime<'2026-01-01T00:00:00'";

async function main() {
  const aed = await getJson<Record<string, unknown>[]>(`${SOCRATA}/2er2-jqsx.json?$limit=50000`);
  writeJson(resolve(RAW, "nyc_aed.json"), aed);
  console.log(`AED inventory: ${aed.length} sites`);

  const q = new URLSearchParams({
    $select:
      "zipcode, date_extract_dow(incident_datetime) as dow, date_extract_hh(incident_datetime) as hh, date_extract_m(incident_datetime) as m, count(*) as n",
    $where: `final_call_type='ARREST' AND ${YEAR_WHERE}`,
    $group: "zipcode, dow, hh, m",
    $limit: "200000",
  });
  const calls = await getJson<{ zipcode?: string; dow: string; hh: string; m: string; n: string }[]>(
    `${SOCRATA}/76xm-jjuj.json?${q}`,
  );
  writeJson(resolve(RAW, "nyc_arrest_2025.json"), calls);
  console.log(`Cardiac-arrest dispatch buckets: ${calls.length}, calls: ${calls.reduce((a, c) => a + Number(c.n), 0)}`);

  const initial = await getJson<{ n: string }[]>(
    `${SOCRATA}/76xm-jjuj.json?${new URLSearchParams({ $select: "count(*) as n", $where: `initial_call_type='ARREST' AND ${YEAR_WHERE}` })}`,
  );
  writeJson(resolve(RAW, "nyc_arrest_2025_initial_total.json"), initial);

  const zips = await getJson<unknown>(`https://data.cityofnewyork.us/resource/pri4-ifjk.geojson?$limit=1000`);
  writeJson(resolve(RAW, "nyc_modzcta.geojson"), zips);
  console.log("ZIP polygons saved");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
