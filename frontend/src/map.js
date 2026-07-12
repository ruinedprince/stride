// The MapLibre map instance plus its markers, 3D buildings, hillshade and the
// route line layers. No preference/shade logic lives here.
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { DEFAULT_CENTER, REDUCED, HEIGHT_EXAGGERATION } from "./config.js";

// pmtiles:// protocol so MapLibre streams building vector tiles per viewport.
maplibregl.addProtocol("pmtiles", new Protocol().tile);

export const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
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

function firstSymbolId() {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

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
        "fill-extrusion-color": [
          "interpolate", ["linear"], ["get", "h"],
          3, "#e7e1d4",
          8, "#d8cdb8",
          16, "#c2a988",
          30, "#a98a6a",
        ],
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
        paint: {
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
