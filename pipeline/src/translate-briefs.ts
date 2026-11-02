/**
 * Spanish for the school briefs: the fixed text is translated in web/src/brief.ts; the AI debate
 * summaries (one per brief that has a saved debate) are translated here by Amazon Bedrock. Every
 * number and every proper name in the English must appear unchanged in the Spanish, or the
 * translation is rejected and retried, so a figure can't drift in translation.
 *
 *   npm run translate -w pipeline     → web/public/data/nyc/briefs-es.json
 */
import { resolve } from "node:path";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { OUT, readJson, writeJson } from "./paths.ts";

const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const dir = resolve(OUT, "nyc");
const briefs = readJson<{ briefs: { id: string; name: string; altHost: { name: string } | null; debate: { summary: string; nextStep: string } | null }[] }>(resolve(dir, "briefs.json")).briefs;

const clean = (t: string) => t.replace(/\s*\[E\d+\]/g, "").trim();
const numbers = (t: string) => t.match(/\d+(?:[.,]\d+)*/g) ?? [];

async function toSpanish(text: string, keep: string[]): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await client.send(
      new ConverseCommand({
        modelId: MODEL,
        system: [
          {
            text: `Translate the user's text into clear, neutral Spanish as used in New York City public notices. Use "DEA" for AED. Keep every number exactly as written, with the same decimal point, and keep these names unchanged: ${keep.join("; ")}. Reply with the translation only.`,
          },
        ],
        messages: [{ role: "user", content: [{ text }] }],
        inferenceConfig: { maxTokens: 400, temperature: 0 },
      }),
    );
    const out = (res.output?.message?.content ?? []).map((c) => c.text ?? "").join("").trim();
    const missing = [...numbers(text), ...keep.filter((k) => text.includes(k))].filter((n) => !out.includes(n));
    if (out && !missing.length) return out;
    console.warn(`  retry (${attempt + 1}): missing ${missing.join(", ")}`);
  }
  throw new Error(`Translation kept failing the number and name check: ${text.slice(0, 80)}`);
}

const out: Record<string, { summary: string; nextStep: string }> = {};
for (const b of briefs) {
  if (!b.debate) continue;
  const keep = [b.name, ...(b.altHost ? [b.altHost.name] : [])];
  out[b.id] = { summary: await toSpanish(clean(b.debate.summary), keep), nextStep: await toSpanish(clean(b.debate.nextStep), keep) };
  console.log(`${b.name}: ok`);
}
writeJson(resolve(dir, "briefs-es.json"), { model: MODEL, checked: "every number and name in the English appears unchanged in the Spanish", briefs: out });
console.log(`${Object.keys(out).length} debate summaries translated`);
