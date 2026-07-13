// Shared constants for the Stride frontend.
export const GRAPHHOPPER_URL = "http://localhost:8989/route";
export const DEFAULT_CENTER = { lat: -22.8164, lon: -45.1927 }; // Guaratinguetá-SP
// Home = where the baked visuals live (trees.json / pois.geojson); Overpass
// streams live data outside it.
export const BBOX = { lonMin: -45.3, latMin: -22.92, lonMax: -45.08, latMax: -22.7 };
// Region = where the GraphHopper graph can route (the regional OSM extract:
// Guará microregion). Bigger than BBOX; used to gate "can we generate a walk here".
export const REGION = { lonMin: -45.5, latMin: -23.0, lonMax: -44.9, latMax: -22.55 };
export const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Vertical exaggeration for the 3D blocks — footprints are mostly 1-story houses
// (~4 m); a constant multiplier keeps relative heights honest while giving the
// city presence under the tilted camera.
export const HEIGHT_EXAGGERATION = 2.6;

// round_trip only targets a distance; try N seeds and keep a good one.
export const BEST_OF = 6;
// Shade routes POST a ~0.8 MB custom model per request, so fewer seeds when a
// per-request custom model is in play (best-of ×6 would fire 6 heavy POSTs).
export const BEST_OF_SHADE = 3;
export const DIST_BAND = 0.08; // candidates within +8pp of the best distance error qualify

// Cap the polygons sent in the per-request shade custom model — the largest
// shadows dominate coverage, so top-N by area keeps most of the effect for a
// fraction of the payload and per-edge polygon checks.
export const TOP_SHADE_POLYS = 100;

export const SHADE_OPACITY = 0.32;
export const CARDINAL = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
