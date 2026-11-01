import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/app.css";
import { circle, detectColumns, parseCsv, parseCsvSites, parseGeoJsonSites, weekStates, type ColumnMap, type ParseResult, type Site } from "@after-hours/engine";
import { DAY_LONG, api, cityNow, el, fmt, hourLabel } from "./common.ts";
import { ATTRIBUTION, basemapStyle } from "./basemap.ts";
import { mapPalette } from "./theme.ts";

const HOURS = 168;
const RADIUS_M = 130;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Row extends Site {
  week: Uint8Array;
}

const state = { day: 1, hour: 14, text: "", kind: "csv" as "csv" | "geojson", override: {} as ColumnMap, tz: guessTz() };
let rows: Row[] = [];
let parsed: ParseResult | null = null;
let routed = false;

function guessTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
}

// ---------- map ----------

const map = new maplibregl.Map({
  container: "map",
  style: basemapStyle(),
  center: [-73.95, 40.72],
  zoom: 10,
  attributionControl: { compact: true, customAttribution: ATTRIBUTION },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
const popup = new maplibregl.Popup({ className: "ah-popup", maxWidth: "320px" });
let mapReady = new Promise<void>((r) => map.on("load", () => r()));

/** What the layers are drawn from, kept so a theme change can rebuild them on the new basemap. */
const drawn = { pts: null as GeoJSON.FeatureCollection | null, areas: null as GeoJSON.FeatureCollection | null };
let handlers = false;

function addLayers() {
  if (!drawn.pts || !drawn.areas) return;
  const pal = mapPalette();
  for (const [id, data] of [["areas", drawn.areas], ["pts", drawn.pts]] as const) {
    const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data);
    else map.addSource(id, { type: "geojson", data });
  }
  if (map.getLayer("areas")) return;
  map.addLayer({
    id: "areas",
    type: "fill",
    source: "areas",
    paint: {
      "fill-color": ["match", ["coalesce", ["feature-state", "s"], 2], 1, pal.open, 0, pal.closed, pal.unknown],
      "fill-opacity": ["match", ["coalesce", ["feature-state", "s"], 2], 1, pal.openFill - 0.1, 0.15],
    },
  });
  map.addLayer({
    id: "pts",
    type: "circle",
    source: "pts",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 15, 7],
      "circle-color": ["match", ["coalesce", ["feature-state", "s"], 2], 1, pal.open, 0, pal.closed, pal.unknownDot],
      "circle-stroke-color": pal.dotStroke,
      "circle-stroke-width": 1.5,
    },
  });
}

async function drawMap() {
  await mapReady;
  drawn.pts = { type: "FeatureCollection", features: rows.map((s, i) => ({ type: "Feature", id: i, properties: {}, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })) };
  drawn.areas = {
    type: "FeatureCollection",
    features: rows.map((s, i) => ({ type: "Feature", id: i, properties: {}, geometry: { type: "Polygon", coordinates: circle([s.lon, s.lat], RADIUS_M) } })),
  };
  routed = false;
  addLayers();
  if (!handlers) {
    handlers = true;
    map.on("click", "pts", (e) => {
      const i = e.features?.[0]?.id as number;
      const s = rows[i];
      const open = Array.from(s.week.slice(0, HOURS)).filter((v) => v === 1).length;
      popup
        .setLngLat([s.lon, s.lat])
        .setDOMContent(
          el(
            "div",
            { class: "card" },
            el("h3", {}, s.name),
            el("p", { class: "card__meta" }, s.hours ?? "No readable hours"),
            el("p", {}, s.hours ? `Reachable ${open} of 168 hours a week.` : "Treated as unknown, never as open."),
          ),
        )
        .addTo(map);
    });
    map.on("mouseenter", "pts", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "pts", () => (map.getCanvas().style.cursor = ""));
  }
  if (rows.length) {
    const b = new maplibregl.LngLatBounds([rows[0].lon, rows[0].lat], [rows[0].lon, rows[0].lat]);
    rows.forEach((s) => b.extend([s.lon, s.lat]));
    map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 600 });
  }
  $("map-status").hidden = true;
  $("starter").hidden = true;
  update();
}

// ---------- parse ----------

async function load(text: string, name: string) {
  state.text = text;
  state.kind = /^\s*[{[]/.test(text) ? "geojson" : "csv";
  state.override = {};
  $("map-status").hidden = false;
  $("map-status").textContent = `Reading ${name}…`;
  await analyse();
}

async function analyse() {
  try {
    parsed = state.kind === "geojson" ? parseGeoJsonSites(JSON.parse(state.text)) : parseCsvSites(state.text, state.override);
  } catch (e) {
    $("map-status").textContent = `Could not read that file: ${(e as Error).message}`;
    return;
  }
  renderColumns();
  const geocoded: Site[] = [];
  const todo = parsed.needsGeocoding.slice(0, 100);
  if (todo.length) {
    $("map-status").textContent = `Finding ${todo.length} addresses with Amazon Location Service…`;
    for (let k = 0; k < todo.length; k += 25) {
      const chunk = todo.slice(k, k + 25);
      try {
        const { results } = await api<{ results: { lon?: number; lat?: number; error?: string }[] }>("/site/geocode", {
          method: "POST",
          body: JSON.stringify({ queries: chunk.map((c) => c.address) }),
        });
        results.forEach((r, j) => {
          const c = chunk[j];
          if (r.lon == null) parsed!.issues.push({ row: c.row, message: `Address "${c.address}" was not found.` });
          else geocoded.push({ id: String(c.row), name: c.name, lat: r.lat!, lon: r.lon, hours: c.hours, hoursSource: c.hours ? "declared" : "unknown", address: c.address });
        });
      } catch (e) {
        parsed.issues.push({ row: chunk[0].row, message: `Geocoding failed: ${(e as Error).message}` });
      }
    }
    if (parsed.needsGeocoding.length > 100) parsed.issues.push({ row: 0, message: `Only the first 100 addresses are geocoded here; use the API for more.` });
  }
  const sites = [...parsed.sites, ...geocoded].slice(0, 5000);
  const memo = new Map<string, Uint8Array>();
  rows = sites.map((s) => {
    const k = s.hours ?? "";
    if (!memo.has(k)) memo.set(k, weekStates(s.hours));
    return { ...s, week: memo.get(k)! };
  });
  if (!rows.length) {
    $("map-status").textContent = "No places with a position were found. Check the columns on the left.";
    $("out").hidden = true;
    return;
  }
  $("out").hidden = false;
  const now = cityNow(state.tz);
  state.day = now.day;
  state.hour = now.hour;
  renderFacts();
  renderIssues();
  renderSnippet();
  buildWeekstrip();
  await drawMap();
}

function renderColumns() {
  $("cols").hidden = state.kind !== "csv";
  if (state.kind !== "csv" || !parsed) return;
  const { headers } = parseCsv(state.text.slice(0, state.text.indexOf("\n") + 1 || undefined));
  const detected = { ...detectColumns(headers), ...state.override };
  const host = $("col-map");
  const fields: [keyof ColumnMap, string][] = [
    ["name", "Name"],
    ["lat", "Latitude"],
    ["lon", "Longitude"],
    ["address", "Address"],
    ["hours", "Opening hours"],
  ];
  host.replaceChildren(
    ...fields.map(([key, label]) => {
      const sel = el("select", { class: "input" }) as HTMLSelectElement;
      sel.append(el("option", { value: "" }, "(none)"), ...headers.map((h) => el("option", { value: h, selected: detected[key] === h }, h)));
      sel.addEventListener("change", () => {
        state.override = { ...state.override, [key]: sel.value || undefined };
        analyse();
      });
      return el("label", { class: "cols__row" }, el("span", {}, label), sel);
    }),
  );
}

// ---------- render ----------

function counts(st: number) {
  const c = [0, 0, 0];
  for (const s of rows) c[s.week[st]]++;
  return c;
}

function update() {
  const st = state.day * 24 + state.hour;
  const c = counts(st);
  $("n-open").textContent = fmt.format(c[1]);
  $("n-closed").textContent = fmt.format(c[0]);
  $("n-unknown").textContent = fmt.format(c[2]);
  $("bar-open").style.flexGrow = String(c[1]);
  $("bar-closed").style.flexGrow = String(c[0]);
  $("bar-unknown").style.flexGrow = String(c[2]);
  $("when-day").textContent = DAY_LONG[state.day];
  $("when-hour").textContent = hourLabel(state.hour);
  $<HTMLInputElement>("hour").value = String(state.hour);
  document.querySelectorAll("#days button").forEach((b, i) => b.setAttribute("aria-checked", String(i === state.day)));
  if (map.getSource("pts"))
    rows.forEach((s, i) => {
      map.setFeatureState({ source: "pts", id: i }, { s: s.week[st] });
      map.setFeatureState({ source: "areas", id: i }, { s: s.week[st] });
    });
  $("weekstrip")
    .querySelectorAll("button")
    .forEach((b, h) => b.classList.toggle("is-now", h === st));
}

function buildWeekstrip() {
  const host = $("weekstrip");
  host.replaceChildren();
  const open = Array.from({ length: HOURS }, (_, h) => counts(h)[1]);
  const max = Math.max(1, ...open);
  open.forEach((n, h) => {
    const b = el("button", { type: "button", title: `${DAY_LONG[Math.floor(h / 24)]} ${hourLabel(h % 24)}: ${n} open` });
    b.style.setProperty("--v", String(n / max));
    b.tabIndex = -1;
    b.addEventListener("click", () => {
      state.day = Math.floor(h / 24);
      state.hour = h % 24;
      update();
    });
    host.append(b);
  });
}

function renderFacts() {
  const open = Array.from({ length: HOURS }, (_, h) => counts(h)[1]);
  const best = open.indexOf(Math.max(...open));
  const worst = open.indexOf(Math.min(...open));
  const withHours = rows.filter((s) => s.hours).length;
  const always = rows.filter((s) => s.week.slice(0, HOURS).every((v) => v === 1)).length;
  const avg = rows.length ? rows.reduce((a, s) => a + s.week.slice(0, HOURS).filter((v) => v === 1).length, 0) / rows.length : 0;
  const when = (h: number) => `${DAY_LONG[Math.floor(h / 24)]} ${hourLabel(h % 24)}`;
  $("facts").replaceChildren(
    el("li", {}, el("b", {}, fmt.format(rows.length)), ` places on the map, ${fmt.format(withHours)} with readable hours.`),
    el("li", {}, el("b", {}, fmt.format(always)), ` open around the clock.`),
    el("li", {}, `On average each place is reachable `, el("b", {}, `${Math.round(avg)} of 168 hours`), ` a week.`),
    el("li", {}, `Most open: `, el("b", {}, `${open[best]} at ${when(best)}`), `. Fewest: `, el("b", {}, `${open[worst]} at ${when(worst)}`), `.`),
  );
}

function renderIssues() {
  const issues = parsed?.issues ?? [];
  $("issues").replaceChildren(
    ...(issues.length
      ? [
          el(
            "details",
            { class: "evidence" },
            el("summary", {}, `${issues.length} row${issues.length === 1 ? "" : "s"} need attention`),
            el("ol", {}, ...issues.slice(0, 50).map((i) => el("li", {}, i.row ? `Row ${i.row}: ${i.message}` : i.message))),
          ),
        ]
      : []),
  );
}

function renderSnippet() {
  const body = { timeZone: state.tz, sites: rows.slice(0, 2).map((s) => ({ name: s.name, lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), hours: s.hours })) };
  $("snippet").textContent = `curl -X POST ${location.origin}/api/v1/analyze \\\n  -H "x-api-key: YOUR_KEY" \\\n  -H "content-type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
}

function downloadCsv() {
  const q = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [
    "name,latitude,longitude,opening_hours,hours_open_per_week,open_weeknights_9pm,open_sunday_3am,status_now",
    ...rows.map((s) => {
      const w = s.week;
      const now = cityNow(state.tz);
      const word = ["closed", "open", "unknown"];
      const nights = [0, 1, 2, 3, 4].every((d) => w[d * 24 + 21] === 1);
      return [s.name, s.lat, s.lon, s.hours, s.hours ? Array.from(w.slice(0, HOURS)).filter((v) => v === 1).length : "", s.hours ? nights : "", word[w[6 * 24 + 3]], word[w[now.day * 24 + now.hour]]].map(q).join(",");
    }),
  ];
  const a = el("a", { href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })), download: "after-hours-results.csv" });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function routeAreas() {
  const btn = $<HTMLButtonElement>("route-areas");
  btn.disabled = true;
  btn.textContent = "Routing…";
  try {
    const pts = rows.slice(0, 25).map((s) => [s.lon, s.lat]);
    const { isolines } = await api<{ isolines: ({ type: string; coordinates: unknown } | null)[] }>("/site/isolines", { method: "POST", body: JSON.stringify({ points: pts, seconds: 120 }) });
    const src = map.getSource("areas") as maplibregl.GeoJSONSource;
    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection" as const,
      features: rows.map((s, i) => ({
        type: "Feature" as const,
        id: i,
        properties: {},
        geometry: (isolines[i] ?? { type: "Polygon", coordinates: circle([s.lon, s.lat], RADIUS_M) }) as GeoJSON.Geometry,
      })),
    };
    src.setData(data);
    drawn.areas = data;
    routed = true;
    $("route-note").textContent = `Routed ${isolines.filter(Boolean).length} two-minute walks with Amazon Location Service${rows.length > 25 ? "; the rest stay as 130 m circles" : ""}.`;
    update();
  } catch (e) {
    $("route-note").textContent = `Routing failed: ${(e as Error).message}`;
  } finally {
    btn.disabled = routed;
    btn.textContent = routed ? "Walking areas routed" : "Route walking areas";
  }
}

// A theme change swaps the basemap and rebuilds the layers on it, keeping the view and the clock.
addEventListener("themechange", () => {
  map.setStyle(basemapStyle(), { diff: false });
  map.once("style.load", () => {
    addLayers();
    update();
  });
});

// ---------- wiring ----------

function wire() {
  const days = $("days");
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d, i) => {
    const b = el("button", { type: "button", onclick: () => ((state.day = i), update()) }, d);
    b.setAttribute("role", "radio");
    days.append(b);
  });
  $<HTMLInputElement>("hour").addEventListener("input", (e) => {
    state.hour = Number((e.target as HTMLInputElement).value);
    update();
  });
  const tz = $<HTMLSelectElement>("tz");
  const zones = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Paris", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney", "UTC"];
  if (!zones.includes(state.tz)) zones.unshift(state.tz);
  tz.append(...zones.map((z) => el("option", { value: z, selected: z === state.tz }, z.replace("_", " "))));
  tz.addEventListener("change", () => {
    state.tz = tz.value;
    renderSnippet();
  });
  $<HTMLInputElement>("file").addEventListener("change", async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) load(await f.text(), f.name);
  });
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("is-over");
    const f = e.dataTransfer?.files?.[0];
    if (f) load(await f.text(), f.name);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-sample]").forEach((b) =>
    b.addEventListener("click", async () => {
      const url = b.dataset.sample!;
      if (url.includes("paris")) state.tz = "Europe/Paris";
      else state.tz = "America/New_York";
      tz.value = state.tz;
      const text = await (await fetch(url)).text();
      load(text, b.dataset.label ?? b.textContent ?? "sample");
    }),
  );
  // Each sample card says how many of its places are open at 9 PM on a Sunday (from build-sample-maps).
  fetch("/samples/maps.json")
    .then((r) => r.json())
    .then((m: Record<string, { open: number; total: number }>) =>
      document.querySelectorAll<HTMLElement>(".starter__card").forEach((c) => {
        const v = m[c.dataset.key!];
        if (v) c.querySelector("span")!.textContent += ` · ${v.open} of ${v.total} open Sunday 9 PM`;
      }),
    )
    .catch(() => {});
  $("download").addEventListener("click", downloadCsv);
  $("route-areas").addEventListener("click", routeAreas);
}

wire();
