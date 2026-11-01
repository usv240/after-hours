import "./styles/doc.css";
import "./styles/brief.css";
import { el, fmt, getJson, revealOnScroll } from "./common.ts";
import { decodeB64 } from "./time.ts";

interface Brief {
  rank: number;
  id: string;
  name: string;
  zip: string;
  area: string;
  where: string;
  aeds: number;
  hoursNote: string;
  expectedCallsPerYear: number;
  zipCalls2025: number;
  openHours: { schoolWeek: number; summerWeek: number };
  nearby: { within400m: number; open247: number; openSunday9pm: number };
  altHost: { name: string; category: string; meters: number } | null;
  debate: { verdict: string; summary: string; nextStep: string } | null;
  council: { district: number; member: string | null; url: string } | null;
  map: string;
}

const VERDICT: Record<string, string> = {
  act: "Act",
  "act-with-conditions": "Act, with conditions",
  "investigate-first": "Investigate first",
  "do-not-act": "Do not act",
};
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function weekGrid(pattern: Uint8Array, offset: number, label: string) {
  const grid = el("div", { class: "bweek", role: "img" });
  grid.setAttribute("aria-label", label);
  for (let d = 0; d < 7; d++) {
    const cells = el("span", { class: "bweek__cells" });
    for (let h = 0; h < 24; h++) cells.append(el("i", { class: pattern[offset + d * 24 + h] === 1 ? "o" : "" }));
    grid.append(el("span", { class: "bweek__row" }, el("span", { class: "bweek__day" }, DAYS[d]), cells));
  }
  grid.append(el("span", { class: "bweek__row bweek__axis" }, el("span", {}), el("span", { class: "bweek__ticks" }, el("span", {}, "midnight"), el("span", {}, "6 AM"), el("span", {}, "noon"), el("span", {}, "6 PM"))));
  return grid;
}

function fact(term: string, value: string, note?: string) {
  return el("div", {}, el("dt", {}, term), el("dd", {}, value ? el("b", { class: "num" }, value) : null, note ? el("span", {}, note) : null));
}

function sheet(b: Brief, all: Brief[], schoolWeek: Uint8Array) {
  const live = `${location.origin}/map.html?t=6-21&school=${b.id}#relocation`;
  const i = all.findIndex((x) => x.id === b.id);
  const prev = all[i - 1], next = all[i + 1];
  const pick = el(
    "select",
    { class: "input brief-pick", ariaLabel: "Choose a school", onchange: (e: Event) => (location.search = `?id=${(e.target as HTMLSelectElement).value}`) },
    ...all.map((x) => el("option", { value: x.id, selected: x.id === b.id }, `${x.rank}. ${x.name}`)),
  );
  const tools = el(
    "div",
    { class: "brief-tools wrap" },
    el("a", { class: "chip", href: "/brief.html" }, "All 100 schools"),
    pick,
    prev ? el("a", { class: "chip", href: `?id=${prev.id}` }, "Previous") : null,
    next ? el("a", { class: "chip", href: `?id=${next.id}` }, "Next") : null,
    el("a", { class: "chip", href: live }, "Open on the map"),
    el("button", { type: "button", class: "button", onclick: () => print() }, "Print or save as PDF"),
  );

  const options = el(
    "ol",
    { class: "bopts" },
    el(
      "li",
      {},
      el("b", {}, "A cabinet on the street wall. "),
      `Move one of the school's ${b.aeds > 1 ? `${b.aeds} AEDs` : "AEDs"} into a weatherproof outdoor cabinet that can be opened at any hour, so the streets in the green area keep a defibrillator in reach after the building locks.`,
    ),
    b.altHost
      ? el(
          "li",
          {},
          el("b", {}, `A host that never closes. `),
          `${b.altHost.name}, a ${b.altHost.category}, is ${b.altHost.meters} m away and is normally staffed around the clock. An AED there, reachable from the street, would cover nights, weekends and summer.`,
        )
      : el("li", {}, el("b", {}, "No always-staffed building within 400 m. "), "Overture Maps lists no fire station, police station or hospital this close, so the street-wall cabinet is the practical option."),
  );

  const doc = el(
    "article",
    { class: "sheet" },
    el(
      "header",
      { class: "sheet__head" },
      el("h1", { id: "sheet-title" }, b.name),
      el("p", { class: "sheet__meta" }, `${b.area}, ZIP ${b.zip} · ${b.aeds} AED${b.aeds === 1 ? "" : "s"} registered · rank ${b.rank} of ${all.length} New York schools`),
    ),
    el(
      "p",
      { class: "sheet__claim" },
      el("b", { class: "num" }, b.expectedCallsPerYear.toFixed(2)),
      el("span", {}, "cardiac-arrest calls a year came from inside this school's two-minute walk at hours when every defibrillator in reach was locked."),
    ),
    el(
      "figure",
      { class: "sheet__map" },
      el("img", { src: b.map, width: 960, height: 540, alt: `Street map around ${b.name}: the school's AED, its two-minute walking area${b.altHost ? `, and ${b.altHost.name}` : ""}.` }),
      el(
        "figcaption",
        {},
        el("span", { class: "k k--school" }, "School AED"),
        el("span", { class: "k k--area" }, "Two-minute walk, routed on real streets"),
        b.altHost ? el("span", { class: "k k--host" }, `${b.altHost.name}, open 24/7`) : null,
        el("span", { class: "k k--other" }, "Other AEDs within 400 m"),
      ),
    ),
    el(
      "div",
      { class: "sheet__cols" },
      el(
        "section",
        {},
        el("h2", { id: "wk" }, "When its AED can be reached"),
        weekGrid(schoolWeek, 0, `Reachable ${b.openHours.schoolWeek} of 168 hours in a school-year week`),
        el("p", { class: "sheet__small" }, `${b.openHours.schoolWeek} of 168 hours in a school-year week, ${b.openHours.summerWeek} in a summer week. ${b.hoursNote.split(". Move")[0]}.`),
      ),
      el(
        "section",
        {},
        el("h2", { id: "nb" }, "The neighbourhood"),
        el(
          "dl",
          { class: "bfacts" },
          fact("Other AED locations within 400 m", fmt.format(b.nearby.within400m), `${b.nearby.open247} open around the clock, ${b.nearby.openSunday9pm} confirmed open at 9 PM on a Sunday`),
          fact(`Cardiac-arrest calls in ZIP ${b.zip}, 2025`, fmt.format(b.zipCalls2025), "FDNY dispatches, final call type ARREST"),
          fact("Where the AEDs are inside", "", b.where || "Not recorded"),
        ),
      ),
    ),
    el("section", { class: "sheet__fix" }, el("h2", { id: "fx" }, "Two ways to keep one in reach"), options),
    b.debate
      ? el(
          "section",
          { class: "sheet__ai" },
          el("h2", { id: "ai" }, `Two AI agents argued it: ${VERDICT[b.debate.verdict] ?? b.debate.verdict}`),
          el("p", {}, b.debate.summary.replace(/\s*\[E\d+\]/g, "")),
          el("p", { class: "sheet__small" }, `Suggested next step: ${b.debate.nextStep.replace(/\s*\[E\d+\]/g, "")} Amazon Bedrock, citing only the evidence on this page. Planning analysis, not advice.`),
        )
      : null,
    el(
      "section",
      { class: "sheet__next" },
      el("h2", { id: "nx" }, "What to do with this page"),
      el(
        "ol",
        { class: "bnext" },
        el("li", {}, el("b", {}, "See it after dark. "), "Walk past after 6 PM. The map assumes the doors are locked; an evening programme with someone at the door would change that."),
        el("li", {}, el("b", {}, "Ask the school. "), "The principal and the custodian engineer know where the AED is, whether the street wall can take a heated cabinet, and who would check it."),
        b.council
          ? el(
              "li",
              {},
              el("b", {}, `Bring it to ${b.council.member ? `Council Member ${b.council.member}` : `District ${b.council.district}`}. `),
              `City Council District ${b.council.district}. Council members fund school projects and can raise this with the Department of Education: `,
              el("a", { href: b.council.url }, b.council.url.replace(/^https:\/\//, "").replace(/\/$/, "")),
            )
          : el("li", {}, el("b", {}, "Bring it to your council member. "), "Council members fund school projects and can take this to the Department of Education: ", el("a", { href: "https://council.nyc.gov/districts/" }, "council.nyc.gov/districts")),
      ),
    ),
    el(
      "section",
      { class: "sheet__unknown" },
      el("h2", { id: "uk" }, "What this data cannot tell you"),
      el("p", {}, "The cost of a cabinet, the risk of vandalism, whether the school already lets people in after hours, and where in the ZIP code each call came from. FDNY publishes calls by ZIP code only, so the calls are spread evenly over its streets."),
    ),
    el(
      "footer",
      { class: "sheet__foot" },
      el("p", {}, "Sources: NYC AED Inventory and FDNY EMS dispatches (NYC Open Data); walking area and map from Amazon Location Service; nearby buildings from Overture Maps. Every figure is reproducible from the public repo."),
      el("p", {}, `Live view: ${live.replace(/^https?:\/\//, "")}`),
      el("p", { class: "sheet__911" }, "In an emergency, call 911 first. Dispatchers know where the AEDs are."),
    ),
  );
  return [tools, el("div", { class: "sheet-wrap" }, doc)];
}

async function main() {
  const root = document.getElementById("brief-root")!;
  const id = new URLSearchParams(location.search).get("id");
  try {
    const data = await getJson<{ schoolWeek: string; briefs: Brief[] }>("/data/nyc/briefs.json");
    const all = data.briefs;
    const b = id && all.find((x) => x.id === id);
    if (b) {
      document.title = `${b.name}: school AED brief | After Hours`;
      document.body.classList.add("is-sheet");
      root.replaceChildren(...sheet(b, all, decodeB64(data.schoolWeek)));
      return;
    }
    document.getElementById("brief-rows")!.replaceChildren(
      ...all.map((x) =>
        el(
          "tr",
          {},
          el("td", { class: "num" }, String(x.rank)),
          el(
            "td",
            {},
            el(
              "a",
              { class: "brief-row", href: `?id=${x.id}` },
              el("img", { src: x.map.replace(".webp", ".thumb.webp"), width: 192, height: 108, alt: "", loading: x.rank > 8 ? "lazy" : "eager" }),
              el("span", {}, el("b", {}, x.name), el("small", {}, `ZIP ${x.zip}`)),
            ),
          ),
          el("td", {}, x.area),
          el("td", { class: "num" }, x.expectedCallsPerYear.toFixed(2)),
          el("td", {}, x.altHost ? `${x.altHost.name}, ${x.altHost.meters} m` : "–"),
        ),
      ),
    );
    document.querySelectorAll("#brief-rows tr").forEach((tr, k) => k < 12 && tr.classList.add("rise"));
  } catch (e) {
    root.prepend(el("p", { class: "error wrap" }, `The briefs could not load: ${(e as Error).message}`));
  }
  revealOnScroll();
}

main();
