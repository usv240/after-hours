import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { LonLat } from "@after-hours/engine";

export interface PresetSite {
  id: string;
  name: string;
  group: string;
  at: LonLat;
  region: string;
  aeds: number;
  source: string;
  pattern: number; // -1 = school calendar
  aiPattern: number | null;
  where: string;
  hours: string | null;
  note: string;
}

export interface PresetData {
  id: string;
  sites: PresetSite[];
  patterns: Uint8Array[];
  schoolPattern: Record<string, number>;
  summary: Record<string, unknown>;
  relocation: Record<string, unknown>[];
}

const s3 = new S3Client({});
// Presets are re-read every ten minutes, so a data publish reaches warm Lambdas without a redeploy.
const cache = new Map<string, { at: number; p: Promise<PresetData> }>();
const TTL_MS = 10 * 60 * 1000;
export const PRESETS = ["nyc", "paris"];

async function load(key: string): Promise<string> {
  const bucket = process.env.DATA_BUCKET;
  if (!bucket) return readFile(resolve(process.env.LOCAL_DATA_DIR ?? "../web/public/data", key), "utf8");
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `data/${key}` }));
  return res.Body!.transformToString();
}

export function preset(id: string): Promise<PresetData> {
  if (!PRESETS.includes(id)) throw Object.assign(new Error(`Unknown preset "${id}". Use one of: ${PRESETS.join(", ")}.`), { status: 400 });
  const hit = cache.get(id);
  let p = hit && Date.now() - hit.at < TTL_MS ? hit.p : undefined;
  if (!p) {
    p = (async () => {
      const [sitesRaw, summaryRaw, relocationRaw] = await Promise.all([
        load(`${id}/sites.json`),
        load(`${id}/summary.json`),
        load(`${id}/relocation.json`).catch(() => "[]"),
      ]);
      const s = JSON.parse(sitesRaw) as { sources: string[]; schoolPattern: Record<string, number>; patterns: string[]; rows: unknown[][] };
      return {
        id,
        patterns: s.patterns.map((b) => Uint8Array.from(Buffer.from(b, "base64"))),
        schoolPattern: s.schoolPattern,
        summary: JSON.parse(summaryRaw),
        relocation: JSON.parse(relocationRaw),
        sites: s.rows.map((r) => ({
          id: r[0] as string,
          name: r[1] as string,
          group: r[2] as string,
          at: [r[3] as number, r[4] as number] as LonLat,
          region: r[5] as string,
          aeds: r[6] as number,
          source: s.sources[r[7] as number],
          pattern: r[8] as number,
          aiPattern: r[9] as number | null,
          where: r[10] as string,
          hours: r[11] as string | null,
          note: r[12] as string,
        })),
      };
    })();
    cache.set(id, { at: Date.now(), p });
    p.catch(() => cache.delete(id));
  }
  return p;
}

/** The week pattern a site follows under the visitor's assumptions. */
export function patternOf(d: PresetData, s: PresetSite, schoolClose: number, includeAi: boolean): Uint8Array {
  if (s.pattern === -1) return d.patterns[d.schoolPattern[String(schoolClose)] ?? d.schoolPattern["18"]];
  if (includeAi && s.aiPattern != null) return d.patterns[s.aiPattern];
  return d.patterns[s.pattern];
}
