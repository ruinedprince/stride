// "Não repetir ruas" — turn the streets from saved walks into thin corridor
// polygons and hand them to GraphHopper as penalized areas, so new routes
// prefer streets you haven't walked yet (the discovery angle).
import { getWalks } from "./storage.js";

const HALF_W = 18; // corridor half-width in meters
const MIN_STEP = 40; // decimate walked geometry to ~40 m segments
const CAP = 120; // bound the custom-model size
const MY = 110540;

export function hasWalked() {
  return getWalks().length > 0;
}

// Keep points ~MIN_STEP apart so dense GH geometry doesn't explode into segments.
function decimate(coords) {
  if (coords.length < 2) return coords;
  const out = [coords[0]];
  let last = coords[0];
  for (const c of coords) {
    const mx = 111320 * Math.cos((last[1] * Math.PI) / 180);
    if (Math.hypot((c[0] - last[0]) * mx, (c[1] - last[1]) * MY) >= MIN_STEP) {
      out.push(c);
      last = c;
    }
  }
  const end = coords[coords.length - 1];
  if (out[out.length - 1] !== end) out.push(end);
  return out;
}

function corridorFeatures() {
  const feats = [];
  let idx = 0;
  for (const w of getWalks()) {
    const pts = decimate(w.coords || []);
    for (let i = 1; i < pts.length && feats.length < CAP; i++) {
      const [x1, y1] = pts[i - 1];
      const [x2, y2] = pts[i];
      const mx = 111320 * Math.cos((y1 * Math.PI) / 180);
      const dx = (x2 - x1) * mx, dy = (y2 - y1) * MY;
      const len = Math.hypot(dx, dy) || 1;
      const plon = ((-dy / len) * HALF_W) / mx; // perpendicular offset, in degrees
      const plat = ((dx / len) * HALF_W) / MY;
      const ring = [
        [x1 + plon, y1 + plat], [x2 + plon, y2 + plat],
        [x2 - plon, y2 - plat], [x1 - plon, y1 - plat],
        [x1 + plon, y1 + plat],
      ].map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]);
      feats.push({ type: "Feature", id: `avoid_${idx++}`, properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
    }
  }
  return feats;
}

// GraphHopper custom model that penalises edges inside the walked corridors.
export function avoidModel() {
  const feats = corridorFeatures();
  if (!feats.length) return null;
  const priority = feats.map((f, i) => ({ [i === 0 ? "if" : "else_if"]: `in_${f.id}`, multiply_by: 0.2 }));
  return { priority, areas: { type: "FeatureCollection", features: feats } };
}
