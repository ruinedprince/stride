// Shared constants for the Stride frontend.
export const GRAPHHOPPER_URL = "http://localhost:8989/route";
export const DEFAULT_CENTER = { lat: -22.8164, lon: -45.1927 }; // Guaratinguetá-SP
export const BBOX = { lonMin: -45.3, latMin: -22.92, lonMax: -45.08, latMax: -22.7 };
export const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Vertical exaggeration for the 3D blocks — footprints are mostly 1-story houses
// (~4 m); a constant multiplier keeps relative heights honest while giving the
// city presence under the tilted camera.
export const HEIGHT_EXAGGERATION = 2.6;

// round_trip only targets a distance; try N seeds and keep a good one.
export const BEST_OF = 6;
export const DIST_BAND = 0.08; // candidates within +8pp of the best distance error qualify

export const SHADE_OPACITY = 0.32;
export const CARDINAL = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
