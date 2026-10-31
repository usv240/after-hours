/**
 * Nightly, started by Amazon EventBridge Scheduler:
 *  1. pull the NYC AED Inventory from NYC Open Data,
 *  2. land it as JSON in S3 and append it to an Apache Iceberg table with Amazon Athena,
 *  3. diff tonight's snapshot against the previous one (Iceberg keeps every version),
 *  4. publish data/nyc/changes.json for the site and invalidate it in CloudFront.
 */
import { createHash } from "node:crypto";
import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from "@aws-sdk/client-athena";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";

const s3 = new S3Client({});
const athena = new AthenaClient({});
const cf = new CloudFrontClient({});
const env = process.env as Record<string, string>;

async function sql(query: string): Promise<string[][]> {
  const { QueryExecutionId } = await athena.send(new StartQueryExecutionCommand({ QueryString: query, WorkGroup: env.WORKGROUP, QueryExecutionContext: { Database: env.DATABASE } }));
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const { QueryExecution } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }));
    const s = QueryExecution?.Status?.State;
    if (s === "SUCCEEDED") break;
    if (s === "FAILED" || s === "CANCELLED") throw new Error(`Athena ${s}: ${QueryExecution?.Status?.StateChangeReason}\n${query}`);
  }
  const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId }));
  return (res.ResultSet?.Rows ?? []).slice(1).map((r) => (r.Data ?? []).map((d) => d.VarCharValue ?? ""));
}

const id = (...p: unknown[]) => createHash("sha1").update(p.map((x) => String(x ?? "")).join("|")).digest("hex").slice(0, 10);

export async function handler() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const res = await fetch("https://data.cityofnewyork.us/resource/2er2-jqsx.json?$limit=50000");
  if (!res.ok) throw new Error(`NYC Open Data ${res.status}`);
  const rows = (await res.json()) as Record<string, string>[];
  const seen = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const lat = Number(r.latitude), lon = Number(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = (r.entity_name ?? "").trim();
    const key = id(name, r.address, lat.toFixed(6), lon.toFixed(6));
    const prev = seen.get(key);
    const aeds = Math.max(1, Math.round(Number(r.aednumaeds ?? 1)) || 1);
    if (prev) prev.aeds = (prev.aeds as number) + aeds;
    else seen.set(key, { site_id: key, name, category: r.location_type ?? "", borough: r.borough ?? "", zip: (r.zip ?? "").slice(0, 5), latitude: lat, longitude: lon, aeds });
  }
  const body = [...seen.values()].map((o) => JSON.stringify(o)).join("\n");
  await s3.send(new PutObjectCommand({ Bucket: env.LAKE_BUCKET, Key: `staging/aed/snapshot_date=${today}/part-0.json`, Body: body, ContentType: "application/x-ndjson" }));

  await sql(`DELETE FROM aed_snapshots WHERE snapshot_date = DATE '${today}'`);
  await sql(
    `INSERT INTO aed_snapshots SELECT site_id, name, category, borough, zip, latitude, longitude, aeds, DATE '${today}' FROM aed_staging WHERE snapshot_date = '${today}'`,
  );
  const [[prevDate = "", snapshots = "0"]] = await sql(
    `SELECT CAST(max(CASE WHEN snapshot_date < DATE '${today}' THEN snapshot_date END) AS varchar), CAST(count(DISTINCT snapshot_date) AS varchar) FROM aed_snapshots`,
  );
  let added = 0, removed = 0, prevCount = 0, addedNames: string[] = [];
  if (prevDate) {
    const diff = await sql(`
      WITH t AS (SELECT site_id, name FROM aed_snapshots WHERE snapshot_date = DATE '${today}'),
           p AS (SELECT site_id, name FROM aed_snapshots WHERE snapshot_date = DATE '${prevDate}')
      SELECT 'added', name FROM t WHERE site_id NOT IN (SELECT site_id FROM p)
      UNION ALL SELECT 'removed', name FROM p WHERE site_id NOT IN (SELECT site_id FROM t)
      UNION ALL SELECT 'prev', CAST(count(*) AS varchar) FROM p`);
    for (const [kind, v] of diff) {
      if (kind === "added") {
        added++;
        if (addedNames.length < 10) addedNames.push(v);
      } else if (kind === "removed") removed++;
      else prevCount = Number(v);
    }
  }
  const changes = {
    refreshedAt: new Date().toISOString(),
    snapshotDate: today,
    previousSnapshot: prevDate || null,
    snapshotsKept: Number(snapshots),
    registryRows: rows.length,
    locations: seen.size,
    previousLocations: prevDate ? prevCount : null,
    added,
    removed,
    addedExamples: addedNames,
    how: "NYC Open Data → Amazon S3 → Apache Iceberg table (Amazon Athena INSERT) → diff against the previous Iceberg snapshot.",
  };
  await s3.send(
    new PutObjectCommand({ Bucket: env.SITE_BUCKET, Key: "data/nyc/changes.json", Body: JSON.stringify(changes, null, 2), ContentType: "application/json", CacheControl: "max-age=300" }),
  );
  await cf.send(
    new CreateInvalidationCommand({
      DistributionId: env.DISTRIBUTION_ID,
      InvalidationBatch: { CallerReference: `refresh-${Date.now()}`, Paths: { Quantity: 1, Items: ["/data/nyc/changes.json"] } },
    }),
  );
  return changes;
}
