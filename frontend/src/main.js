// App wiring: the map-load setup sequence, DOM event handlers, and init.
import { map, MAP_STYLES, add3dBuildings, addHillshade, initRouteLayers, initWalkedLayer, setWalkedData, addTreeLayer, appendLiveTrees, initPoiLayer, setPoiBeacons, clearPoiBeacons, initDynShadeLayer, setDynShade, ensureStartMarker, setDestMarker, setPoiMarker, setNavMarker, clearAltRoute } from "./map.js";
import { sunForHour, computeShadows } from "./dynshade.js";
import { REDUCED, DEFAULT_CENTER, REGION } from "./config.js";
import { fractionIn } from "./geo.js";
import { setStatus, setBusy, fmtKm, fmtDuration } from "./ui.js";
import { generateRoute, generateFaithful, generatePointToPoint, generateLoopVia } from "./routing.js";
import { drawRoute } from "./render.js";
import * as pref from "./shade.js";
import { fetchWeather, suggest } from "./weather.js";
import { MOODS } from "./intent.js";
import { loadPois, poisOfType, addLivePois } from "./pois.js";
import * as overpass from "./overpass.js";
import * as nav from "./navigation.js";
import { getWalks, saveWalk, deleteWalk, updateWalk } from "./storage.js";
import { avoidModel, walkedGeoJSON, loadGrid, exploredStats } from "./discovery.js";

// ---------------------------------------------------------------------------
// Map layers — built on load and rebuilt whenever the base style is swapped
// (dark/light), since setStyle drops custom sources/layers.
// ---------------------------------------------------------------------------
async function buildLayers() {
  addHillshade();
  add3dBuildings();
  initDynShadeLayer();
  await pref.initGreenOverlay();
  initWalkedLayer();
  await addTreeLayer();
  initPoiLayer();
  initRouteLayers();
  setWalkedData(walkedGeoJSON());
  await pref.applyPreferenceOverlays(); // restores shade/green + sun light for the current pref
  if (lastPath) {
    map.getSource("route").setData({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: lastPath.points.coordinates.map((c) => [c[0], c[1]]) }, properties: {} }],
    });
  }
}

map.on("load", async () => {
  await buildLayers();
  ensureStartMarker(DEFAULT_CENTER.lon, DEFAULT_CENTER.lat);
  if (!REDUCED) {
    map.easeTo({ pitch: 56, bearing: -18, zoom: 14.4, duration: 2400 });
  } else {
    map.jumpTo({ pitch: 45, zoom: 14.4 });
  }
});

// Click the map: in Loop mode moves the start, in A→B mode sets the destination.
map.on("click", (e) => {
  if (mode === "ab") {
    setDest(e.lngLat.lat, e.lngLat.lng);
    setStatus("Destino marcado. Toque em <b>Gerar rota</b>.", "");
  } else {
    setStart(e.lngLat.lat, e.lngLat.lng);
    setStatus("Partida movida. Toque em <b>Gerar caminhada</b>.", "");
  }
});

// ---------------------------------------------------------------------------
// Route mode — Loop (round_trip) vs A→B (point-to-point)
// ---------------------------------------------------------------------------
let mode = "loop"; // "loop" | "ab"

function setDest(lat, lon) {
  document.getElementById("dest-lat").value = lat.toFixed(6);
  document.getElementById("dest-lon").value = lon.toFixed(6);
  document.getElementById("dest-coords").textContent = `${lat.toFixed(4).replace(".", ",").replace("-", "−")} · ${lon
    .toFixed(4)
    .replace(".", ",")
    .replace("-", "−")}`;
  setDestMarker([lon, lat]);
}

function setMode(m) {
  mode = m;
  document.querySelectorAll("#mode-segment .seg").forEach((b) => {
    const active = b.dataset.mode === m;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-checked", String(active));
  });
  const ab = m === "ab";
  document.getElementById("sec-destino").hidden = !ab;
  for (const id of ["sec-objetivo", "sec-poi", "sec-distancia", "sec-variacao"]) {
    document.getElementById(id).hidden = ab;
  }
  clearPoi();
  document.getElementById("compare").hidden = ab;
  updateAvoidVisibility();
  document.getElementById("generate").textContent = ab ? "Gerar rota" : "Gerar caminhada";
  if (!ab) {
    setDestMarker(null);
    document.getElementById("dest-lat").value = "";
    document.getElementById("dest-coords").textContent = "toque no mapa para marcar";
  } else {
    setStatus("Toque no mapa para marcar o destino.", "");
  }
}

document.querySelectorAll("#mode-segment .seg").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

// ---------------------------------------------------------------------------
// Start point
// ---------------------------------------------------------------------------
function setStart(lat, lon) {
  document.getElementById("lat").value = lat.toFixed(6);
  document.getElementById("lon").value = lon.toFixed(6);
  document.getElementById("coords").textContent = `${lat.toFixed(4).replace(".", ",").replace("-", "−")} · ${lon
    .toFixed(4)
    .replace(".", ",")
    .replace("-", "−")}`;
  ensureStartMarker(lon, lat);
}

function readForm() {
  return {
    lat: parseFloat(document.getElementById("lat").value),
    lon: parseFloat(document.getElementById("lon").value),
    km: currentKm(),
    seed: parseInt(document.getElementById("seed").value || "0", 10),
  };
}

// ---------------------------------------------------------------------------
// Preference controls
// ---------------------------------------------------------------------------
// Select a preference and sync the segmented control — reused by the weather
// suggestion, so it lives in a function rather than inline in the handler.
function selectPref(prefName) {
  pref.setPref(prefName);
  document.querySelectorAll("#pref-segment .seg").forEach((b) => {
    const active = b.dataset.pref === prefName;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-checked", String(active));
  });
  const p = pref.applyPreferenceOverlays();
  scheduleDynShade();
  return p;
}
document.querySelectorAll("#pref-segment .seg").forEach((btn) => {
  btn.addEventListener("click", () => { selectPref(btn.dataset.pref); clearMoodHighlight(); });
});

// Continuous sun slider — moves the sun, tint and 3D light, and re-casts the
// live shadows for the new time.
const sunSlider = document.getElementById("sun-slider");
sunSlider.addEventListener("input", () => {
  pref.setHour(parseFloat(sunSlider.value));
  pref.applySunVisuals();
  scheduleDynShade();
  clearMoodHighlight();
});

// Distance / duration — the control reads either km or minutes; "min" converts
// to km at GraphHopper's foot pace (~5 km/h) before routing.
const MIN_PER_KM = 12;
const distInput = document.getElementById("distance");
let unit = "km"; // "km" | "min"

const chipValue = (chip) => (unit === "min" ? chip.dataset.min : chip.dataset.km);

function markActiveChip() {
  document.querySelectorAll("#distance-chips .chip").forEach((b) => b.classList.toggle("is-active", chipValue(b) === distInput.value));
}
function relabelChips() {
  document.querySelectorAll("#distance-chips .chip").forEach((b) => {
    b.textContent = unit === "min" ? `${b.dataset.min} min` : `${b.dataset.km} km`;
  });
}
function setUnit(u) {
  if (u === unit) return;
  const val = parseFloat(distInput.value);
  if (!Number.isNaN(val)) {
    distInput.value = u === "min" ? String(Math.round(val * MIN_PER_KM)) : String(+(val / MIN_PER_KM).toFixed(1));
  }
  unit = u;
  document.querySelectorAll("#unit-toggle button").forEach((b) => b.classList.toggle("is-active", b.dataset.unit === u));
  relabelChips();
  markActiveChip();
}
document.querySelectorAll("#unit-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => { setUnit(btn.dataset.unit); clearMoodHighlight(); });
});

// Set distance in km (objectives + weather card use this); forces km unit.
function setDistance(km) {
  setUnit("km");
  distInput.value = String(km);
  markActiveChip();
}
document.querySelectorAll("#distance-chips .chip").forEach((btn) => {
  btn.addEventListener("click", () => { distInput.value = chipValue(btn); markActiveChip(); clearMoodHighlight(); });
});
distInput.addEventListener("input", () => { markActiveChip(); clearMoodHighlight(); });

// Current target in km + a human label ("45 min" / "6 km").
function currentKm() {
  const raw = parseFloat(distInput.value);
  return unit === "min" ? raw / MIN_PER_KM : raw;
}
function targetLabel() {
  const raw = parseFloat(distInput.value);
  return unit === "min" ? `${Math.round(raw)} min` : `${raw} km`;
}

// ---------------------------------------------------------------------------
// Objectives / moods — one-tap "how do you want to walk", configures the same
// controls and generates immediately.
// ---------------------------------------------------------------------------
const moodRow = document.getElementById("mood-row");
for (const m of MOODS) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mood";
  btn.dataset.mood = m.id;
  btn.innerHTML = `<span class="mood-icon">${m.icon}</span>${m.label}`;
  btn.addEventListener("click", () => applyMood(m));
  moodRow.appendChild(btn);
}

function highlightMood(id) {
  moodRow.querySelectorAll(".mood").forEach((b) => b.classList.toggle("is-active", b.dataset.mood === id));
}
function clearMoodHighlight() {
  moodRow.querySelectorAll(".mood.is-active").forEach((b) => b.classList.remove("is-active"));
}

function applyMood(m) {
  setDistance(m.km);
  if (m.shuffle) document.getElementById("seed").value = String(Math.floor(Math.random() * 1000));
  if (m.pref === "shade" && m.hour != null) {
    sunSlider.value = String(m.hour);
    pref.setHour(m.hour);
  }
  selectPref(m.pref);
  highlightMood(m.id);
  clearPoi();
  document.getElementById("route-form").requestSubmit(); // generate right away
}

// ---------------------------------------------------------------------------
// Pass by a POI — routes A → nearest POI of the chosen type → A (out-and-back).
// ---------------------------------------------------------------------------
const POI_NAMES = { cafe: "um café", viewpoint: "um mirante", water: "um ponto de água", park: "um parque" };

document.querySelectorAll("#poi-row .mood").forEach((btn) => {
  btn.addEventListener("click", () => passByPoi(btn.dataset.poi));
});

function highlightPoi(type) {
  document.querySelectorAll("#poi-row .mood").forEach((b) => b.classList.toggle("is-active", b.dataset.poi === type));
}
function clearPoi() {
  document.querySelectorAll("#poi-row .mood.is-active").forEach((b) => b.classList.remove("is-active"));
  setPoiMarker(null);
  clearPoiBeacons();
}

// Click a type → raise the sky beacons for every POI of that type and route a
// loop that passes by the nearest one. Clicking any beacon re-routes via it.
async function passByPoi(type) {
  const lat = parseFloat(document.getElementById("lat").value);
  const lon = parseFloat(document.getElementById("lon").value);
  const list = poisOfType(type, lat, lon);
  if (!list.length) {
    setStatus("Nenhum ponto desse tipo por perto.", "warn");
    return;
  }
  clearMoodHighlight();
  highlightPoi(type);
  setPoiBeacons(list, (f) => routeThroughPoi(f)); // clickable sky icons
  const nearest = list[0];
  await routeThroughPoi({
    geometry: nearest.geometry,
    properties: { type, name: nearest.properties.name },
  });
}

const inRegion = (lat, lon) => lon >= REGION.lonMin && lon <= REGION.lonMax && lat >= REGION.latMin && lat <= REGION.latMax;

// Route a distance-loop that passes by one specific POI feature.
async function routeThroughPoi(feature) {
  const lat = parseFloat(document.getElementById("lat").value);
  const lon = parseFloat(document.getElementById("lon").value);
  // Outside the baked graph there are no routes yet (fase 4) — still show the
  // POIs around you, just don't pretend we can route there.
  if (!inRegion(lat, lon)) {
    setPoiMarker(feature.geometry.coordinates);
    setStatus("Aqui fora ainda dá pra ver os POIs e prédios, mas o roteamento cobre a região do Vale do Paraíba em volta de Guaratinguetá.", "warn");
    return;
  }
  const { km, seed } = readForm();
  const [plon, plat] = feature.geometry.coordinates;
  const type = feature.properties.type;
  const nm = feature.properties.name || POI_NAMES[type];
  const btn = document.getElementById("generate");
  setBusy(btn, true);
  clearAltRoute();
  await pref.applyPreferenceOverlays();
  updateDynShade();
  setStatus(`Traçando um circuito passando por ${nm}…`, "");
  try {
    const best = await generateLoopVia(lat, lon, { lat: plat, lon: plon }, km, seed, routeSpec(), pref.prefCollection());
    setPoiMarker([plon, plat]);
    drawRoute(best.response);
    afterRoute(best.response.paths[0]);
    const via = best.passes ? `passando por ${nm}` : `perto de ${nm}`;
    const grew = best.targetKm > km + 0.05 ? ` (esticado p/ ${best.targetKm.toFixed(1)} km p/ alcançá-lo)` : "";
    setStatus(`Circuito ${via} · ${fmtKm(best.response.paths[0].distance)}${grew}.`, "ok");
  } catch (err) {
    if (err instanceof TypeError) setStatus("Servidor de rotas indisponível em <code>localhost:8989</code> (veja o README).", "warn");
    else setStatus("Erro ao traçar a rota: " + err.message, "error");
  } finally {
    setBusy(btn, false);
  }
}

// Geolocation — with cause-specific messages (the old generic error never told
// you WHY it failed: permission, insecure context, timeout).
function onLocated(pos) {
  const { latitude: lat, longitude: lon } = pos.coords;
  setStart(lat, lon);
  map.flyTo({ center: [lon, lat], zoom: 15, duration: REDUCED ? 0 : 1200 });
  refreshWeather();
  const inside = inRegion(lat, lon);
  setStatus(
    inside
      ? "Partida definida na sua localização."
      : "Você está fora da região coberta (Vale do Paraíba em volta de Guaratinguetá) — a rota pode falhar. Toque no mapa dentro da região.",
    inside ? "ok" : "warn"
  );
}

function onLocateError(err, wasHighAccuracy) {
  // Timeout on high accuracy → retry once with coarse (network) location.
  if (err.code === err.TIMEOUT && wasHighAccuracy) {
    navigator.geolocation.getCurrentPosition(onLocated, (e) => onLocateError(e, false), {
      enableHighAccuracy: false,
      timeout: 12000,
      maximumAge: 60000,
    });
    return;
  }
  const msg = {
    1: "Permissão de localização negada. Clique no 🔒 na barra de endereço → permitir localização, e tente de novo. Ou toque no mapa.",
    2: "Localização indisponível no momento. Toque no mapa para escolher a partida.",
    3: "A localização demorou demais. Toque no mapa para escolher a partida.",
  }[err.code] || ("Não foi possível localizar: " + err.message);
  setStatus(msg, "warn");
}

document.getElementById("locate").addEventListener("click", () => {
  if (!window.isSecureContext) {
    setStatus(
      `Localização exige HTTPS ou <code>localhost</code> — você está em <code>${location.host}</code>. Toque no mapa para escolher a partida.`,
      "warn"
    );
    return;
  }
  if (!navigator.geolocation) {
    setStatus("Este navegador não oferece geolocalização.", "warn");
    return;
  }
  setStatus("Localizando…", "");
  navigator.geolocation.getCurrentPosition(onLocated, (e) => onLocateError(e, true), {
    enableHighAccuracy: true,
    timeout: 8000,
    maximumAge: 30000,
  });
});

// Surprise me — new random variation, generate immediately
document.getElementById("shuffle").addEventListener("click", () => {
  document.getElementById("seed").value = String(Math.floor(Math.random() * 1000));
  document.getElementById("route-form").requestSubmit();
});

// ---------------------------------------------------------------------------
// Weather suggestion — reads current conditions near the start and proposes a
// setup; the hot+sunny case flows straight into the shade engine.
// ---------------------------------------------------------------------------
let currentSuggestion = null;

async function refreshWeather() {
  const card = document.getElementById("weather-card");
  const lat = parseFloat(document.getElementById("lat").value);
  const lon = parseFloat(document.getElementById("lon").value);
  try {
    currentSuggestion = suggest(await fetchWeather(lat, lon));
    document.getElementById("wx-icon").textContent = currentSuggestion.icon;
    document.getElementById("wx-headline").textContent = currentSuggestion.headline;
    document.getElementById("wx-message").textContent = currentSuggestion.message;
    const btn = document.getElementById("wx-apply");
    btn.classList.remove("is-applied");
    btn.textContent = "Aplicar sugestão";
    card.hidden = false;
  } catch {
    card.hidden = true; // weather is an enhancement — fail silently
  }
}

document.getElementById("wx-apply").addEventListener("click", async () => {
  const s = currentSuggestion;
  if (!s) return;
  if (s.pref === "shade" && s.hour != null) {
    sunSlider.value = String(s.hour);
    pref.setHour(s.hour);
  }
  if (s.distanceKm) setDistance(s.distanceKm);
  await selectPref(s.pref);
  const btn = document.getElementById("wx-apply");
  btn.classList.add("is-applied");
  btn.textContent = "✓ Aplicado";
  setStatus("Sugestão aplicada — toque em <b>Gerar caminhada</b>.", "ok");
});

// ---------------------------------------------------------------------------
// Routing spec — merges the preference model with the "avoid walked" model
// ---------------------------------------------------------------------------
function mergeModels(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    priority: [...a.priority, ...b.priority],
    areas: { type: "FeatureCollection", features: [...a.areas.features, ...b.areas.features] },
  };
}

const avoidOn = () => document.getElementById("avoid-walked").checked;

function routeSpec() {
  if (avoidOn()) return { profile: "foot", customModel: mergeModels(pref.prefModel(), avoidModel()) };
  return pref.routingSpec();
}

function updateAvoidVisibility() {
  document.getElementById("avoid-field").hidden = mode === "ab" || getWalks().length === 0;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
document.getElementById("route-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { lat, lon, km, seed } = readForm();
  const btn = document.getElementById("generate");

  // A→B mode needs a destination before it can route.
  const destLat = parseFloat(document.getElementById("dest-lat").value);
  const destLon = parseFloat(document.getElementById("dest-lon").value);
  if (mode === "ab" && Number.isNaN(destLat)) {
    setStatus("Toque no mapa para marcar o destino.", "warn");
    return;
  }

  setBusy(btn, true);
  clearAltRoute();
  clearPoi();
  await pref.applyPreferenceOverlays();
  updateDynShade(); // fresh shadows feed the shade-aware routing model
  setStatus(mode === "ab" ? "Traçando a rota…" : "Traçando a caminhada…", "");

  try {
    if (mode === "ab") {
      const resp = await generatePointToPoint(lat, lon, destLat, destLon, routeSpec());
      drawRoute(resp, { loop: false });
      afterRoute(resp.paths[0]);
      setStatus(`Rota até o destino · ${fmtKm(resp.paths[0].distance)}.`, "ok");
      return;
    }
    // Best-of prefers shadiest/greenest, or — when avoiding walked streets — the
    // least-reused loop among the distance-acceptable candidates.
    const avoidM = avoidOn() ? avoidModel() : null;
    const spec = avoidM ? { profile: "foot", customModel: mergeModels(pref.prefModel(), avoidM) } : pref.routingSpec();
    const best = await generateFaithful(lat, lon, km, seed, spec, pref.prefCollection(), avoidM?.areas || null);
    drawRoute(best.response);
    afterRoute(best.response.paths[0]);
    const offBy = Math.abs(best.distance - km * 1000) / (km * 1000);
    const note = offBy > 0.2
      ? " — a malha da região não tem um circuito mais próximo"
      : ` (melhor de ${best.tried} variações)`;
    setStatus(`Alvo ${targetLabel()} → ${fmtKm(best.distance)}${note}.`, "ok");
  } catch (err) {
    if (err instanceof TypeError && mode !== "ab") {
      try {
        const sample = await fetch("/sample-route.json").then((r) => r.json());
        drawRoute(sample, { isSample: true });
        setStatus(
          'Servidor de rotas indisponível em <code>localhost:8989</code>. ' +
            'Exibindo <span class="sample-badge">AMOSTRA</span> — não é rota real. ' +
            "Inicie o backend (veja o README).",
          "warn"
        );
      } catch {
        setStatus("Servidor indisponível e amostra ausente: " + err.message, "error");
      }
    } else {
      setStatus("Erro ao traçar a rota: " + err.message, "error");
    }
  } finally {
    setBusy(btn, false);
  }
});

// ---------------------------------------------------------------------------
// Compare — regular vs. the selected preference on the same winning seed
// ---------------------------------------------------------------------------
document.getElementById("compare").addEventListener("click", async () => {
  const { lat, lon, km, seed } = readForm();
  if (pref.pref === "none") {
    setStatus("Escolha uma prioridade (verde ou sombra) para comparar com a rota normal.", "warn");
    return;
  }
  const btn = document.getElementById("compare");
  setBusy(btn, true);
  await pref.applyPreferenceOverlays();
  updateDynShade();
  setStatus("Traçando as duas caminhadas…", "");

  try {
    const best = await generateFaithful(lat, lon, km, seed, { profile: "foot", customModel: null });
    const regular = best.response;
    const preferred = await generateRoute(lat, lon, km, best.seed, pref.routingSpec());

    const regCoords = regular.paths[0].points.coordinates.map((c) => [c[0], c[1]]);
    map.getSource("route-alt").setData({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: regCoords }, properties: {} }],
    });
    drawRoute(preferred);

    const fc = pref.prefCollection();
    const metric = pref.prefLabel();
    const fReg = fractionIn(regCoords, fc);
    const fPref = fractionIn(preferred.paths[0].points.coordinates.map((c) => [c[0], c[1]]), fc);
    const pct = (f) => (f === null ? "?" : `${Math.round(f * 100)}%`);
    setStatus(
      `<span class="cmp-reg">normal ${fmtKm(regular.paths[0].distance)} · ${pct(fReg)} ${metric}</span> vs. ` +
        `<span class="cmp-pref">${metric} ${fmtKm(preferred.paths[0].distance)} · ${pct(fPref)}</span>`,
      "ok"
    );
  } catch (err) {
    setStatus(
      err instanceof TypeError
        ? "Comparar exige o servidor de rotas em <code>localhost:8989</code> (veja o README)."
        : "Erro ao traçar a rota: " + err.message,
      "error"
    );
  } finally {
    setBusy(btn, false);
  }
});

// ---------------------------------------------------------------------------
// Live navigation
// ---------------------------------------------------------------------------
let lastRoute = null; // { distanceM, timeMs } of the drawn route, for sharing
let lastNav = null; // latest live-nav state, for sharing
let lastPath = null; // full GH path of the drawn route, for saving

function afterRoute(path) {
  nav.setRoute(path);
  lastPath = path;
  lastRoute = { distanceM: path.distance, timeMs: path.time };
  document.getElementById("start-walk").hidden = false;
  document.getElementById("route-actions").hidden = false;
}

function buildShareText(live) {
  const lat = document.getElementById("lat").value;
  const lon = document.getElementById("lon").value;
  if (live && lastNav) {
    const eta = new Date(Date.now() + (lastNav.etaMs || 0)).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const here = `https://www.google.com/maps?q=${lastNav.lat.toFixed(5)},${lastNav.lon.toFixed(5)}`;
    return `🚶 Estou caminhando pelo Stride — faltam ${fmtDist(lastNav.remaining)}, chego ~${eta}. Onde estou: ${here}`;
  }
  const maps = `https://www.google.com/maps?q=${lat},${lon}`;
  if (lastRoute) {
    return `🚶 Vou caminhar ${fmtKm(lastRoute.distanceM)} pelo Stride (~${fmtDuration(lastRoute.timeMs)}). Partida: ${maps}`;
  }
  return "🚶 Caminhando pelo Stride.";
}

async function share(live, btn) {
  const text = buildShareText(live);
  try {
    if (navigator.share) {
      await navigator.share({ title: "Stride", text });
    } else {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = "✓ Copiado";
      setTimeout(() => { btn.textContent = orig; }, 1600);
    }
  } catch {
    /* user cancelled the share sheet — ignore */
  }
}

document.getElementById("share-walk").addEventListener("click", (e) => share(false, e.currentTarget));
document.getElementById("nav-share").addEventListener("click", (e) => share(true, e.currentTarget));

// --- saved walks (localStorage) ---------------------------------------------
function walkName(path) {
  const label = pref.prefLabel() || (mode === "ab" ? "A→B" : "normal");
  const d = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  return `${fmtKm(path.distance)} · ${label} · ${d}`;
}

document.getElementById("save-walk").addEventListener("click", (e) => {
  if (!lastPath) return;
  saveWalk({
    id: `${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    ts: Date.now(),
    name: walkName(lastPath),
    distanceM: lastPath.distance,
    timeM: lastPath.time,
    ascendM: lastPath.ascend ?? null,
    loop: mode !== "ab",
    coords: lastPath.points.coordinates,
    instructions: lastPath.instructions || [],
    favorite: false,
    rating: 0,
  });
  renderSaved();
  const b = e.currentTarget, o = b.textContent;
  b.textContent = "✓ Salva";
  setTimeout(() => { b.textContent = o; }, 1500);
});

function loadWalk(w) {
  const path = { distance: w.distanceM, time: w.timeM, ascend: w.ascendM, points: { coordinates: w.coords }, instructions: w.instructions };
  drawRoute({ paths: [path] }, { loop: w.loop !== false });
  afterRoute(path);
  setStatus(`Carregada: ${w.name}.`, "ok");
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderSaved() {
  const walks = getWalks();
  document.getElementById("saved-walks").hidden = walks.length === 0;
  document.getElementById("saved-count").textContent = walks.length || "";
  const list = document.getElementById("saved-list");
  list.innerHTML = "";
  for (const w of walks) {
    const li = document.createElement("li");
    li.className = "saved-item";
    li.innerHTML =
      `<button type="button" class="saved-load">` +
        `<span class="saved-name">${w.favorite ? "★ " : ""}${esc(w.name)}</span>` +
        `<span class="saved-meta">${fmtKm(w.distanceM)} · ~${fmtDuration(w.timeM)}</span>` +
      `</button>` +
      `<button type="button" class="icon-btn up ${w.rating === 1 ? "on" : ""}" title="Gostei">👍</button>` +
      `<button type="button" class="icon-btn down ${w.rating === -1 ? "on" : ""}" title="Não curti">👎</button>` +
      `<button type="button" class="icon-btn fav ${w.favorite ? "on" : ""}" title="Favorita">${w.favorite ? "★" : "☆"}</button>` +
      `<button type="button" class="icon-btn del" title="Excluir">🗑</button>`;
    li.querySelector(".saved-load").addEventListener("click", () => loadWalk(w));
    li.querySelector(".up").addEventListener("click", () => { updateWalk(w.id, { rating: w.rating === 1 ? 0 : 1 }); renderSaved(); });
    li.querySelector(".down").addEventListener("click", () => { updateWalk(w.id, { rating: w.rating === -1 ? 0 : -1 }); renderSaved(); });
    li.querySelector(".fav").addEventListener("click", () => { updateWalk(w.id, { favorite: !w.favorite }); renderSaved(); });
    li.querySelector(".del").addEventListener("click", () => { deleteWalk(w.id); renderSaved(); });
    list.appendChild(li);
  }

  // Explored % + the walked-streets overlay ("your territory").
  const exEl = document.getElementById("explored-stat");
  exEl.hidden = walks.length === 0;
  if (walks.length) {
    const ex = exploredStats();
    document.getElementById("explored-fill").style.width = `${Math.min(100, ex.pct)}%`;
    document.getElementById("explored-text").textContent =
      `🗺️ ${ex.pct.toFixed(1).replace(".", ",")}% de Guaratinguetá · ${ex.cells} de ${ex.total} quarteirões`;
  }
  setWalkedData(walkedGeoJSON());

  updateAvoidVisibility();
}

const OFF_ROUTE_M = 35;
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${Math.round(m)} m`);
let lastRecenter = 0;
let navStartMs = 0; // for pace
let navFollowed = false; // GPS-mode camera has locked on

// --- turn-by-turn voice -----------------------------------------------------
let muted = false;
let annKey = -1, aheadSaid = false, nowSaid = false;

function maneuverIcon(sign) {
  return {
    "-3": "↰", "-2": "←", "-1": "↖", "0": "↑", "1": "↗", "2": "→", "3": "↱",
    "4": "🏁", "5": "◎", "6": "↻", "-7": "↖", "7": "↗", "-8": "↩", "-98": "↩",
  }[String(sign)] || "↑";
}

function speak(text) {
  if (muted || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "pt-BR";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function maybeAnnounce(ins) {
  if (ins.isFinish) return;
  if (ins.idx !== annKey) { annKey = ins.idx; aheadSaid = false; nowSaid = false; }
  if (!aheadSaid && ins.distToNext <= 120 && ins.distToNext > 25) {
    speak(`Em ${Math.round(ins.distToNext)} metros, ${ins.text}`);
    aheadSaid = true;
  } else if (!nowSaid && ins.distToNext <= 25) {
    speak(ins.text);
    nowSaid = true;
  }
}

function onNavUpdate(s) {
  if (s.done) {
    document.getElementById("nav-bar").style.width = "100%";
    document.getElementById("nav-remaining").textContent = "0 m";
    document.getElementById("nav-off").hidden = true;
    document.getElementById("nav-instr-icon").textContent = "🏁";
    document.getElementById("nav-instr-text").textContent = "Você chegou!";
    document.getElementById("nav-instr-dist").textContent = "";
    document.querySelector("#nav-panel .nav-title").textContent = "Você chegou! 🎉";
    document.getElementById("nav-sim").disabled = false;
    speak("Você chegou ao destino.");
    return;
  }
  setNavMarker([s.lon, s.lat]);
  lastNav = { remaining: s.remaining, etaMs: s.etaMs, lon: s.lon, lat: s.lat };
  document.getElementById("nav-bar").style.width = `${Math.round((s.frac || 0) * 100)}%`;
  document.getElementById("nav-remaining").textContent = fmtDist(s.remaining);
  document.getElementById("nav-covered").textContent = fmtDist(s.covered || 0);
  const arrival = new Date(Date.now() + (s.etaMs || 0));
  document.getElementById("nav-eta").textContent = arrival.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("nav-off").hidden = s.offBy <= OFF_ROUTE_M;

  // Pace (min/km): live (real elapsed / covered) when walking; the route's
  // average during a simulation, since sim time is a fast-forward.
  const coveredKm = (s.covered || 0) / 1000;
  const pace = s.simulated
    ? nav.avgPaceMinKm()
    : coveredKm > 0.05 ? (Date.now() - navStartMs) / 60000 / coveredKm : 0;
  document.getElementById("nav-pace").textContent =
    pace > 0 && pace < 90 ? `${Math.floor(pace)}'${String(Math.round((pace % 1) * 60)).padStart(2, "0")}"` : "—";

  const ins = s.instruction;
  if (ins) {
    document.getElementById("nav-instr-icon").textContent = maneuverIcon(ins.sign);
    document.getElementById("nav-instr-text").textContent = ins.text;
    document.getElementById("nav-instr-dist").textContent = ins.isFinish ? "" : `em ${fmtDist(ins.distToNext)}`;
    maybeAnnounce(ins);
  }

  // GPS-mode camera: lock onto the walker (zoom in once, then follow).
  const now = Date.now();
  if (!navFollowed) {
    map.easeTo({ center: [s.lon, s.lat], zoom: 16.5, pitch: 55, duration: 900 });
    navFollowed = true;
    lastRecenter = now;
  } else if (now - lastRecenter > 700) {
    map.easeTo({ center: [s.lon, s.lat], duration: 600 });
    lastRecenter = now;
  }
}

function enterNav() {
  for (const id of ["route-form", "weather-card", "stats", "start-walk", "route-actions", "saved-walks"]) {
    document.getElementById(id).hidden = true;
  }
  setStatus("", "");
  document.querySelector("#nav-panel .nav-title").textContent = "Caminhando";
  document.getElementById("nav-off").hidden = true;
  document.getElementById("nav-sim").disabled = false;
  document.getElementById("nav-panel").hidden = false;
  annKey = -1; aheadSaid = false; nowSaid = false; // fresh announcements
  navStartMs = Date.now(); navFollowed = false;
  nav.start(onNavUpdate, (err) =>
    setStatus("Sem GPS (" + (err.message || "negado") + ") — toque em ▶ Simular percurso.", "warn")
  );
}

function exitNav() {
  nav.stop();
  setNavMarker(null);
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  document.getElementById("nav-panel").hidden = true;
  for (const id of ["route-form", "weather-card", "stats", "start-walk", "route-actions"]) {
    document.getElementById(id).hidden = false;
  }
  renderSaved();
}

if (import.meta.env?.DEV) window.__nav = nav; // dev-only handle for debugging
document.getElementById("start-walk").addEventListener("click", enterNav);
document.getElementById("nav-mute").addEventListener("click", () => {
  muted = !muted;
  const b = document.getElementById("nav-mute");
  b.textContent = muted ? "🔇" : "🔊";
  b.classList.toggle("is-muted", muted);
  if (muted && "speechSynthesis" in window) window.speechSynthesis.cancel();
});
document.getElementById("nav-stop").addEventListener("click", exitNav);
document.getElementById("nav-sim").addEventListener("click", () => {
  nav.stop();
  document.getElementById("nav-sim").disabled = true;
  document.getElementById("nav-off").hidden = true;
  document.querySelector("#nav-panel .nav-title").textContent = "Caminhando";
  navStartMs = Date.now(); navFollowed = false;
  nav.simulate(onNavUpdate);
});

// ---------------------------------------------------------------------------
// Theme (dark / light) — swaps the base map style and rebuilds layers
// ---------------------------------------------------------------------------
const themeToggle = document.getElementById("theme-toggle");
function setThemeIcon() {
  const dark = document.documentElement.dataset.theme === "dark";
  themeToggle.textContent = dark ? "☀️" : "🌙";
  themeToggle.setAttribute("aria-label", dark ? "Modo claro" : "Modo escuro");
}
themeToggle.addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("stride.theme", dark ? "dark" : "light"); } catch {}
  setThemeIcon();
  map.setStyle(MAP_STYLES[dark ? "dark" : "light"]);
  map.once("style.load", buildLayers);
});
setThemeIcon();

// ---------------------------------------------------------------------------
// Live surroundings — stream trees + POIs from Overpass for areas outside the
// baked region, so the map stays alive as you pan anywhere.
// ---------------------------------------------------------------------------
const liveChip = document.createElement("div");
liveChip.id = "live-chip";
liveChip.hidden = true;
liveChip.textContent = "🌳 carregando arredores…";
document.body.appendChild(liveChip);

let liveTimer = null;
map.on("moveend", () => {
  scheduleDynShade();
  if (map.getZoom() < 14) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(loadSurroundings, 600);
});
// Re-cast shade once building tiles finish loading (they arrive after moveend).
map.on("sourcedata", (e) => {
  if (e.isSourceLoaded && (e.sourceId === "buildings" || e.sourceId === "openmaptiles")) scheduleDynShade();
});

async function loadSurroundings() {
  let started = false;
  const res = await overpass.loadAround(map.getBounds(), () => {
    started = true;
    liveChip.hidden = false;
  });
  if (started) liveChip.hidden = true;
  if (!res) return;
  if (res.trees?.length) appendLiveTrees(res.trees);
  if (res.pois?.length) addLivePois(res.pois);
}

// Dynamic shade — cast shadows live from the buildings in view, for areas
// outside the baked region (the home region keeps its higher-quality baked
// shade). Driven by the same sun slider; only when the "sombra" preference is on.
let dynTimer = 0;
function scheduleDynShade() {
  clearTimeout(dynTimer);
  dynTimer = setTimeout(updateDynShade, 80); // coalesce bursts (slider drags, moves)
}

// Gather building footprints from the loaded vector tiles (querySourceFeatures
// covers a bit beyond the viewport, so a routed loop keeps shade coverage).
function gatherBuildings() {
  const out = [], seen = new Set();
  const srcs = [["buildings", "buildings", "h"], ["openmaptiles", "building", "render_height"]];
  for (const [src, sourceLayer, hKey] of srcs) {
    if (!map.getSource(src)) continue;
    let feats;
    try { feats = map.querySourceFeatures(src, { sourceLayer }); } catch { continue; }
    for (const f of feats) {
      const h = f.properties[hKey];
      if (!h || h < 2) continue;
      const g = f.geometry;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const poly of polys) {
        const ring = poly[0];
        const key = ring[0][0].toFixed(5) + "," + ring[0][1].toFixed(5) + "," + Math.round(h);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ring, height: h });
        if (out.length >= 2500) return out;
      }
    }
  }
  return out;
}

// Cast the shadows for the current view + hour, show them, and hand them to the
// shade module so they also drive shade-aware routing. Works everywhere now.
function updateDynShade() {
  if (pref.pref !== "shade" || map.getZoom() < 13) {
    setDynShade(null);
    pref.setActiveShade(null);
    return;
  }
  const c = map.getCenter();
  const sun = sunForHour(c.lat, c.lng, pref.hour);
  const fc = computeShadows(gatherBuildings(), c.lat, sun.az, sun.el);
  setDynShade(fc);
  pref.setActiveShade(fc);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
setStart(DEFAULT_CENTER.lat, DEFAULT_CENTER.lon);
pref.updateSunArc();
refreshWeather();
loadPois();
loadGrid().then(renderSaved);
renderSaved();

// Shade is cast live for any hour now, so the slider spans the daylit hours.
sunSlider.min = "6";
sunSlider.max = "18";
pref.updateSunArc();
