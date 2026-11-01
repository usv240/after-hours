/**
 * The After Hours API. One Lambda behind API Gateway serves two route families:
 *   /site/*  the public website (no key; throttled at the stage),
 *   /v1/*    developers (x-api-key required; usage plan 5 req/s, 1,000/day).
 * Both call exactly the same functions, so what you see on the site is what the API returns.
 */
import {
  HOURS_IN_WEEK,
  SEASONS,
  formatHourOfWeek,
  nearest,
  normaliseHours,
  validateHours,
  weekStates,
  wallTimeFor,
  type LonLat,
} from "@after-hours/engine";
import { PRESETS, patternOf, preset } from "./data.ts";
import { ZONES, describe, stateFor, wallTimeIn } from "./time.ts";
import { geocode, isolines, walkingRoute, walkingSeconds } from "./location.ts";
import { debate, type Evidence } from "./debate.ts";
import { answerQuestion } from "./ask.ts";
import { mintKey, spend } from "./keys.ts";
import { mcp, type McpTools } from "./mcp.ts";

type Query = Record<string, string | undefined>;
interface Req {
  method: string;
  path: string;
  query: Query;
  body: unknown;
}
interface Res {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const STATE_NAME = ["closed", "open", "unknown"] as const;
const num = (v: string | undefined, name: string, min: number, max: number, dflt?: number) => {
  if (v == null || v === "") {
    if (dflt === undefined) throw fail(400, `"${name}" is required.`);
    return dflt;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw fail(400, `"${name}" must be a number between ${min} and ${max}.`);
  return n;
};
const bool = (v: string | undefined) => v === "1" || v === "true";

function assumptions(q: Query) {
  return {
    schoolClose: num(q.schoolClose, "schoolClose", 15, 21, 18),
    includeAi: bool(q.includeAi),
  };
}

// ---------- endpoints ----------

async function presets() {
  return Promise.all(
    PRESETS.map(async (id) => {
      const d = await preset(id);
      const s = d.summary;
      return { id, name: s.name, city: s.city, sites: s.sites, aeds: s.aeds, timeZone: ZONES[id], catchment: s.catchment, sources: s.sources, hoursSources: s.hoursSources };
    }),
  );
}

async function availabilityAt(q: Query) {
  const id = q.preset ?? "nyc";
  const d = await preset(id);
  const t = wallTimeIn(ZONES[id], q.at);
  const st = stateFor(t);
  const a = assumptions(q);
  const counts = { open: 0, closed: 0, unknown: 0 };
  const sites = d.sites.map((s) => {
    const state = STATE_NAME[patternOf(d, s, a.schoolClose, a.includeAi)[st]];
    counts[state]++;
    return { id: s.id, state };
  });
  return { preset: id, at: describe(t), assumptions: a, counts, sites: bool(q.list) ? sites : undefined };
}

async function nearestOpen(q: Query) {
  const id = q.preset ?? "nyc";
  const d = await preset(id);
  const p: LonLat = [num(q.lon, "lon", -180, 180), num(q.lat, "lat", -90, 90)];
  const t = wallTimeIn(ZONES[id], q.at);
  const st = stateFor(t);
  const a = assumptions(q);
  const shortlist = nearest(d.sites, p, 25, 2500);
  if (!shortlist.length) return { at: describe(t), message: "No registered AED within 2.5 km of this point.", candidates: [] };
  let seconds: (number | null)[];
  let routed = true;
  try {
    seconds = await walkingSeconds(p, shortlist.map((r) => r.site.at));
  } catch {
    // Routing unavailable: estimate from distance (1.3 m/s, 1.3x street detour) and say so.
    routed = false;
    seconds = shortlist.map((r) => Math.round((r.meters * 1.3) / 1.3));
  }
  const candidates = shortlist
    .map((r, i) => ({
      id: r.site.id,
      name: r.site.name,
      group: r.site.group,
      at: r.site.at,
      where: r.site.where,
      straightMeters: Math.round(r.meters),
      walkSeconds: seconds[i],
      state: STATE_NAME[patternOf(d, r.site, a.schoolClose, a.includeAi)[st]],
      hoursSource: r.site.source,
      hours: r.site.hours,
    }))
    .filter((c) => c.walkSeconds != null)
    .sort((x, y) => x.walkSeconds! - y.walkSeconds!);
  const timeBlind = candidates[0] ?? null;
  let open = candidates.find((c) => c.state === "open") ?? null;
  if (!open) {
    // Nothing open among the nearest 25: look further out, straight line, then route that one.
    const far = nearest(d.sites.filter((s) => patternOf(d, s, a.schoolClose, a.includeAi)[st] === 1), p, 1, 30000)[0];
    if (far) {
      const [secs] = routed ? await walkingSeconds(p, [far.site.at]).catch(() => [null]) : [null];
      open = {
        id: far.site.id, name: far.site.name, group: far.site.group, at: far.site.at, where: far.site.where,
        straightMeters: Math.round(far.meters), walkSeconds: secs ?? Math.round(far.meters), state: "open",
        hoursSource: far.site.source, hours: far.site.hours,
      };
    }
  }
  let route = null;
  if (open && routed && bool(q.route)) route = await walkingRoute(p, open.at).catch(() => null);
  return {
    at: describe(t),
    assumptions: a,
    routedBy: routed ? "Amazon Location Service Route Matrix, pedestrian" : "estimate from straight-line distance (routing unavailable)",
    timeBlindNearest: timeBlind,
    nearestOpen: open,
    extraSecondsBecauseOfHours: open && timeBlind ? Math.max(0, open.walkSeconds! - timeBlind.walkSeconds!) : null,
    candidates: candidates.slice(0, 8),
    route,
    note: "Planning tool, not an emergency service. In an emergency call 911 (112 in Europe) first.",
  };
}

interface InSite {
  name?: string;
  lat: number;
  lon: number;
  hours?: string | null;
}

/** Bring your own data: any list of places with opening hours, analysed hour by hour. */
function analyze(body: unknown) {
  const b = body as { sites?: InSite[]; at?: string; timeZone?: string };
  if (!Array.isArray(b?.sites) || !b.sites.length) throw fail(400, 'Send {"sites":[{"name","lat","lon","hours"}]}. Hours use OpenStreetMap syntax, e.g. "Mo-Fr 08:00-18:00" or "24/7".');
  if (b.sites.length > 5000) throw fail(413, "Up to 5,000 sites per request.");
  const issues: { index: number; message: string }[] = [];
  const memo = new Map<string, Uint8Array>();
  const out = b.sites.map((s, i) => {
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) issues.push({ index: i, message: "Missing or invalid lat/lon." });
    let hours = normaliseHours(s.hours);
    if (hours) {
      const problem = validateHours(hours);
      if (problem) {
        issues.push({ index: i, message: `Hours "${s.hours}" could not be read: ${problem}. Treated as unknown.` });
        hours = null;
      }
    }
    const key = hours ?? "";
    if (!memo.has(key)) memo.set(key, weekStates(hours));
    return { name: s.name ?? `Site ${i + 1}`, lat, lon, hours, week: memo.get(key)! };
  });
  const week = Object.fromEntries(
    SEASONS.map((season, si) => {
      const open = new Array(HOURS_IN_WEEK).fill(0), unknown = new Array(HOURS_IN_WEEK).fill(0);
      for (const s of out)
        for (let h = 0; h < HOURS_IN_WEEK; h++) {
          const v = s.week[si * HOURS_IN_WEEK + h];
          if (v === 1) open[h]++;
          else if (v === 2) unknown[h]++;
        }
      return [season, { open, unknown }];
    }),
  );
  const school = week.school as { open: number[] };
  const worst = school.open.reduce((w, v, h) => (v < school.open[w] ? h : w), 0);
  const best = school.open.reduce((w, v, h) => (v > school.open[w] ? h : w), 0);
  const always = out.filter((s) => s.week.slice(0, HOURS_IN_WEEK).every((v) => v === 1)).length;
  let current = null;
  if (b.timeZone || b.at) {
    const t = wallTimeIn(b.timeZone ?? "UTC", b.at);
    const st = stateFor(t);
    current = { at: describe(t), open: out.filter((s) => s.week[st] === 1).length };
  }
  return {
    sites: out.length,
    withHours: out.filter((s) => s.hours).length,
    alwaysOpen: always,
    peak: { when: formatHourOfWeek(best), open: school.open[best] },
    trough: { when: formatHourOfWeek(worst), open: school.open[worst] },
    current,
    week,
    perSite: out.map((s) => ({ name: s.name, hours: s.hours, weekStates: Buffer.from(s.week).toString("base64") })),
    issues,
    legend: "weekStates: 336 bytes, base64. Byte h (0-167) is a school-year week from Monday 00:00; 168-335 is a summer week. 0 closed, 1 open, 2 unknown.",
  };
}

async function evidenceFor(body: { preset?: string; siteId?: string }) {
  const d = await preset(body.preset ?? "nyc");
  const s = d.summary as Record<string, any>;
  const site = d.sites.find((x) => x.id === body.siteId) ?? d.sites.find((x) => x.id === (d.relocation[0] as { id: string })?.id);
  if (!site) throw fail(404, "Site not found.");
  const rank = d.relocation.find((r) => r.id === site.id) as
    | { rank: number; expectedCallsPerYear: number; altHost: { name: string; category: string; meters: number } | null }
    | undefined;
  const v = s.calls?.byVariant?.[s.headlineVariant];
  const pattern = patternOf(d, site, 18, false);
  const openHours = pattern.slice(0, HOURS_IN_WEEK).filter((x) => x === 1).length;
  const near = nearest(d.sites, site.at, 12, 400).filter((r) => r.site.id !== site.id);
  const always = near.filter((r) => patternOf(d, r.site, 18, false).slice(0, HOURS_IN_WEEK).every((x) => x === 1));
  const ev: Evidence[] = [
    { id: "E1", text: `${site.name} (${site.group}, ZIP ${site.region}) has a registered AED${site.where ? ` at "${site.where}"` : ""}.` },
    { id: "E2", text: `Its hours come from: ${site.note}` },
    { id: "E3", text: `Under that assumption it is reachable ${openHours} of 168 hours in a school-year week, and 0 hours in a summer week if it is a school.` },
    rank
      ? { id: "E4", text: `In 2025, an expected ${rank.expectedCallsPerYear} cardiac-arrest 911 calls a year came from inside its two-minute walking area at hours when every AED in reach was shut (rank ${rank.rank} of ${d.relocation.length} NYC schools).` }
      : { id: "E4", text: "It is not in the top 100 schools for after-hours calls in reach." },
    { id: "E5", text: `Within 400 m there are ${near.length} other registered AED locations; ${always.length} of them are open 24/7 by their published hours.` },
    { id: "E6", text: `Citywide, a time-blind map puts ${(v?.timeBlindCoverage * 100).toFixed(1)}% of call-weighted area within a two-minute walk of an AED; at the hour calls actually came in, ${(v?.actualCoverage * 100).toFixed(1)}% was within reach of one confirmed open.` },
    { id: "E7", text: "Published research: a bystander shock with a public AED was associated with survival to discharge of 66.5% versus 43.0% without (Pollack et al., Circulation 2018, observed shockable public arrests)." },
    {
      id: "E8",
      text: rank?.altHost
        ? `Overture Maps lists ${rank.altHost.name}, a ${rank.altHost.category} normally staffed around the clock, ${rank.altHost.meters} m away: a possible alternative host for a 24/7 AED.`
        : "Overture Maps lists no fire station, police station or hospital within 400 m.",
    },
    { id: "E9", text: "Unknown to this data: cabinet cost, vandalism risk, whether the school already allows after-hours access, and the actual location of each 2025 call inside the ZIP (only ZIP-level data is public)." },
  ];
  return { site, ev };
}

export async function runDebate(body: unknown) {
  const b = (body ?? {}) as { preset?: string; siteId?: string };
  const { site, ev } = await evidenceFor(b);
  await spend("debates", Number(process.env.DEBATES_PER_DAY ?? 400), "Today's debate limit is reached. Read a saved debate, or try again tomorrow.");
  return debate(`Move the AED at ${site.name} into a 24/7 outdoor cabinet on the building's street wall.`, ev);
}

// ---------- ask the map ----------

/** A question in plain words → the place and hour to look at. The answer itself comes from /nearest. */
async function ask(body: unknown) {
  const question = String((body as { question?: unknown })?.question ?? "").trim();
  if (!question) throw fail(400, 'Send {"question":"Sunday 11 PM near Penn Station"}.');
  if (question.length > 300) throw fail(413, "Keep the question under 300 characters.");
  await spend("asks", Number(process.env.ASKS_PER_DAY ?? 2000), "Today's question limit is reached. Drop a pin on the map instead.");
  const a = await answerQuestion(question, wallTimeIn(ZONES.nyc));
  return {
    question,
    ...a,
    geocodedBy: "Amazon Location Service Places (Geocode)",
    note: "Planning tool, not an emergency service. In an emergency call 911 first.",
  };
}

// ---------- router ----------

const routes: Record<string, (r: Req) => Promise<unknown> | unknown> = {
  "GET /health": () => ({ ok: true, service: "after-hours", presets: PRESETS }),
  "GET /presets": () => presets(),
  "GET /summary": async (r) => (await preset(r.query.preset ?? "nyc")).summary,
  "GET /availability": (r) => availabilityAt(r.query),
  "GET /nearest": (r) => nearestOpen(r.query),
  "GET /relocation": async (r) => (await preset(r.query.preset ?? "nyc")).relocation.slice(0, num(r.query.limit, "limit", 1, 100, 20)),
  "POST /analyze": (r) => analyze(r.body),
  "POST /geocode": async (r) => {
    const b = r.body as { queries?: string[]; bias?: LonLat };
    if (!Array.isArray(b?.queries) || !b.queries.length) throw fail(400, 'Send {"queries":["address", ...]}.');
    if (b.queries.length > 25) throw fail(413, "Up to 25 addresses per request.");
    return { results: await geocode(b.queries, b.bias) };
  },
  "POST /isolines": async (r) => {
    const b = r.body as { points?: LonLat[]; seconds?: number };
    if (!Array.isArray(b?.points) || !b.points.length) throw fail(400, 'Send {"points":[[lon,lat], ...], "seconds":120}.');
    if (b.points.length > 25) throw fail(413, "Up to 25 points per request.");
    const seconds = Math.min(600, Math.max(30, Number(b.seconds ?? 120)));
    return { seconds, travelMode: "Pedestrian", isolines: await isolines(b.points, seconds) };
  },
  "POST /debate": (r) => runDebate(r.body),
  "POST /ask": (r) => ask(r.body),
  "POST /keys": (r) => mintKey(String((r.body as { label?: string })?.label ?? "")),
};

const q = (a: Record<string, unknown>): Query =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)]));

const mcpTools: McpTools = {
  availability: (a) => availabilityAt(q(a)),
  nearest: (a) => nearestOpen({ ...q(a), route: "0" }),
  relocation: async (a) => (await preset("nyc")).relocation.slice(0, Math.min(100, Math.max(1, Number(a.limit ?? 10)))),
  summary: async (a) => {
    const s = (await preset(String(a.preset ?? "nyc"))).summary as Record<string, unknown>;
    const { week: _w, ...rest } = s;
    return rest;
  },
  analyze: async (a) => {
    const r = analyze(a) as Record<string, unknown>;
    delete r.perSite;
    return r;
  },
};

export async function route(req: Req): Promise<Res> {
  const path = req.path.replace(/^\/api(?=\/)/, "").replace(/^\/(site|v1)(?=\/)/, "").replace(/\/+$/, "") || "/";
  const fn = routes[`${req.method} ${path}`];
  try {
    if (req.method === "OPTIONS") return { status: 204, body: null };
    if (path === "/mcp") {
      if (req.method !== "POST") return { status: 405, body: { error: "MCP over HTTP: send JSON-RPC with POST." }, headers: { allow: "POST" } };
      return await mcp(req.body, mcpTools);
    }
    if (!fn) throw fail(404, `No route ${req.method} ${path}. See /api.html for the reference.`);
    return { status: 200, body: await fn({ ...req, path }) };
  } catch (e) {
    const err = e as Error & { status?: number };
    if (!err.status) console.error(err);
    return { status: err.status ?? 500, body: { error: err.status ? err.message : "Something went wrong on our side." } };
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-api-key",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

/** API Gateway (REST, proxy integration) entry point. */
export async function handler(event: {
  httpMethod: string;
  path: string;
  queryStringParameters?: Query | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}) {
  let body: unknown = null;
  if (event.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    try {
      body = JSON.parse(raw);
    } catch {
      return { statusCode: 400, headers: { "content-type": "application/json", ...CORS }, body: JSON.stringify({ error: "Body must be JSON." }) };
    }
  }
  const res = await route({ method: event.httpMethod, path: event.path, query: event.queryStringParameters ?? {}, body });
  const cacheable = event.httpMethod === "GET" && res.status === 200 && /\/(presets|summary|relocation)$/.test(event.path);
  return {
    statusCode: res.status,
    headers: { "content-type": "application/json", "cache-control": cacheable ? "public, max-age=300" : "no-store", ...CORS, ...res.headers },
    body: res.body === undefined ? "" : JSON.stringify(res.body),
  };
}
