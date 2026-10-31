import { normaliseHours, validateHours, type HoursSource } from "./hours.ts";

export interface Site {
  id: string;
  name: string;
  lat: number;
  lon: number;
  hours: string | null;
  hoursSource: HoursSource;
  category?: string;
  address?: string;
}

export interface RowIssue {
  row: number; // 1-based, header excluded
  message: string;
}

export interface ParseResult {
  sites: Site[];
  /** Rows with an address but no coordinates: the site can geocode these with Amazon Location. */
  needsGeocoding: { row: number; name: string; address: string; hours: string | null }[];
  issues: RowIssue[];
  columns: ColumnMap;
}

export interface ColumnMap {
  lat?: string;
  lon?: string;
  name?: string;
  hours?: string;
  address?: string;
  category?: string;
  id?: string;
}

const CANDIDATES: Record<keyof ColumnMap, RegExp> = {
  lat: /^(lat|latitude|y|c_lat_coor1)$/i,
  lon: /^(lon|lng|long|longitude|x|c_long_coor1)$/i,
  name: /^(name|title|site|site_name|entity_name|location_name|c_nom)$/i,
  hours: /^(opening_hours|hours|open_hours|availability|c_dispo_horaires|operating_hours)$/i,
  address: /^(address|street_address|full_address|addr|location)$/i,
  category: /^(category|type|location_type|kind)$/i,
  id: /^(id|gid|site_id|ref|@id)$/i,
};

export function detectColumns(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  for (const field of Object.keys(CANDIDATES) as (keyof ColumnMap)[]) {
    const hit = headers.find((h) => CANDIDATES[field].test(h.trim()));
    if (hit) map[field] = hit;
  }
  return map;
}

/** RFC 4180 CSV, plus semicolon files (common in European open data), detected from the header. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.indexOf("\n") === -1 ? src.length : src.indexOf("\n"));
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.some((v) => v !== "")) records.push(record);
      record = [];
    } else field += c;
  }
  record.push(field);
  if (record.some((v) => v !== "")) records.push(record);
  const headers = (records.shift() ?? []).map((h) => h.trim());
  const rows = records.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { headers, rows };
}

function toSites(rows: Record<string, string>[], columns: ColumnMap): ParseResult {
  const sites: Site[] = [];
  const needsGeocoding: ParseResult["needsGeocoding"] = [];
  const issues: RowIssue[] = [];
  rows.forEach((r, i) => {
    const row = i + 1;
    const name = (columns.name && r[columns.name]) || `Site ${row}`;
    const rawHours = columns.hours ? r[columns.hours] : undefined;
    let hours = normaliseHours(rawHours);
    if (hours) {
      const problem = validateHours(hours);
      if (problem) {
        issues.push({ row, message: `Hours "${rawHours}" could not be read (${problem}); treated as unknown.` });
        hours = null;
      }
    }
    const lat = columns.lat ? Number(String(r[columns.lat]).replace(",", ".")) : NaN;
    const lon = columns.lon ? Number(String(r[columns.lon]).replace(",", ".")) : NaN;
    const address = columns.address ? r[columns.address] : undefined;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
    if (!hasCoords) {
      if (address) needsGeocoding.push({ row, name, address, hours });
      else issues.push({ row, message: "No coordinates and no address; skipped." });
      return;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      issues.push({ row, message: `Coordinates ${lat}, ${lon} are out of range; skipped.` });
      return;
    }
    sites.push({
      id: (columns.id && r[columns.id]) || String(row),
      name,
      lat,
      lon,
      hours,
      hoursSource: hours ? "declared" : "unknown",
      category: columns.category ? r[columns.category] : undefined,
      address,
    });
  });
  return { sites, needsGeocoding, issues, columns };
}

export function parseCsvSites(text: string, override?: ColumnMap): ParseResult {
  const { headers, rows } = parseCsv(text);
  return toSites(rows, { ...detectColumns(headers), ...override });
}

/** GeoJSON points, including OpenStreetMap exports where hours live in `opening_hours`. */
export function parseGeoJsonSites(json: unknown): ParseResult {
  const fc = json as { features?: { geometry?: { type: string; coordinates: number[] }; properties?: Record<string, unknown>; id?: unknown }[] };
  const rows: Record<string, string>[] = [];
  for (const f of fc.features ?? []) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties ?? {};
    rows.push({
      id: String(p.id ?? p["@id"] ?? f.id ?? ""),
      name: String(p.name ?? p.title ?? p["defibrillator:location"] ?? ""),
      opening_hours: String(p.opening_hours ?? p.hours ?? ""),
      category: String(p.category ?? p.type ?? ""),
      lat: String(f.geometry.coordinates[1]),
      lon: String(f.geometry.coordinates[0]),
    });
  }
  return toSites(rows, { id: "id", name: "name", hours: "opening_hours", category: "category", lat: "lat", lon: "lon" });
}
