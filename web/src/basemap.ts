import type { StyleSpecification } from "maplibre-gl";
import { mapPalette, theme } from "./theme.ts";

const KEY = import.meta.env.VITE_LOCATION_KEY as string | undefined;
const REGION = (import.meta.env.VITE_LOCATION_REGION as string | undefined) ?? "us-east-1";

/** Amazon Location Service Maps v2, monochrome, light or dark to match the page. Without a key, a plain ground so the data still reads. */
export function basemapStyle(): string | StyleSpecification {
  if (KEY) return `https://maps.geo.${REGION}.amazonaws.com/v2/styles/Monochrome/descriptor?key=${KEY}&color-scheme=${theme() === "dark" ? "Dark" : "Light"}`;
  return {
    version: 8,
    sources: {},
    layers: [{ id: "ground", type: "background", paint: { "background-color": mapPalette().ground } }],
  };
}

export const HAS_BASEMAP = Boolean(KEY);
export const ATTRIBUTION = KEY ? "© AWS, © HERE" : "";
