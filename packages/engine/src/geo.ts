export type LonLat = [number, number];
export type Ring = LonLat[];
export type Polygon = Ring[]; // outer ring first, then holes
export type MultiPolygon = Polygon[];

const R = 6371008.8;
const rad = Math.PI / 180;

export function distanceMeters(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Degrees per metre near a latitude, for building grids and bounding boxes. */
export function degPerMeter(lat: number): { dLat: number; dLon: number } {
  return { dLat: 1 / 111_320, dLon: 1 / (111_320 * Math.cos(lat * rad)) };
}

function inRing(p: LonLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inPolygon(p: LonLat, poly: Polygon): boolean {
  if (!inRing(p, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(p, poly[k])) return false;
  return true;
}

export function inMultiPolygon(p: LonLat, mp: MultiPolygon): boolean {
  return mp.some((poly) => inPolygon(p, poly));
}

export function bboxOf(points: LonLat[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** A circle as a polygon, used as the walking catchment when no routed isoline is available. */
export function circle(center: LonLat, radiusM: number, steps = 32): Polygon {
  const { dLat, dLon } = degPerMeter(center[1]);
  const ring: Ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([center[0] + Math.cos(a) * radiusM * dLon, center[1] + Math.sin(a) * radiusM * dLat]);
  }
  return [ring];
}
