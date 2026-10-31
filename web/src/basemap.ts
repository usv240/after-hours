import type { StyleSpecification } from "maplibre-gl";

const KEY = import.meta.env.VITE_LOCATION_KEY as string | undefined;
const REGION = (import.meta.env.VITE_LOCATION_REGION as string | undefined) ?? "us-east-1";

/** Amazon Location Service Maps v2, dark monochrome. Without a key, a plain dark ground so the data still reads. */
export function basemapStyle(): string | StyleSpecification {
  if (KEY) return `https://maps.geo.${REGION}.amazonaws.com/v2/styles/Monochrome/descriptor?key=${KEY}&color-scheme=Dark`;
  return {
    version: 8,
    sources: {},
    layers: [{ id: "ground", type: "background", paint: { "background-color": "#161616" } }],
  };
}

export const HAS_BASEMAP = Boolean(KEY);
export const ATTRIBUTION = KEY ? "© AWS, © HERE" : "";
