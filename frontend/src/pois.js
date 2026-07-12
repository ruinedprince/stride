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
