/**
 * Light by default; dark when the visitor asks for it, remembered in localStorage. The head of every
 * page sets data-theme before first paint (partials/theme.html); this wires the header toggle and
 * tells the maps, which draw their own colours, to repaint.
 */
export type Theme = "light" | "dark";

const KEY = "ah-theme";
const GROUND: Record<Theme, string> = { light: "#fbfbf9", dark: "#121212" };

export const theme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function setTheme(t: Theme) {
  const root = document.documentElement;
  if (t === theme()) return;
  root.classList.add("theme-switching");
  root.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", GROUND[t]);
  syncToggle();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  dispatchEvent(new CustomEvent<Theme>("themechange", { detail: t }));
}

function syncToggle() {
  const b = document.getElementById("theme-toggle");
  if (!b) return;
  const dark = theme() === "dark";
  b.setAttribute("aria-pressed", String(dark));
  b.title = dark ? "Switch to the light theme" : "Switch to the dark theme";
}

/** The colours the maps paint with, composed per theme (not inverted): on paper the open green
 * deepens, dots take a white ring, and the walking route turns night blue, because yellow vanishes. */
export function mapPalette() {
  return theme() === "dark"
    ? {
        open: "#3ee08f", closed: "#e2453b", unknown: "#9a9a9a", unknownDot: "#8c8c8c",
        openFill: 0.55, closedFill: 0.14, unknownFill: 0.18, halo: 0.22,
        dotStroke: "#121212", fixedStroke: "#ffffff", regionLine: "#ffffff", regionLineOpacity: 0.12,
        route: "#ffd100", ground: "#161616",
      }
    : {
        open: "#0f9d58", closed: "#d93025", unknown: "#8a8a8a", unknownDot: "#8a8a8a",
        openFill: 0.42, closedFill: 0.16, unknownFill: 0.16, halo: 0.18,
        dotStroke: "#ffffff", fixedStroke: "#121212", regionLine: "#121212", regionLineOpacity: 0.14,
        route: "#1e4bd7", ground: "#ecece8",
      };
}

export type MapPalette = ReturnType<typeof mapPalette>;

const toggle = document.getElementById("theme-toggle");
if (toggle) {
  syncToggle();
  toggle.addEventListener("click", () => setTheme(theme() === "dark" ? "light" : "dark"));
}
