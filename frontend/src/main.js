// App wiring: the map-load setup sequence, DOM event handlers, and init.
import { map, add3dBuildings, addHillshade, initRouteLayers, ensureStartMarker, setDestMarker, setPoiMarker, setNavMarker, clearAltRoute } from "./map.js";
import { REDUCED, DEFAULT_CENTER, BBOX } from "./config.js";
import { fractionIn } from "./geo.js";
import { setStatus, setBusy, fmtKm } from "./ui.js";
import { generateRoute, generateFaithful, generatePointToPoint, generateThrough } from "./routing.js";
import { drawRoute } from "./render.js";
import * as pref from "./shade.js";
import { fetchWeather, suggest } from "./weather.js";
import { MOODS } from "./intent.js";
import { loadPois, nearestPoi } from "./pois.js";
import * as nav from "./navigation.js";

// ---------------------------------------------------------------------------
// Map load — build layers in stacking order, then a cinematic tilt-in
// ---------------------------------------------------------------------------
map.on("load", async () => {
  addHillshade();
  add3dBuildings();
  pref.setSunLight(null);
  await pref.initGreenOverlay();
  pref.initShadeLayers();
  initRouteLayers();
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
  return pref.applyPreferenceOverlays();
}
document.querySelectorAll("#pref-segment .seg").forEach((btn) => {
  btn.addEventListener("click", () => { selectPref(btn.dataset.pref); clearMoodHighlight(); });
});

// Continuous sun slider — moves the sun, tint and 3D light every frame, and
// cross-dissolves the shadow overlay between the bracketing baked hours.
const sunSlider = document.getElementById("sun-slider");
sunSlider.addEventListener("input", () => {
  pref.setHour(parseFloat(sunSlider.value));
  pref.applySunVisuals();
  pref.updateShadeBlend();
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
}

async function passByPoi(type) {
  const lat = parseFloat(document.getElementById("lat").value);
  const lon = parseFloat(document.getElementById("lon").value);
  const poi = nearestPoi(type, lat, lon);
  if (!poi) {
    setStatus("Nenhum ponto desse tipo por perto.", "warn");
    return;
  }
  const btn = document.getElementById("generate");
  setBusy(btn, true);
  clearAltRoute();
  clearMoodHighlight();
  highlightPoi(type);
  await pref.applyPreferenceOverlays();
  setStatus("Traçando a ida e volta…", "");
  try {
    const resp = await generateThrough([[lon, lat], [poi.lon, poi.lat], [lon, lat]], pref.routingSpec());
    setPoiMarker([poi.lon, poi.lat]);
    drawRoute(resp);
    afterRoute(resp.paths[0]);
    const nm = poi.name || POI_NAMES[type];
    setStatus(`Ida e volta por ${nm} · ${fmtKm(resp.paths[0].distance)} (${Math.round(poi.dist)} m de ida).`, "ok");
  } catch (err) {
    setStatus("Erro ao traçar a rota: " + err.message, "error");
  } finally {
    setBusy(btn, false);
  }
}

// Geolocation
document.getElementById("locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("Este navegador não oferece geolocalização.", "warn");
    return;
  }
  setStatus("Localizando…", "");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      setStart(lat, lon);
      map.flyTo({ center: [lon, lat], zoom: 15, duration: REDUCED ? 0 : 1200 });
      refreshWeather(); // conditions at the new start point
      const inside = lon >= BBOX.lonMin && lon <= BBOX.lonMax && lat >= BBOX.latMin && lat <= BBOX.latMax;
      setStatus(
        inside
          ? "Partida definida na sua localização."
          : "Você está fora da área da demonstração (Guaratinguetá-SP) — a rota pode falhar.",
        inside ? "ok" : "warn"
      );
    },
    () => setStatus("Não foi possível obter sua localização. Toque no mapa para escolher a partida.", "warn"),
    { enableHighAccuracy: true, timeout: 8000 }
  );
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
  setStatus(mode === "ab" ? "Traçando a rota…" : "Traçando a caminhada…", "");

  try {
    if (mode === "ab") {
      const resp = await generatePointToPoint(lat, lon, destLat, destLon, pref.routingSpec());
      drawRoute(resp, { loop: false });
      afterRoute(resp.paths[0]);
      setStatus(`Rota até o destino · ${fmtKm(resp.paths[0].distance)}.`, "ok");
      return;
    }
    // Best-of prefers the shadiest/greenest of the distance-acceptable candidates.
    const best = await generateFaithful(lat, lon, km, seed, pref.routingSpec(), pref.prefCollection());
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
function afterRoute(path) {
  nav.setRoute(path);
  document.getElementById("start-walk").hidden = false;
}

const OFF_ROUTE_M = 35;
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${Math.round(m)} m`);
let lastRecenter = 0;

function onNavUpdate(s) {
  const simBtn = document.getElementById("nav-sim");
  if (s.done) {
    document.getElementById("nav-bar").style.width = "100%";
    document.getElementById("nav-remaining").textContent = "0 m";
    document.getElementById("nav-off").hidden = true;
    document.querySelector("#nav-panel .nav-title").textContent = "Você chegou! 🎉";
    simBtn.disabled = false;
    return;
  }
  setNavMarker([s.lon, s.lat]);
  document.getElementById("nav-bar").style.width = `${Math.round((s.frac || 0) * 100)}%`;
  document.getElementById("nav-remaining").textContent = fmtDist(s.remaining);
  const arrival = new Date(Date.now() + (s.etaMs || 0));
  document.getElementById("nav-eta").textContent = arrival.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("nav-off").hidden = s.offBy <= OFF_ROUTE_M;
  // Recenter throttled (a per-tick camera move thrashes the 3D renderer).
  const now = Date.now();
  if (now - lastRecenter > 1000) {
    map.setCenter([s.lon, s.lat]);
    lastRecenter = now;
  }
}

function enterNav() {
  for (const id of ["route-form", "weather-card", "stats", "start-walk"]) {
    document.getElementById(id).hidden = true;
  }
  setStatus("", "");
  document.querySelector("#nav-panel .nav-title").textContent = "Caminhando";
  document.getElementById("nav-off").hidden = true;
  document.getElementById("nav-sim").disabled = false;
  document.getElementById("nav-panel").hidden = false;
  nav.start(onNavUpdate, (err) =>
    setStatus("Sem GPS (" + (err.message || "negado") + ") — toque em ▶ Simular percurso.", "warn")
  );
}

function exitNav() {
  nav.stop();
  setNavMarker(null);
  document.getElementById("nav-panel").hidden = true;
  for (const id of ["route-form", "weather-card", "stats", "start-walk"]) {
    document.getElementById(id).hidden = false;
  }
}

if (import.meta.env?.DEV) window.__nav = nav; // dev-only handle for debugging
document.getElementById("start-walk").addEventListener("click", enterNav);
document.getElementById("nav-stop").addEventListener("click", exitNav);
document.getElementById("nav-sim").addEventListener("click", () => {
  nav.stop();
  document.getElementById("nav-sim").disabled = true;
  document.getElementById("nav-off").hidden = true;
  document.querySelector("#nav-panel .nav-title").textContent = "Caminhando";
  nav.simulate(onNavUpdate);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
setStart(DEFAULT_CENTER.lat, DEFAULT_CENTER.lon);
pref.updateSunArc();
refreshWeather();
loadPois();

pref.loadManifest().then((hours) => {
  if (!hours) return;
  sunSlider.min = String(hours[0]);
  sunSlider.max = String(hours[hours.length - 1]);
  pref.updateSunArc();
});
