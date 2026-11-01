import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const summaries: Record<string, unknown> = {};
/** The pipeline's summary, plus the measured evaluations (`npm run eval -w api`) under "evals". */
function summary(id: string) {
  return (summaries[id] ??= (() => {
    const dir = resolve(__dirname, "public/data", id);
    const s = JSON.parse(readFileSync(resolve(dir, "summary.json"), "utf8"));
    if (existsSync(resolve(dir, "evals.json"))) s.evals = JSON.parse(readFileSync(resolve(dir, "evals.json"), "utf8"));
    return s;
  })());
}

/** {{nyc:findings.calls|int}} → a number from the pipeline's summary, formatted. Pages never hardcode a figure. */
function figure(expr: string): string {
  const [ref, fmt = "raw"] = expr.split("|");
  const [id, path] = ref.split(":");
  let v: unknown = summary(id);
  for (const k of path.split(".")) v = (v as Record<string, unknown>)?.[k];
  if (v === undefined) throw new Error(`Unknown figure ${expr}`);
  const n = Number(v);
  switch (fmt) {
    case "int":
      return Math.round(n).toLocaleString("en-US");
    case "pct":
      return `${Math.round(n * 100)}%`;
    case "pct1":
      return `${(n * 100).toFixed(1)}%`;
    default:
      return String(v);
  }
}

/** Replaces <!--partial:name--> with web/partials/name.html and fills {{figures}}, so pages ship as real HTML. */
function partials(): Plugin {
  return {
    name: "after-hours-partials",
    transformIndexHtml(html, ctx) {
      const page = (ctx.filename.split(/[\\/]/).pop() ?? "").replace(".html", "");
      return html
        .replace(/<!--partial:(\w+)-->/g, (_, name: string) =>
          readFileSync(resolve(__dirname, "partials", `${name}.html`), "utf8").replace(`data-nav="${page}"`, `data-nav="${page}" aria-current="page"`),
        )
        .replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => figure(expr.trim()));
    },
  };
}

export default defineConfig({
  plugins: [partials()],
  server: {
    port: 5173,
    proxy: { "^/api/": { target: "http://localhost:8787", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        map: resolve(__dirname, "map.html"),
        data: resolve(__dirname, "data.html"),
        api: resolve(__dirname, "api.html"),
        method: resolve(__dirname, "method.html"),
        brief: resolve(__dirname, "brief.html"),
      },
    },
  },
});
