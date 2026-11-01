/**
 * Turns pipeline sites into the static presets the website and API serve:
 * hour-by-hour availability, walking coverage per ZIP / arrondissement, call-weighted
 * headline numbers, a ranked "make it 24/7" list, and plain CSV downloads.
 *
 * Variants: NYC numbers exist for three school closing times (3, 6 and 9 PM) and with or
 * without Amazon Bedrock's hour estimates. Headline numbers use 6 PM and no AI estimates.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HOURS_IN_WEEK,
  SEASONS,
  degPerMeter,
  distanceMeters,
  inMultiPolygon,
  mondayIndex,
  schoolHours,
  seasonOfMonth,
  stateIndex,
  weekStates,
  type LonLat,
  type MultiPolygon,
} from "@after-hours/engine";
import { CACHE, OUT, RAW, readJson, readJsonOr, writeJson } from "./paths.ts";
import type { PipelineSite } from "./sites.ts";
import { credibleHosts } from "./hosts.ts";
import { rankingEval } from "./ranking-eval.ts";

const STATES = HOURS_IN_WEEK * 2;
const CELL_M = 50;
/** Straight-line stand-in for a two-minute walk where no routed isoline exists (Paris). */
const FALLBACK_RADIUS_M = 130;
const SCHOOL_CLOSE_OPTIONS = [15, 18, 21];
const DEFAULT_CLOSE = 18;

interface Region {
  id: string;
  name: string;
  pop: number;
  shape: MultiPolygon;
}

interface Preset {
  id: string;
  name: string;
  city: string;
  regionLabel: string;
  center: LonLat;
  zoom: number;
  sites: PipelineSite[];
  regions: Region[];
  isolines: Record<string, MultiPolygon | null>;
  calls?: number[][];
  callsTotal?: number;
  callsUnmatched?: number;
  sources: { name: string; url: string; licence: string }[];
  extra?: Record<string, unknown>;
}

interface Variant {
  key: string;
  close: number;
  ai: boolean;
}

// ---------- geometry ----------

function simplifyRing(ring: LonLat[], tol: number): LonLat[] {
  if (ring.length < 5) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let max = 0, idx = -1;
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * ring[i][0] - dx * ring[i][1] + bx * ay - by * ax) / len;
      if (d > max) (max = d), (idx = i);
    }
    if (max > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

const round = (v: number, d = 5) => Math.round(v * 10 ** d) / 10 ** d;
function simplifyMulti(mp: MultiPolygon, tol: number, digits = 5): MultiPolygon {
  return mp.map((poly) => poly.map((ring) => simplifyRing(ring, tol).map(([x, y]) => [round(x, digits), round(y, digits)] as LonLat)));
}

function asMulti(geom: { type: string; coordinates: unknown }): MultiPolygon {
  return (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates) as MultiPolygon;
}

const b64 = (arr: ArrayLike<number>, bytes: 1 | 2 = 1) =>
  Buffer.from(bytes === 1 ? Uint8Array.from(arr) : new Uint8Array(Uint16Array.from(arr).buffer)).toString("base64");

// ---------- hour patterns ----------

const UNKNOWN = "\u0000unknown";

function patternTable(preset: Preset) {
  const patterns: Uint8Array[] = [];
  const index = new Map<string, number>();
  const intern = (hours: string | null) => {
    const k = hours ?? UNKNOWN;
    let i = index.get(k);
    if (i === undefined) {
      i = patterns.length;
      patterns.push(weekStates(hours));
      index.set(k, i);
    }
    return i;
  };
  const unknown = intern(null);
  const schoolPattern: Record<number, number> = {};
  const hasSchools = preset.sites.some((s) => s.hoursSource === "calendar");
  if (hasSchools) for (const c of SCHOOL_CLOSE_OPTIONS) schoolPattern[c] = intern(schoolHours(c));
  // -1 = school (depends on the closing-time control). AI estimates never enter the headline pattern.
  const base = preset.sites.map((s) => (s.hoursSource === "calendar" ? -1 : s.hoursSource === "ai" ? unknown : intern(s.hours)));
  const ai = preset.sites.map((s) => (s.hoursSource === "ai" ? intern(s.hours) : null));
  return { patterns, base, ai, schoolPattern, hasSchools };
}

function statesFor(t: ReturnType<typeof patternTable>, v: Variant): Uint8Array[] {
  return t.base.map((p, i) => t.patterns[p === -1 ? t.schoolPattern[v.close] : v.ai && t.ai[i] !== null ? t.ai[i]! : p]);
}

// ---------- the grid ----------

interface Cell {
  region: number;
  hits: number[];
}

function buildCells(preset: Preset) {
  const { sites, regions, isolines } = preset;
  const { dLat, dLon } = degPerMeter(preset.center[1]);
  const bLat = 500 * dLat, bLon = 500 * dLon;
  const index = new Map<string, number[]>();
  sites.forEach((s, i) => {
    const k = `${Math.floor(s.lon / bLon)}:${Math.floor(s.lat / bLat)}`;
    (index.get(k) ?? index.set(k, []).get(k)!).push(i);
  });
  const near = (x: number, y: number) => {
    const bx = Math.floor(x / bLon), by = Math.floor(y / bLat);
    const out: number[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(index.get(`${bx + i}:${by + j}`) ?? []));
    return out;
  };
  const stepLat = CELL_M * dLat, stepLon = CELL_M * dLon;
  const cells: Cell[] = [];
  const cellCount = regions.map(() => 0);
  regions.forEach((r, ri) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const poly of r.shape) for (const [x, y] of poly[0]) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
    const y0 = Math.ceil(s / stepLat) * stepLat, x0 = Math.ceil(w / stepLon) * stepLon;
    for (let y = y0; y < n; y += stepLat)
      for (let x = x0; x < e; x += stepLon) {
        const p: LonLat = [x, y];
        if (!inMultiPolygon(p, r.shape)) continue;
        cellCount[ri]++;
        const hits = near(x, y)
          .filter((i) => {
            const iso = isolines[sites[i].id];
            return iso ? inMultiPolygon(p, iso) : distanceMeters([sites[i].lon, sites[i].lat], p) <= FALLBACK_RADIUS_M;
          })
          .sort((a, b) => distanceMeters([sites[a].lon, sites[a].lat], p) - distanceMeters([sites[b].lon, sites[b].lat], p));
        if (hits.length) cells.push({ region: ri, hits });
      }
  });
  return { cells, cellCount };
}

function coverage(preset: Preset, cells: Cell[], states: Uint8Array[]) {
  const R = preset.regions.length;
  const reachable = new Array(R).fill(0);
  const open = Array.from({ length: R }, () => new Array(STATES).fill(0));
  const unknown = Array.from({ length: R }, () => new Array(STATES).fill(0));
  for (const c of cells) {
    reachable[c.region]++;
    for (let st = 0; st < STATES; st++) {
      let o = false, u = false;
      for (const i of c.hits) {
        const v = states[i][st];
        if (v === 1) {
          o = true;
          break;
        }
        if (v === 2) u = true;
      }
      if (o) open[c.region][st]++;
      else if (u) unknown[c.region][st]++;
    }
  }
  return { reachable, open, unknown };
}

function callWeighted(preset: Preset, cellCount: number[], cov: ReturnType<typeof coverage>) {
  let calls = 0, blind = 0, actual = 0, unknownShare = 0, nothingOpen = 0;
  preset.calls!.forEach((byState, ri) => {
    if (!cellCount[ri]) return;
    byState.forEach((n, st) => {
      if (!n) return;
      calls += n;
      blind += (n * cov.reachable[ri]) / cellCount[ri];
      actual += (n * cov.open[ri][st]) / cellCount[ri];
      unknownShare += (n * cov.unknown[ri][st]) / cellCount[ri];
      if (cov.open[ri][st] === 0) nothingOpen += n;
    });
  });
  return {
    calls,
    timeBlindCoverage: blind / calls,
    actualCoverage: actual / calls,
    unknownCoverage: unknownShare / calls,
    callsInZipsWithNothingOpen: nothingOpen,
  };
}

// ---------- build ----------

function build(preset: Preset) {
  const dir = resolve(OUT, preset.id);
  mkdirSync(dir, { recursive: true });
  const t = patternTable(preset);
  const t0 = Date.now();
  const { cells, cellCount } = buildCells(preset);
  console.log(`${preset.id}: ${cells.length} reachable cells of ${cellCount.reduce((a, b) => a + b, 0)} (${Date.now() - t0} ms)`);

  const hasAi = t.ai.some((p) => p !== null);
  const variants: Variant[] = [];
  for (const close of t.hasSchools ? SCHOOL_CLOSE_OPTIONS : [0])
    for (const ai of hasAi ? [false, true] : [false]) variants.push({ key: `${close}${ai ? "a" : ""}`, close, ai });
  const headlineKey = t.hasSchools ? String(DEFAULT_CLOSE) : "0";
  const cov: Record<string, ReturnType<typeof coverage>> = {};
  for (const v of variants) cov[v.key] = coverage(preset, cells, statesFor(t, v));
  const main = cov[headlineKey];

  // ----- regions -----
  writeJson(resolve(dir, "regions.geojson"), {
    type: "FeatureCollection",
    features: preset.regions.map((r, i) => ({
      type: "Feature",
      id: i,
      properties: { id: r.id, name: r.name, pop: r.pop },
      geometry: { type: "MultiPolygon", coordinates: simplifyMulti(r.shape, 0.00008) },
    })),
  });
  const siteCount = preset.regions.map((r) => preset.sites.filter((s) => s.zip === r.id).length);
  writeJson(resolve(dir, "region-stats.json"), {
    variants: variants.map((v) => v.key),
    headline: headlineKey,
    regions: preset.regions.map((r, i) => ({
      id: r.id,
      name: r.name,
      pop: r.pop,
      cells: cellCount[i],
      reachable: main.reachable[i],
      sites: siteCount[i],
      calls: preset.calls ? b64(preset.calls[i]) : null,
      // Shares quantised to 0-255 per hour of the two reference weeks.
      open: Object.fromEntries(variants.map((v) => [v.key, b64(cov[v.key].open[i].map((x) => (cellCount[i] ? Math.round((255 * x) / cellCount[i]) : 0)))])),
      unknown: Object.fromEntries(variants.map((v) => [v.key, b64(cov[v.key].unknown[i].map((x) => (cellCount[i] ? Math.round((255 * x) / cellCount[i]) : 0)))])),
    })),
  });

  // ----- sites and catchments -----
  const SRC = ["declared", "places", "calendar", "ai", "assumed", "unknown"];
  writeJson(resolve(dir, "sites.json"), {
    columns: ["id", "name", "group", "lon", "lat", "region", "aeds", "source", "pattern", "aiPattern", "where", "hours", "note"],
    sources: SRC,
    schoolPattern: t.schoolPattern,
    patterns: t.patterns.map((p) => Buffer.from(p).toString("base64")),
    rows: preset.sites.map((s, i) => [
      s.id, s.name, s.group, round(s.lon), round(s.lat), s.zip, s.aeds, SRC.indexOf(s.hoursSource), t.base[i], t.ai[i], s.where, s.hours, s.hoursNote,
    ]),
  });
  const routed = preset.sites.filter((s) => preset.isolines[s.id]).length;
  writeJson(resolve(dir, "catchments.geojson"), {
    type: "FeatureCollection",
    features: preset.sites
      .map((s, i) => {
        const iso = preset.isolines[s.id];
        return iso ? { type: "Feature", id: i, properties: {}, geometry: { type: "MultiPolygon", coordinates: simplifyMulti(iso, 0.00003, 5) } } : null;
      })
      .filter(Boolean),
  });

  // ----- summary -----
  const counts = (states: Uint8Array[], season: number) => {
    const open = new Array(HOURS_IN_WEEK).fill(0), unknown = new Array(HOURS_IN_WEEK).fill(0);
    for (const p of states)
      for (let h = 0; h < HOURS_IN_WEEK; h++) {
        const v = p[season * HOURS_IN_WEEK + h];
        if (v === 1) open[h]++;
        else if (v === 2) unknown[h]++;
      }
    return { open, unknown };
  };
  const summary: Record<string, unknown> = {
    id: preset.id,
    name: preset.name,
    city: preset.city,
    regionLabel: preset.regionLabel,
    center: preset.center,
    zoom: preset.zoom,
    sources: preset.sources,
    generatedAt: new Date().toISOString(),
    catchment: routed
      ? { kind: "isoline", seconds: 120, routed, label: "two-minute walk, routed on real streets by Amazon Location Service" }
      : { kind: "radius", meters: FALLBACK_RADIUS_M, label: `${FALLBACK_RADIUS_M} m in a straight line (about a two-minute walk)` },
    sites: preset.sites.length,
    aeds: preset.sites.reduce((a, s) => a + s.aeds, 0),
    groups: tally(preset.sites.map((s) => s.group)),
    hoursSources: tally(preset.sites.map((s) => s.hoursSource)),
    variants: variants.map((v) => v.key),
    headlineVariant: headlineKey,
    schoolCloseOptions: t.hasSchools ? SCHOOL_CLOSE_OPTIONS : null,
    defaultSchoolClose: t.hasSchools ? DEFAULT_CLOSE : null,
    cells: cellCount.reduce((a, b) => a + b, 0),
    cellMeters: CELL_M,
    week: Object.fromEntries(variants.map((v) => [v.key, Object.fromEntries(SEASONS.map((s, si) => [s, counts(statesFor(t, v), si)]))])),
    ...preset.extra,
  };

  const hw = (summary.week as Record<string, Record<string, { open: number[]; unknown: number[] }>>)[headlineKey];
  const fig: Record<string, number> = {
    openTue2pm: hw.school.open[24 + 14],
    openTue5pm: hw.school.open[24 + 17],
    openTue6pm: hw.school.open[24 + 18],
    openTue9pm: hw.school.open[24 + 21],
    openSun3am: hw.school.open[6 * 24 + 3],
    openAugTue2pm: hw.summer.open[24 + 14],
    unknownSites: hw.school.unknown[24 + 14],
    dropTue2pmToSun3am: 1 - hw.school.open[6 * 24 + 3] / hw.school.open[24 + 14],
    declaredOrPublished: preset.sites.filter((s) => s.hoursSource === "declared" || s.hoursSource === "places").length,
    declaredShare: preset.sites.filter((s) => s.hoursSource === "declared").length / preset.sites.length,
    outdoor: preset.sites.filter((s) => s.outdoor === true).length,
  };
  summary.figures = fig;

  if (preset.calls) {
    summary.calls = {
      total: preset.callsTotal,
      unmatchedZip: preset.callsUnmatched,
      byVariant: Object.fromEntries(variants.map((v) => [v.key, callWeighted(preset, cellCount, cov[v.key])])),
    };
    summary.findings = findings(preset, t, cov, headlineKey, cellCount);
    summary.relocation = relocation(preset, cells, cellCount, statesFor(t, { key: headlineKey, close: DEFAULT_CLOSE, ai: false }), t.base, dir);
    // Does the ranking beat simpler ways of choosing, and does it hold under other assumptions?
    const regionIndex = new Map(preset.regions.map((r, i) => [r.id, i]));
    const at = (close: number, ai: boolean) => statesFor(t, { key: `${close}${ai ? "a" : ""}`, close, ai });
    const evalOut = rankingEval(
      cells,
      preset.calls,
      cellCount,
      (i) => t.base[i] === -1,
      (i) => regionIndex.get(preset.sites[i].zip) ?? 0,
      siteCount,
      [
        { key: "base", label: "As published: schools lock at 6 PM, unknown hours count as shut", states: at(DEFAULT_CLOSE, false), unknownOpen: false },
        { key: "close15", label: "Schools lock at 3 PM", states: at(15, false), unknownOpen: false },
        { key: "close21", label: "Schools stay open until 9 PM", states: at(21, false), unknownOpen: false },
        { key: "unknownOpen", label: "Every venue of unknown hours open around the clock", states: at(DEFAULT_CLOSE, false), unknownOpen: true },
        { key: "ai", label: "Bedrock's estimated hours counted", states: at(DEFAULT_CLOSE, true), unknownOpen: false },
      ],
    );
    writeJson(resolve(dir, "ranking-eval.json"), evalOut);
    summary.rankingEval = evalOut;
    summary.gapRegions = preset.regions
      .map((r, i) => {
        const calls = preset.calls![i].reduce((a, b) => a + b, 0);
        if (!cellCount[i] || calls < 60) return null;
        const actual = preset.calls![i].reduce((a, n, st) => a + n * (main.open[i][st] / cellCount[i]), 0) / calls;
        return { id: r.id, name: r.name, calls, sites: siteCount[i], timeBlind: main.reachable[i] / cellCount[i], actual };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.timeBlind - b.actual - (a.timeBlind - a.actual))
      .slice(0, 15);
  }
  writeJson(resolve(dir, "summary.json"), summary, true);

  // ----- downloads -----
  const csv = (rows: (string | number | null | undefined)[][]) =>
    rows.map((r) => r.map((v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")).join("\n");
  writeFileSync(
    resolve(dir, "sites.csv"),
    csv([
      ["id", "name", "category", "latitude", "longitude", preset.regionLabel.toLowerCase(), "aeds", "opening_hours", "hours_source", "hours_note"],
      ...preset.sites.map((s) => [s.id, s.name, s.group, s.lat, s.lon, s.zip, s.aeds, s.hours, s.hoursSource, s.hoursNote]),
    ]),
  );
  const share = (i: number, st: number) => (cellCount[i] ? (main.open[i][st] / cellCount[i]).toFixed(3) : "");
  writeFileSync(
    resolve(dir, "coverage.csv"),
    csv([
      [preset.regionLabel.toLowerCase(), "name", "population", "aed_locations", "share_in_walk_ignoring_hours", "share_open_tue_2pm", "share_open_tue_9pm", "share_open_sun_3am", "share_open_august_tue_2pm"],
      ...preset.regions.map((r, i) => [r.id, r.name, r.pop, siteCount[i], cellCount[i] ? (main.reachable[i] / cellCount[i]).toFixed(3) : "", share(i, stateIndex("school", 38)), share(i, stateIndex("school", 45)), share(i, stateIndex("school", 147)), share(i, stateIndex("summer", 38))]),
    ]),
  );
  console.log(`${preset.id}: presets written`);
  return summary;
}

/** The numbers the landing page states, computed here so the page never hardcodes one. */
function findings(preset: Preset, t: ReturnType<typeof patternTable>, cov: Record<string, ReturnType<typeof coverage>>, headline: string, cellCount: number[]) {
  const school = t.patterns[t.schoolPattern[DEFAULT_CLOSE]];
  let calls = 0, schoolShut = 0, night = 0, weekend = 0, summer = 0;
  const byHour = new Array(24).fill(0);
  for (const byState of preset.calls!)
    byState.forEach((n, st) => {
      if (!n) return;
      calls += n;
      if (school[st] !== 1) schoolShut += n;
      const h = st % HOURS_IN_WEEK;
      byHour[h % 24] += n;
      if (h % 24 >= 19 || h % 24 < 7) night += n;
      if (h >= 5 * 24) weekend += n;
      if (st >= HOURS_IN_WEEK) summer += n;
    });
  const boroughs: Record<string, { locations: number; schools: number }> = {};
  for (const s of preset.sites) {
    const b = (boroughs[s.area] ??= { locations: 0, schools: 0 });
    b.locations++;
    if (s.hoursSource === "calendar") b.schools++;
  }
  // Each ZIP's calls are spread over its 50 m squares, exactly as callWeighted() does for the
  // published 4.6% and 1.4%, so the share lost here is 1 − (open share ÷ time-blind share).
  const wv = (key: string) => {
    let blind = 0, open = 0, unknown = 0;
    preset.calls!.forEach((byState, ri) => {
      if (!cellCount[ri]) return;
      byState.forEach((c, st) => {
        if (!c) return;
        blind += (c * cov[key].reachable[ri]) / cellCount[ri];
        open += (c * cov[key].open[ri][st]) / cellCount[ri];
        unknown += (c * cov[key].unknown[ri][st]) / cellCount[ri];
      });
    });
    return { lostConservative: 1 - open / blind, lostIfUnknownWereOpen: 1 - (open + unknown) / blind };
  };
  const hourOpen = new Array(24).fill(0);
  const week = t.base.map((p, i) => t.patterns[p === -1 ? t.schoolPattern[DEFAULT_CLOSE] : p]);
  for (const p of week) for (let h = 0; h < 24; h++) if (p[stateIndex("school", 24 + h)] === 1) hourOpen[h]++;
  const share = (b: string) => (boroughs[b] ? boroughs[b].schools / boroughs[b].locations : 0);
  const outside = Object.entries(boroughs).filter(([b]) => b !== "Manhattan").reduce((a, [, v]) => [a[0] + v.schools, a[1] + v.locations], [0, 0]);
  return {
    locations: preset.sites.length,
    schoolLocations: preset.sites.filter((s) => s.hoursSource === "calendar").length,
    schoolShare: preset.sites.filter((s) => s.hoursSource === "calendar").length / preset.sites.length,
    schoolShareOutsideManhattan: outside[0] / outside[1],
    schoolShareBrooklyn: share("Brooklyn"),
    schoolShareBronx: share("Bronx"),
    schoolShareQueens: share("Queens"),
    schoolShareStatenIsland: share("Staten Island"),
    schoolShareManhattan: share("Manhattan"),
    callsWhenSchoolsShutShare: schoolShut / calls,
    boroughs,
    calls,
    callsWhenSchoolsShut: schoolShut,
    callsAtNight: night,
    callsOnWeekends: weekend,
    callsInSummer: summer,
    callsByHourOfDay: byHour,
    openLocationsByHourTuesday: hourOpen,
    coverageLost: wv(headline),
    coverageLostWithAi: wv(`${DEFAULT_CLOSE}a`),
    coverageLostSchools9pm: wv("21"),
  };
}

function tally(values: string[]) {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/**
 * Ranks school AEDs by the 2025 cardiac-arrest calls expected inside their walking catchment
 * while every AED in reach was shut: what a 24/7 outdoor cabinet on that wall would have reached.
 * Each cell is credited to its nearest school, so neighbouring schools never double-count.
 */
function relocation(preset: Preset, cells: Cell[], cellCount: number[], states: Uint8Array[], base: number[], dir: string) {
  // Always-staffed buildings from Overture Maps (Registry of Open Data on AWS, via Amazon Athena): see overture.ts.
  const overture = readJsonOr<{ release: string; hosts: { name: string; category: string; lon: number; lat: number }[] }>(resolve(CACHE, "nyc_overture_hosts.json"), { release: "", hosts: [] });
  const boroughOfZip = new Map(preset.sites.filter((s) => s.zip && s.area).map((s) => [s.zip, s.area]));
  const hosts = credibleHosts(overture.hosts, preset.regions, boroughOfZip);
  console.log(`${preset.id}: ${hosts.length} of ${overture.hosts.length} Overture places kept as always-staffed hosts`);
  const gain = new Map<number, number>();
  for (const c of cells) {
    const calls = preset.calls![c.region];
    const perCell = 1 / cellCount[c.region];
    const school = c.hits.find((i) => base[i] === -1);
    if (school === undefined) continue;
    for (let st = 0; st < STATES; st++) {
      if (!calls[st] || c.hits.some((i) => states[i][st] === 1)) continue;
      gain.set(school, (gain.get(school) ?? 0) + calls[st] * perCell);
    }
  }
  const rows = [...gain.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100)
    .map(([i, g], k) => {
      const s = preset.sites[i];
      const alt = hosts
        .map((h) => ({ h, m: distanceMeters([s.lon, s.lat], [h.lon, h.lat]) }))
        .filter((x) => x.m <= 400)
        .sort((a, b) => a.m - b.m)[0];
      return {
        rank: k + 1, id: s.id, name: s.name, zip: s.zip, area: s.area, lon: s.lon, lat: s.lat, expectedCallsPerYear: round(g, 2),
        altHost: alt ? { name: alt.h.name, category: alt.h.category.replace(/_/g, " "), meters: Math.round(alt.m), lon: alt.h.lon, lat: alt.h.lat } : null,
      };
    });
  writeJson(resolve(dir, "relocation.json"), rows);
  writeFileSync(
    resolve(dir, "relocation.csv"),
    [
      "rank,site_id,name,zip,borough,latitude,longitude,expected_after_hours_arrest_calls_in_reach_per_year,nearest_24h_staffed_building,its_type,meters_away",
      ...rows.map(
        (r) =>
          `${r.rank},${r.id},"${r.name.replace(/"/g, '""')}",${r.zip},${r.area},${r.lat},${r.lon},${r.expectedCallsPerYear},"${(r.altHost?.name ?? "").replace(/"/g, '""')}",${r.altHost?.category ?? ""},${r.altHost?.meters ?? ""}`,
      ),
    ].join("\n"),
  );
  return {
    method: "Expected 2025 cardiac-arrest calls inside the school's two-minute walk while every AED in reach was shut.",
    overtureRelease: overture.release,
    staffedBuildings: hosts.length,
    withStaffedBuildingNearby: rows.filter((r) => r.altHost).length,
    top: rows.slice(0, 10),
  };
}

// ---------- presets ----------

function nycPreset(): Preset {
  const sites = readJson<PipelineSite[]>(resolve(CACHE, "nyc_sites.json"));
  const zips = readJson<{ features: { properties: Record<string, string>; geometry: { type: string; coordinates: unknown } }[] }>(resolve(RAW, "nyc_modzcta.geojson"));
  const regions: Region[] = zips.features
    .filter((f) => f.geometry && f.properties.modzcta !== "99999")
    .map((f) => ({ id: f.properties.modzcta, name: f.properties.label, pop: Number(f.properties.pop_est) || 0, shape: asMulti(f.geometry) }));
  const regionOf = new Map<string, number>();
  regions.forEach((r, i) => {
    regionOf.set(r.id, i);
    for (const z of r.name.split(/[ ,]+/)) if (/^\d{5}$/.test(z)) regionOf.set(z, i);
  });
  for (const s of sites) {
    const inside = regions.findIndex((r) => inMultiPolygon([s.lon, s.lat], r.shape));
    const ri = inside >= 0 ? inside : regionOf.get(s.zip) ?? -1;
    if (ri >= 0) s.zip = regions[ri].id;
  }
  const raw = readJson<{ zipcode?: string; dow: string; hh: string; m: string; n: string }[]>(resolve(RAW, "nyc_arrest_2025.json"));
  const calls = regions.map(() => new Array(STATES).fill(0));
  let total = 0, unmatched = 0;
  for (const b of raw) {
    const n = Number(b.n);
    total += n;
    const ri = b.zipcode ? regionOf.get(b.zipcode) : undefined;
    if (ri === undefined) {
      unmatched += n;
      continue;
    }
    calls[ri][stateIndex(seasonOfMonth(Number(b.m)), mondayIndex(Number(b.dow)) * 24 + Number(b.hh))] += n;
  }
  return {
    id: "nyc",
    name: "New York City",
    city: "New York",
    regionLabel: "ZIP",
    center: [-73.94, 40.7],
    zoom: 10.2,
    sites,
    regions,
    isolines: readJsonOr(resolve(CACHE, "nyc_isolines.json"), {}),
    calls,
    callsTotal: total,
    callsUnmatched: unmatched,
    sources: [
      { name: "NYC Automated External Defibrillator (AED) Inventory", url: "https://data.cityofnewyork.us/d/2er2-jqsx", licence: "NYC Open Data terms of use" },
      { name: "FDNY EMS Incident Dispatch Data (2025, final call type ARREST)", url: "https://data.cityofnewyork.us/d/76xm-jjuj", licence: "NYC Open Data terms of use" },
      { name: "Modified ZIP Code Tabulation Areas (MODZCTA)", url: "https://data.cityofnewyork.us/d/pri4-ifjk", licence: "NYC Open Data terms of use" },
    ],
    extra: {
      registry: readJsonOr(resolve(CACHE, "nyc_registry_stats.json"), null),
      aiGrade: readJsonOr(resolve(CACHE, "nyc_ai_grade.json"), null),
    },
  };
}

function parisPreset(): Preset {
  const sites = readJson<PipelineSite[]>(resolve(CACHE, "paris_sites.json"));
  const arr = readJson<{ features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[] }>(resolve(RAW, "paris_arrondissements.geojson"));
  return {
    id: "paris",
    name: "Paris",
    city: "Paris",
    regionLabel: "Arrondissement",
    center: [2.345, 48.858],
    zoom: 11.3,
    sites,
    regions: arr.features.map((f) => ({ id: String(f.properties.c_ar), name: String(f.properties.l_aroff ?? f.properties.l_ar), pop: 0, shape: asMulti(f.geometry) })),
    isolines: {},
    sources: [
      { name: "Géo'DAE, Base nationale des défibrillateurs", url: "https://www.data.gouv.fr/datasets/geodae-base-nationale-des-defibrillateurs", licence: "Licence Ouverte 2.0" },
      { name: "Arrondissements de Paris", url: "https://opendata.paris.fr/explore/dataset/arrondissements/", licence: "ODbL" },
    ],
    extra: { registry: readJsonOr(resolve(CACHE, "paris_stats.json"), null) },
  };
}

const built = [build(nycPreset()), build(parisPreset())];
writeJson(
  resolve(OUT, "presets.json"),
  built.map((s) => ({ id: s.id, name: s.name, city: s.city, sites: s.sites, center: s.center, zoom: s.zoom, regionLabel: s.regionLabel })),
  true,
);
