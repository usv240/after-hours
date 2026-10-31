/** Saves debates for the top-ranked schools, so the site opens on a finished one instantly. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDebate } from "./handler.ts";

const dir = resolve(process.env.LOCAL_DATA_DIR ?? "../web/public/data", "nyc/debates");
mkdirSync(dir, { recursive: true });
const ranked = JSON.parse(readFileSync(resolve(dir, "../relocation.json"), "utf8")) as { id: string; name: string }[];
const top = ranked.slice(0, Number(process.argv[2] ?? 10));
let next = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let i = next++; i < top.length; i = next++) {
      const r = top[i];
      try {
        const d = await runDebate({ preset: "nyc", siteId: r.id });
        writeFileSync(resolve(dir, `${r.id}.json`), JSON.stringify({ ...d, savedAt: new Date().toISOString() }));
        console.log(`${r.name}: ${(d as { verdict: { verdict: string } }).verdict.verdict}`);
      } catch (e) {
        console.warn(r.name, (e as Error).message);
      }
    }
  }),
);
