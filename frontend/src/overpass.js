// Live OSM fetch (keyless) for areas OUTSIDE the baked region — trees, green
// areas and POIs pulled from the Overpass API per viewport, so the map stays
// alive as you pan anywhere. Cached by coarse tile so each area is fetched once;
// a cooldown avoids hammering Overpass when it rate-limits.
import { BBOX } from "./config.js";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const TILE = 0.02;              // ~2.2 km tiles
const MAX_TILES = 9;           // per fetch (bounds the Overpass query size)
const PER_POLY = 180;          // scatter cap per green polygon
const PER_FETCH_TREES = 1800;  // scatter cap per fetch
const ROW_SPACING_M = 12;
const COOLDOWN_MS = 15000;

const done = new Set();        // tile keys already fetched
let cooldownUntil = 0;

// Small deterministic PRNG so live scatter is stable within a session.
let seed = 987654321;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

const DENSE = new Set(["wood", "forest"]);
const SPARSE = new Set(["grassland", "heath", "scrub", "meadow", "grass"]);
const PARK_LEISURE = new Set(["park", "garden", "nature_reserve", "recreation_ground", "dog_park"]);

function leafCode(t) { return t === "needleleaved" ? 1 : 0; }

function haversine(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function ringAreaM2(ring) {
  if (ring.length < 4) return 0;
  const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * Math.PI / 180;
  const mx = 111320 * Math.cos(lat0), my = 110540;
  let a = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1], [x2, y2] = ring[i];
    a += (x1 * mx) * (y2 * my) - (x2 * mx) * (y1 * my);
  }
  return Math.abs(a) / 2;
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function greenPerM2(tg) {
  if (DENSE.has(tg.natural) || DENSE.has(tg.landuse)) return 250;
  if (SPARSE.has(tg.natural) || SPARSE.has(tg.landuse)) return 1400;
  if (PARK_LEISURE.has(tg.leisure)) return 600;
  return null;
}

function fillType(leaf) {
  if (leaf === "needleleaved") return 1;
  if (leaf === "broadleaved") return 0;
  if (leaf === "mixed") return rnd() < 0.3 ? 1 : 0;
  return 0;
}

function poiFeature(type, lon, lat, tg) {
  return { type: "Feature", properties: { type, name: tg.name || "" }, geometry: { type: "Point", coordinates: [lon, lat] } };
}

function scatter(ring, tg, out) {
  const per = greenPerM2(tg);
  if (!per) return;
  const n = Math.min(PER_POLY, Math.floor(ringAreaM2(ring) / per));
  if (n < 1) return;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  let placed = 0, tries = 0;
  while (placed < n && tries < n * 20) {
    tries++;
    const lon = minX + rnd() * (maxX - minX), lat = minY + rnd() * (maxY - minY);
    if (inRing(lon, lat, ring)) { out.push([+lon.toFixed(6), +lat.toFixed(6), fillType(tg.leaf_type)]); placed++; }
  }
}

function sampleRow(geom, t, out) {
  let carry = 0;
  for (let i = 1; i < geom.length; i++) {
    const a = [geom[i - 1].lon, geom[i - 1].lat], b = [geom[i].lon, geom[i].lat];
    const seg = haversine(a, b);
    if (!seg) continue;
    let d = -carry;
    while (d < seg) {
      if (d >= 0) { const f = d / seg; out.push([+(a[0] + (b[0] - a[0]) * f).toFixed(6), +(a[1] + (b[1] - a[1]) * f).toFixed(6), t]); }
      d += ROW_SPACING_M;
    }
    carry = d - seg;
  }
}

function parse(elements) {
  const trees = [], pois = [];
  for (const el of elements) {
    const tg = el.tags || {};
    if (el.type === "node") {
      if (tg.natural === "tree") trees.push([el.lon, el.lat, leafCode(tg.leaf_type)]);
      else if (tg.amenity === "cafe") pois.push(poiFeature("cafe", el.lon, el.lat, tg));
      else if (tg.tourism === "viewpoint") pois.push(poiFeature("viewpoint", el.lon, el.lat, tg));
      else if (tg.amenity === "drinking_water") pois.push(poiFeature("water", el.lon, el.lat, tg));
      continue;
    }
    if (el.type === "way" && el.geometry) {
      if (tg.natural === "tree_row") { sampleRow(el.geometry, leafCode(tg.leaf_type), trees); continue; }
      if (greenPerM2(tg)) {
        const ring = el.geometry.map((p) => [p.lon, p.lat]);
        if (trees.length < PER_FETCH_TREES) scatter(ring, tg, trees);
        if (PARK_LEISURE.has(tg.leisure)) {
          const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
          const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
          pois.push(poiFeature("park", cx, cy, tg));
        }
      }
    }
  }
  return { trees, pois };
}

async function fetchOverpass(s, w, n, e) {
  const q = `[out:json][timeout:25];(` +
    `node["natural"="tree"](${s},${w},${n},${e});` +
    `way["natural"="tree_row"](${s},${w},${n},${e});` +
    `way["leisure"~"^(park|garden|nature_reserve|recreation_ground|dog_park)$"](${s},${w},${n},${e});` +
    `way["landuse"~"^(forest|grass|meadow|village_green)$"](${s},${w},${n},${e});` +
    `way["natural"~"^(wood|grassland|scrub|heath)$"](${s},${w},${n},${e});` +
    `node["amenity"="cafe"](${s},${w},${n},${e});` +
    `node["tourism"="viewpoint"](${s},${w},${n},${e});` +
    `node["amenity"="drinking_water"](${s},${w},${n},${e});` +
    `);out geom;`;
  const body = "data=" + encodeURIComponent(q);
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.elements) return j.elements;
    } catch { /* try next endpoint */ }
  }
  return null;
}

function tilesFor(bounds) {
  const tiles = [];
  const x0 = Math.floor(bounds.getWest() / TILE), x1 = Math.floor(bounds.getEast() / TILE);
  const y0 = Math.floor(bounds.getSouth() / TILE), y1 = Math.floor(bounds.getNorth() / TILE);
  for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) tiles.push([tx, ty]);
  return tiles;
}

// Fetch trees + POIs for any not-yet-seen tiles in the viewport. Returns
// { trees, pois } for the new tiles, or null when nothing new / on failure.
// onStart() fires right before a network request so the UI can show a hint.
export async function loadAround(bounds, onStart) {
  if (Date.now() < cooldownUntil) return null;
  const missing = tilesFor(bounds).filter(([tx, ty]) => {
    const k = tx + "_" + ty;
    if (done.has(k)) return false;
    const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
    if (cx >= BBOX.lonMin && cx <= BBOX.lonMax && cy >= BBOX.latMin && cy <= BBOX.latMax) {
      done.add(k); // home region is already baked
      return false;
    }
    return true;
  }).slice(0, MAX_TILES);
  if (!missing.length) return null;

  if (onStart) onStart();
  const s = Math.min(...missing.map((t) => t[1] * TILE));
  const n = Math.max(...missing.map((t) => (t[1] + 1) * TILE));
  const w = Math.min(...missing.map((t) => t[0] * TILE));
  const e = Math.max(...missing.map((t) => (t[0] + 1) * TILE));
  const elements = await fetchOverpass(s, w, n, e);
  if (!elements) { cooldownUntil = Date.now() + COOLDOWN_MS; return null; }
  missing.forEach(([tx, ty]) => done.add(tx + "_" + ty));
  return parse(elements);
}
