// Live navigation: follow the walker along a generated route, report progress /
// remaining / ETA, and flag when they drift off-route. Uses the Geolocation API
// (watchPosition); simulate() animates a virtual walker for demos/desktop.
import { haversine } from "./geo.js";

let route = null; // { coords:[[lon,lat]], cumM:[], totalM, timeMs }
let onUpdate = null;
let watchId = null;
let simTimer = null;

export function setRoute(ghPath) {
  const coords = ghPath.points.coordinates.map((c) => [c[0], c[1]]);
  const cumM = [0];
  for (let i = 1; i < coords.length; i++) {
    cumM.push(cumM[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  route = { coords, cumM, totalM: cumM[cumM.length - 1] || 0, timeMs: ghPath.time || 0 };
}

export function hasRoute() {
  return !!route;
}

// Snap a live position onto the route → { offBy, covered, remaining, frac, snap }.
export function progressAt(lon, lat) {
  if (!route) return null;
  const { coords, cumM, totalM } = route;
  const mx = 111320 * Math.cos((lat * Math.PI) / 180);
  const my = 110540;
  const px = lon * mx, py = lat * my;

  let best = { d: Infinity, seg: 1, along: 0, snap: coords[0] };
  for (let i = 1; i < coords.length; i++) {
    const ax = coords[i - 1][0] * mx, ay = coords[i - 1][1] * my;
    const bx = coords[i][0] * mx, by = coords[i][1] * my;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best.d) {
      best = { d, seg: i, along: t * Math.sqrt(len2), snap: [qx / mx, qy / my] };
    }
  }
  const covered = cumM[best.seg - 1] + best.along;
  return {
    offBy: best.d,
    covered,
    remaining: Math.max(0, totalM - covered),
    frac: totalM ? covered / totalM : 0,
    snap: best.snap,
  };
}

function etaMsFor(remaining) {
  const perM = route.totalM ? route.timeMs / route.totalM : 720; // fallback ~5 km/h
  return remaining * perM;
}

function emit(lon, lat, p) {
  onUpdate?.({ lon, lat, ...p, etaMs: etaMsFor(p.remaining) });
}

export function start(cb, errCb) {
  onUpdate = cb;
  if (!navigator.geolocation) {
    errCb?.(new Error("Geolocalização indisponível"));
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { longitude: lon, latitude: lat } = pos.coords;
      const p = progressAt(lon, lat);
      if (p) emit(lon, lat, p);
    },
    (err) => errCb?.(err),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 }
  );
}

// Virtual walker for demos — advances along the route by arc length. Speed is
// scaled so any route previews in ~40 s (it's a fast-forward, not real time).
export function simulate(cb, speedMps) {
  onUpdate = cb;
  const { coords, cumM, totalM } = route;
  const v = speedMps || Math.max(15, totalM / 40);
  let dist = 0;
  const stepMs = 100;
  simTimer = setInterval(() => {
    dist = Math.min(totalM, dist + (v * stepMs) / 1000);
    let i = 1;
    while (i < cumM.length && cumM[i] < dist) i++;
    let lon, lat;
    if (i >= cumM.length) {
      [lon, lat] = coords[coords.length - 1];
    } else {
      const t = (dist - cumM[i - 1]) / Math.max(1e-9, cumM[i] - cumM[i - 1]);
      lon = coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]);
      lat = coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]);
    }
    emit(lon, lat, {
      offBy: 0,
      covered: dist,
      remaining: totalM - dist,
      frac: totalM ? dist / totalM : 1,
      snap: [lon, lat],
    });
    if (dist >= totalM) {
      clearInterval(simTimer);
      simTimer = null;
      onUpdate?.({ done: true });
    }
  }, stepMs);
}

export function stop() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  if (simTimer) clearInterval(simTimer);
  watchId = null;
  simTimer = null;
  onUpdate = null;
}
