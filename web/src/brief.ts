import "./styles/doc.css";
import "./styles/brief.css";
import { el, fmt, getJson, revealOnScroll } from "./common.ts";
import { decodeB64 } from "./time.ts";
import { T, langOf } from "./brief-i18n.ts";

const lang = langOf();
const t = T[lang];
/** Keeps the current language on every link between briefs. */
const withLang = (q: string) => (lang === "es" ? `${q}&lang=es` : q);

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

function weekGrid(pattern: Uint8Array, offset: number, label: string) {
  const grid = el("div", { class: "bweek", role: "img" });
  grid.setAttribute("aria-label", label);
  for (let d = 0; d < 7; d++) {
    const cells = el("span", { class: "bweek__cells" });
    for (let h = 0; h < 24; h++) cells.append(el("i", { class: pattern[offset + d * 24 + h] === 1 ? "o" : "" }));
    grid.append(el("span", { class: "bweek__row" }, el("span", { class: "bweek__day" }, t.days[d]), cells));
  }
  grid.append(el("span", { class: "bweek__row bweek__axis" }, el("span", {}), el("span", { class: "bweek__ticks" }, ...t.ticks.map((x) => el("span", {}, x)))));
  return grid;
}

function fact(term: string, value: string, note?: string) {
  return el("div", {}, el("dt", {}, term), el("dd", {}, value ? el("b", { class: "num" }, value) : null, note ? el("span", {}, note) : null));
}

function sheet(b: Brief, all: Brief[], schoolWeek: Uint8Array, es: Record<string, { summary: string; nextStep: string }>) {
  const live = `${location.origin}/map.html?t=6-21&school=${b.id}#relocation`;
  const i = all.findIndex((x) => x.id === b.id);
  const prev = all[i - 1], next = all[i + 1];
  const pick = el(
    "select",
    { class: "input brief-pick", ariaLabel: t.choose, onchange: (e: Event) => (location.search = withLang(`?id=${(e.target as HTMLSelectElement).value}`)) },
    ...all.map((x) => el("option", { value: x.id, selected: x.id === b.id }, `${x.rank}. ${x.name}`)),
  );
  const tools = el(
    "div",
    { class: "brief-tools wrap" },
    el("a", { class: "chip", href: "/brief.html" }, t.all),
    pick,
    prev ? el("a", { class: "chip", href: withLang(`?id=${prev.id}`) }, t.prev) : null,
    next ? el("a", { class: "chip", href: withLang(`?id=${next.id}`) }, t.next) : null,
    el("a", { class: "chip", href: live }, t.onMap),
    el("a", { class: "chip chip--lang", href: lang === "es" ? `?id=${b.id}` : `?id=${b.id}&lang=es`, hreflang: lang === "es" ? "en" : "es", title: t.otherTitle }, t.other),
    el("button", { type: "button", class: "button", onclick: () => print() }, t.print),
  );

  const options = el(
    "ol",
    { class: "bopts" },
    el(
      "li",
      {},
      el("b", {}, t.cabinet),
      t.cabinetText(b.aeds),
    ),
    b.altHost
      ? el(
          "li",
          {},
          el("b", {}, t.host),
          t.hostText(b.altHost.name, t.category(b.altHost.category), b.altHost.meters),
        )
      : el("li", {}, el("b", {}, t.noHost), t.noHostText),
  );

  const doc = el(
    "article",
    { class: "sheet" },
    el(
      "header",
      { class: "sheet__head" },
      el("h1", { id: "sheet-title" }, b.name),
      el("p", { class: "sheet__meta" }, t.meta(b.area, b.zip, b.aeds, b.rank, all.length)),
    ),
    el(
      "p",
      { class: "sheet__claim" },
      el("b", { class: "num" }, b.expectedCallsPerYear.toFixed(2)),
      el("span", {}, t.claim),
    ),
    el(
      "figure",
      { class: "sheet__map" },
      el("img", { src: lang === "es" ? b.map.replace(".webp", ".es.webp") : b.map, width: 960, height: 540, alt: t.mapAlt(b.name, b.altHost?.name ?? null) }),
      el(
        "figcaption",
        {},
        el("span", { class: "k k--school" }, t.kSchool),
        el("span", { class: "k k--area" }, t.kArea),
        b.altHost ? el("span", { class: "k k--host" }, t.kHost(b.altHost.name)) : null,
        el("span", { class: "k k--other" }, t.kOther),
      ),
    ),
    el(
      "div",
      { class: "sheet__cols" },
      el(
        "section",
        {},
        el("h2", { id: "wk" }, t.wk),
        weekGrid(schoolWeek, 0, t.wkLabel(b.openHours.schoolWeek)),
        el("p", { class: "sheet__small" }, t.wkNote(b.openHours.schoolWeek, b.openHours.summerWeek, b.hoursNote.split(". Move")[0])),
      ),
      el(
        "section",
        {},
        el("h2", { id: "nb" }, t.nb),
        el(
          "dl",
          { class: "bfacts" },
          fact(t.nearby, fmt.format(b.nearby.within400m), t.nearbyNote(b.nearby.open247, b.nearby.openSunday9pm)),
          fact(t.zipCalls(b.zip), fmt.format(b.zipCalls2025), t.zipNote),
          fact(t.where, "", b.where || t.notRecorded),
        ),
      ),
    ),
    el("section", { class: "sheet__fix" }, el("h2", { id: "fx" }, t.fx), options),
    b.debate
      ? el(
          "section",
          { class: "sheet__ai" },
          el("h2", { id: "ai" }, t.ai(t.verdict[b.debate.verdict] ?? b.debate.verdict)),
          el("p", {}, lang === "es" && es[b.id] ? es[b.id].summary : b.debate.summary.replace(/\s*\[E\d+\]/g, "")),
          el("p", { class: "sheet__small" }, t.aiNote(lang === "es" && es[b.id] ? es[b.id].nextStep : b.debate.nextStep.replace(/\s*\[E\d+\]/g, ""))),
        )
      : null,
    el(
      "section",
      { class: "sheet__next" },
      el("h2", { id: "nx" }, t.nx),
      el(
        "ol",
        { class: "bnext" },
        el("li", {}, el("b", {}, t.s1), t.s1t),
        el("li", {}, el("b", {}, t.s2), t.s2t),
        b.council
          ? el(
              "li",
              {},
              el("b", {}, t.s3(b.council.member, b.council.district)),
              t.s3t(b.council.district),
              el("a", { href: b.council.url }, b.council.url.replace(/^https:\/\//, "").replace(/\/$/, "")),
            )
          : el("li", {}, el("b", {}, t.s3none), t.s3noneT, el("a", { href: "https://council.nyc.gov/districts/" }, "council.nyc.gov/districts")),
      ),
    ),
    el(
      "section",
      { class: "sheet__unknown" },
      el("h2", { id: "uk" }, t.uk),
      el("p", {}, t.ukt),
    ),
    el(
      "footer",
      { class: "sheet__foot" },
      el("p", {}, t.sources),
      el("p", {}, `${t.live}: ${live.replace(/^https?:\/\//, "")}`),
      el("p", { class: "sheet__911" }, t.e911),
    ),
  );
  return [tools, el("div", { class: "sheet-wrap" }, doc)];
}

async function main() {
  const root = document.getElementById("brief-root")!;
  const id = new URLSearchParams(location.search).get("id");
  try {
    const [data, es] = await Promise.all([
      getJson<{ schoolWeek: string; briefs: Brief[] }>("/data/nyc/briefs.json"),
      lang === "es" ? getJson<{ briefs: Record<string, { summary: string; nextStep: string }> }>("/data/nyc/briefs-es.json").then((x) => x.briefs).catch(() => ({})) : Promise.resolve({}),
    ]);
    const all = data.briefs;
    const b = id && all.find((x) => x.id === id);
    if (b) {
      document.title = t.title(b.name);
      document.documentElement.lang = lang;
      document.body.classList.add("is-sheet");
      root.replaceChildren(...sheet(b, all, decodeB64(data.schoolWeek), es));
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
