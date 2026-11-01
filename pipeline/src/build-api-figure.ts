/**
 * The API page's picture: one real /nearest response (East New York, Sunday 9 PM) drawn by
 * Amazon Location GetStaticMap. The route comes from the live API, so the picture is the answer.
 * Usage: tsx src/build-api-figure.ts https://your-site  → web/public/figures/nearest-east-new-york.png
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GeoMapsClient, GetStaticMapCommand } from "@aws-sdk/client-geo-maps";
import { ROOT } from "./paths.ts";

const site = process.argv[2] ?? "http://localhost:8787";
const base = site.includes("8787") ? site : `${site.replace(/\/$/, "")}/api/site`;
const at: [number, number] = [-73.8945, 40.6705];
const q = new URLSearchParams({ preset: "nyc", lon: String(at[0]), lat: String(at[1]), at: "2026-10-25T21:00", schoolClose: "18", includeAi: "0", route: "1" });
const r = (await (await fetch(`${base}/nearest?${q}`)).json()) as {
  timeBlindNearest: { at: [number, number]; walkSeconds: number };
  nearestOpen: { at: [number, number]; walkSeconds: number };
  route: { line: [number, number][] };
};

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const step = Math.max(1, Math.ceil(r.route.line.length / 80));
const line = r.route.line.filter((_, i) => i % step === 0 || i === r.route.line.length - 1).map((p) => p.map(r5));
const overlay = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { color: "#ffd100", width: "6px", "outline-color": "#121212", "outline-width": "2px" }, geometry: { type: "LineString", coordinates: line } },
    { type: "Feature", properties: { color: "#121212", size: "medium" }, geometry: { type: "Point", coordinates: at } },
    { type: "Feature", properties: { color: "#c81e1e", size: "large", label: `Locked, ${Math.round(r.timeBlindNearest.walkSeconds / 60)} min` }, geometry: { type: "Point", coordinates: r.timeBlindNearest.at.map(r5) } },
    { type: "Feature", properties: { color: "#0b7a4b", size: "large", label: `Open, ${Math.round(r.nearestOpen.walkSeconds / 60)} min walk` }, geometry: { type: "Point", coordinates: r.nearestOpen.at.map(r5) } },
  ],
};
const res = await new GeoMapsClient({ region: process.env.AWS_REGION ?? "us-east-1" }).send(
  new GetStaticMapCommand({
    FileName: "map",
    BoundedPositions: [at, r.nearestOpen.at, r.timeBlindNearest.at].map((p) => p.map(r5).join(",")).join(","),
    Padding: 80,
    Width: 1200,
    Height: 600,
    Style: "Standard",
    ColorScheme: "Light",
    PointsOfInterests: "Disabled",
    ScaleBarUnit: "MilesKilometers",
    GeoJsonOverlay: JSON.stringify(overlay),
  }),
);
const dir = resolve(ROOT, "web/public/figures");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "nearest-east-new-york.png"), res.Blob!);
console.log(`nearest ${Math.round(r.timeBlindNearest.walkSeconds / 60)} min locked, open ${Math.round(r.nearestOpen.walkSeconds / 60)} min, ${line.length} route points`);
