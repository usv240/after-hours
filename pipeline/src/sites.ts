import { createHash } from "node:crypto";
import type { HoursSource } from "@after-hours/engine";

/** One AED site as the pipeline carries it from source to preset. */
export interface PipelineSite {
  id: string;
  name: string;
  group: string;
  rawCategory: string;
  lat: number;
  lon: number;
  zip: string;
  area: string; // borough or arrondissement
  aeds: number;
  where: string; // floor / location note from the registry
  outdoor: boolean | null;
  hours: string | null;
  hoursSource: HoursSource;
  hoursNote: string;
}

export function stableId(...parts: (string | number | undefined)[]): string {
  return createHash("sha1").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 10);
}

/** NYC registry categories folded into the groups the map legend uses. */
export function nycGroup(locationType: string): string {
  const t = locationType.toLowerCase();
  if (t.includes("school") || t === "child care") return "School";
  if (t.includes("college")) return "College";
  if (t.includes("business")) return "Business";
  if (t.includes("senior")) return "Senior centre";
  if (t.includes("government")) return "Government";
  if (t.includes("park")) return "Park";
  if (t.includes("health club")) return "Gym";
  if (t.includes("museum") || t.includes("zoo")) return "Museum or zoo";
  if (t.includes("performance") || t.includes("stadium")) return "Venue";
  if (t.includes("health & social") || t.includes("nursing")) return "Health and care";
  if (t.includes("transportation")) return "Transit";
  if (t.includes("worship")) return "Place of worship";
  return "Other";
}
