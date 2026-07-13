// The MapLibre map instance plus its markers, 3D buildings, hillshade and the
// route line layers. No preference/shade logic lives here.
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { DEFAULT_CENTER, REDUCED, HEIGHT_EXAGGERATION, SHADE_OPACITY } from "./config.js";

// pmtiles:// protocol so MapLibre streams building vector tiles per viewport.
maplibregl.addProtocol("pmtiles", new Protocol().tile);

export const MAP_STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

// Initial theme: saved choice, else the OS preference. Set the attribute now so
// the panel paints themed from the first frame.
const savedTheme = (() => { try { return localStorage.getItem("stride.theme"); } catch { return null; } })();
const initialDark = savedTheme ? savedTheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = initialDark ? "dark" : "light";

export const map = new maplibregl.Map({
  container: "map",
  style: initialDark ? MAP_STYLES.dark : MAP_STYLES.light,
  center: [DEFAULT_CENTER.lon, DEFAULT_CENTER.lat],
  zoom: 13.2,
  pitch: 0,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
if (import.meta.env?.DEV) window.__map = map; // dev-only handle for debugging

let startMarker = null;
let endMarker = null;

export function ensureStartMarker(lon, lat) {
  if (!startMarker) {
    const el = document.createElement("div");
    el.className = "start-marker";
    startMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
  } else {
    startMarker.setLngLat([lon, lat]);
  }
}

// End marker only shown when a route does NOT close the loop.
export function setEndMarker(lonLat) {
  if (endMarker) {
    endMarker.remove();
    endMarker = null;
  }
  if (lonLat) {
    endMarker = new maplibregl.Marker({ color: "#b3402f", scale: 0.8 }).setLngLat(lonLat).addTo(map);
  }
}

// Destination (B) marker for A→B mode — persists once picked.
let destMarker = null;
export function setDestMarker(lonLat) {
  if (destMarker) {
    destMarker.remove();
    destMarker = null;
  }
  if (lonLat) {
    destMarker = new maplibregl.Marker({ color: "#b3402f" }).setLngLat(lonLat).addTo(map);
  }
}

// POI marker for the "Passar por" feature (amber).
let poiMarker = null;
export function setPoiMarker(lonLat) {
  if (poiMarker) {
    poiMarker.remove();
    poiMarker = null;
  }
  if (lonLat) {
    poiMarker = new maplibregl.Marker({ color: "#c77d1a" }).setLngLat(lonLat).addTo(map);
  }
}

// Live position dot during navigation (pulsing blue).
let navMarker = null;
export function setNavMarker(lonLat) {
  if (!lonLat) {
    if (navMarker) navMarker.remove();
    navMarker = null;
    return;
  }
  if (!navMarker) {
    const el = document.createElement("div");
    el.className = "nav-dot";
    navMarker = new maplibregl.Marker({ element: el }).setLngLat(lonLat).addTo(map);
  } else {
    navMarker.setLngLat(lonLat);
  }
}

function firstSymbolId() {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

const isDark = () => document.documentElement.dataset.theme === "dark";

function buildingColor(prop) {
  return isDark()
    ? ["interpolate", ["linear"], ["get", prop], 3, "#2c322d", 8, "#363c35", 16, "#454b3d", 30, "#565b46"]
    : ["interpolate", ["linear"], ["get", prop], 3, "#e7e1d4", 8, "#d8cdb8", 16, "#c2a988", 30, "#a98a6a"];
}

export function add3dBuildings() {
  // Hide OpenMapTiles' own flat building layer — we extrude instead.
  for (const layer of map.getStyle().layers) {
    if (layer.id.includes("building")) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }

  // Global fallback: extrude the basemap's own building footprints (keyless,
  // worldwide) so cities OUTSIDE the baked region still get 3D blocks. The
  // high-detail PMTiles below is drawn ON TOP for the home region (better
  // footprints from OSM + Microsoft ML, and it feeds the shadows).
  map.addLayer(
    {
      id: "stride-3d-buildings-global",
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 13,
      filter: ["!=", ["get", "hide_3d"], true],
      paint: {
        "fill-extrusion-color": buildingColor("render_height"),
        "fill-extrusion-height": ["*", ["coalesce", ["get", "render_height"], 3], HEIGHT_EXAGGERATION],
        "fill-extrusion-base": ["*", ["coalesce", ["get", "render_min_height"], 0], HEIGHT_EXAGGERATION],
        "fill-extrusion-opacity": 0.92,
        "fill-extrusion-vertical-gradient": true,
      },
    },
    firstSymbolId()
  );

  map.addSource("buildings", {
    type: "vector",
    url: `pmtiles://${location.origin}/buildings.pmtiles`,
  });
  map.addLayer(
    {
      id: "stride-3d-buildings",
      type: "fill-extrusion",
      source: "buildings",
      "source-layer": "buildings",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": isDark()
          ? ["interpolate", ["linear"], ["get", "h"], 3, "#2c322d", 8, "#363c35", 16, "#454b3d", 30, "#565b46"]
          : ["interpolate", ["linear"], ["get", "h"], 3, "#e7e1d4", 8, "#d8cdb8", 16, "#c2a988", 30, "#a98a6a"],
        "fill-extrusion-height": ["*", ["get", "h"], HEIGHT_EXAGGERATION],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.92,
        "fill-extrusion-vertical-gradient": true,
        "fill-extrusion-height-transition": { duration: REDUCED ? 0 : 800 },
      },
    },
    firstSymbolId()
  );
}

export function addHillshade() {
  // Terrain relief — the city sits at ~530 m with the Serra da Mantiqueira
  // around it. Open, keyless terrarium-encoded DEM tiles.
  try {
    map.addSource("dem", {
      type: "raster-dem",
      tiles: ["https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 15,
      attribution: "Elevation: Mapzen/AWS Terrain Tiles",
    });
    map.addLayer(
      {
        id: "hillshade",
        type: "hillshade",
        source: "dem",
        paint: isDark()
          ? {
              "hillshade-shadow-color": "#05070a",
              "hillshade-accent-color": "#0c0f0c",
              "hillshade-highlight-color": "#3d443d",
              "hillshade-exaggeration": 0.4,
            }
          : {
              "hillshade-shadow-color": "#5b5048",
              "hillshade-accent-color": "#6b5a48",
              "hillshade-highlight-color": "#fffdf7",
              "hillshade-exaggeration": 0.5,
            },
      },
      firstSymbolId()
    );
  } catch {
    // Optional — the map works without relief.
  }
}

export function initRouteLayers() {
  // Comparison route (regular profile) — slate dashed, under the main line.
  map.addSource("route-alt", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "route-alt-line",
    type: "line",
    source: "route-alt",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#5b6b60", "line-width": 4, "line-opacity": 0.75, "line-dasharray": [2, 1.5] },
  });

  // Main route — white casing + brand-green line.
  map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#1e7a4a", "line-width": 5, "line-opacity": 0.95 },
  });
}

export function clearAltRoute() {
  const src = map.getSource("route-alt");
  if (src) src.setData({ type: "FeatureCollection", features: [] });
}

// Walked-streets overlay ("your territory") — under the route lines.
export function initWalkedLayer() {
  map.addSource("walked", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "walked-fill",
    type: "fill",
    source: "walked",
    paint: { "fill-color": "#1e7a4a", "fill-opacity": 0.25 },
  });
}

export function setWalkedData(fc) {
  const src = map.getSource("walked");
  if (src) src.setData(fc);
}

// --- Real 3D trees ---------------------------------------------------------
// The region's dominant broadleaf, extruded like the buildings (a brown trunk +
// a rounded canopy) so they grow with zoom instead of shrinking like billboards.
// Positions arrive as compact points; we build the geometry once, client-side,
// to keep the payload small at high density.
function octaRing(lon, lat, rM) {
  const dLat = rM / 110540;
  const dLon = rM / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

// color group c: 0 = trunk, 1 = broadleaf canopy, 2 = conifer canopy
function box(lon, lat, r, base, h, c) {
  return { type: "Feature", properties: { c, base, h }, geometry: { type: "Polygon", coordinates: [octaRing(lon, lat, r)] } };
}

function buildTreeFC(trees) {
  const feats = [];
  for (let i = 0; i < trees.length; i++) {
    const [lon, lat, t] = trees[i];
    // deterministic per-tree variation (stable geometry across reloads)
    const r1 = ((i * 2654435761) % 1000) / 1000;
    const r2 = ((i * 40503 + 17) % 1000) / 1000;
    const r3 = ((i * 97 + 3) % 1000) / 1000;
    if (t === 1) {
      // conifer — a thin trunk under three tapering tiers (a stylised pine)
      const trunkH = 1.3 + r1 * 0.7;
      const total = 3.6 + r3 * 3.4;
      const canR = 1.7 + r2 * 1.1;
      const h1 = total * 0.5, h2 = total * 0.32, h3 = total * 0.18;
      feats.push(box(lon, lat, 0.34, 0, trunkH, 0));
      feats.push(box(lon, lat, canR, trunkH, trunkH + h1, 2));
      feats.push(box(lon, lat, canR * 0.66, trunkH + h1, trunkH + h1 + h2, 2));
      feats.push(box(lon, lat, canR * 0.34, trunkH + h1 + h2, trunkH + h1 + h2 + h3, 2));
    } else {
      // broadleaf — trunk + one rounded canopy
      const trunkH = 1.6 + r1 * 1.0;
      const canR = 2.0 + r2 * 2.0;
      const top = trunkH + 3.0 + r3 * 3.0;
      feats.push(box(lon, lat, 0.45, 0, trunkH, 0));
      feats.push(box(lon, lat, canR, trunkH, top, 1));
    }
  }
  return { type: "FeatureCollection", features: feats };
}

let treeFC = null; // cached so we don't rebuild geometry on every setStyle
export async function addTreeLayer() {
  if (!treeFC) {
    try {
      const { trees } = await fetch("/trees.json").then((r) => r.json());
      treeFC = buildTreeFC(trees);
    } catch {
      treeFC = { type: "FeatureCollection", features: [] };
    }
  }
  if (!map.getSource("trees")) map.addSource("trees", { type: "geojson", data: treeFC });
  if (!map.getLayer("trees")) {
    const trunk = isDark() ? "#4a3320" : "#6d4b2c";
    const broadleaf = isDark()
      ? ["interpolate", ["linear"], ["get", "h"], 4, "#2f5d38", 9, "#3f7a49"]
      : ["interpolate", ["linear"], ["get", "h"], 4, "#4f9e5a", 9, "#6cbf76"];
    const conifer = isDark() ? "#234f34" : "#2f7048";
    map.addLayer(
      {
        id: "trees",
        type: "fill-extrusion",
        source: "trees",
        minzoom: 13.5,
        paint: {
          "fill-extrusion-color": ["match", ["get", "c"], 0, trunk, 2, conifer, broadleaf],
          "fill-extrusion-base": ["*", ["get", "base"], HEIGHT_EXAGGERATION],
          "fill-extrusion-height": ["*", ["get", "h"], HEIGHT_EXAGGERATION],
          "fill-extrusion-opacity": 0.95,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      firstSymbolId()
    );
  }
}

// Dynamic shade — live-cast shadow polygons for areas outside the baked region
// (dynshade.js), on the ground beneath the buildings.
export function initDynShadeLayer() {
  if (!map.getSource("dyn-shade")) {
    map.addSource("dyn-shade", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  if (!map.getLayer("dyn-shade-fill")) {
    map.addLayer({
      id: "dyn-shade-fill",
      type: "fill",
      source: "dyn-shade",
      paint: { "fill-color": "#31456b", "fill-opacity": SHADE_OPACITY },
    }, map.getLayer("stride-3d-buildings-global") ? "stride-3d-buildings-global" : firstSymbolId());
  }
}

export function setDynShade(fc) {
  const src = map.getSource("dyn-shade");
  if (src) src.setData(fc || { type: "FeatureCollection", features: [] });
}

// Append live-fetched trees (Overpass, areas outside the baked region) to the
// same source/layer. Capped so panning across a big city can't grow unbounded.
const MAX_TREE_FEATURES = 90000; // ~2 features/tree → ~45k trees on screen budget
export function appendLiveTrees(pts) {
  if (!treeFC || !pts || !pts.length || treeFC.features.length >= MAX_TREE_FEATURES) return;
  treeFC.features.push(...buildTreeFC(pts).features);
  const src = map.getSource("trees");
  if (src) src.setData(treeFC);
}

// --- POI sky beacons -------------------------------------------------------
// For the selected "Passar por" type: a tall light column rising into the sky
// (world-3D, so it grows with zoom) topped by a big glowing icon floating above
// it (an HTML marker, always readable, pulsing). Blade-Runner / Pokémon-GO vibe.
export const POI_STYLE = {
  cafe: { emoji: "☕", color: "#f0a028", glow: "#ffcf7a" },
  viewpoint: { emoji: "⛰️", color: "#9b7bff", glow: "#c7b6ff" },
  water: { emoji: "💧", color: "#3aa6e6", glow: "#8fd4ff" },
  park: { emoji: "🌳", color: "#33b463", glow: "#8ff0b3" },
};
const BEAM_CORE_H = 230, BEAM_GLOW_H = 190; // metres — tall enough to read from afar

function beaconFC(features) {
  const feats = [];
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    const type = f.properties.type;
    feats.push({ type: "Feature", properties: { type, kind: 0, h: BEAM_GLOW_H }, geometry: { type: "Polygon", coordinates: [octaRing(lon, lat, 4.5)] } });
    feats.push({ type: "Feature", properties: { type, kind: 1, h: BEAM_CORE_H }, geometry: { type: "Polygon", coordinates: [octaRing(lon, lat, 1.4)] } });
  }
  return { type: "FeatureCollection", features: feats };
}

const beamColor = ["match", ["get", "type"], "cafe", POI_STYLE.cafe.color, "viewpoint", POI_STYLE.viewpoint.color, "water", POI_STYLE.water.color, "park", POI_STYLE.park.color, "#888"];
let _beaconFC = { type: "FeatureCollection", features: [] };

export function initPoiLayer() {
  if (!map.getSource("poi-beacons")) map.addSource("poi-beacons", { type: "geojson", data: _beaconFC });
  else map.getSource("poi-beacons").setData(_beaconFC);
  for (const [id, kind, opacity] of [["poi-beam-glow", 0, 0.16], ["poi-beam-core", 1, 0.5]]) {
    if (!map.getLayer(id)) {
      map.addLayer({
        id,
        type: "fill-extrusion",
        source: "poi-beacons",
        filter: ["==", ["get", "kind"], kind],
        paint: {
          "fill-extrusion-color": beamColor,
          "fill-extrusion-base": 0,
          "fill-extrusion-height": ["get", "h"],
          "fill-extrusion-opacity": opacity,
          "fill-extrusion-vertical-gradient": false,
        },
      });
    }
  }
}

let poiMarkers = [];
let poiOnPick = null;

function poiMarkerEl(type, name) {
  const st = POI_STYLE[type] || { emoji: "📍", color: "#888", glow: "#ccc" };
  const wrap = document.createElement("div");
  wrap.className = "poi-sky";
  wrap.style.setProperty("--c", st.color);
  wrap.style.setProperty("--glow", st.glow);
  wrap.innerHTML =
    `<div class="poi-sky-disc"><span class="poi-sky-halo"></span>${st.emoji}</div>` +
    (name ? `<div class="poi-sky-tag">${name}</div>` : "");
  return wrap;
}

// Show every POI of a type as a sky beacon; onPick(feature) fires on icon click.
export function setPoiBeacons(features, onPick) {
  poiOnPick = onPick || null;
  _beaconFC = beaconFC(features || []);
  const src = map.getSource("poi-beacons");
  if (src) src.setData(_beaconFC);
  for (const m of poiMarkers) m.remove();
  poiMarkers = (features || []).map((f) => {
    const el = poiMarkerEl(f.properties.type, f.properties.name);
    if (poiOnPick) el.addEventListener("click", (e) => { e.stopPropagation(); poiOnPick(f); });
    return new maplibregl.Marker({ element: el, offset: [0, -120] })
      .setLngLat(f.geometry.coordinates)
      .addTo(map);
  });
}

export function clearPoiBeacons() {
  _beaconFC = { type: "FeatureCollection", features: [] };
  const src = map.getSource("poi-beacons");
  if (src) src.setData(_beaconFC);
  for (const m of poiMarkers) m.remove();
  poiMarkers = [];
}
