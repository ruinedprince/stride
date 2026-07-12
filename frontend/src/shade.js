// Preference state and everything shade/sun/green: the baked-hour model, the
// continuous sun interpolation, the two-layer shade cross-dissolve, the sun arc,
// and how a preference maps to a GraphHopper routing spec.
import { map } from "./map.js";
import { CARDINAL, SHADE_OPACITY } from "./config.js";
import { fmtHour } from "./ui.js";

// Shade is pre-baked at whole hours (build_shade_areas.py); shade-index.json
// lists each baked hour with the real sun azimuth/elevation.
export let BAKED_HOURS = [9, 12, 15]; // replaced by the manifest on load
export const SUN_BY_HOUR = {
  9: { az: 47.7, el: 25.8 }, 12: { az: 1.6, el: 44.2 }, 15: { az: 314.1, el: 27.6 },
};

export let pref = "none"; // none | green | shade
export let hour = 15; // continuous 8..17 while pref === shade
export function setPref(p) { pref = p; }
export function setHour(h) { hour = h; }

let greenAreas = null;
export function getGreenAreas() { return greenAreas; }

const shadeCache = {}; // integer hour -> geojson FeatureCollection
const shadeModelCache = {}; // integer hour -> GraphHopper custom_model (built from geojson)
let aHour = null, bHour = null;

export function nearestBaked(h) {
  return BAKED_HOURS.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
}

// The two baked hours bracketing the slider position.
export function bracket(h) {
  const lo = [...BAKED_HOURS].reverse().find((x) => x <= h) ?? BAKED_HOURS[0];
  const hi = BAKED_HOURS.find((x) => x >= h) ?? BAKED_HOURS[BAKED_HOURS.length - 1];
  return [lo, hi];
}

// Continuous sun az/el interpolated between the bracketing baked hours.
// Azimuth is unwrapped so it doesn't jump across 360→0 at noon.
export function sunAt(h) {
  const [lo, hi] = bracket(h);
  const a = SUN_BY_HOUR[lo], b = SUN_BY_HOUR[hi];
  if (!a || !b) return a || b || { az: 0, el: 30 };
  if (lo === hi) return a;
  const t = (h - lo) / (hi - lo);
  let az0 = a.az, az1 = b.az;
  if (Math.abs(az1 - az0) > 180) az1 += az1 < az0 ? 360 : -360;
  return { az: (az0 + (az1 - az0) * t + 360) % 360, el: a.el + (b.el - a.el) * t };
}

function shadeHour() {
  return nearestBaked(hour);
}

export function activeShade() {
  return pref === "shade" ? shadeCache[shadeHour()] || null : null;
}

export function prefCollection() {
  if (pref === "green") return greenAreas;
  return activeShade();
}

// green → static foot_green profile; shade → foot + per-request custom model;
// none → plain foot.
export function routingSpec() {
  if (pref === "green") return { profile: "foot_green", customModel: null };
  if (pref === "shade") return { profile: "foot", customModel: shadeModelCache[shadeHour()] || null };
  return { profile: "foot", customModel: null };
}

export function prefLabel() {
  if (pref === "green") return "verde";
  if (pref === "shade") return `sombra ${fmtHour(hour)}`;
  return "";
}

// Custom model from a shade display geojson — polygons become `areas`, edges
// outside them get priority × 0.3 (verified identical to shade_<h>.json).
function buildShadeModel(fc) {
  const priority = fc.features.map((f, i) => ({
    [i === 0 ? "if" : "else_if"]: `in_${f.id}`,
    multiply_by: 1.0,
  }));
  priority.push({ else: "", multiply_by: 0.3 });
  return { priority, areas: { type: "FeatureCollection", features: fc.features } };
}

export async function ensureShade(h) {
  if (shadeCache[h] !== undefined) return shadeCache[h];
  try {
    const fc = await fetch(`/shade-${h}.geojson`).then((r) => r.json());
    shadeCache[h] = fc;
    shadeModelCache[h] = buildShadeModel(fc);
    if (fc.properties?.sun_azimuth_deg != null) {
      SUN_BY_HOUR[h] = { az: fc.properties.sun_azimuth_deg, el: fc.properties.sun_elevation_deg };
    }
  } catch {
    shadeCache[h] = null;
  }
  return shadeCache[h];
}

// Cross-dissolve the shade overlay to the slider position (two cheap opacity
// writes per tick when both bracket hours are cached).
export function updateShadeBlend() {
  const [lo, hi] = bracket(hour);
  const frac = hi > lo ? (hour - lo) / (hi - lo) : 0;
  const paint = () => {
    if (aHour !== lo && shadeCache[lo]) { map.getSource("shade-a").setData(shadeCache[lo]); aHour = lo; }
    if (bHour !== hi && shadeCache[hi]) { map.getSource("shade-b").setData(shadeCache[hi]); bHour = hi; }
    map.setPaintProperty("shade-a-fill", "fill-opacity", SHADE_OPACITY * (1 - frac));
    map.setPaintProperty("shade-b-fill", "fill-opacity", SHADE_OPACITY * frac);
  };
  if (shadeCache[lo] !== undefined && shadeCache[hi] !== undefined) {
    paint();
  } else {
    Promise.all([ensureShade(lo), ensureShade(hi)]).then(paint);
  }
}

// --- sun visuals -------------------------------------------------------------
export function setSunLight(hourOrNull) {
  if (hourOrNull != null) {
    const { az, el } = sunAt(hourOrNull);
    map.setLight({ anchor: "map", position: [1.3, az, 90 - el], intensity: 0.35 });
  } else {
    map.setLight({ anchor: "viewport", position: [1.15, 210, 30], intensity: 0.25 });
  }
}

function sunColor(el) {
  const t = Math.max(0, Math.min(1, el / 45));
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  const low = [210, 105, 30], high = [242, 169, 59]; // #d2691e → #f2a93b
  return `rgb(${lerp(low[0], high[0])}, ${lerp(low[1], high[1])}, ${lerp(low[2], high[2])})`;
}

export function updateSunArc() {
  const { az, el } = sunAt(hour);
  const x = 20 + 160 * ((hour - 7) / 10); // 7h left → 17h right
  const y = 92 - 80 * Math.max(0, Math.min(1, el / 50));
  document.getElementById("sun-dot").style.transform = `translate(${x}px, ${y}px)`;
  const dir = CARDINAL[Math.round(az / 45) % 8];
  document.getElementById("sun-info").textContent =
    `${fmtHour(hour)} · sol a ${dir}, ${Math.round(el)}° acima do horizonte`;
}

export function applySunVisuals() {
  document.documentElement.style.setProperty("--sun", sunColor(sunAt(hour).el));
  setSunLight(hour);
  updateSunArc();
}

export async function applyPreferenceOverlays() {
  const isShade = pref === "shade";
  if (isShade) {
    const [lo, hi] = bracket(hour);
    await Promise.all([ensureShade(lo), ensureShade(hi)]);
    updateShadeBlend();
  }
  for (const layer of ["green-fill", "green-outline"]) {
    if (map.getLayer(layer)) {
      map.setLayoutProperty(layer, "visibility", pref === "green" ? "visible" : "none");
    }
  }
  for (const layer of ["shade-a-fill", "shade-b-fill"]) {
    if (map.getLayer(layer)) {
      map.setLayoutProperty(layer, "visibility", isShade ? "visible" : "none");
    }
  }
  document.getElementById("sun-arc").hidden = !isShade;
  if (isShade) {
    applySunVisuals();
  } else {
    document.documentElement.style.removeProperty("--sun");
    setSunLight(null);
  }
}

// --- one-time map setup ------------------------------------------------------
export function initShadeLayers() {
  // Two layers cross-dissolve between the baked hours bracketing the slider.
  for (const id of ["shade-a", "shade-b"]) {
    map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: `${id}-fill`,
      type: "fill",
      source: id,
      layout: { visibility: "none" },
      paint: { "fill-color": "#31456b", "fill-opacity": 0 },
    });
  }
}

export async function initGreenOverlay() {
  try {
    greenAreas = await fetch("/green-areas.geojson").then((r) => r.json());
    map.addSource("green-areas", { type: "geojson", data: greenAreas });
    map.addLayer({
      id: "green-fill",
      type: "fill",
      source: "green-areas",
      layout: { visibility: "none" },
      paint: { "fill-color": "#2f9e44", "fill-opacity": 0.16 },
    });
    map.addLayer({
      id: "green-outline",
      type: "line",
      source: "green-areas",
      layout: { visibility: "none" },
      paint: { "line-color": "#2f9e44", "line-opacity": 0.45, "line-width": 1 },
    });
  } catch {
    // Overlay is optional — routing still works without it.
  }
}

// Manifest: which hours exist + their real sun position. Returns the sorted
// hours (caller wires the slider bounds).
export async function loadManifest() {
  try {
    const idx = await fetch("/shade-index.json").then((r) => r.json());
    if (!Array.isArray(idx.hours) || !idx.hours.length) return null;
    BAKED_HOURS = idx.hours.map((e) => e.h).sort((a, b) => a - b);
    for (const e of idx.hours) SUN_BY_HOUR[e.h] = { az: e.az, el: e.el };
    return BAKED_HOURS;
  } catch {
    return null; // falls back to the built-in 9/12/15
  }
}
