import "./styles/landing.css";
import { DAY_LONG, cityNow, fmt, getJson, hourLabel, revealOnScroll } from "./common.ts";

interface Summary {
  sites: number;
  headlineVariant: string;
  week: Record<string, Record<"school" | "summer", { open: number[]; unknown: number[] }>>;
  findings: { callsByHourOfDay: number[]; openLocationsByHourTuesday: number[]; calls: number };
  relocation: { top: { name: string; zip: string }[] };
}

const SVG = "http://www.w3.org/2000/svg";

function arc(r0: number, r1: number, a0: number, a1: number): string {
  // Angles in turns, 0 = top, clockwise.
  const p = (r: number, a: number) => [r * Math.sin(a * 2 * Math.PI), -r * Math.cos(a * 2 * Math.PI)].map((v) => v.toFixed(3)).join(" ");
  return `M${p(r1, a0)} A${r1} ${r1} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
}

function buildDial(s: Summary) {
  const dial = document.getElementById("dial")!;
  const outer = document.getElementById("dial-outer")!;
  const inner = document.getElementById("dial-inner")!;
  const labels = document.getElementById("dial-labels")!;
  const hand = document.getElementById("dial-hand")!;
  const now = cityNow("America/New_York");
  const season = now.month === 7 || now.month === 8 ? "summer" : "school";
  const week = s.week[s.headlineVariant][season];
  const day = now.day;
  const open = Array.from({ length: 24 }, (_, h) => week.open[day * 24 + h]);
  const calls = s.findings.callsByHourOfDay;
  const maxOpen = Math.max(...week.open);
  const maxCalls = Math.max(...calls);
  const gap = 0.0025;

  const segs = open.map((n, h) => {
    const a = document.createElementNS(SVG, "path");
    a.setAttribute("d", arc(70, 98, h / 24 + gap, (h + 1) / 24 - gap));
    a.setAttribute("class", "dial__seg dial__seg--aed");
    a.style.setProperty("--v", (n / maxOpen).toFixed(3));
    outer.append(a);
    const c = document.createElementNS(SVG, "path");
    c.setAttribute("d", arc(50, 66, h / 24 + gap, (h + 1) / 24 - gap));
    c.setAttribute("class", "dial__seg dial__seg--call");
    c.style.setProperty("--v", (calls[h] / maxCalls).toFixed(3));
    inner.append(c);
    return a;
  });
  for (const [h, text] of [[0, "midnight"], [6, "6 AM"], [12, "noon"], [18, "6 PM"]] as const) {
    const t = document.createElementNS(SVG, "text");
    const a = (h / 24) * 2 * Math.PI;
    t.setAttribute("x", (42 * Math.sin(a)).toFixed(2));
    t.setAttribute("y", (-42 * Math.cos(a)).toFixed(2));
    t.setAttribute("class", "dial__label");
    t.textContent = text;
    labels.append(t);
  }

  const whenEl = document.getElementById("readout-when")!;
  const openEl = document.getElementById("readout-open")!;
  const callsEl = document.getElementById("readout-calls")!;
  const callShare = (h: number) => calls[h] / s.findings.calls;
  let hour = now.hour;
  let shown = Number(openEl.textContent?.replace(/,/g, "")) || 0;

  const set = (h: number, isNow = false) => {
    hour = (h + 24) % 24;
    const angle = ((hour + 0.5) / 24) * 360;
    hand.setAttribute("transform", `rotate(${angle})`);
    segs.forEach((seg, i) => seg.classList.toggle("is-now", i === hour));
    whenEl.textContent = `${isNow ? "Right now in New York, " : ""}${DAY_LONG[day]}${season === "summer" ? " in summer" : ""}, ${hourLabel(hour)} to ${hourLabel((hour + 1) % 24)}`;
    const target = open[hour];
    const from = shown;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 380);
      const e = 1 - Math.pow(1 - k, 3);
      shown = Math.round(from + (target - from) * e);
      openEl.textContent = fmt.format(shown);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    callsEl.textContent = `${(callShare(hour) * 100).toFixed(1)}% of 2025's cardiac-arrest calls came in this hour of the day.`;
    dial.setAttribute("aria-valuenow", String(hour));
    dial.setAttribute("aria-valuetext", hourLabel(hour));
  };
  set(hour, true);

  const angleHour = (e: PointerEvent) => {
    const r = dial.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    const turns = (Math.atan2(x, -y) / (2 * Math.PI) + 1) % 1;
    return Math.floor(turns * 24);
  };
  let dragging = false;
  dial.addEventListener("pointerdown", (e) => {
    dragging = true;
    dial.setPointerCapture(e.pointerId);
    set(angleHour(e));
  });
  dial.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const h = angleHour(e);
    if (h !== hour) set(h);
  });
  dial.addEventListener("pointerup", () => (dragging = false));
  dial.addEventListener("pointercancel", () => (dragging = false));
  dial.addEventListener("keydown", (e) => {
    const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (delta) {
      e.preventDefault();
      set(hour + delta);
    } else if (e.key === "Home") set(0);
    else if (e.key === "End") set(23);
  });
}

function buildChart(s: Summary) {
  const fill = (id: string, values: number[]) => {
    const max = Math.max(...values);
    const host = document.getElementById(id)!;
    values.forEach((v, h) => {
      const bar = document.createElement("span");
      bar.style.height = `${Math.max(1.5, (100 * v) / max)}%`;
      bar.style.transitionDelay = `${h * 18}ms`;
      bar.title = `${hourLabel(h)}: ${fmt.format(v)}`;
      host.append(bar);
    });
  };
  fill("chart-calls", s.findings.callsByHourOfDay);
  fill("chart-aeds", s.findings.openLocationsByHourTuesday);
}

function buildNames(s: Summary) {
  const track = document.getElementById("names-track")!;
  const names = s.relocation.top.map((r) => r.name);
  for (let copy = 0; copy < 2; copy++)
    for (const n of names) {
      const span = document.createElement("span");
      span.textContent = n;
      track.append(span);
    }
}

async function main() {
  revealOnScroll();
  try {
    const s = await getJson<Summary>("/data/nyc/summary.json");
    buildDial(s);
    buildChart(s);
    buildNames(s);
  } catch (e) {
    console.error(e);
  }
}

main();
