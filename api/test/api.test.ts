/**
 * The API against the published data files, offline: no AWS call is made. The headline numbers the
 * site and the article state are asserted here as the API returns them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/handler.ts";
import { resolveTime, sameName } from "../src/ask.ts";

delete process.env.DATA_BUCKET;
delete process.env.TABLE;

const get = async (path: string, query: Record<string, string> = {}) => route({ method: "GET", path: `/site${path}`, query, body: null });
const post = async (path: string, body: unknown) => route({ method: "POST", path: `/site${path}`, query: {}, body });
const body = <T>(r: { body: unknown }) => r.body as T;

test("health lists both cities", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  assert.deepEqual(body<{ presets: string[] }>(r).presets, ["nyc", "paris"]);
});

test("availability matches the headline: 2,636 open on a school Tuesday at 2 PM, 52 on Sunday at 3 AM", async () => {
  type Counts = { counts: { open: number; closed: number; unknown: number } };
  const tue = body<Counts>(await get("/availability", { preset: "nyc", at: "2026-10-20T14:00" })).counts;
  const sun = body<Counts>(await get("/availability", { preset: "nyc", at: "2026-11-01T03:00" })).counts;
  assert.equal(tue.open, 2636);
  assert.equal(sun.open, 52);
  assert.equal(sun.open + sun.closed + sun.unknown, 4032);
});

test("AI-estimated hours stay out unless asked for, and never lower the open count", async () => {
  type Counts = { counts: { open: number } };
  const off = body<Counts>(await get("/availability", { preset: "nyc", at: "2026-11-01T03:00" })).counts.open;
  const on = body<Counts>(await get("/availability", { preset: "nyc", at: "2026-11-01T03:00", includeAi: "1" })).counts.open;
  assert.ok(on >= off);
});

test("relocation: ranked, highest first, and the top 100 add up to about 84 calls a year", async () => {
  type Row = { rank: number; id: string; expectedCallsPerYear: number };
  const five = body<Row[]>(await get("/relocation", { limit: "5" }));
  assert.deepEqual(five.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(five[0].id, "73af9eab1f");
  for (let i = 1; i < five.length; i++) assert.ok(five[i - 1].expectedCallsPerYear >= five[i].expectedCallsPerYear);
  const all = body<Row[]>(await get("/relocation", { limit: "100" }));
  assert.equal(all.length, 100);
  assert.equal(Math.round(all.reduce((a, r) => a + r.expectedCallsPerYear, 0)), 84);
});

test("bad input gets a 4xx with a reason, never a 500", async () => {
  assert.equal((await post("/ask", {})).status, 400);
  assert.equal((await post("/ask", { question: "x".repeat(301) })).status, 413);
  assert.equal((await get("/nearest", { lat: "999", lon: "-73.9" })).status, 400);
  assert.equal((await get("/availability", { at: "not a date" })).status, 400);
  assert.equal((await get("/relocation", { limit: "0" })).status, 400);
  assert.equal((await post("/geocode", { queries: [] })).status, 400);
  assert.equal((await get("/nope")).status, 404);
});

test("the MCP server lists its tools", async () => {
  const r = await route({ method: "POST", path: "/mcp", query: {}, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  const names = (r.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok(names.includes("nearest_open_aed"));
  assert.ok(names.includes("aed_availability"));
});

// Calendar arithmetic stays in code; the model only names the day. Today in these tests: Sunday 1 November 2026, 10 AM.
const NOW = { year: 2026, month: 11, day: 1, hour: 10, minute: 0 };

test("ask: weekdays, relative days and dates become the right day of the week", () => {
  assert.deepEqual(resolveTime({ weekday: "Tuesday", hour: 14 }, NOW), { day: 1, hour: 14, summer: false });
  assert.deepEqual(resolveTime({ when: "tomorrow", hour: 12 }, NOW), { day: 0, hour: 12, summer: false });
  assert.deepEqual(resolveTime({ when: "now" }, NOW), { day: 6, hour: 10, summer: false });
  assert.deepEqual(resolveTime({ when: "tonight", hour: null }, NOW), { day: 6, hour: 21, summer: false });
  // Christmas 2026 is a Friday; a July date is summer whatever the model said.
  assert.deepEqual(resolveTime({ date: "2026-12-25", hour: 9 }, NOW), { day: 4, hour: 9, summer: false });
  assert.deepEqual(resolveTime({ date: "2027-07-04", hour: 21, summer: false }, NOW), { day: 6, hour: 21, summer: true });
  // Out-of-range hours from the model are dropped, not trusted.
  assert.equal(resolveTime({ weekday: "Monday", hour: 99 }, NOW).hour, null);
});

test("ask: a landmark result must carry the name that was asked for", () => {
  assert.equal(sameName("Apollo Theater, Manhattan", "Theatre Aly, New York (Manhattan), NY 10038, United States"), false);
  assert.equal(sameName("Apollo Theater, Manhattan", "New Amsterdam Theatre (New Amsterdam Theater)"), false);
  assert.equal(sameName("Times Square, Manhattan", "Times Sq, New York (Manhattan), NY 10036, United States"), true);
  assert.equal(sameName("Grand Central Terminal, Manhattan", "Grand Central Terminal"), true);
});
