/**
 * `npm run verify` re-checks the numbers the README and the article state, from the files anyone can
 * download from the live site: sites.csv, relocation.csv, summary.json and evals.json. Counts are
 * recomputed from the CSVs with the same engine the pipeline uses, not read back from the summary.
 * `npm run verify -- --live` also asks the live API the questions the article quotes.
 *
 * Exits 1 if any claim fails, so a number can't drift from the data without someone noticing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stateIndex, weekStates } from "@after-hours/engine";

const DATA = resolve(import.meta.dirname, "../../web/public/data");
const SITE = "https://dqcf6x4e7zbds.cloudfront.net";
const live = process.argv.includes("--live");

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
function csv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n") row.push(field), rows.push(row), (row = []), (field = "");
    else if (c !== "\r") field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const read = (path: string) => readFileSync(resolve(DATA, path), "utf8");
const json = (path: string) => JSON.parse(read(path));
const pct = (x: number) => Math.round(x * 100);
const pct1 = (x: number) => Math.round(x * 1000) / 10;

const results: { claim: string; got: string; ok: boolean }[] = [];
const check = (claim: string, got: unknown, ok: boolean) => results.push({ claim, got: String(got), ok });

// ---------- the registry, recomputed from sites.csv ----------

const sites = csv(read("nyc/sites.csv"));
const bySource = (s: string) => sites.filter((r) => r.hours_source === s).length;
const schools = bySource("calendar");
check("4,032 AED locations in New York", sites.length, sites.length === 4032);
check("11,008 AEDs at them", sites.reduce((a, r) => a + Number(r.aeds), 0), sites.reduce((a, r) => a + Number(r.aeds), 0) === 11008);
check("1,925 locations are schools (48%)", `${schools} (${pct(schools / sites.length)}%)`, schools === 1925 && pct(schools / sites.length) === 48);
check("742 venues have hours published by Amazon Location", bySource("places"), bySource("places") === 742);
check("1,278 have AI-estimated hours, 87 have none", `${bySource("ai")}, ${bySource("unknown")}`, bySource("ai") === 1278 && bySource("unknown") === 87);

// Open counts: only school calendars and published hours count; AI estimates and unknowns never do.
const memo = new Map<string, Uint8Array>();
const states = (h: string) => memo.get(h) ?? memo.set(h, weekStates(h || null)).get(h)!;
const openAt = (hourOfWeek: number) =>
  sites.filter((r) => (r.hours_source === "calendar" || r.hours_source === "places") && states(r.opening_hours)[stateIndex("school", hourOfWeek)] === 1).length;
const tue2pm = openAt(24 + 14), tue6pm = openAt(24 + 18), sun3am = openAt(6 * 24 + 3);
check("2,636 confirmed open on a school Tuesday at 2 PM", tue2pm, tue2pm === 2636);
check("250 at 6 PM, when school buildings lock", tue6pm, tue6pm === 250);
check("52 at 3 AM on a Sunday", sun3am, sun3am === 52);

// ---------- the calls and the coverage, from summary.json ----------

const s = json("nyc/summary.json");
const f = s.findings;
const v = s.calls.byVariant[s.headlineVariant];
check("25,448 cardiac-arrest calls in 2025", f.calls, f.calls === 25448 && v.calls === 25448);
check("64% came while school buildings were shut", `${pct(f.callsWhenSchoolsShut / f.calls)}%`, pct(f.callsWhenSchoolsShut / f.calls) === 64);
check("69% outside Manhattan are schools", `${pct(f.schoolShareOutsideManhattan)}%`, pct(f.schoolShareOutsideManhattan) === 69);
check("A time-blind map covers 4.6% of the call-weighted city; 1.4% was open", `${pct1(v.timeBlindCoverage)}%, ${pct1(v.actualCoverage)}%`, pct1(v.timeBlindCoverage) === 4.6 && pct1(v.actualCoverage) === 1.4);
const lost = 1 - v.actualCoverage / v.timeBlindCoverage;
const lostKind = 1 - (v.actualCoverage + v.unknownCoverage) / v.timeBlindCoverage;
check("69% of that coverage was behind a locked door (1 − 1.4 ÷ 4.6, unrounded)", `${pct1(lost)}%`, pct(lost) === 69 && Math.abs(lost - f.coverageLost.lostConservative) < 1e-9);
check("39% even if every venue of unknown hours were open around the clock", `${pct1(lostKind)}%`, pct(lostKind) === 39 && Math.abs(lostKind - f.coverageLost.lostIfUnknownWereOpen) < 1e-9);
check("Bedrock's hours, graded blind on 742 venues: 85% of hours right", `${pct(s.aiGrade.hourAgreement)}%`, s.aiGrade.venuesWithKnownHours === 742 && pct(s.aiGrade.hourAgreement) === 85);
check("…and it called a shut venue open 8.3% of the time", `${pct1(s.aiGrade.falseOpenShare)}%`, pct1(s.aiGrade.falseOpenShare) === 8.3);

// ---------- the ranking, recomputed from relocation.csv ----------

const rel = csv(read("nyc/relocation.csv"));
const calls = rel.map((r) => Number(r.expected_after_hours_arrest_calls_in_reach_per_year));
const sum = (n: number) => calls.slice(0, n).reduce((a, b) => a + b, 0);
check("100 schools ranked, highest first", rel.length, rel.length === 100 && rel.every((r, i) => Number(r.rank) === i + 1) && calls.every((c, i) => i === 0 || calls[i - 1] >= c));
check("Together the top 100 reach about 84 cardiac arrests a year", sum(100).toFixed(1), Math.round(sum(100)) === 84);
check("#1 is P.S. 053 Basheer Quisim; Engine 92 Ladder 44 is 268 m away", `${rel[0].name}; ${rel[0].nearest_24h_staffed_building}, ${rel[0].meters_away} m`, rel[0].name === "P.S. 053 Basheer Quisim" && rel[0].nearest_24h_staffed_building === "Engine 92 Ladder 44" && rel[0].meters_away === "268");
check("69 of the 100 have an always-staffed building within 400 m", rel.filter((r) => r.meters_away).length, rel.filter((r) => r.meters_away).length === 69);
const before = v.calls * v.actualCoverage;
check("About 363 calls had an open AED in reach; with the top 100 fixed, at least 448 (+23%)", `${Math.round(before)} → ${Math.round(before + sum(100))} (+${pct(sum(100) / before)}%)`, Math.round(before) === 363 && Math.round(before + sum(100)) === 448 && pct(sum(100) / before) === 23);

// ---------- Paris, where owners must declare hours ----------

const p = json("paris/summary.json");
check("Paris: 838 confirmed open on Tuesday at 2 PM, 219 on Sunday at 3 AM", `${p.figures.openTue2pm} → ${p.figures.openSun3am}`, p.figures.openTue2pm === 838 && p.figures.openSun3am === 219);

// ---------- Ask the map, from evals.json ----------

const e = json("nyc/evals.json").ask;
check("Ask the map: 19 of 20 questions read right, 12 of 12 written after", `${e.development.ordinary.correct}/${e.development.ordinary.of}, ${e.heldOut.ordinary.correct}/${e.heldOut.ordinary.of}`, e.development.ordinary.correct === 19 && e.heldOut.ordinary.correct === 12 && e.heldOut.ordinary.of === 12);
check("…no miss put a wrong place or hour on the map", e.development.ordinary.missesWrong + e.heldOut.ordinary.missesWrong, e.development.ordinary.missesWrong + e.heldOut.ordinary.missesWrong === 0);
check("…all 14 places outside the city declined, all 11 emergencies flagged, 0 false alarms in 39", `${e.development.outside.declined + e.heldOut.outside.declined}, ${e.development.emergency.flagged + e.heldOut.emergency.flagged}, ${e.development.falseAlarms.n + e.heldOut.falseAlarms.n} of ${e.development.falseAlarms.of + e.heldOut.falseAlarms.of}`, e.development.outside.declined + e.heldOut.outside.declined === 14 && e.development.emergency.flagged + e.heldOut.emergency.flagged === 11 && e.development.falseAlarms.n + e.heldOut.falseAlarms.n === 0);

// ---------- the live site (optional) ----------

if (live) {
  type Cand = { name: string; group: string; state: string; walkSeconds: number };
  type Near = { timeBlindNearest: Cand | null; nearestOpen: Cand | null };
  const near = async (lon: number, lat: number, at: string) => (await (await fetch(`${SITE}/api/site/nearest?preset=nyc&lon=${lon}&lat=${lat}&at=${at}`)).json()) as Near;
  const min = (c: Cand | null) => (c ? Math.round(c.walkSeconds / 60) : null);
  const ps151: [number, number] = [-73.94763, 40.77785];
  const a = await near(...ps151, "2026-11-02T16:00");
  check("Live: outside P.S. 151 on a Monday at 4 PM, the nearest AED is the school's own, open", `${a.timeBlindNearest?.name}, ${a.timeBlindNearest?.state}`, a.timeBlindNearest?.group === "School" && a.timeBlindNearest.state === "open");
  const b = await near(...ps151, "2026-11-02T19:00");
  check("Live: at 7 PM it is locked; the nearest open one is a gym, 12 minutes on foot", `${b.timeBlindNearest?.state}; ${b.nearestOpen?.group}, ${min(b.nearestOpen)} min`, b.timeBlindNearest?.state === "closed" && b.nearestOpen?.group === "Gym" && min(b.nearestOpen) === 12);
  const c = await near(...ps151, "2027-07-05T16:00");
  check("Live: on a Monday in July at 4 PM, locked; the nearest open one is 11 minutes away", `${c.timeBlindNearest?.state}; ${min(c.nearestOpen)} min`, c.timeBlindNearest?.state === "closed" && min(c.nearestOpen) === 11);
  const d = await near(-73.8945, 40.6705, "2026-11-01T21:00");
  check("Live: East New York, Sunday 9 PM: the nearest AED is 4 minutes away and locked; the nearest open one is 53", `${min(d.timeBlindNearest)} min ${d.timeBlindNearest?.state}; ${min(d.nearestOpen)} min`, min(d.timeBlindNearest) === 4 && d.timeBlindNearest?.state === "closed" && min(d.nearestOpen) === 53);
  type Ask = { reading: { day: number; hour: number; summer: boolean }; place: { lon: number; lat: number } | null };
  const q = (await (await fetch(`${SITE}/api/site/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "a Saturday night in July at Coney Island" }) })).json()) as Ask;
  const ci = q.place ? await near(q.place.lon, q.place.lat, `2027-07-03T${String(q.reading.hour).padStart(2, "0")}:00`) : null;
  check(
    'Live: "a Saturday night in July at Coney Island" → the New York Aquarium, 4 minutes, locked; the nearest open one 22 minutes away',
    ci ? `${ci.timeBlindNearest?.name} ${min(ci.timeBlindNearest)} min ${ci.timeBlindNearest?.state}; ${min(ci.nearestOpen)} min` : "no place",
    q.reading.day === 5 && q.reading.summer && ci?.timeBlindNearest?.name === "New York Aquarium" && min(ci.timeBlindNearest) === 4 && ci.timeBlindNearest.state === "closed" && min(ci.nearestOpen) === 22,
  );
  const w = (await (await fetch(`${SITE}/data/nyc/changes.json`, { cache: "no-store" })).json()) as { previousSnapshot: string | null; locations: number };
  check("Live: the nightly Iceberg snapshot ran and compared two nights", `${w.previousSnapshot} → ${w.locations} locations`, !!w.previousSnapshot && w.locations === 4032);
}

for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.claim}\n    ${r.got}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length} claims checked${live ? ", including the live site" : ""}: ${results.length - failed} hold${failed ? `, ${failed} FAIL` : ""}.`);
process.exit(failed ? 1 : 0);
