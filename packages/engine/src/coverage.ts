import { degPerMeter, distanceMeters, inMultiPolygon, inPolygon, type LonLat, type MultiPolygon, type Polygon } from "./geo.ts";
import { HOURS_IN_WEEK } from "./week.ts";

export const STATES = HOURS_IN_WEEK * 2;

export interface CoverageSite {
  at: LonLat;
  /** 336 bytes from weekStates(): 0 closed, 1 open, 2 unknown. */
  states: Uint8Array;
  /** Routed walking catchment. When absent, a straight-line radius stands in. */
  catchment?: Polygon | MultiPolygon | null;
}

export interface CoverageRegion {
  id: string;
  shape: MultiPolygon;
}

export interface RegionCoverage {
  id: string;
  /** Grid cells inside the region. Every cell is the same area, so shares are area shares. */
  cells: number;
  /** Cells within reach of any site at all: what a time-blind map reports. */
  reachable: number;
  /** Per state (336): cells within reach of at least one site that is open. */
  open: number[];
  /** Per state: cells whose only sites in reach have unknown hours. */
  unknown: number[];
}

function isMulti(c: Polygon | MultiPolygon): c is MultiPolygon {
  return Array.isArray(c[0]?.[0]?.[0]);
}

function covers(site: CoverageSite, p: LonLat, radiusM: number): boolean {
  if (site.catchment) {
    return isMulti(site.catchment) ? inMultiPolygon(p, site.catchment) : inPolygon(p, site.catchment);
  }
  return distanceMeters(site.at, p) <= radiusM;
}

/**
 * Lays a square grid over each region and asks, for every cell and every hour of the
 * reference weeks, whether someone standing there could walk to an open defibrillator.
 * A coarse bucket index keeps the candidate search to the few sites near each cell.
 */
export function regionCoverage(
  sites: CoverageSite[],
  regions: CoverageRegion[],
  { cellMeters = 50, radiusMeters = 170, searchMeters = 400 } = {},
): RegionCoverage[] {
  const lat0 = regions.length ? regions[0].shape[0][0][0][1] : sites[0]?.at[1] ?? 40.7;
  const { dLat, dLon } = degPerMeter(lat0);
  const bucketLat = searchMeters * dLat;
  const bucketLon = searchMeters * dLon;
  const buckets = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / bucketLon)}:${Math.floor(y / bucketLat)}`;
  sites.forEach((s, i) => {
    const k = key(s.at[0], s.at[1]);
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(i);
  });
  const near = (p: LonLat): number[] => {
    const bx = Math.floor(p[0] / bucketLon);
    const by = Math.floor(p[1] / bucketLat);
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(`${bx + dx}:${by + dy}`);
        if (list) out.push(...list);
      }
    return out;
  };

  const stepLat = cellMeters * dLat;
  const stepLon = cellMeters * dLon;
  return regions.map((region) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const poly of region.shape)
      for (const [x, y] of poly[0]) {
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      }
    const res: RegionCoverage = {
      id: region.id,
      cells: 0,
      reachable: 0,
      open: new Array(STATES).fill(0),
      unknown: new Array(STATES).fill(0),
    };
    const hits: number[] = [];
    for (let y = s + stepLat / 2; y < n; y += stepLat) {
      for (let x = w + stepLon / 2; x < e; x += stepLon) {
        const p: LonLat = [x, y];
        if (!inMultiPolygon(p, region.shape)) continue;
        res.cells++;
        hits.length = 0;
        for (const i of near(p)) if (covers(sites[i], p, radiusMeters)) hits.push(i);
        if (!hits.length) continue;
        res.reachable++;
        for (let st = 0; st < STATES; st++) {
          let open = false;
          let unknown = false;
          for (const i of hits) {
            const v = sites[i].states[st];
            if (v === 1) {
              open = true;
              break;
            }
            if (v === 2) unknown = true;
          }
          if (open) res.open[st]++;
          else if (unknown) res.unknown[st]++;
        }
      }
    }
    return res;
  });
}

export interface NearestResult<T> {
  site: T;
  meters: number;
}

/** Straight-line nearest sites; the API then re-ranks the shortlist by walking time. */
export function nearest<T extends { at: LonLat }>(sites: T[], p: LonLat, k = 10, maxMeters = 2000): NearestResult<T>[] {
  return sites
    .map((site) => ({ site, meters: distanceMeters(site.at, p) }))
    .filter((r) => r.meters <= maxMeters)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, k);
}
