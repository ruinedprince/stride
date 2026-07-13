// Client-side shadow projection — for areas OUTSIDE the baked region we don't
// have pre-computed shade, so we cast it live: take the building footprints in
// view, the real sun position for the spot/time, and sweep each footprint away
// from the sun to get its ground shadow. Works anywhere buildings render.

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Sun azimuth (from North, clockwise) + elevation (deg) for a place and time.
// Standard low-precision solar position (good to ~0.1°, plenty for shadows).
export function solarPosition(lat, lon, date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;                      // days since J2000
  let L = (280.460 + 0.9856474 * n) % 360; if (L < 0) L += 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const alpha = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  let gmst = (280.46061837 + 360.98564736629 * n) % 360; if (gmst < 0) gmst += 360;
  let ha = (gmst + lon) * RAD - alpha;           // local hour angle
  ha = Math.atan2(Math.sin(ha), Math.cos(ha));   // normalise to [-π, π]
  const latR = lat * RAD;
  const el = Math.asin(clamp(Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha), -1, 1));
  let az = Math.acos(clamp((Math.sin(decl) - Math.sin(el) * Math.sin(latR)) / (Math.cos(el) * Math.cos(latR)), -1, 1)) * DEG;
  if (Math.sin(ha) > 0) az = 360 - az;           // afternoon → western sky
  return { az, el: el * DEG };
}

// The sun position for a longitude at a "local solar hour" (0..24), so the
// time-of-day slider means the same thing anywhere, independent of the browser
// timezone. Uses today's (UTC) date.
export function sunForHour(lat, lon, hour) {
  const now = new Date();
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + (hour - lon / 15) * 3600000;
  return solarPosition(lat, lon, new Date(t));
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  const hull = lower.concat(upper);
  hull.push(hull[0]);
  return hull;
}

const MAX_SHADOW_M = 220; // clamp huge low-sun shadows

function ringAreaM2(ring, lat) {
  const mPerLon = 111320 * Math.cos(lat * RAD), mPerLat = 110540;
  let a = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1], [x2, y2] = ring[i];
    a += (x1 * mPerLon) * (y2 * mPerLat) - (x2 * mPerLon) * (y1 * mPerLat);
  }
  return Math.abs(a) / 2;
}

// buildings: [{ ring:[[lon,lat],...], height }]. Returns a shade FeatureCollection
// whose features carry an id + area_m2 so they can seed a routing custom model.
export function computeShadows(buildings, lat, sunAz, sunEl) {
  const feats = [];
  if (sunEl <= 3) return { type: "FeatureCollection", features: feats }; // sun down / grazing
  const tanEl = Math.tan(sunEl * RAD), azR = sunAz * RAD;
  const dirE = -Math.sin(azR), dirN = -Math.cos(azR);   // ground direction away from sun
  const mPerLon = 111320 * Math.cos(lat * RAD), mPerLat = 110540;
  for (const b of buildings) {
    const L = Math.min(MAX_SHADOW_M, b.height / tanEl);
    if (L < 1.5) continue;
    const offLon = (dirE * L) / mPerLon, offLat = (dirN * L) / mPerLat;
    const pts = [];
    for (const [x, y] of b.ring) { pts.push([x, y]); pts.push([x + offLon, y + offLat]); }
    const hull = convexHull(pts);
    if (hull.length >= 4) {
      feats.push({
        type: "Feature",
        id: "sh" + feats.length,
        properties: { area_m2: Math.round(ringAreaM2(hull, lat)) },
        geometry: { type: "Polygon", coordinates: [hull] },
      });
    }
  }
  return { type: "FeatureCollection", features: feats };
}
