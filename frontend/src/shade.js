// Preference state and everything shade/sun/green. Shade is now cast live
// everywhere (dynshade.js) — no baked-hour anchor. The current shadow polygons
// (computed by main from the buildings in view) are handed here via
// setActiveShade and drive both the map overlay and shade-aware routing.
import { map } from "./map.js";
import { CARDINAL, SHADE_OPACITY, TOP_SHADE_POLYS } from "./config.js";
import { fmtHour } from "./ui.js";
import { sunForHour } from "./dynshade.js";

export let pref = "none"; // none | green | shade
export let hour = 15; // continuous local solar hour while pref === shade
export function setPref(p) { pref = p; }
export function setHour(h) { hour = h; }

let greenAreas = null;
export function getGreenAreas() { return greenAreas; }

// The live-cast shadow polygons for the current view/time (set by main.js).
let shadeFC = { type: "FeatureCollection", features: [] };
export function setActiveShade(fc) { shadeFC = fc || { type: "FeatureCollection", features: [] }; }

export function activeShade() {
  return pref === "shade" ? shadeFC : null;
}

export function prefCollection() {
  if (pref === "green") return greenAreas;
  return activeShade();
}

// green → static foot_green profile; shade → foot + per-request custom model
// built from the live shadows; none → plain foot.
export function routingSpec() {
  if (pref === "green") return { profile: "foot_green", customModel: null };
  if (pref === "shade") return { profile: "foot", customModel: shadeFC.features.length ? buildShadeModel(shadeFC) : null };
  return { profile: "foot", customModel: null };
}

export function prefLabel() {
  if (pref === "green") return "verde";
  if (pref === "shade") return `sombra ${fmtHour(hour)}`;
  return "";
}

// The current preference as a per-request custom model (client-side), so it can
// be merged with the "avoid walked" model.
export function prefModel() {
  if (pref === "green") return greenAreas ? buildShadeModel(greenAreas) : null;
  if (pref === "shade") return shadeFC.features.length ? buildShadeModel(shadeFC) : null;
  return null;
}

// Custom model from a shade/green display geojson — polygons become `areas`,
// edges outside them get priority × 0.3. Only the largest TOP_SHADE_POLYS
// polygons go in the per-request model (payload/speed).
function buildShadeModel(fc) {
  const feats = [...fc.features]
    .sort((a, b) => (b.properties?.area_m2 || 0) - (a.properties?.area_m2 || 0))
    .slice(0, TOP_SHADE_POLYS);
  const priority = feats.map((f, i) => ({
    [i === 0 ? "if" : "else_if"]: `in_${f.id}`,
    multiply_by: 1.0,
  }));
  priority.push({ else: "", multiply_by: 0.3 });
  return { priority, areas: { type: "FeatureCollection", features: feats } };
}

// --- sun visuals -------------------------------------------------------------
// Real sun position for the current view centre and slider hour.
function currentSun() {
  const c = map.getCenter();
  return sunForHour(c.lat, c.lng, hour);
}

export function setSunLight(on) {
  if (on) {
    const { az, el } = currentSun();
    map.setLight({ anchor: "map", position: [1.3, az, 90 - Math.max(0, el)], intensity: 0.35 });
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
  const { az, el } = currentSun();
  const x = 20 + 160 * Math.max(0, Math.min(1, (hour - 6) / 12)); // 6h left → 18h right
  const y = 92 - 80 * Math.max(0, Math.min(1, el / 50));
  document.getElementById("sun-dot").style.transform = `translate(${x}px, ${y}px)`;
  const info = document.getElementById("sun-info");
  if (el < 0) {
    info.textContent = `${fmtHour(hour)} · sol abaixo do horizonte`;
  } else {
    const dir = CARDINAL[Math.round(az / 45) % 8];
    info.textContent = `${fmtHour(hour)} · sol a ${dir}, ${Math.round(el)}° acima do horizonte`;
  }
}

export function applySunVisuals() {
  document.documentElement.style.setProperty("--sun", sunColor(currentSun().el));
  setSunLight(true);
  updateSunArc();
}

export async function applyPreferenceOverlays() {
  const isShade = pref === "shade";
  for (const layer of ["green-fill", "green-outline"]) {
    if (map.getLayer(layer)) {
      map.setLayoutProperty(layer, "visibility", pref === "green" ? "visible" : "none");
    }
  }
  document.getElementById("sun-arc").hidden = !isShade;
  if (isShade) {
    applySunVisuals();
  } else {
    document.documentElement.style.removeProperty("--sun");
    setSunLight(false);
  }
}

// --- one-time map setup ------------------------------------------------------
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
