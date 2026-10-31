import maplibregl, { type LngLatLike, type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/app.css";
import { DAY_LONG, api, cityNow, el, fmt, getJson, hourLabel } from "./common.ts";
import { HOURS, decodeB64, localIso, stateIndex, type Season } from "./time.ts";
import { ATTRIBUTION, basemapStyle } from "./basemap.ts";

// ---------- data shapes ----------

interface Summary {
  id: string;
  name: string;
  city: string;
  regionLabel: string;
  center: [number, number];
  zoom: number;
  sites: number;
  variants: string[];
  headlineVariant: string;
  schoolCloseOptions: number[] | null;
  week: Record<string, Record<Season, { open: number[]; unknown: number[] }>>;
  hoursSources: Record<string, number>;
  catchment: { kind: string; label: string };
  aiGrade?: { falseOpenShare: number };
}
interface SitesFile {
  columns: string[];
  sources: string[];
  schoolPattern: Record<string, number>;
  patterns: string[];
  rows: [string, string, string, number, number, string, number, number, number, number | null, string, string | null, string][];
}
interface RegionStats {
  variants: string[];
  regions: { id: string; name: string; pop: number; cells: number; reachable: number; sites: number; calls: string | null; open: Record<string, string>; unknown: Record<string, string> }[];
}
interface Relocation {
  rank: number;
  id: string;
  name: string;
  zip: string;
  area: string;
  lon: number;
  lat: number;
  expectedCallsPerYear: number;
  altHost: { name: string; category: string; meters: number } | null;
}

const TZ: Record<string, string> = { nyc: "America/New_York", paris: "Europe/Paris" };
const SOURCE_LABEL: Record<string, string> = {
  declared: "Declared by the owner",
  places: "Amazon Location Service",
  calendar: "School calendar",
  ai: "Amazon Bedrock estimate",
  assumed: "Assumed",
  unknown: "Not published",
};
const STATE_WORD = ["Locked", "Open", "Hours unknown"];

// ---------- state ----------

const state = {
  preset: "nyc",
  season: "school" as Season,
  day: 1,
  hour: 14,
  close: 18,
  ai: false,
  tab: "explore",
  playing: 0 as number,
};

let summary: Summary;
let sites: SitesFile;
let patterns: Uint8Array[] = [];
let regions: RegionStats;
let regionOpen: number[] = [];
let regionCalls: (Uint8Array | null)[] = [];
let relocation: Relocation[] = [];
let siteState = new Uint8Array(0);
let pinMarker: maplibregl.Marker | null = null;
let loadToken = 0;
/**
 * Feature ids are timetable groups, not sites: every location that keeps the same hours shares
 * one id, so a clock change is a few hundred feature-state updates instead of eight thousand.
 */
const SCHOOL_GROUP = 1_000_000;
const AI_GROUP = 2_000_000;
let groupOf = new Int32Array(0);
let groupIds: number[] = [];
let lastPaintKey = "";
const regionState = new Map<number, number>();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- map ----------

const map = new maplibregl.Map({
  container: "map",
  style: basemapStyle(),
  center: [-73.94, 40.7],
  zoom: 10.2,
  minZoom: 9,
  maxZoom: 18,
  attributionControl: { compact: true, customAttribution: ATTRIBUTION },
  cooperativeGestures: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "340px", className: "ah-popup" });
const hoverTip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "ah-tip", offset: 10 });

function variantKey() {
  if (!summary.schoolCloseOptions) return summary.headlineVariant;
  return `${state.close}${state.ai ? "a" : ""}`;
}

function patternFor(row: SitesFile["rows"][number]): Uint8Array {
  const p = row[8];
  if (p === -1) return patterns[sites.schoolPattern[String(state.close)]];
  if (state.ai && row[9] != null) return patterns[row[9]];
  return patterns[p];
}

async function loadPreset(id: string) {
  const token = ++loadToken;
  $("map-status").textContent = "Loading locations…";
  $("map-status").hidden = false;
  const base = `/data/${id}`;
  const [s, st, rs, rel, catchments] = await Promise.all([
    getJson<Summary>(`${base}/summary.json`),
    getJson<SitesFile>(`${base}/sites.json`),
    getJson<RegionStats>(`${base}/region-stats.json`),
    id === "nyc" ? getJson<Relocation[]>(`${base}/relocation.json`) : Promise.resolve([]),
    getJson<{ type: string; features: { id: number; properties: Record<string, number> }[] }>(`${base}/catchments.geojson`),
  ]);
  if (token !== loadToken) return;
  summary = s;
  sites = st;
  regions = rs;
  relocation = rel;
  patterns = st.patterns.map(decodeB64);
  regionCalls = rs.regions.map((r) => (r.calls ? decodeB64(r.calls) : null));
  siteState = new Uint8Array(st.rows.length);
  state.preset = id;
  groupOf = Int32Array.from(st.rows, (r) => (r[8] === -1 ? SCHOOL_GROUP : r[9] != null ? AI_GROUP + r[9] : r[8]));
  groupIds = [...new Set(groupOf)];
  lastPaintKey = "";
  regionState.clear();
  for (const f of catchments.features) f.properties = { g: groupOf[f.id] };

  for (const layer of ["catch-fill", "catch-line", "regions-fill", "regions-line", "points", "points-halo"]) if (map.getLayer(layer)) map.removeLayer(layer);
  for (const src of ["catch", "regions", "points"]) if (map.getSource(src)) map.removeSource(src);

  map.addSource("regions", { type: "geojson", data: `${base}/regions.geojson` });
  map.addSource("catch", { type: "geojson", data: catchments as unknown as GeoJSON.FeatureCollection });
  map.addSource("points", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: st.rows.map((r, i) => ({ type: "Feature", properties: { i, g: groupOf[i] }, geometry: { type: "Point", coordinates: [r[3], r[4]] } })),
    },
  });
  const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addLayer(
    {
      id: "regions-fill",
      type: "fill",
      source: "regions",
      paint: { "fill-color": "#c81e1e", "fill-opacity": ["coalesce", ["feature-state", "calls"], 0] },
    },
    firstLabel,
  );
  map.addLayer({ id: "regions-line", type: "line", source: "regions", paint: { "line-color": "#ffffff", "line-opacity": 0.12, "line-width": 0.6 } }, firstLabel);
  map.addLayer(
    {
      id: "catch-fill",
      type: "fill",
      source: "catch",
      paint: {
        "fill-color": "#9a9a9a",
        "fill-opacity": 0.18,
      },
    },
    firstLabel,
  );
  map.addLayer({
    id: "points-halo",
    type: "circle",
    source: "points",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 0, 13, 9, 16, 16],
      "circle-color": "#3ee08f",
      "circle-opacity": 0,
      "circle-blur": 0.6,
    },
  });
  map.addLayer({
    id: "points",
    type: "circle",
    source: "points",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.6, 12, 3, 15, 6.5],
      "circle-color": "#8c8c8c",
      "circle-stroke-color": "#121212",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 0, 14, 1.5],
      "circle-opacity": ["case", ["boolean", ["feature-state", "dim"], false], 0.35, 1],
    },
  });
  applyLayerToggles();
  map.jumpTo({ center: s.center, zoom: s.zoom });

  // Panel copy and controls that depend on the preset.
  $("city-name").textContent = s.city;
  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.preset === id)));
  $("school-field").hidden = !s.schoolCloseOptions;
  $("ai-field").hidden = !s.variants.some((v) => v.endsWith("a"));
  $("tab-relocation").hidden = id !== "nyc";
  if (id !== "nyc" && state.tab === "relocation") setTab("explore");
  $("region-layer-label").textContent =
    id === "nyc" ? "ZIP codes, shaded by cardiac-arrest calls at this hour" : "Arrondissements";
  $("city-intro").textContent =
    id === "nyc"
      ? "Each dot is a building with a public defibrillator. Its glow is the area within a two-minute walk, routed on real streets. Move the clock and watch which ones lock."
      : `Paris uses France's national registry, where owners must declare when each AED can be reached. ${fmt.format(s.hoursSources.unknown ?? 0)} of ${fmt.format(s.sites)} never did, so they show as unknown. Walking areas here are ${s.catchment.label}.`;
  buildWeekstrip();
  renderRelocation();
  const wait = () => {
    if (map.isSourceLoaded("catch") && map.isSourceLoaded("regions")) {
      $("map-status").hidden = true;
      update();
    } else setTimeout(wait, 120);
  };
  update();
  wait();
}

function applyLayerToggles() {
  const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  const c = $<HTMLInputElement>("layer-catch").checked;
  const r = $<HTMLInputElement>("layer-regions").checked;
  const p = $<HTMLInputElement>("layer-points").checked;
  vis("catch-fill", c);
  vis("regions-fill", r);
  vis("regions-line", r);
  vis("points", p);
  vis("points-halo", p);
}

// ---------- the clock ----------

function update() {
  if (!summary) return;
  const st = stateIndex(state.season, state.day, state.hour);
  const counts = [0, 0, 0];
  sites.rows.forEach((row, i) => {
    const v = patternFor(row)[st];
    siteState[i] = v;
    counts[v]++;
  });
  if (map.getSource("points")) {
    // Colour by timetable group with one paint expression per hour. Changing a data-driven
    // paint value re-tiles on MapLibre's worker, so the page never stalls on the main thread.
    const school = patterns[sites.schoolPattern[String(state.close)]];
    const open: number[] = [], closed: number[] = [];
    for (const g of groupIds) {
      const v = g === SCHOOL_GROUP ? school?.[st] ?? 2 : g >= AI_GROUP ? (state.ai ? patterns[g - AI_GROUP][st] : 2) : patterns[g][st];
      if (v === 1) open.push(g);
      else if (v === 0) closed.push(g);
    }
    const key = `${open.join(",")}|${closed.join(",")}`;
    if (key !== lastPaintKey) {
      lastPaintKey = key;
      const by = <T,>(o: T, c: T, u: T) => {
        const e: unknown[] = ["match", ["get", "g"]];
        if (open.length) e.push(open, o);
        if (closed.length) e.push(closed, c);
        e.push(u);
        return (e.length > 3 ? e : u) as maplibregl.ExpressionSpecification;
      };
      map.setPaintProperty("catch-fill", "fill-color", by("#3ee08f", "#e2453b", "#9a9a9a"));
      map.setPaintProperty("catch-fill", "fill-opacity", by(0.55, 0.14, 0.18));
      map.setPaintProperty("points", "circle-color", by("#3ee08f", "#e2453b", "#8c8c8c"));
      map.setPaintProperty("points-halo", "circle-opacity", by(0.22, 0, 0));
    }
    const vk = variantKey();
    let maxCalls = 0;
    regionCalls.forEach((c) => c && (maxCalls = Math.max(maxCalls, c[st])));
    regions.regions.forEach((r, i) => {
      const calls = regionCalls[i]?.[st] ?? 0;
      const shade = calls ? Math.round(100 * (0.1 + 0.4 * (calls / Math.max(1, maxCalls)))) / 100 : 0;
      if (regionState.get(i) !== shade) {
        regionState.set(i, shade);
        map.setFeatureState({ source: "regions", id: i }, { calls: shade });
      }
      regionOpen[i] = decodeCached(r.open[vk], i, vk)[st];
    });
  }

  const total = sites.rows.length;
  $("n-open").textContent = fmt.format(counts[1]);
  $("n-closed").textContent = fmt.format(counts[0]);
  $("n-unknown").textContent = fmt.format(counts[2]);
  $("bar-open").style.flexGrow = String(counts[1] / total);
  $("bar-closed").style.flexGrow = String(counts[0] / total);
  $("bar-unknown").style.flexGrow = String(counts[2] / total);

  // Coverage: share of the city's grid within a two-minute walk of an open AED.
  let cells = 0, open = 0, reach = 0, calls = 0;
  regions.regions.forEach((r, i) => {
    cells += r.cells;
    reach += r.reachable;
    open += (regionOpen[i] / 255) * r.cells;
    calls += regionCalls[i]?.[st] ?? 0;
  });
  const pct = (x: number) => (x > 0 && x < 0.0005 ? "under 0.1" : x < 0.1 ? (x * 100).toFixed(1) : Math.round(x * 100)) + "%";
  const callLine =
    state.preset === "nyc"
      ? ` In 2025, ${fmt.format(calls)} cardiac-arrest call${calls === 1 ? "" : "s"} came in at this hour of the week${state.season === "summer" ? " in July and August" : ""}.`
      : "";
  $("cover-line").textContent = `${pct(open / cells)} of the city is within a two-minute walk of an open defibrillator, against ${pct(reach / cells)} if every one were open.${callLine}`;

  $("when-day").textContent = `${DAY_LONG[state.day]}${state.season === "summer" ? " in summer" : ""}`;
  $("when-hour").textContent = `${hourLabel(state.hour)}`;
  $<HTMLInputElement>("hour").value = String(state.hour);
  document.querySelectorAll<HTMLButtonElement>("#days button").forEach((b, i) => b.setAttribute("aria-checked", String(i === state.day)));
  document.querySelectorAll<HTMLButtonElement>("#season button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.season === state.season)));
  paintWeekstrip();
}

const b64Cache = new Map<string, Uint8Array>();
function decodeCached(b64: string, i: number, vk: string) {
  const k = `${state.preset}:${vk}:${i}`;
  let v = b64Cache.get(k);
  if (!v) b64Cache.set(k, (v = decodeB64(b64)));
  return v;
}

function weekCounts() {
  return summary.week[variantKey()][state.season];
}

function buildWeekstrip() {
  const host = $("weekstrip");
  host.replaceChildren();
  for (let h = 0; h < HOURS; h++) {
    const b = el("button", { type: "button", title: "" });
    b.dataset.h = String(h);
    b.tabIndex = -1;
    b.setAttribute("aria-label", `${DAY_LONG[Math.floor(h / 24)]} ${hourLabel(h % 24)}`);
    host.append(b);
  }
  paintWeekstrip();
}

function paintWeekstrip() {
  const w = weekCounts();
  const max = Math.max(...w.open, 1);
  const now = state.day * 24 + state.hour;
  $("weekstrip")
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((b, h) => {
      b.style.setProperty("--v", String(w.open[h] / max));
      b.classList.toggle("is-now", h === now);
      b.title = `${DAY_LONG[Math.floor(h / 24)]} ${hourLabel(h % 24)}: ${fmt.format(w.open[h])} open`;
    });
}

// ---------- site details ----------

function siteCard(i: number) {
  const r = sites.rows[i];
  const p = patternFor(r);
  const base = state.season === "summer" ? HOURS : 0;
  const strip = el("div", { class: "mini-week" });
  for (let d = 0; d < 7; d++) {
    const row = el("div", { class: "mini-week__row" }, el("span", { class: "mini-week__day" }, ["M", "T", "W", "T", "F", "S", "S"][d]));
    const cells = el("div", { class: "mini-week__cells" });
    for (let h = 0; h < 24; h++) {
      const v = p[base + d * 24 + h];
      cells.append(el("i", { class: `s${v}${d === state.day && h === state.hour ? " now" : ""}` }));
    }
    row.append(cells);
    strip.append(row);
  }
  const openHours = Array.from(p.slice(base, base + HOURS)).filter((v) => v === 1).length;
  const source = sites.sources[r[7]];
  return el(
    "div",
    { class: "card" },
    el("p", { class: `card__state card__state--s${siteState[i]}` }, `${STATE_WORD[siteState[i]]} at ${hourLabel(state.hour)}`),
    el("h3", {}, r[1]),
    el("p", { class: "card__meta" }, [r[2], r[5] ? `${summary.regionLabel} ${r[5]}` : "", r[6] > 1 ? `${r[6]} AEDs` : ""].filter(Boolean).join(" · ")),
    r[10] ? el("p", { class: "card__where" }, `Where inside: ${r[10]}`) : null,
    strip,
    el("p", { class: "card__hours" }, `Reachable ${openHours} of 168 hours ${state.season === "summer" ? "in a summer week" : "in a school-year week"}.`),
    el("p", { class: "card__source" }, el("b", {}, `${SOURCE_LABEL[source]}: `), r[12]),
  );
}

map.on("mousemove", "points", (e) => {
  const f = e.features?.[0];
  if (!f) return;
  map.getCanvas().style.cursor = "pointer";
  const i = f.properties.i as number;
  hoverTip.setLngLat(e.lngLat).setHTML("").addTo(map);
  hoverTip.setDOMContent(el("span", {}, `${sites.rows[i][1]} · ${STATE_WORD[siteState[i]].toLowerCase()}`));
});
map.on("mouseleave", "points", () => {
  map.getCanvas().style.cursor = "";
  hoverTip.remove();
});
map.on("click", (e) => {
  const hits = map.queryRenderedFeatures(e.point, { layers: ["points"].filter((l) => map.getLayer(l)) });
  if (state.tab === "pin") {
    dropPin([e.lngLat.lng, e.lngLat.lat]);
    return;
  }
  if (hits.length) {
    const i = hits[0].properties.i as number;
    popup.setLngLat([sites.rows[i][3], sites.rows[i][4]]).setDOMContent(siteCard(i)).addTo(map);
    return;
  }
  const reg = map.queryRenderedFeatures(e.point, { layers: ["regions-fill"].filter((l) => map.getLayer(l)) })[0] as MapGeoJSONFeature | undefined;
  if (reg) popup.setLngLat(e.lngLat).setDOMContent(regionCard(reg.id as number)).addTo(map);
});

function regionCard(i: number) {
  const r = regions.regions[i];
  const st = stateIndex(state.season, state.day, state.hour);
  const vk = variantKey();
  const open = decodeCached(r.open[vk], i, vk)[st] / 255;
  const calls = regionCalls[i];
  const yearCalls = calls ? Array.from(calls).reduce((a, b) => a + b, 0) : null;
  return el(
    "div",
    { class: "card" },
    el("h3", {}, `${summary.regionLabel} ${r.name}`),
    el("p", { class: "card__meta" }, `${fmt.format(r.sites)} AED location${r.sites === 1 ? "" : "s"}${r.pop ? ` · ${fmt.format(r.pop)} residents` : ""}`),
    el(
      "p",
      {},
      `Within a two-minute walk of an open AED at ${hourLabel(state.hour)}: ${(open * 100).toFixed(1)}% of its streets. If every AED were open: ${((100 * r.reachable) / Math.max(1, r.cells)).toFixed(1)}%.`,
    ),
    yearCalls != null ? el("p", {}, `${fmt.format(yearCalls)} cardiac-arrest calls in 2025.`) : null,
  );
}

// ---------- collapse here ----------

function minutes(s: number) {
  const m = Math.round(s / 60);
  return m <= 1 ? "1 minute" : `${m} minutes`;
}

async function dropPin(at: [number, number], label?: string) {
  pinMarker?.remove();
  const node = el("div", { class: "pin" });
  pinMarker = new maplibregl.Marker({ element: node }).setLngLat(at).addTo(map);
  clearRoute();
  const out = $("pin-result");
  out.replaceChildren(el("p", { class: "loading" }, `Walking the streets from ${label ?? "this point"}…`));
  const q = new URLSearchParams({
    preset: state.preset,
    lon: String(at[0]),
    lat: String(at[1]),
    at: localIso(state.season, state.day, state.hour),
    schoolClose: String(state.close),
    includeAi: state.ai ? "1" : "0",
    route: "1",
  });
  try {
    const r = await api<{
      at: string;
      routedBy: string;
      timeBlindNearest: Cand | null;
      nearestOpen: Cand | null;
      extraSecondsBecauseOfHours: number | null;
      candidates: Cand[];
      route: { line: [number, number][]; seconds: number; meters: number } | null;
      message?: string;
    }>(`/site/nearest?${q}`);
    renderPin(r, at);
  } catch (e) {
    out.replaceChildren(el("p", { class: "error" }, `Could not route from here: ${(e as Error).message}`));
  }
}

interface Cand {
  id: string;
  name: string;
  group: string;
  at: [number, number];
  where: string;
  straightMeters: number;
  walkSeconds: number;
  state: "open" | "closed" | "unknown";
  hoursSource: string;
}

function renderPin(r: { timeBlindNearest: Cand | null; nearestOpen: Cand | null; extraSecondsBecauseOfHours: number | null; candidates: Cand[]; route: { line: [number, number][] } | null; routedBy: string; message?: string }, at: [number, number]) {
  const out = $("pin-result");
  const when = `${DAY_LONG[state.day]}${state.season === "summer" ? " in summer" : ""} at ${hourLabel(state.hour)}`;
  if (!r.timeBlindNearest) {
    out.replaceChildren(el("p", {}, r.message ?? "No registered defibrillator nearby."));
    return;
  }
  const near = r.timeBlindNearest;
  const open = r.nearestOpen;
  const verdict =
    near.state === "open"
      ? el("p", { class: "verdict verdict--ok" }, `The nearest defibrillator is open. ${minutes(near.walkSeconds)} each way.`)
      : el(
          "p",
          { class: "verdict verdict--bad" },
          open
            ? `The nearest one is ${near.state === "closed" ? "locked" : "of unknown hours"}. The nearest open one is ${minutes(open.walkSeconds)} away, ${minutes(r.extraSecondsBecauseOfHours ?? 0)} further.`
            : "Nothing open within reach at this hour.",
        );
  const row = (c: Cand, tag: string) =>
    el(
      "li",
      { class: `cand cand--${c.state}` },
      el("span", { class: "cand__tag" }, tag),
      el("b", {}, c.name),
      el("span", {}, `${c.group} · ${minutes(c.walkSeconds)} walk · ${c.state === "closed" ? "locked" : c.state}`),
    );
  const list = el("ol", { class: "cands" }, row(near, "Nearest"));
  if (open && open.id !== near.id) list.append(row(open, "Nearest open"));
  const roundTrip = open ? open.walkSeconds * 2 : null;
  out.replaceChildren(
    el("p", { class: "pin__when" }, when),
    verdict,
    list,
    roundTrip
      ? el(
          "p",
          { class: "hint" },
          roundTrip > 20 * 60
            ? `That is too far for anyone to fetch in time: a round trip of about ${minutes(roundTrip)}. Each minute without CPR and defibrillation costs roughly 7 to 10% of the chance of survival.`
            : `A bystander has to fetch it and come back: about ${minutes(roundTrip)} before the first shock. Each minute without CPR and defibrillation costs roughly 7 to 10% of the chance of survival.`,
        )
      : "",
    el("p", { class: "fine" }, `Walking times: ${r.routedBy}.`),
  );
  const bounds = new maplibregl.LngLatBounds(at, at);
  bounds.extend(near.at as LngLatLike);
  if (open) bounds.extend(open.at as LngLatLike);
  if (r.route?.line?.length) {
    drawRoute(r.route.line);
    r.route.line.forEach((p) => bounds.extend(p));
  }
  drawCandidates(near, open);
  map.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 80, right: 80 }, maxZoom: 16.5, duration: 700 });
}

function clearRoute() {
  for (const id of ["route", "cands"]) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
}

function drawRoute(line: [number, number][]) {
  map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } } });
  map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#ffd100", "line-width": 4, "line-dasharray": [1.2, 1.2] }, layout: { "line-cap": "round" } });
}

function drawCandidates(near: Cand, open: Cand | null) {
  const feats = [near, open].filter(Boolean).map((c) => ({ type: "Feature" as const, properties: { s: c!.state }, geometry: { type: "Point" as const, coordinates: c!.at } }));
  map.addSource("cands", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
  map.addLayer({
    id: "cands",
    type: "circle",
    source: "cands",
    paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 3, "circle-stroke-color": ["match", ["get", "s"], "open", "#3ee08f", "closed", "#e2453b", "#9a9a9a"] },
  });
}

$("search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("search-input").value.trim();
  if (!q) return;
  try {
    const { results } = await api<{ results: { lon?: number; lat?: number; label?: string; error?: string }[] }>("/site/geocode", {
      method: "POST",
      body: JSON.stringify({ queries: [`${q}, ${summary.city}`], bias: summary.center }),
    });
    const hit = results[0];
    if (hit?.lon == null) throw new Error("No match for that address.");
    dropPin([hit.lon, hit.lat!], hit.label);
  } catch (err) {
    $("pin-result").replaceChildren(el("p", { class: "error" }, (err as Error).message));
  }
});

// ---------- make it 24/7 ----------

function renderRelocation() {
  const host = $("rank");
  host.replaceChildren(
    ...relocation.slice(0, 25).map((r) =>
      el(
        "li",
        {},
        el(
          "button",
          { type: "button", class: "rank__item", onclick: () => focusSchool(r) },
          el("span", { class: "rank__n num" }, String(r.rank)),
          el("span", { class: "rank__name" }, r.name, el("small", {}, `ZIP ${r.zip} · ${r.area}`)),
          el("span", { class: "rank__v num" }, r.expectedCallsPerYear.toFixed(1), el("small", {}, "calls/yr")),
        ),
      ),
    ),
  );
}

interface Debate {
  evidence: { id: string; text: string }[];
  turns: { speaker: string; text: string }[];
  verdict: { verdict: string; summary: string; strongestFor: string; strongestAgainst: string; nextStep: string; uncitedClaims: number };
  savedAt?: string;
}

const VERDICT: Record<string, string> = {
  act: "Act",
  "act-with-conditions": "Act, with conditions",
  "investigate-first": "Investigate first",
  "do-not-act": "Do not act",
};

function schoolIntro(r: Relocation) {
  return [
    el("h3", { class: "debate__title" }, r.name),
    el("p", {}, `${r.expectedCallsPerYear.toFixed(1)} cardiac-arrest calls a year inside its two-minute walk while every AED in reach was locked.`),
    r.altHost
      ? el("p", { class: "hint" }, `Another option: ${r.altHost.name}, a ${r.altHost.category} staffed around the clock, is ${r.altHost.meters} m away (Overture Maps, via Amazon Athena).`)
      : "",
  ];
}

async function focusSchool(r: Relocation) {
  map.flyTo({ center: [r.lon, r.lat], zoom: 15.5, duration: 900 });
  const i = sites.rows.findIndex((row) => row[0] === r.id);
  if (i >= 0) popup.setLngLat([r.lon, r.lat]).setDOMContent(siteCard(i)).addTo(map);
  const host = $("debate");
  const btn = el("button", { type: "button", class: "button", onclick: () => runDebate(r) }, "Hear both sides");
  host.replaceChildren(
    ...schoolIntro(r),
    el("p", { class: "hint" }, "Two Amazon Bedrock agents argue whether this AED should move to a 24/7 cabinet on the street wall. They may only cite the numbered evidence. A third agent gives the verdict."),
    btn,
  );
  // The top schools have a saved debate, so the answer is there at once; a fresh one is a click away.
  try {
    const res = await fetch(`/data/nyc/debates/${r.id}.json`);
    if (res.ok) renderDebate(r, (await res.json()) as Debate);
  } catch {
    /* no saved debate for this school */
  }
}

async function runDebate(r: Relocation) {
  const host = $("debate");
  const steps = ["The advocate is reading the evidence…", "The skeptic is answering…", "Second round…", "The judge is weighing it…"];
  const status = el("p", { class: "loading" }, steps[0]);
  const old = host.querySelector(".button");
  if (old) old.replaceWith(status);
  else host.append(status);
  let k = 0;
  const timer = setInterval(() => (status.textContent = steps[Math.min(++k, steps.length - 1)]), 5000);
  try {
    const d = await api<Debate>("/site/debate", { method: "POST", body: JSON.stringify({ preset: "nyc", siteId: r.id }) });
    clearInterval(timer);
    renderDebate(r, d);
  } catch (e) {
    clearInterval(timer);
    status.textContent = `The debate could not run: ${(e as Error).message}`;
    status.className = "error";
  }
}

function renderDebate(r: Relocation, d: Debate) {
  const cite = (text: string) => {
    const p = el("p", {});
    text.split(/(\[E\d+\])/).forEach((part) => {
      const m = /^\[(E\d+)\]$/.exec(part);
      p.append(m ? el("a", { class: "cite", href: `#ev-${m[1]}` }, m[1]) : part);
    });
    return p;
  };
  const fresh = el("button", { type: "button", class: "chip", onclick: () => runDebate(r) }, d.savedAt ? "Run a fresh debate" : "Run it again");
  $("debate").replaceChildren(
    ...schoolIntro(r),
    el(
      "div",
      { class: "verdict-box" },
      el("p", { class: "verdict-box__word" }, VERDICT[d.verdict.verdict] ?? d.verdict.verdict),
      el("p", {}, d.verdict.summary),
      el("p", { class: "fine" }, `Next step: ${d.verdict.nextStep}`),
    ),
    el(
      "ol",
      { class: "turns" },
      ...d.turns.map((t) => el("li", { class: `turn turn--${t.speaker}` }, el("b", {}, t.speaker === "advocate" ? "For" : "Against"), cite(t.text))),
    ),
    el(
      "details",
      { class: "evidence" },
      el("summary", {}, `The evidence they were given (${d.evidence.length} lines)`),
      el("ol", {}, ...d.evidence.map((e) => el("li", { id: `ev-${e.id}` }, el("b", {}, `${e.id} `), e.text))),
    ),
    el(
      "p",
      { class: "fine" },
      `${d.savedAt ? `Saved ${new Date(d.savedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}. ` : ""}Sentences with a number but no citation: ${d.verdict.uncitedClaims}. Generated by Amazon Bedrock; planning analysis, not advice.`,
    ),
    fresh,
  );
}

// ---------- controls ----------

function setTab(tab: string) {
  state.tab = tab;
  for (const t of ["explore", "pin", "relocation"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === tab));
    $(`pane-${t}`).hidden = t !== tab;
  }
  map.getCanvas().style.cursor = tab === "pin" ? "crosshair" : "";
  document.body.classList.toggle("is-pin", tab === "pin");
  history.replaceState(null, "", tab === "explore" ? location.pathname : `#${tab}`);
}

function wire() {
  const days = $("days");
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d, i) => {
    const b = el("button", { type: "button", onclick: () => ((state.day = i), update()) }, d);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", DAY_LONG[i]);
    days.append(b);
  });
  $<HTMLInputElement>("hour").addEventListener("input", (e) => {
    state.hour = Number((e.target as HTMLInputElement).value);
    update();
  });
  document.querySelectorAll<HTMLButtonElement>("#season button").forEach((b) =>
    b.addEventListener("click", () => {
      state.season = b.dataset.season as Season;
      update();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>("#school-close button").forEach((b) =>
    b.addEventListener("click", () => {
      state.close = Number(b.dataset.close);
      document.querySelectorAll("#school-close button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      update();
    }),
  );
  $<HTMLInputElement>("include-ai").addEventListener("change", (e) => {
    state.ai = (e.target as HTMLInputElement).checked;
    update();
  });
  for (const id of ["layer-catch", "layer-regions", "layer-points"]) $(id).addEventListener("change", applyLayerToggles);
  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => b.addEventListener("click", () => b.dataset.preset !== state.preset && loadPreset(b.dataset.preset!)));
  for (const t of ["explore", "pin", "relocation"]) $(`tab-${t}`).addEventListener("click", () => setTab(t));
  $("now").addEventListener("click", () => {
    const n = cityNow(TZ[state.preset]);
    Object.assign(state, { day: n.day, hour: n.hour, season: n.month === 7 || n.month === 8 ? "summer" : "school" });
    update();
  });
  $("weekstrip").addEventListener("click", (e) => {
    const h = Number((e.target as HTMLElement).dataset.h);
    if (Number.isNaN(h)) return;
    state.day = Math.floor(h / 24);
    state.hour = h % 24;
    update();
  });
  const play = $("play");
  const stop = () => {
    clearInterval(state.playing);
    state.playing = 0;
    play.setAttribute("aria-pressed", "false");
    $("play-icon").setAttribute("d", "M4 2.5v11l9-5.5z");
  };
  play.addEventListener("click", () => {
    if (state.playing) return stop();
    play.setAttribute("aria-pressed", "true");
    $("play-icon").setAttribute("d", "M4 3h3v10H4zM9 3h3v10H9z");
    state.playing = window.setInterval(() => {
      const h = (state.day * 24 + state.hour + 1) % HOURS;
      state.day = Math.floor(h / 24);
      state.hour = h % 24;
      update();
    }, 280);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, textarea, [role=slider]")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const h = (state.day * 24 + state.hour + (e.key === "ArrowRight" ? 1 : -1) + HOURS) % HOURS;
      state.day = Math.floor(h / 24);
      state.hour = h % 24;
      update();
    }
  });
}

wire();
const initialTab = location.hash.slice(1);
map.on("load", () => {
  loadPreset("nyc").then(() => {
    if (["pin", "relocation"].includes(initialTab)) setTab(initialTab);
  });
});
map.on("error", (e) => console.warn("map", e.error?.message));
