import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availability,
  componentsToOsm,
  normaliseHours,
  schoolHours,
  weekStates,
  weekCounts,
  stateIndex,
  parseCsvSites,
  parseGeoJsonSites,
  regionCoverage,
  circle,
  hourOfWeekFromWall,
} from "../src/index.ts";

const tue = (hour: number, month = 10, day = 20) => ({ year: 2026, month, day, hour, minute: 30 });

test("24/7 is always open; missing hours are unknown, never open", () => {
  assert.equal(availability("24/7", tue(3)), "open");
  assert.equal(availability(null, tue(14)), "unknown");
  assert.equal(availability(normaliseHours("Mo-Su off"), tue(14)), "unknown");
  assert.equal(availability("not hours at all", tue(14)), "unknown");
});

test("school hours: open on a school-day afternoon, shut at night and in summer", () => {
  const h = schoolHours(18);
  assert.equal(availability(h, tue(14)), "open");
  assert.equal(availability(h, tue(21)), "closed");
  assert.equal(availability(h, { year: 2026, month: 7, day: 14, hour: 10, minute: 0 }), "closed");
  assert.equal(availability(h, { year: 2026, month: 10, day: 24, hour: 10, minute: 0 }), "closed"); // Saturday
});

test("Amazon Location opening-hours components convert to OSM syntax", () => {
  const planetFitness = [
    { OpenTime: "T050000", OpenDuration: "PT18H00M", Recurrence: "FREQ:DAILY;BYDAY:MO,TU,WE,TH" },
    { OpenTime: "T050000", OpenDuration: "PT17H00M", Recurrence: "FREQ:DAILY;BYDAY:FR" },
    { OpenTime: "T070000", OpenDuration: "PT12H00M", Recurrence: "FREQ:DAILY;BYDAY:SA,SU" },
  ];
  const osm = componentsToOsm(planetFitness)!;
  assert.equal(osm, "Mo,Tu,We,Th 05:00-23:00, Fr 05:00-22:00, Sa,Su 07:00-19:00");
  assert.equal(availability(osm, tue(22)), "open");
  assert.equal(availability(osm, tue(23)), "closed");
  assert.equal(componentsToOsm([{ OpenTime: "T000000", OpenDuration: "PT24H00M", Recurrence: "FREQ:DAILY;BYDAY:MO,TU,WE,TH,FR,SA,SU" }]), "24/7");
});

test("hours that run past midnight stay open after 00:00", () => {
  const osm = componentsToOsm([{ OpenTime: "T180000", OpenDuration: "PT08H00M", Recurrence: "FREQ:DAILY;BYDAY:MO,TU,WE,TH,FR,SA,SU" }])!;
  assert.equal(availability(osm, { year: 2026, month: 10, day: 21, hour: 1, minute: 0 }), "open");
  assert.equal(availability(osm, { year: 2026, month: 10, day: 21, hour: 3, minute: 0 }), "closed");
});

test("week states and counts line up with the reference weeks", () => {
  const school = weekStates(schoolHours(15));
  const always = weekStates("24/7");
  const counts = weekCounts([school, always, weekStates(null)], "school");
  assert.equal(counts.open[stateIndex("school", 10)], 2); // Monday 10:00
  assert.equal(counts.open[stateIndex("school", 22)], 1); // Monday 22:00
  assert.equal(counts.unknown[0], 1);
  assert.equal(school[stateIndex("summer", 10)], 0);
  assert.equal(hourOfWeekFromWall({ year: 2026, month: 11, day: 1, hour: 3, minute: 0 }), 6 * 24 + 3); // Sunday
});

test("CSV import: detects columns, semicolons, aliases, bad hours and missing coordinates", () => {
  const csv = "name;latitude;longitude;opening_hours;address\nGym;40.7;-73.9;24h;\nLibrary;40.71;-73.91;Mo-Fr 9-5ish;\nClinic;;;Mo-Fr 08:00-18:00;12 Main St\nNothing;;;;\n";
  const r = parseCsvSites(csv);
  assert.equal(r.sites.length, 2);
  assert.equal(r.sites[0].hours, "24/7");
  assert.equal(r.sites[1].hours, null);
  assert.equal(r.needsGeocoding.length, 1);
  assert.equal(r.issues.length, 2);
});

test("GeoJSON import reads OpenStreetMap-style opening_hours", () => {
  const r = parseGeoJsonSites({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-73.9, 40.7] }, properties: { name: "Deli", opening_hours: "24/7" } }],
  });
  assert.equal(r.sites[0].hours, "24/7");
});

test("coverage: a closed site still counts for a time-blind map but not at night", () => {
  const at: [number, number] = [-73.9, 40.7];
  const region = { id: "z", shape: [circle(at, 300)] };
  const [cov] = regionCoverage([{ at, states: weekStates(schoolHours(15)) }], [region], { cellMeters: 25, radiusMeters: 150 });
  assert.ok(cov.cells > 100);
  assert.ok(cov.reachable > 0 && cov.reachable < cov.cells);
  assert.equal(cov.open[stateIndex("school", 10)], cov.reachable);
  assert.equal(cov.open[stateIndex("school", 22)], 0);
});
