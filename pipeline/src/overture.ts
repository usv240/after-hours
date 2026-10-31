/**
 * Registry of Open Data on AWS → Amazon Athena. Overture Maps places are queried where they
 * sit (s3://overturemaps-us-west-2, Parquet) to find buildings that are staffed around the
 * clock (fire stations, police stations, hospitals) near the schools at the top of the
 * relocation list: alternative 24/7 hosts for an outdoor AED cabinet.
 */
import { resolve } from "node:path";
import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from "@aws-sdk/client-athena";
import { distanceMeters } from "@after-hours/engine";
import { CACHE, readJson, writeJson } from "./paths.ts";

const RELEASE = process.env.OVERTURE_RELEASE ?? "2026-10-21.0";
const athena = new AthenaClient({ region: "us-east-1" });
const WG = "after-hours";

async function sql(q: string): Promise<string[][]> {
  const { QueryExecutionId } = await athena.send(new StartQueryExecutionCommand({ QueryString: q, WorkGroup: WG, QueryExecutionContext: { Database: "after_hours" } }));
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const { QueryExecution } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }));
    const s = QueryExecution?.Status?.State;
    if (s === "SUCCEEDED") {
      console.log(`  scanned ${((QueryExecution?.Statistics?.DataScannedInBytes ?? 0) / 1e9).toFixed(2)} GB`);
      break;
    }
    if (s === "FAILED" || s === "CANCELLED") throw new Error(`${s}: ${QueryExecution?.Status?.StateChangeReason}`);
  }
  const rows: string[][] = [];
  let NextToken: string | undefined;
  do {
    const r = await athena.send(new GetQueryResultsCommand({ QueryExecutionId, NextToken }));
    rows.push(...(r.ResultSet?.Rows ?? []).map((x) => (x.Data ?? []).map((d) => d.VarCharValue ?? "")));
    NextToken = r.NextToken;
  } while (NextToken);
  return rows.slice(1);
}

async function main() {
  await sql("DROP TABLE IF EXISTS overture_places");
  await sql(`CREATE EXTERNAL TABLE overture_places (
      id string,
      names struct<primary:string>,
      basic_category string,
      taxonomy struct<primary:string, hierarchy:array<string>>,
      confidence double,
      bbox struct<xmin:double, xmax:double, ymin:double, ymax:double>
    )
    STORED AS PARQUET
    LOCATION 's3://overturemaps-us-west-2/release/${RELEASE}/theme=places/type=place/'`);
  const BBOX = "bbox.xmin BETWEEN -74.27 AND -73.69 AND bbox.ymin BETWEEN 40.49 AND 40.92";
  // Overture's basic_category; these are the building types staffed through the night.
  const keep = ["fire_station", "police_station", "hospital", "emergency_department"];
  const places = await sql(
    `SELECT names.primary, basic_category, (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2, confidence
     FROM overture_places WHERE ${BBOX} AND basic_category IN (${keep.map((c) => `'${c}'`).join(",")}) AND confidence >= 0.7`,
  );
  const hosts = places.map(([name, category, lon, lat, confidence]) => ({ name, category, lon: Number(lon), lat: Number(lat), confidence: Number(confidence) }));
  writeJson(resolve(CACHE, "nyc_overture_hosts.json"), { release: RELEASE, categories: keep, hosts });
  console.log(`${hosts.length} always-staffed buildings from Overture ${RELEASE}`);

  // Attach the nearest one (within 400 m) to each ranked school.
  const ranked = readJson<{ id: string; name: string; lon: number; lat: number }[]>(resolve(CACHE, "../../web/public/data/nyc/relocation.json"));
  let within = 0;
  for (const r of ranked) {
    const best = hosts
      .map((h) => ({ h, m: distanceMeters([r.lon, r.lat], [h.lon, h.lat]) }))
      .filter((x) => x.m <= 400)
      .sort((a, b) => a.m - b.m)[0];
    if (best) within++;
  }
  console.log(`${within} of ${ranked.length} ranked schools have one within 400 m`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
