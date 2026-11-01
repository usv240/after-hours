import maplibregl, { type LngLatLike, type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/app.css";
import { DAY_LONG, api, cityNow, el, fmt, getJson, hourLabel } from "./common.ts";
import { HOURS, decodeB64, localIso, stateIndex, type Season } from "./time.ts";
import { ATTRIBUTION, basemapStyle } from "./basemap.ts";
import { mapPalette } from "./theme.ts";

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
  calls?: { byVariant: Record<string, { calls: number; actualCoverage: number }> };
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
  pin: null as [number, number] | null,
  school: null as string | null,
  /** How many of the ranked schools have their AED moved to a 24/7 street cabinet. */
  fixed: 0,
};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
/** Relocation rank of each site (1–100), 0 when it is not on the list. */
let rankOf = new Int32Array(0);
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

/** What the map layers are drawn from, kept so a theme change can rebuild them on the new basemap. */
let layerData: { regions: string; points: GeoJSON.FeatureCollection; catch: GeoJSON.FeatureCollection } | null = null;

/** Adds this page's sources and layers, under the basemap's labels, in the current theme's colours. */
function addLayers() {
  if (!layerData) return;
  const pal = mapPalette();
  for (const layer of ["catch-fill", "catch-line", "regions-fill", "regions-line", "points", "points-halo"]) if (map.getLayer(layer)) map.removeLayer(layer);
  for (const src of ["catch", "regions", "points"]) if (map.getSource(src)) map.removeSource(src);
  map.addSource("regions", { type: "geojson", data: layerData.regions });
  map.addSource("catch", { type: "geojson", data: layerData.catch });
  map.addSource("points", { type: "geojson", data: layerData.points });
  const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addLayer(
    {
      id: "regions-fill",
      type: "fill",
      source: "regions",
      // ZIP shading is a city-scale signal: it fades as you zoom to street level, so the streets stay readable.
      paint: {
        "fill-color": "#c81e1e",
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 12, ["coalesce", ["feature-state", "calls"], 0], 15, ["*", 0.3, ["coalesce", ["feature-state", "calls"], 0]]],
      },
    },
    firstLabel,
  );
  map.addLayer({ id: "regions-line", type: "line", source: "regions", paint: { "line-color": pal.regionLine, "line-opacity": pal.regionLineOpacity, "line-width": 0.6 } }, firstLabel);
  map.addLayer(
    {
      id: "catch-fill",
      type: "fill",
      source: "catch",
      paint: {
        "fill-color": pal.unknown,
        "fill-opacity": pal.unknownFill,
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
      "circle-color": pal.open,
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
      "circle-color": pal.unknownDot,
      "circle-stroke-color": pal.dotStroke,
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 0, 14, 1.5],
      "circle-opacity": ["case", ["boolean", ["feature-state", "dim"], false], 0.35, 1],
    },
  });
  lastPaintKey = "";
  regionState.clear();
}

async function loadPreset(id: string) {
  const token = ++loadToken;
  $("map-status").textContent = "Loading locations…";
  $("map-status").hidden = false;
  const base = `/data/${id}`;
  // Walking areas are the heaviest file; the dots and the clock work without them, so they follow.
  const catchments = getJson<{ type: string; features: { id: number; properties: Record<string, number> }[] }>(`${base}/catchments.geojson`);
  const [s, st, rs, rel] = await Promise.all([
    getJson<Summary>(`${base}/summary.json`),
    getJson<SitesFile>(`${base}/sites.json`),
    getJson<RegionStats>(`${base}/region-stats.json`),
    id === "nyc" ? getJson<Relocation[]>(`${base}/relocation.json`) : Promise.resolve([]),
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
  const indexOf = new Map(st.rows.map((r, i) => [r[0], i]));
  rankOf = new Int32Array(st.rows.length);
  for (const r of rel) if (indexOf.has(r.id)) rankOf[indexOf.get(r.id)!] = r.rank;
  if (id !== "nyc") state.fixed = 0;
  lastPaintKey = "";
  regionState.clear();

  layerData = {
    regions: `${base}/regions.geojson`,
    points: {
      type: "FeatureCollection",
      features: st.rows.map((r, i) => ({ type: "Feature", properties: { i, g: groupOf[i], r: rankOf[i] }, geometry: { type: "Point", coordinates: [r[3], r[4]] } })),
    },
    catch: { type: "FeatureCollection", features: [] },
  };
  addLayers();
  applyLayerToggles();
  map.jumpTo({ center: s.center, zoom: s.zoom });

  // Panel copy and controls that depend on the preset.
  $("city-name").textContent = s.city;
  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.preset === id)));
  $("school-field").hidden = !s.schoolCloseOptions;
  $("ai-field").hidden = !s.variants.some((v) => v.endsWith("a"));
  $("tab-relocation").hidden = id !== "nyc";
  $("ask").hidden = id !== "nyc";
  if (id !== "nyc" && state.tab === "relocation") setTab("explore");
  $("region-layer-label").textContent =
    id === "nyc" ? "ZIP codes, shaded by cardiac-arrest calls at this hour" : "Arrondissements";
  $("city-intro").textContent =
    id === "nyc"
      ? "Each dot is a building with a public defibrillator. The shape around it is the area within a two-minute walk, routed on real streets. Move the clock and watch which ones lock."
      : `Paris uses France's national registry, where owners must declare when each AED can be reached. ${fmt.format(s.hoursSources.unknown ?? 0)} of ${fmt.format(s.sites)} never did, so they show as unknown. Walking areas here are ${s.catchment.label}.`;
  buildWeekstrip();
  renderRelocation();
  renderFix();
  update();
  $("map-status").textContent = "Drawing two-minute walking areas…";
  catchments
    .then((c) => {
      if (token !== loadToken) return;
      for (const f of c.features) f.properties = { g: groupOf[f.id], r: rankOf[f.id] };
      if (layerData) layerData.catch = c as unknown as GeoJSON.FeatureCollection;
      (map.getSource("catch") as maplibregl.GeoJSONSource).setData(c as unknown as GeoJSON.FeatureCollection);
      map.once("idle", () => token === loadToken && ($("map-status").hidden = true));
    })
    .catch(() => ($("map-status").textContent = "Walking areas could not load; the dots still show each location's state."));
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
    const v = isFixed(i) ? 1 : patternFor(row)[st];
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
    const key = `${open.join(",")}|${closed.join(",")}|${state.fixed}`;
    if (key !== lastPaintKey) {
      lastPaintKey = key;
      const by = <T,>(o: T, c: T, u: T) => {
        const e: unknown[] = ["match", ["get", "g"]];
        if (open.length) e.push(open, o);
        if (closed.length) e.push(closed, c);
        e.push(u);
        const plain = e.length > 3 ? e : u;
        // Schools given a street cabinet are open at every hour, whatever their timetable says.
        return (state.fixed ? ["case", fixedRule, o, plain] : plain) as maplibregl.ExpressionSpecification;
      };
      const fixedRule = ["all", [">", ["get", "r"], 0], ["<=", ["get", "r"], state.fixed]];
      const ifFixed = (f: unknown, other: unknown) => (state.fixed ? ["case", fixedRule, f, other] : other);
      const pal = mapPalette();
      map.setPaintProperty("catch-fill", "fill-color", by(pal.open, pal.closed, pal.unknown));
      map.setPaintProperty("catch-fill", "fill-opacity", by(pal.openFill, pal.closedFill, pal.unknownFill));
      map.setPaintProperty("points", "circle-color", by(pal.open, pal.closed, pal.unknownDot));
      map.setPaintProperty("points", "circle-stroke-color", ifFixed(pal.fixedStroke, pal.dotStroke) as maplibregl.ExpressionSpecification);
      map.setPaintProperty("points", "circle-stroke-width", ["interpolate", ["linear"], ["zoom"], 11, ifFixed(1.5, 0), 14, ifFixed(2, 1.5)] as maplibregl.ExpressionSpecification);
      map.setPaintProperty("points", "circle-radius", ["interpolate", ["linear"], ["zoom"], 9, ifFixed(4, 1.6), 12, ifFixed(6, 3), 15, ifFixed(9, 6.5)] as maplibregl.ExpressionSpecification);
      map.setPaintProperty("points-halo", "circle-opacity", by(pal.halo, 0, 0));
      map.setPaintProperty("points-halo", "circle-radius", ["interpolate", ["linear"], ["zoom"], 9, ifFixed(12, 0), 13, ifFixed(18, 9), 16, ifFixed(24, 16)] as maplibregl.ExpressionSpecification);
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
  const fixNote = state.fixed ? ` (This share leaves out the ${state.fixed} schools you gave a 24/7 cabinet.)` : "";
  $("cover-line").textContent = `${pct(open / cells)} of the city is within a two-minute walk of an open defibrillator, against ${pct(reach / cells)} if every one were open.${fixNote}${callLine}`;

  $("when-day").textContent = `${DAY_LONG[state.day]}${state.season === "summer" ? " in summer" : ""}`;
  $("when-hour").textContent = `${hourLabel(state.hour)}`;
  $<HTMLInputElement>("hour").value = String(state.hour);
  document.querySelectorAll<HTMLButtonElement>("#days button").forEach((b, i) => b.setAttribute("aria-checked", String(i === state.day)));
  document.querySelectorAll<HTMLButtonElement>("#season button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.season === state.season)));
  document.querySelectorAll<HTMLButtonElement>("#school-close button").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.close) === state.close)));
  $<HTMLInputElement>("include-ai").checked = state.ai;
  paintWeekstrip();
  syncUrl();
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
    isFixed(i) ? el("p", { class: "card__where" }, `Given a 24/7 street cabinet in this scenario (#${rankOf[i]} on the list). The week below is its current timetable.`) : null,
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

type PinResult = Parameters<typeof renderPin>[0];

async function dropPin(at: [number, number], label?: string): Promise<PinResult | null> {
  state.pin = at;
  syncUrl();
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
    return r;
  } catch (e) {
    out.replaceChildren(el("p", { class: "error" }, `Could not route from here: ${(e as Error).message}`));
    return null;
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
  // When the nearest AED is under the pin (a school's own), show the surrounding block, not a zero-size box.
  bounds.extend([at[0] - 0.0025, at[1] - 0.0016]).extend([at[0] + 0.0025, at[1] + 0.0016]);
  map.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 80, right: 80 }, maxZoom: 16.5, duration: 700 });
}

/** The pin's walk and the AEDs it found, kept so a theme change can redraw them. */
let drawn: { line: [number, number][] | null; cands: { near: Cand; open: Cand | null } | null } = { line: null, cands: null };

function clearRoute() {
  for (const id of ["route", "cands"]) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
  drawn = { line: null, cands: null };
}

function drawRoute(line: [number, number][]) {
  drawn.line = line;
  map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } } });
  map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": mapPalette().route, "line-width": 4, "line-dasharray": [1.2, 1.2] }, layout: { "line-cap": "round" } });
}

function drawCandidates(near: Cand, open: Cand | null) {
  drawn.cands = { near, open };
  const pal = mapPalette();
  const feats = [near, open].filter(Boolean).map((c) => ({ type: "Feature" as const, properties: { s: c!.state }, geometry: { type: "Point" as const, coordinates: c!.at } }));
  map.addSource("cands", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
  map.addLayer({
    id: "cands",
    type: "circle",
    source: "cands",
    paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 3, "circle-stroke-color": ["match", ["get", "s"], "open", pal.open, "closed", pal.closed, pal.unknown] },
  });
}

// A theme change swaps the basemap (light or dark monochrome) and rebuilds this page's layers on it,
// keeping the view, the clock, the pin and its route.
addEventListener("themechange", () => {
  const keep = drawn;
  map.setStyle(basemapStyle(), { diff: false });
  map.once("style.load", () => {
    addLayers();
    applyLayerToggles();
    if (keep.line) drawRoute(keep.line);
    if (keep.cands) drawCandidates(keep.cands.near, keep.cands.open);
    update();
  });
});

// ---------- ask the map ----------

interface AskOut {
  reading: { place: string | null; day: number | null; hour: number | null; summer: boolean; emergency: boolean };
  place: { label: string; lon: number; lat: number } | null;
  readBy: string;
  message?: string;
}

/** Bedrock reads the question into a place and an hour; the map and the routing engine answer it. */
async function askMap(question: string) {
  const out = $("ask-result");
  out.replaceChildren(el("p", { class: "loading" }, "Reading your question…"));
  let a: AskOut;
  try {
    a = await api<AskOut>("/site/ask", { method: "POST", body: JSON.stringify({ question }) });
  } catch (err) {
    out.replaceChildren(el("p", { class: "error" }, (err as Error).message));
    return;
  }
  const sos = a.reading.emergency
    ? el("p", { class: "ask__sos" }, "If this is happening now, call 911 first. The dispatcher will start CPR instructions and can direct you to an AED.")
    : null;
  if (!a.place) {
    out.replaceChildren(...[sos, el("p", { class: "error" }, a.message ?? "Couldn't find that place.")].filter(Boolean) as Node[]);
    return;
  }
  a.place.label = a.place.label.replace(/, United States$/, "").replace(/, NY( \d{5}(-\d{4})?)?$/, "");
  if (a.reading.day != null) state.day = a.reading.day;
  if (a.reading.hour != null) state.hour = a.reading.hour;
  state.season = a.reading.summer ? "summer" : "school";
  update();
  const read = el(
    "p",
    { class: "ask__read" },
    "Read as ",
    el("b", {}, `${DAY_LONG[state.day]}${state.season === "summer" ? " in summer" : ""}, ${hourLabel(state.hour)}, near ${a.place.label}`),
    a.reading.day == null || a.reading.hour == null ? " (the time you didn't give is the one already on the map)" : "",
    ".",
  );
  out.replaceChildren(...([sos, read, el("p", { class: "loading" }, "Walking the streets…")].filter(Boolean) as Node[]));
  setTab("pin");
  const r = await dropPin([a.place.lon, a.place.lat], a.place.label);
  const near = r?.timeBlindNearest, open = r?.nearestOpen;
  const walk = (c: Cand) => `${Math.max(1, Math.round((c.walkSeconds ?? 0) / 60))}-minute walk`;
  const answer = !near
    ? el("p", {}, r?.message ?? "No registered AED nearby.")
    : near.state === "open"
      ? el("p", { class: "ask__answer" }, el("b", { class: "is-open" }, "Open. "), `${near.name}, a ${walk(near)}.`)
      : el(
          "p",
          { class: "ask__answer" },
          el("b", { class: near.state === "closed" ? "is-closed" : "is-unknown" }, near.state === "closed" ? "Locked. " : "Hours unknown. "),
          `The nearest AED, ${near.name}, is a ${walk(near)}. `,
          open ? `The nearest open one is ${open.name}, a ${walk(open)}.` : "None is open within reach.",
        );
  out.replaceChildren(
    ...([sos, read, answer, el("p", { class: "fine" }, `${a.readBy} read the question. Amazon Location Service found the place and walked the streets.`)].filter(Boolean) as Node[]),
  );
}

$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("ask-input").value.trim();
  if (q) askMap(q);
});
document.querySelectorAll<HTMLButtonElement>(".ask__eg").forEach((b) =>
  b.addEventListener("click", () => {
    $<HTMLInputElement>("ask-input").value = b.textContent!;
    askMap(b.textContent!);
  }),
);

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
          el("span", { class: "rank__v num" }, r.expectedCallsPerYear.toFixed(2), el("small", {}, "calls/yr")),
        ),
      ),
    ),
  );
}

function isFixed(i: number) {
  return state.fixed > 0 && rankOf[i] > 0 && rankOf[i] <= state.fixed;
}

/**
 * The ranking credits each street cell's calls to one school only, so the gains of the top N add up
 * without double counting. The sum is a floor: a cabinet can also reach cells credited to a school
 * further down the list.
 */
function renderFix() {
  const host = $("fix-result");
  document.querySelectorAll<HTMLButtonElement>("#fix button").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.fix) === state.fixed)));
  $("legend-fixed").hidden = !state.fixed;
  const v = summary.calls?.byVariant[summary.headlineVariant];
  if (!v) return host.replaceChildren();
  const before = v.calls * v.actualCoverage;
  if (!state.fixed) {
    host.replaceChildren(
      el("p", {}, `Of ${fmt.format(v.calls)} cardiac-arrest calls in 2025, about ${fmt.format(Math.round(before))} came within a two-minute walk of an open AED.`),
      el("p", { class: "fine" }, "Pick a number to move those schools' AEDs outside and see the map at night."),
    );
    return;
  }
  const gain = relocation.slice(0, state.fixed).reduce((a, r) => a + r.expectedCallsPerYear, 0);
  host.replaceChildren(
    el("p", { class: "fix-result__big num" }, `+${Math.round(gain)}`, el("small", {}, " calls a year")),
    el(
      "p",
      {},
      `Of ${fmt.format(v.calls)} cardiac-arrest calls in 2025, about ${fmt.format(Math.round(before))} came within a two-minute walk of an open AED. With these ${state.fixed} schools' AEDs in street cabinets, at least ${fmt.format(Math.round(before + gain))}: ${Math.round((100 * gain) / before)}% more. Their walking areas now stay green at every hour.`,
    ),
    el("p", { class: "fine" }, "Each call is credited to one school only, so the total never counts a call twice. Assumes school buildings lock at 6 PM."),
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
    el("p", {}, `${r.expectedCallsPerYear.toFixed(2)} cardiac-arrest calls a year inside its two-minute walk while every AED in reach was locked.`),
    r.altHost
      ? el("p", { class: "hint" }, `Another option: ${r.altHost.name}, a ${r.altHost.category} normally staffed around the clock (public access unverified), is ${r.altHost.meters} m away (Overture Maps, via Amazon Athena).`)
      : "",
    el("a", { class: "dl", href: `/brief.html?id=${r.id}` }, "Open the one-page brief for this school"),
  ];
}

async function focusSchool(r: Relocation): Promise<Debate | null> {
  state.school = r.id;
  syncUrl();
  if (reduceMotion) map.jumpTo({ center: [r.lon, r.lat], zoom: 15.5 });
  else map.flyTo({ center: [r.lon, r.lat], zoom: 15.5, duration: 900 });
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
    if (res.ok) {
      const d = (await res.json()) as Debate;
      renderDebate(r, d);
      return d;
    }
  } catch {
    /* no saved debate for this school */
  }
  return null;
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
  syncUrl();
}

// ---------- shareable links ----------

/** Every view has a link: ?p=nyc&t=6-21&s=summer&c=18&ai=1&pin=lon,lat&school=id#pin */
let urlTimer = 0;
function syncUrl() {
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => {
    const q = new URLSearchParams();
    if (state.preset !== "nyc") q.set("p", state.preset);
    q.set("t", `${state.day}-${state.hour}`);
    if (state.season !== "school") q.set("s", state.season);
    if (state.close !== 18) q.set("c", String(state.close));
    if (state.ai) q.set("ai", "1");
    if (state.tab === "pin" && state.pin) q.set("pin", state.pin.map((v) => v.toFixed(5)).join(","));
    if (state.tab === "relocation" && state.school) q.set("school", state.school);
    if (state.fixed) q.set("fix", String(state.fixed));
    history.replaceState(null, "", `${location.pathname}?${q}${state.tab === "explore" ? "" : `#${state.tab}`}`);
  }, 200);
}

function readUrl() {
  const q = new URLSearchParams(location.search);
  const t = /^(\d)-(\d{1,2})$/.exec(q.get("t") ?? "");
  if (t && +t[1] < 7 && +t[2] < 24) Object.assign(state, { day: +t[1], hour: +t[2] });
  if (q.get("s") === "summer") state.season = "summer";
  if (["15", "18", "21"].includes(q.get("c") ?? "")) state.close = Number(q.get("c"));
  state.ai = q.get("ai") === "1";
  if (["10", "25", "50", "100"].includes(q.get("fix") ?? "")) state.fixed = Number(q.get("fix"));
  const pin = (q.get("pin") ?? "").split(",").map(Number);
  return {
    preset: q.get("p") === "paris" ? "paris" : "nyc",
    tab: location.hash.slice(1),
    pin: pin.length === 2 && pin.every(Number.isFinite) ? (pin as [number, number]) : null,
    school: q.get("school"),
    story: q.has("story"),
    ask: (q.get("ask") ?? "").trim().slice(0, 300),
  };
}

async function copyLink(btn: HTMLElement) {
  clearTimeout(urlTimer);
  syncUrl();
  await new Promise((r) => setTimeout(r, 220));
  const label = btn.querySelector("span")!;
  try {
    await navigator.clipboard.writeText(location.href);
    label.textContent = "Link copied";
  } catch {
    label.textContent = "Copy the address bar";
  }
  setTimeout(() => (label.textContent = "Copy link"), 1800);
}

// ---------- the 60-second story ----------

/**
 * A guided run through the finding, on the live map: the same arc as the write-up, with every
 * number read from the pipeline's summary and the East New York walk routed live.
 */
type BeatOut = { big: string; text: string; tone?: "open" | "closed" | "school" | "ink"; extra?: HTMLElement };
interface Beat {
  run: () => Promise<BeatOut> | BeatOut;
  hold: number;
}
const story = { i: -1, timer: 0, started: 0, left: 0, paused: false, token: 0, card: null as HTMLElement | null };
const PS_151: [number, number] = [-73.94763, 40.77785];

function setClock(day: number, hour: number, season: Season = "school") {
  Object.assign(state, { day, hour, season });
  update();
}

function cityView(zoom?: number) {
  const o = { center: summary.center as LngLatLike, zoom: zoom ?? summary.zoom };
  if (reduceMotion) map.jumpTo(o);
  else map.flyTo({ ...o, duration: 1400, essential: true });
}

async function tickHours(from: number, to: number) {
  for (let h = from; h <= to; h++) {
    state.hour = h;
    update();
    if (!reduceMotion && h < to) await new Promise((r) => setTimeout(r, 420));
  }
}

function beats(): Beat[] {
  const s = summary as Summary & Record<string, any>;
  const f = s.figures, k = s.findings;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    {
      hold: 7500,
      run: () => {
        if (state.tab !== "explore") setTab("explore");
        setClock(1, 14);
        cityView();
        return { big: fmt.format(f.openTue2pm), text: "defibrillator locations are open on a school Tuesday at 2 PM. Each green area is the ground within a two-minute walk of one, routed on real streets." };
      },
    },
    {
      hold: 7000,
      run: async () => {
        await tickHours(14, 18);
        return { tone: "school", big: fmt.format(f.openTue6pm), text: `are left at 6 PM. School buildings lock, and ${pct(k.schoolShare)} of New York's AED locations are in schools.` };
      },
    },
    {
      hold: 7500,
      run: () => {
        setClock(6, 3);
        return { tone: "closed", big: fmt.format(f.openSun3am), text: "are open by their published hours at 3 AM on a Sunday, in a city of eight million. The rest are shut by their hours, or nobody has published them." };
      },
    },
    {
      hold: 8000,
      run: () => {
        setClock(6, 21);
        return { tone: "closed", big: pct(k.callsWhenSchoolsShutShare), text: `of 2025's ${fmt.format(k.calls)} cardiac-arrest calls came while school buildings were shut. The red ZIP codes are the calls at the hour shown.` };
      },
    },
    {
      hold: 8000,
      run: () => ({
        tone: "closed",
        big: pct(k.coverageLost.lostConservative),
        text: `of the coverage an ordinary AED map shows was locked at the hour the calls came. Even if every venue with unknown hours were open around the clock, ${pct(k.coverageLost.lostIfUnknownWereOpen)} would still be lost.`,
      }),
    },
    // One sidewalk, two hours: outside P.S. 151, where teachers used the school's AED to save a colleague
    // after school in 2025 (NY1). The same question, three hours later, gets a different answer.
    {
      hold: 8000,
      run: async () => {
        setClock(0, 16);
        setTab("pin");
        const r = await dropPin(PS_151, "outside P.S. 151");
        const near = r?.timeBlindNearest;
        if (!near) return { tone: "ink", big: "P.S. 151", text: "Monday, 4 PM. Drop your own pin to walk the streets to the nearest open defibrillator." };
        return {
          tone: near.state === "open" ? "open" : "closed",
          big: near.state === "open" ? "Open" : minutes(near.walkSeconds),
          text: `Monday, 4 PM, outside P.S. 151 on the Upper East Side, where teachers used the school's AED to save a colleague after school in 2025. The nearest defibrillator is ${near.group === "School" ? "the school's own" : near.name}, and ${near.state === "open" ? "the doors are open" : "it is locked"}.`,
        };
      },
    },
    {
      hold: 8500,
      run: async () => {
        setClock(0, 19);
        const r = await dropPin(PS_151, "outside P.S. 151");
        const near = r?.timeBlindNearest, open = r?.nearestOpen;
        if (!near) return { tone: "ink", big: "P.S. 151", text: "Monday, 7 PM. Drop your own pin to walk the streets to the nearest open defibrillator." };
        return {
          tone: "closed",
          big: open ? minutes(open.walkSeconds) : "None open",
          text: `Same sidewalk, 7 PM. The school's AED is ${near.state === "closed" ? "locked" : "of unknown hours"}. The nearest open one is ${open ? `${open.group === "Gym" ? "a gym" : open.name}, ${minutes(open.walkSeconds)} away on foot` : "out of reach"}. Routed by Amazon Location Service.`,
        };
      },
    },
    {
      hold: 10000,
      run: async () => {
        const top = relocation[0];
        const n = relocation.length;
        const gain = relocation.reduce((a, r) => a + r.expectedCallsPerYear, 0);
        const v = s.calls?.byVariant[s.headlineVariant];
        const d = await fetch(`/data/nyc/debates/${top.id}.json`).then((r) => (r.ok ? (r.json() as Promise<Debate>) : null)).catch(() => null);
        const verdict = d ? (VERDICT[d.verdict.verdict] ?? d.verdict.verdict).toLowerCase() : null;
        popup.remove();
        pinMarker?.remove();
        pinMarker = null;
        clearRoute();
        setTab("relocation");
        state.fixed = n;
        renderFix();
        setClock(6, 3);
        cityView();
        return {
          big: `+${Math.round(gain)} a year`,
          text: `Sunday, 3 AM again, with the AEDs of the ${n} schools where it matters most in 24/7 cabinets on the street wall. Modelled on 2025, at least ${Math.round(gain)} more cardiac-arrest calls a year would have had one in reach${v ? `, ${Math.round((100 * gain) / (v.calls * v.actualCoverage))}% more than today` : ""}. First on the list: ${top.name}.${verdict ? ` Two AI agents argued its case; the verdict: ${verdict}.` : ""}`,
          extra: el("a", { class: "story__link", href: `/brief.html?id=${top.id}` }, "Open its one-page brief"),
        };
      },
    },
    {
      hold: 0,
      run: () => ({
        tone: "ink",
        big: "Your turn",
        text: "Move the clock, drop a pin on your own block, or bring your own list of defibrillators, naloxone boxes or cooling centres.",
        extra: el(
          "span",
          { class: "story__actions" },
          el("button", { type: "button", class: "story__link", onclick: () => storyClose() }, "Explore the map"),
          el("a", { class: "story__link", href: "/data.html" }, "Bring your own data"),
        ),
      }),
    },
  ];
}

let storyBeats: Beat[] = [];

function storyOpen() {
  if (!summary || state.preset !== "nyc") return;
  if (state.playing) $("play").click();
  if (state.fixed) {
    state.fixed = 0;
    renderFix();
  }
  storyBeats = beats();
  popup.remove();
  story.card?.remove();
  const segs = el("div", { class: "story__segs" }, ...storyBeats.map(() => el("span", {}, el("i", {}))));
  const card = el(
    "section",
    { class: "story", ariaLabel: "The 60-second story" },
    segs,
    el("div", { class: "story__body", ariaLive: "polite" }, el("p", { class: "story__big" }), el("p", { class: "story__text" }), el("div", { class: "story__extra" })),
    el(
      "div",
      { class: "story__ctrl" },
      el("button", { type: "button", class: "story__btn", id: "story-pause", onclick: () => storyPause() }, "Pause"),
      el("button", { type: "button", class: "story__btn", id: "story-next", onclick: () => storyGo(story.i + 1) }, "Next"),
      el("button", { type: "button", class: "story__btn story__btn--x", ariaLabel: "Close the story", onclick: () => storyClose() }, "Close"),
    ),
  );
  document.querySelector(".mapwrap")!.append(card);
  story.card = card;
  story.paused = false;
  document.body.classList.add("is-story");
  storyGo(0);
}

async function storyGo(i: number) {
  const card = story.card;
  if (!card || i >= storyBeats.length) return;
  const tok = ++story.token;
  clearTimeout(story.timer);
  story.i = i;
  const beat = storyBeats[i];
  card.querySelectorAll<HTMLElement>(".story__segs span").forEach((s, j) => {
    s.className = j < i ? "is-done" : j === i ? "is-on" : "";
    s.style.setProperty("--hold", `${beat.hold}ms`);
  });
  card.classList.add("is-busy");
  ($("story-next") as HTMLButtonElement).hidden = i === storyBeats.length - 1;
  ($("story-pause") as HTMLButtonElement).hidden = i === storyBeats.length - 1;
  const out = await beat.run();
  if (tok !== story.token || !story.card) return;
  card.classList.remove("is-busy");
  const big = card.querySelector<HTMLElement>(".story__big")!;
  big.textContent = out.big;
  big.dataset.tone = out.tone ?? "open";
  card.querySelector(".story__text")!.textContent = out.text;
  card.querySelector(".story__extra")!.replaceChildren(...(out.extra ? [out.extra] : []));
  // Restart the progress fill for this beat.
  const on = card.querySelector<HTMLElement>(".story__segs .is-on");
  if (on) {
    on.classList.remove("is-on");
    void on.offsetWidth;
    on.classList.add("is-on");
  }
  if (beat.hold) {
    story.started = performance.now();
    story.left = beat.hold;
    if (!story.paused) story.timer = window.setTimeout(() => storyGo(i + 1), beat.hold);
  }
}

function storyPause() {
  const card = story.card;
  if (!card) return;
  story.paused = !story.paused;
  card.classList.toggle("is-paused", story.paused);
  $("story-pause").textContent = story.paused ? "Play" : "Pause";
  if (story.paused) {
    clearTimeout(story.timer);
    story.left = Math.max(0, story.left - (performance.now() - story.started));
  } else {
    story.started = performance.now();
    story.timer = window.setTimeout(() => storyGo(story.i + 1), story.left);
  }
}

function storyClose() {
  story.token++;
  clearTimeout(story.timer);
  story.card?.remove();
  story.card = null;
  document.body.classList.remove("is-story");
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
  document.querySelectorAll<HTMLButtonElement>("#fix button").forEach((b) =>
    b.addEventListener("click", () => {
      state.fixed = Number(b.dataset.fix);
      renderFix();
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
const initial = readUrl();
$("story-btn").addEventListener("click", storyOpen);
$("share").addEventListener("click", (e) => copyLink(e.currentTarget as HTMLElement));
document.addEventListener("keydown", (e) => e.key === "Escape" && story.card && storyClose());
map.on("load", () => {
  loadPreset(initial.preset).then(() => {
    if (initial.story) return storyOpen();
    // A shared question (?ask=Sunday 3 AM near Penn Station) is asked as soon as the map is ready.
    if (initial.ask && state.preset === "nyc") {
      $<HTMLInputElement>("ask-input").value = initial.ask;
      return askMap(initial.ask);
    }
    if (["pin", "relocation"].includes(initial.tab)) setTab(initial.tab);
    if (initial.tab === "pin" && initial.pin) dropPin(initial.pin);
    const school = initial.tab === "relocation" && relocation.find((r) => r.id === initial.school);
    if (school) focusSchool(school);
  });
});
map.on("error", (e) => console.warn("map", e.error?.message));
