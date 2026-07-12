// App wiring: the map-load setup sequence, DOM event handlers, and init.
import { map, add3dBuildings, addHillshade, initRouteLayers, ensureStartMarker, clearAltRoute } from "./map.js";
import { REDUCED, DEFAULT_CENTER, BBOX } from "./config.js";
import { fractionIn } from "./geo.js";
import { setStatus, setBusy, fmtKm } from "./ui.js";
import { generateRoute, generateFaithful } from "./routing.js";
import { drawRoute } from "./render.js";
import * as pref from "./shade.js";

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
document.querySelectorAll("#pref-segment .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    pref.setPref(btn.dataset.pref);
    document.querySelectorAll("#pref-segment .seg").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-checked", String(active));
    });
    pref.applyPreferenceOverlays();
  });
});

// Continuous sun slider — moves the sun, tint and 3D light every frame, and
// cross-dissolves the shadow overlay between the bracketing baked hours.
const sunSlider = document.getElementById("sun-slider");
sunSlider.addEventListener("input", () => {
  pref.setHour(parseFloat(sunSlider.value));
  pref.applySunVisuals();
  pref.updateShadeBlend();
});

// Distance chips
document.querySelectorAll("#distance-chips .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("distance").value = btn.dataset.km;
    document.querySelectorAll("#distance-chips .chip").forEach((b) => b.classList.toggle("is-active", b === btn));
  });
});
document.getElementById("distance").addEventListener("input", (e) => {
  document.querySelectorAll("#distance-chips .chip").forEach((b) => b.classList.toggle("is-active", b.dataset.km === e.target.value));
});

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

pref.loadManifest().then((hours) => {
  if (!hours) return;
  sunSlider.min = String(hours[0]);
  sunSlider.max = String(hours[hours.length - 1]);
  pref.updateSunArc();
});
