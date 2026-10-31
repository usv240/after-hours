/**
 * Amazon Bedrock estimates opening hours for venues Amazon Location could not match,
 * from the registry's own words: name, category and the floor/location note.
 * It may abstain, and it is graded first, blind, on venues whose real hours Places returned.
 */
import { resolve } from "node:path";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { availability, normaliseHours, validateHours, wallTimeFor, HOURS_IN_WEEK } from "@after-hours/engine";
import { CACHE, readJson, readJsonOr, writeJson } from "./paths.ts";
import type { PipelineSite } from "./sites.ts";
import type { AiGuess, PlacesHit } from "./assign-hours.ts";

const MODEL = process.env.HOURS_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const client = new BedrockRuntimeClient({ region: "us-east-1" });
const BATCH = 25;

const SYSTEM = `You estimate when the public can physically reach a defibrillator (AED) inside a New York City venue.
You get the venue name, its registry category and a location note. Reply with JSON only:
{"results":[{"i":<index>,"hours":"<OpenStreetMap opening_hours or null>","confidence":"high|medium|low|abstain","reason":"<max 12 words>"}]}
Rules:
- Use OpenStreetMap opening_hours syntax, e.g. "Mo-Fr 09:00-17:00", "Mo-Su 06:00-22:00", "24/7".
- "24/7" only when the venue type is almost always staffed around the clock (hospital, nursing home, 24-hour transit terminal, residential building with a doorman).
- Offices and law firms: weekday business hours. Senior centres: weekday daytime.
- If the name gives no real clue about the venue type, set confidence "abstain" and hours null. Abstaining is better than guessing.
- Never invent a specific business you do not recognise.`;

async function ask(batch: PipelineSite[]): Promise<Map<number, AiGuess>> {
  const lines = batch.map((s, i) => `${i}. ${s.name} | category: ${s.rawCategory || s.group} | note: ${s.where || "-"}`).join("\n");
  const res = await client.send(
    new ConverseCommand({
      modelId: MODEL,
      system: [{ text: SYSTEM }],
      messages: [{ role: "user", content: [{ text: lines }] }],
      inferenceConfig: { maxTokens: 4000, temperature: 0 },
    }),
  );
  const text = res.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { results: (AiGuess & { i: number })[] };
  const out = new Map<number, AiGuess>();
  for (const r of json.results ?? []) {
    let hours = normaliseHours(r.hours);
    if (hours && validateHours(hours)) hours = null;
    out.set(r.i, { hours, confidence: hours ? r.confidence : "abstain", reason: String(r.reason ?? "").slice(0, 120) });
  }
  return out;
}

async function run(sites: PipelineSite[], cache: Record<string, AiGuess>, file: string) {
  const todo = sites.filter((s) => !cache[s.id]);
  for (let k = 0; k < todo.length; k += BATCH) {
    const batch = todo.slice(k, k + BATCH);
    try {
      const got = await ask(batch);
      batch.forEach((s, i) => (cache[s.id] = got.get(i) ?? { hours: null, confidence: "abstain", reason: "no answer" }));
    } catch (e) {
      console.warn("batch failed", (e as Error).message.slice(0, 120));
    }
    writeJson(file, cache);
    process.stdout.write(`${Math.min(k + BATCH, todo.length)}/${todo.length}\r`);
  }
  console.log();
}

/** Hour-by-hour agreement over the school-year reference week. */
function grade(sites: PipelineSite[], truth: Record<string, PlacesHit | null>, guesses: Record<string, AiGuess>) {
  let graded = 0, abstained = 0, hoursChecked = 0, agree = 0, falseOpen = 0, falseClosed = 0, false247 = 0;
  for (const s of sites) {
    const t = truth[s.id]?.hours;
    const g = guesses[s.id];
    if (!t || !g) continue;
    if (!g.hours) {
      abstained++;
      continue;
    }
    graded++;
    if (g.hours === "24/7" && t !== "24/7") false247++;
    for (let h = 0; h < HOURS_IN_WEEK; h++) {
      const w = wallTimeFor("school", h);
      const a = availability(t, w), b = availability(g.hours, w);
      if (a === "unknown" || b === "unknown") continue;
      hoursChecked++;
      if (a === b) agree++;
      else if (b === "open") falseOpen++;
      else falseClosed++;
    }
  }
  return {
    model: MODEL,
    venuesWithKnownHours: graded + abstained,
    abstained,
    graded,
    hourAgreement: agree / hoursChecked,
    falseOpenShare: falseOpen / hoursChecked,
    falseClosedShare: falseClosed / hoursChecked,
    false247,
  };
}

async function main() {
  const sites = readJson<PipelineSite[]>(resolve(CACHE, "nyc_sites.json")).filter((s) => s.group !== "School");
  const places = readJsonOr<Record<string, PlacesHit | null>>(resolve(CACHE, "nyc_places.json"), {});
  const blindFile = resolve(CACHE, "nyc_ai_blind.json");
  const blind = readJsonOr<Record<string, AiGuess>>(blindFile, {});
  const known = sites.filter((s) => places[s.id]?.hours);
  console.log(`Blind test on ${known.length} venues with Amazon Location hours…`);
  await run(known, blind, blindFile);
  const report = grade(known, places, blind);
  writeJson(resolve(CACHE, "nyc_ai_grade.json"), report, true);
  console.log(report);

  const aiFile = resolve(CACHE, "nyc_ai_hours.json");
  const ai = readJsonOr<Record<string, AiGuess>>(aiFile, {});
  const unknown = sites.filter((s) => !places[s.id]?.hours);
  console.log(`Estimating ${unknown.length} venues with no published hours…`);
  await run(unknown, ai, aiFile);
  const vals = unknown.map((s) => ai[s.id]).filter(Boolean);
  console.log({ estimated: vals.filter((v) => v.hours).length, abstained: vals.filter((v) => !v.hours).length });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
