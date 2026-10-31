/**
 * "Hear both sides": two Amazon Bedrock agents argue one After Hours finding, then a third
 * judges. Every claim must cite an evidence line by its id; the judge checks that, so the
 * debate can only use numbers the data actually contains.
 */
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({});
const MODEL = process.env.DEBATE_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export interface Evidence {
  id: string;
  text: string;
}

export interface Turn {
  speaker: "advocate" | "skeptic";
  text: string;
  cites: string[];
}

export interface Verdict {
  verdict: "act" | "act-with-conditions" | "investigate-first" | "do-not-act";
  summary: string;
  strongestFor: string;
  strongestAgainst: string;
  nextStep: string;
  uncitedClaims: number;
}

const RULES = `Rules you must follow:
- Use only the evidence lines provided. Cite them inline like [E3]. Never invent numbers, names, costs or studies.
- If the evidence does not support a point, say that it is unknown.
- Quote numbers exactly as the evidence states them. Never turn them into multiples ("double", "3x") or new percentages.
- Plain English for a city council staffer. No jargon, no headings, no bold, no lists. One paragraph, 70 words at most.
- This is planning analysis, not emergency advice.`;

async function say(system: string, prompt: string, maxTokens = 400): Promise<string> {
  const res = await client.send(
    new ConverseCommand({
      modelId: MODEL,
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens, temperature: 0.4 },
    }),
  );
  const text = (res.output?.message?.content ?? []).map((c) => c.text ?? "").join("").trim();
  // Belt and braces: strip markdown the model may still add.
  return text.replace(/^#+\s.*$/gm, "").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\n{2,}/g, "\n").trim();
}

const citesOf = (t: string) => [...new Set([...t.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]))];

export async function debate(question: string, evidence: Evidence[]): Promise<{ question: string; evidence: Evidence[]; turns: Turn[]; verdict: Verdict; model: string }> {
  const ev = evidence.map((e) => `[${e.id}] ${e.text}`).join("\n");
  const advocate = `You are the Advocate. You argue FOR the proposal.\n${RULES}`;
  const skeptic = `You are the Skeptic. You argue AGAINST the proposal or for caution, focusing on uncertainty in the data, cost and better alternatives.\n${RULES}`;
  const turns: Turn[] = [];
  const transcript = () => turns.map((t) => `${t.speaker.toUpperCase()}: ${t.text}`).join("\n\n");
  for (let round = 0; round < 2; round++) {
    for (const [speaker, sys] of [["advocate", advocate], ["skeptic", skeptic]] as const) {
      const text = await say(
        sys,
        `Proposal: ${question}\n\nEvidence:\n${ev}\n\nDebate so far:\n${transcript() || "(you speak first)"}\n\n${round === 0 ? "Make your opening argument." : "Respond to the other side's strongest point."}`,
      );
      turns.push({ speaker, text, cites: citesOf(text) });
    }
  }
  const raw = await say(
    `You are the Judge. Weigh both sides using only the evidence. Penalise any claim without an [E#] citation. Quote numbers exactly as the evidence states them; never restate them as multiples. Reply with JSON only:
{"verdict":"act|act-with-conditions|investigate-first|do-not-act","summary":"<max 40 words>","strongestFor":"<max 20 words>","strongestAgainst":"<max 20 words>","nextStep":"<one concrete action, max 20 words>"}`,
    `Proposal: ${question}\n\nEvidence:\n${ev}\n\nDebate:\n${transcript()}`,
    500,
  );
  const v = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Verdict;
  // Sentences that state a number without citing evidence, counted rather than trusted.
  v.uncitedClaims = turns.reduce((n, t) => n + t.text.split(/(?<=[.!?])\s+/).filter((s) => /\d/.test(s.replace(/\[E\d+\]/g, "")) && !/\[E\d+\]/.test(s)).length, 0);
  return { question, evidence, turns, verdict: v, model: MODEL };
}
