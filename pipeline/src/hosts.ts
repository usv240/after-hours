/**
 * Which Overture places can honestly be called "staffed around the clock".
 *
 * Overture's categories are broad: "hospital" includes clinics, surgeries and rehab centres,
 * "emergency_department" includes individual doctors, and a few places sit far from where their
 * name says they are. A host is kept only if it lies inside a New York ZIP code, its name says what
 * its category claims, it is not a clinic-type or person-named place, and any borough in its name
 * matches the borough it actually sits in.
 */
import { inMultiPolygon, type MultiPolygon } from "@after-hours/engine";

export interface Host {
  name: string;
  category: string;
  lon: number;
  lat: number;
}

const NAME_FITS: Record<string, RegExp> = {
  fire_station: /\b(engine|ladder|fire|fdny|ems|rescue|squad|battalion)\b|^[EL]\d+\b/i,
  police_station: /\b(precinct|police|nypd)\b/i,
  emergency_department: /\b(emergency|hospital|medical center)\b/i,
  hospital: /\b(hospitals?|medical center)\b/i,
};
const NOT_ALWAYS_STAFFED =
  /surg|rehab|nursing|primary care|clinic|dental|imaging|radiology|physical therapy|urgent|auxiliary|archcare|\bride\b|gotham|veterinar|animal|pharm|dialysis|hospice|infusion|psychiatr|counsel|academy|booking|court|sheriff|secret service|ambulatory|internal medicine|gastro|\b(md|do|pc)\b|,\s*(md|do)\b/i;
const ELSEWHERE = /\b(nj|new jersey|bayonne|jersey city|pennsylvania|mifflin|nittany|westchester|nassau|yonkers)\b/i;
const BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];

export function credibleHosts(
  hosts: Host[],
  regions: { id: string; shape: MultiPolygon }[],
  boroughOfZip: Map<string, string>,
): Host[] {
  return hosts.filter((h) => {
    if (!NAME_FITS[h.category]?.test(h.name) || NOT_ALWAYS_STAFFED.test(h.name) || ELSEWHERE.test(h.name)) return false;
    const zip = regions.find((r) => inMultiPolygon([h.lon, h.lat], r.shape))?.id;
    if (!zip) return false;
    const named = BOROUGHS.find((b) => new RegExp(`\\b${b}\\b`, "i").test(h.name));
    const actual = boroughOfZip.get(zip);
    return !named || !actual || named === actual;
  });
}
