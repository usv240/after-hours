/**
 * Paris preset from France's national defibrillator registry (Géo'DAE, Licence Ouverte 2.0).
 * France requires owners to declare when each AED is accessible, so this preset has
 * declared hours, and it is the yardstick for After Hours' hours estimates in New York.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsv, normaliseHours, validateHours, inMultiPolygon, type MultiPolygon } from "@after-hours/engine";
import { CACHE, RAW, readJson, writeJson } from "./paths.ts";
import { stableId, type PipelineSite } from "./sites.ts";

const CSV_URL = "https://www.data.gouv.fr/api/1/datasets/r/edb6a9e1-2f16-4bbf-99e7-c3eb6b90794c";

async function main() {
  const csvPath = resolve(RAW, "geodae.csv");
  if (!existsSync(csvPath)) {
    const res = await fetch(CSV_URL);
    writeFileSync(csvPath, Buffer.from(await res.arrayBuffer()));
  }
  const arr = readJson<{ features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] }>(
    resolve(RAW, "paris_arrondissements.geojson"),
  );
  const areas = arr.features.map((f) => ({
    name: String(f.properties.l_aroff ?? f.properties.l_ar),
    num: Number(f.properties.c_ar),
    shape: (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as MultiPolygon,
  }));

  const { rows } = parseCsv(readFileSync(csvPath, "utf8"));
  const sites: PipelineSite[] = [];
  const stats = { registry: rows.length, paris: 0, declared: 0, neverDeclared: 0, unreadable: 0 };
  for (const r of rows) {
    if (!r.c_etat_fonct?.startsWith("En fonct") || r.c_etat !== "Actif") continue;
    const lat = Number(r.c_lat_coor1);
    const lon = Number(r.c_long_coor1);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const area = areas.find((a) => inMultiPolygon([lon, lat], a.shape));
    if (!area) continue;
    stats.paris++;
    let hours = normaliseHours(r.c_dispo_horaires);
    if (hours && validateHours(hours)) {
      stats.unreadable++;
      hours = null;
    }
    if (hours) stats.declared++;
    else stats.neverDeclared++;
    const outdoor = r.c_acc?.startsWith("Ext") ?? null;
    sites.push({
      id: stableId("fr", r.gid),
      // c_nom is sometimes a person's name in this registry, so the place type stands in for it.
      name: outdoor ? "Outdoor defibrillator" : "Indoor defibrillator",
      group: outdoor ? "Outdoor cabinet" : "Indoor",
      rawCategory: r.c_acc ?? "",
      lat,
      lon,
      zip: String(area.num),
      area: area.name,
      aeds: 1,
      where: (r.c_acc_complt ?? "").slice(0, 120),
      outdoor,
      hours,
      hoursSource: hours ? "declared" : "unknown",
      hoursNote: hours
        ? `Hours declared by the owner to Géo'DAE: ${r.c_dispo_horaires}`
        : "The owner never declared hours to Géo'DAE (the form default is 'Mo-Su off').",
    });
  }
  writeJson(resolve(CACHE, "paris_sites.json"), sites);
  writeJson(resolve(CACHE, "paris_stats.json"), stats, true);
  console.log("Paris", stats);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
