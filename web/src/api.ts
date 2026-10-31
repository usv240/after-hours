import "./styles/doc.css";
import "./styles/app.css";
import { el } from "./common.ts";

interface Endpoint {
  id: string;
  method: "GET" | "POST";
  path: string;
  desc: string;
  params: string;
}

const ENDPOINTS: Endpoint[] = [
  { id: "availability", method: "GET", path: "/availability", desc: "Open, locked and unknown AED locations in New York at 3 AM on a Sunday.", params: "preset=nyc\nat=2026-11-01T03:00\nschoolClose=18" },
  { id: "nearest", method: "GET", path: "/nearest", desc: "From a corner in East New York at 3 AM: the nearest AED, and the nearest one that is open.", params: "preset=nyc\nlat=40.6745\nlon=-73.8890\nat=2026-11-01T03:00" },
  { id: "relocation", method: "GET", path: "/relocation", desc: "The five NYC schools whose AED would reach the most after-hours cardiac arrests if moved to a 24/7 cabinet.", params: "limit=5" },
  {
    id: "analyze",
    method: "POST",
    path: "/analyze",
    desc: "Bring your own list. Three places, three kinds of hours, one of them unreadable on purpose.",
    params: JSON.stringify(
      {
        timeZone: "America/Chicago",
        sites: [
          { name: "Fire station 12", lat: 41.881, lon: -87.623, hours: "24/7" },
          { name: "Public library", lat: 41.876, lon: -87.628, hours: "Mo-Th 09:00-20:00; Fr,Sa 09:00-17:00; Su 13:00-17:00" },
          { name: "Gym", lat: 41.889, lon: -87.631, hours: "open late most days" },
        ],
      },
      null,
      2,
    ),
  },
  { id: "isolines", method: "POST", path: "/isolines", desc: "A two-minute walk around Times Square, routed by Amazon Location Service.", params: JSON.stringify({ points: [[-73.9855, 40.758]], seconds: 120 }, null, 2) },
  { id: "summary", method: "GET", path: "/summary", desc: "Every headline number for Paris.", params: "preset=paris" },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const origin = location.origin;

function store(k: string, v?: string) {
  try {
    if (v === undefined) return sessionStorage.getItem(k) ?? "";
    sessionStorage.setItem(k, v);
  } catch {
    /* storage can be blocked; the key still works for this page */
  }
  return "";
}

function current(): Endpoint {
  return ENDPOINTS.find((e) => e.id === $<HTMLSelectElement>("ep").value) ?? ENDPOINTS[0];
}

function requestFor(ep: Endpoint, key: string) {
  const raw = $<HTMLTextAreaElement>("ep-params").value.trim();
  const base = key ? "/api/v1" : "/api/site";
  if (ep.method === "GET") {
    const qs = new URLSearchParams(
      raw
        .split(/\n|&/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split("=").map((s) => s.trim()) as [string, string]),
    );
    return { url: `${base}${ep.path}?${qs}`, init: { method: "GET" } as RequestInit };
  }
  JSON.parse(raw); // surface syntax errors before sending
  return { url: `${base}${ep.path}`, init: { method: "POST", body: raw } as RequestInit };
}

function selectEndpoint() {
  const ep = current();
  $("ep-desc").textContent = `${ep.method} ${ep.path}: ${ep.desc}`;
  $("ep-params-label").textContent = ep.method === "GET" ? "Query (one name=value per line)" : "JSON body";
  $<HTMLTextAreaElement>("ep-params").value = ep.params;
}

async function send() {
  const ep = current();
  const key = $<HTMLInputElement>("ep-key").value.trim();
  const status = $("res-status");
  const body = $("res-body");
  let req;
  try {
    req = requestFor(ep, key);
  } catch (e) {
    status.textContent = `The JSON body has a mistake: ${(e as Error).message}`;
    return;
  }
  status.textContent = "Sending…";
  body.textContent = "";
  const t0 = performance.now();
  try {
    const res = await fetch(req.url, { ...req.init, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) } });
    const ms = Math.round(performance.now() - t0);
    const text = await res.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not JSON */
    }
    status.textContent = `${res.status} ${res.statusText || (res.ok ? "OK" : "")} · ${ms} ms · ${key ? "through /api/v1 with your key" : "through the site route (no key)"}`;
    status.className = `console__status ${res.ok ? "is-ok" : "is-bad"}`;
    body.textContent = pretty.length > 60000 ? `${pretty.slice(0, 60000)}\n… (truncated for display)` : pretty;
    if (res.status === 403 && key) status.textContent += ". That key is not valid yet: new keys can take a few minutes to start working everywhere. Try again shortly.";
  } catch (e) {
    status.textContent = `Network error: ${(e as Error).message}`;
  }
}

function curl() {
  const ep = current();
  const key = $<HTMLInputElement>("ep-key").value.trim() || "YOUR_KEY";
  const req = requestFor(ep, key);
  const parts = [`curl ${ep.method === "POST" ? "-X POST " : ""}"${origin}${req.url}"`, `-H "x-api-key: ${key}"`];
  if (ep.method === "POST") parts.push(`-H "content-type: application/json"`, `-d '${(req.init.body as string).replace(/\s*\n\s*/g, " ")}'`);
  return parts.join(" \\\n  ");
}

async function createKey(e: Event) {
  e.preventDefault();
  const btn = $<HTMLButtonElement>("key-btn");
  const out = $("key-out");
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    const res = await fetch("/api/site/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: $<HTMLInputElement>("key-label").value }) });
    const data = (await res.json()) as { key?: string; plan?: string; error?: string };
    if (!res.ok || !data.key) throw new Error(data.error ?? `Request failed (${res.status})`);
    store("ah-key", data.key);
    $<HTMLInputElement>("ep-key").value = data.key;
    const copy = el("button", { type: "button", class: "chip" }, "Copy");
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(data.key!);
      copy.textContent = "Copied";
    });
    out.replaceChildren(
      el("p", { class: "keybox__key" }, el("code", {}, data.key), copy),
      el("p", { class: "fine" }, `Plan: ${data.plan}. It is already filled into the console below. New keys can take a few minutes to reach every API Gateway server; a 403 in that time is expected.`),
    );
    btn.textContent = "Key created";
  } catch (err) {
    out.replaceChildren(el("p", { class: "error" }, (err as Error).message));
    btn.disabled = false;
    btn.textContent = "Create my key";
  }
}

function init() {
  const sel = $<HTMLSelectElement>("ep");
  sel.append(...ENDPOINTS.map((e) => el("option", { value: e.id }, `${e.method} ${e.path}`)));
  sel.addEventListener("change", selectEndpoint);
  selectEndpoint();
  $<HTMLInputElement>("ep-key").value = store("ah-key");
  $("send").addEventListener("click", send);
  $("copy-curl").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(curl());
    (e.target as HTMLButtonElement).textContent = "Copied";
    setTimeout(() => ((e.target as HTMLButtonElement).textContent = "Copy as curl"), 1500);
  });
  $("key-form").addEventListener("submit", createKey);
  $("base-url").textContent = `${origin}/api/v1`;
  $("mcp-cmd").textContent = `claude mcp add --transport http after-hours ${origin}/api/mcp`;
  $("mcp-json").textContent = JSON.stringify({ mcpServers: { "after-hours": { command: "npx", args: ["-y", "mcp-remote", `${origin}/api/mcp`] } } }, null, 2);
}

init();
