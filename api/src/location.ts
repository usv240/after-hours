import { GeoRoutesClient, CalculateRouteMatrixCommand, CalculateRoutesCommand, CalculateIsolinesCommand } from "@aws-sdk/client-geo-routes";
import { GeoPlacesClient, GeocodeCommand, ReverseGeocodeCommand, SearchTextCommand } from "@aws-sdk/client-geo-places";
import type { LonLat } from "@after-hours/engine";

const routes = new GeoRoutesClient({});
const places = new GeoPlacesClient({});

/** Walking seconds from one point to many AEDs, by Amazon Location Route Matrix (Pedestrian). */
export async function walkingSeconds(from: LonLat, to: LonLat[]): Promise<(number | null)[]> {
  if (!to.length) return [];
  const res = await routes.send(
    new CalculateRouteMatrixCommand({
      Origins: [{ Position: from }],
      Destinations: to.map((p) => ({ Position: p })),
      TravelMode: "Pedestrian",
      RoutingBoundary: { Unbounded: true },
    }),
  );
  return (res.RouteMatrix?.[0] ?? []).map((e) => (e?.Error ? null : e?.Duration ?? null));
}

/** The walking line itself, for drawing on the map. */
export async function walkingRoute(from: LonLat, to: LonLat): Promise<{ line: LonLat[]; seconds: number; meters: number } | null> {
  const res = await routes.send(
    new CalculateRoutesCommand({ Origin: from, Destination: to, TravelMode: "Pedestrian", LegGeometryFormat: "Simple" }),
  );
  const route = res.Routes?.[0];
  if (!route) return null;
  const line = (route.Legs ?? []).flatMap((l) => (l.Geometry?.LineString ?? []) as LonLat[]);
  return { line, seconds: route.Summary?.Duration ?? 0, meters: route.Summary?.Distance ?? 0 };
}

export async function isolines(points: LonLat[], seconds: number): Promise<({ type: "MultiPolygon"; coordinates: unknown } | null)[]> {
  return Promise.all(
    points.map(async (p) => {
      try {
        const res = await routes.send(
          new CalculateIsolinesCommand({ Origin: p, Thresholds: { Time: [seconds] }, TravelMode: "Pedestrian", IsolineGeometryFormat: "Simple" }),
        );
        const polys = (res.Isolines?.[0]?.Geometries ?? []).map((g) => g.Polygon).filter(Boolean);
        return polys.length ? { type: "MultiPolygon" as const, coordinates: polys } : null;
      } catch {
        return null;
      }
    }),
  );
}

/** Named places (a station, museum, park) inside a box: Places SearchText finds landmarks the address geocoder misses. */
export async function searchPlace(q: string, box: [number, number, number, number]) {
  const res = await places.send(new SearchTextCommand({ QueryText: q.slice(0, 200), Filter: { BoundingBox: box }, MaxResults: 5, IntendedUse: "SingleUse" }));
  return (res.ResultItems ?? [])
    .filter((it) => it.Position)
    .map((it) => ({ lon: it.Position![0], lat: it.Position![1], label: it.Title ?? q, type: it.PlaceType, state: it.Address?.Region?.Code, county: it.Address?.SubRegion?.Name }));
}

/** The street address at a point ("1060 Grand Concourse, Bronx"), the first thing a caller tells a dispatcher. */
export async function addressAt(p: LonLat): Promise<string | null> {
  const res = await places.send(new ReverseGeocodeCommand({ QueryPosition: p, MaxResults: 1, IntendedUse: "SingleUse" }));
  const a = res.ResultItems?.[0]?.Address;
  if (!a) return null;
  const street = [a.AddressNumber, a.Street].filter(Boolean).join(" ");
  const place = a.District ?? a.Locality ?? a.SubRegion?.Name;
  return [street || res.ResultItems?.[0]?.Title, place].filter(Boolean).join(", ") || null;
}

export async function geocode(queries: string[], bias?: LonLat) {
  return Promise.all(
    queries.map(async (q) => {
      try {
        const res = await places.send(new GeocodeCommand({ QueryText: q.slice(0, 200), BiasPosition: bias, MaxResults: 1, IntendedUse: "SingleUse" }));
        const it = res.ResultItems?.[0];
        return it?.Position
          ? { query: q, lon: it.Position[0], lat: it.Position[1], label: it.Title ?? q, type: it.PlaceType, state: it.Address?.Region?.Code, county: it.Address?.SubRegion?.Name }
          : { query: q, error: "No match" };
      } catch (e) {
        return { query: q, error: (e as Error).name };
      }
    }),
  );
}
