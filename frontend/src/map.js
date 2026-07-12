// The MapLibre map instance plus its markers, 3D buildings, hillshade and the
// route line layers. No preference/shade logic lives here.
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { DEFAULT_CENTER, REDUCED, HEIGHT_EXAGGERATION } from "./config.js";

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

export function add3dBuildings() {
  // Hide OpenMapTiles' own sparse building layer — we replace it with the full
  // bbox footprints (OSM + Microsoft ML) that also cast the shadows.
  for (const layer of map.getStyle().layers) {
    if (layer.id.includes("building")) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }
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

// Decorative broadleaf trees (region's dominant leaf type) scattered in green
// areas, as camera-facing billboards that "stand up" under the tilted view.
const TREE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="60" viewBox="0 0 44 60">` +
  `<rect x="19" y="38" width="6" height="20" rx="2" fill="#6d4b2c"/>` +
  `<circle cx="13" cy="31" r="10" fill="#3f8f4e"/>` +
  `<circle cx="31" cy="31" r="11" fill="#2f6e3c"/>` +
  `<circle cx="22" cy="19" r="13" fill="#49a05a"/>` +
  `</svg>`;

function loadSvgImage(svg, w, h) {
  return new Promise((resolve) => {
    const img = new Image(w, h);
    img.onload = () => resolve(img);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// Floating POI badges — emoji-in-a-pin billboards for the selected "Passar por"
// type, standing above the ground under the tilted camera.
const POI_STYLE = {
  cafe: { emoji: "☕", ring: "#c77d1a" },
  viewpoint: { emoji: "⛰️", ring: "#7a5cff" },
  water: { emoji: "💧", ring: "#2b8fd6" },
  park: { emoji: "🌳", ring: "#1e7a4a" },
};

function poiBadgeImage({ emoji, ring }) {
  const S = 60, H = S + 14, cx = S / 2, cy = S / 2, r = S / 2 - 4;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = ring; // pointer stem
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy + r - 3);
  ctx.lineTo(cx + 7, cy + r - 3);
  ctx.lineTo(cx, H - 1);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath(); // white disc + colored ring
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.font = "30px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, cx, cy + 1);
  return ctx.getImageData(0, 0, S, H);
}

export function initPoiIcons() {
  for (const [type, st] of Object.entries(POI_STYLE)) {
    const id = "poi-" + type;
    if (!map.hasImage(id)) map.addImage(id, poiBadgeImage(st), { pixelRatio: 2 });
  }
  if (!map.getSource("pois")) {
    map.addSource("pois", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  if (!map.getLayer("pois")) {
    map.addLayer({
      id: "pois",
      type: "symbol",
      source: "pois",
      layout: {
        "icon-image": ["concat", "poi-", ["get", "type"]],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.55, 16.5, 0.95],
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "text-field": ["coalesce", ["get", "name"], ""],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 0.4],
        "text-optional": true,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": isDark() ? "#e8ede6" : "#2a2f2c",
        "text-halo-color": isDark() ? "#12140f" : "#ffffff",
        "text-halo-width": 1.6,
      },
    });
  }
}

export function setPoiIcons(features) {
  const src = map.getSource("pois");
  if (src) src.setData({ type: "FeatureCollection", features: features || [] });
}

export async function addTreeLayer() {
  if (!map.hasImage("tree")) {
    const img = await loadSvgImage(TREE_SVG, 44, 60);
    if (!map.hasImage("tree")) map.addImage("tree", img, { pixelRatio: 2 });
  }
  if (!map.getSource("trees")) {
    map.addSource("trees", { type: "geojson", data: "/trees.geojson" });
  }
  if (!map.getLayer("trees")) {
    map.addLayer({
      id: "trees",
      type: "symbol",
      source: "trees",
      minzoom: 14.5,
      layout: {
        "icon-image": "tree",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 14.5, 0.18, 17.5, 0.5],
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-opacity": 0.9 },
    });
  }
}
