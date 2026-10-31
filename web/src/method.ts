import "./styles/doc.css";
import { el, fmt } from "./common.ts";

interface Changes {
  refreshedAt: string;
  snapshotDate: string;
  previousSnapshot: string | null;
  snapshotsKept: number;
  locations: number;
  added: number;
  removed: number;
  addedExamples: string[];
}

async function watch() {
  const box = document.getElementById("watch-box")!;
  try {
    const res = await fetch("/data/nyc/changes.json", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const c = (await res.json()) as Changes;
    const when = new Date(c.refreshedAt).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
    box.replaceChildren(
      el(
        "dl",
        {},
        el("div", {}, el("dt", {}, "Locations tonight"), el("dd", { class: "num" }, fmt.format(c.locations))),
        el("div", {}, el("dt", {}, "Added since last snapshot"), el("dd", { class: "num" }, c.previousSnapshot ? fmt.format(c.added) : "–")),
        el("div", {}, el("dt", {}, "Removed"), el("dd", { class: "num" }, c.previousSnapshot ? fmt.format(c.removed) : "–")),
        el("div", {}, el("dt", {}, "Snapshots kept"), el("dd", { class: "num" }, fmt.format(c.snapshotsKept))),
      ),
      el(
        "p",
        { class: "fine" },
        `Last run ${when} New York time${c.previousSnapshot ? `, compared with ${c.previousSnapshot}` : ", the first snapshot, so there is nothing to compare yet"}.${c.addedExamples.length ? ` New: ${c.addedExamples.slice(0, 3).join("; ")}.` : ""}`,
      ),
    );
  } catch {
    box.replaceChildren(el("p", { class: "fine" }, "The nightly snapshot has not run yet on this copy of the site."));
  }
}

watch();
