// App wiring: the map-load setup sequence, DOM event handlers, and init.
import { map, add3dBuildings, addHillshade, initRouteLayers, ensureStartMarker, clearAltRoute } from "./map.js";
import { REDUCED, DEFAULT_CENTER, BBOX } from "./config.js";
import { fractionIn } from "./geo.js";
import { setStatus, setBusy, fmtKm } from "./ui.js";
import { generateRoute, generateFaithful } from "./routing.js";
import { drawRoute } from "./render.js";
import * as pref from "./shade.js";
import { fetchWeather, suggest } from "./weather.js";
import { MOODS } from "./intent.js";

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

// Click the map to move the start point.
map.on("click", (e) => {
  setStart(e.lngLat.lat, e.lngLat.lng);
  setStatus("Partida movida. Toque em <b>Gerar caminhada</b>.", "");
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
    km: parseFloat(document.getElementById("distance").value),
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

// Distance chips
function setDistance(km) {
  document.getElementById("distance").value = String(km);
  document.querySelectorAll("#distance-chips .chip").forEach((b) => b.classList.toggle("is-active", b.dataset.km === String(km)));
}
document.querySelectorAll("#distance-chips .chip").forEach((btn) => {
  btn.addEventListener("click", () => { setDistance(btn.dataset.km); clearMoodHighlight(); });
});
document.getElementById("distance").addEventListener("input", (e) => {
  document.querySelectorAll("#distance-chips .chip").forEach((b) => b.classList.toggle("is-active", b.dataset.km === e.target.value));
  clearMoodHighlight();
});

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
  document.getElementById("route-form").requestSubmit(); // generate right away
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
  setBusy(btn, true);
  clearAltRoute();
  await pref.applyPreferenceOverlays();
  setStatus("Traçando a caminhada…", "");

  try {
    // Best-of prefers the shadiest/greenest of the distance-acceptable candidates.
    const best = await generateFaithful(lat, lon, km, seed, pref.routingSpec(), pref.prefCollection());
    drawRoute(best.response);
    const offBy = Math.abs(best.distance - km * 1000) / (km * 1000);
    const note = offBy > 0.2
      ? " — a malha da região não tem um circuito mais próximo"
      : ` (melhor de ${best.tried} variações)`;
    setStatus(`Alvo ${km} km → ${fmtKm(best.distance)}${note}.`, "ok");
  } catch (err) {
    if (err instanceof TypeError) {
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
// Init
// ---------------------------------------------------------------------------
setStart(DEFAULT_CENTER.lat, DEFAULT_CENTER.lon);
pref.updateSunArc();
refreshWeather();

pref.loadManifest().then((hours) => {
  if (!hours) return;
  sunSlider.min = String(hours[0]);
  sunSlider.max = String(hours[hours.length - 1]);
  pref.updateSunArc();
});
