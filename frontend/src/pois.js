// Points of interest (café, mirante, água, parque) for the "Passar por" feature.
import { haversine } from "./geo.js";

let pois = null;

export async function loadPois() {
  try {
    pois = await fetch("/pois.geojson").then((r) => r.json());
  } catch {
    pois = null;
  }
  return pois;
}

// Merge live-fetched POIs (Overpass, outside the baked region) into the pool,
// de-duplicated by rounded coordinate so overlapping fetches don't stack.
const seen = new Set();
export function addLivePois(features) {
  if (!pois) pois = { type: "FeatureCollection", features: [] };
  for (const f of features || []) {
    const [lon, lat] = f.geometry.coordinates;
    const key = f.properties.type + ":" + lon.toFixed(5) + "," + lat.toFixed(5);
    if (seen.has(key)) continue;
    seen.add(key);
    pois.features.push(f);
  }
}

// POIs of a type, nearest first, capped — for the floating map icons.
export function poisOfType(type, lat, lon, limit = 40) {
  if (!pois) return [];
  const feats = pois.features.filter((f) => f.properties.type === type);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    feats.sort((a, b) =>
      haversine(lat, lon, a.geometry.coordinates[1], a.geometry.coordinates[0]) -
      haversine(lat, lon, b.geometry.coordinates[1], b.geometry.coordinates[0]));
  }
  return feats.slice(0, limit);
}

// Nearest POI of a type to (lat, lon): { lon, lat, name, dist } or null.
export function nearestPoi(type, lat, lon) {
  if (!pois) return null;
  let best = null, bestD = Infinity;
  for (const f of pois.features) {
    if (f.properties.type !== type) continue;
    const [plon, plat] = f.geometry.coordinates;
    const d = haversine(lat, lon, plat, plon);
    if (d < bestD) {
      bestD = d;
      best = { lon: plon, lat: plat, name: f.properties.name, dist: d };
    }
  }
  return best;
}
