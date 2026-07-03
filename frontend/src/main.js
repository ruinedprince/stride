import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const GRAPHHOPPER_URL = "http://localhost:8989/route";
const DEFAULT_CENTER = { lat: -22.8164, lon: -45.1927 }; // Guaratinguetá-SP center
const BBOX = { lonMin: -45.3, latMin: -22.92, lonMax: -45.08, latMax: -22.7 };
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Sun position per preset hour (2026-07-03) — refreshed from the shade
// geojson properties when loaded, these are the baked fallbacks.
const SUN = {
  9: { az: 47.7, el: 25.8 },
  12: { az: 1.6, el: 44.2 },
  15: { az: 314.1, el: 27.6 },
};

// ---------------------------------------------------------------------------
// Map — OpenFreeMap vector tiles (open, no API key), tilted 3D camera
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [DEFAULT_CENTER.lon, DEFAULT_CENTER.lat],
  zoom: 13.2,
  pitch: 0,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

let startMarker = null;
let endMarker = null;
let greenAreas = null;
const shadeCache = {}; // hour -> geojson FeatureCollection

function ensureStartMarker(lon, lat) {
  if (!startMarker) {
    const el = document.createElement("div");
    el.className = "start-marker";
    startMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
  } else {
    startMarker.setLngLat([lon, lat]);
  }
}

function add3dBuildings() {
  // The positron style ships openmaptiles building footprints with
  // render_height — extrude them for the 3D city look.
  const style = map.getStyle();
  const vecId = Object.keys(style.sources).find((k) => style.sources[k].type === "vector");
  if (!vecId) return;
  const firstSymbol = style.layers.find((l) => l.type === "symbol")?.id;
  map.addLayer(
    {
      id: "stride-3d-buildings",
      type: "fill-extrusion",
      source: vecId,
      "source-layer": "building",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": "#e9e5da",
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 5],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.72,
      },
    },
    firstSymbol
  );
}

function setSunLight(hour) {
  // Light the 3D buildings from the real sun direction of the chosen hour.
  if (hour && SUN[hour]) {
    const { az, el } = SUN[hour];
    map.setLight({ anchor: "map", position: [1.3, az, 90 - el], intensity: 0.35 });
  } else {
    map.setLight({ anchor: "viewport", position: [1.15, 210, 30], intensity: 0.25 });
  }
}

map.on("load", async () => {
  add3dBuildings();
  setSunLight(null);

  // Green overlay (Phase 1)
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

  // Shade overlay (Phase 2) — polygons swapped per selected hour
  map.addSource("shade-areas", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "shade-fill",
    type: "fill",
    source: "shade-areas",
    layout: { visibility: "none" },
    paint: {
      "fill-color": "#31456b",
      "fill-opacity": 0,
      "fill-opacity-transition": { duration: REDUCED ? 0 : 450 },
    },
  });
  map.addLayer({
    id: "shade-outline",
    type: "line",
    source: "shade-areas",
    layout: { visibility: "none" },
    paint: { "line-color": "#31456b", "line-opacity": 0.35, "line-width": 0.8 },
  });

  // Comparison route (regular profile) — slate dashed, under the main line
  map.addSource("route-alt", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "route-alt-line",
    type: "line",
    source: "route-alt",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": "#5b6b60",
      "line-width": 4,
      "line-opacity": 0.75,
      "line-dasharray": [2, 1.5],
    },
  });

  // Main route — white casing + brand green line
  map.addSource("route", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
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

  ensureStartMarker(DEFAULT_CENTER.lon, DEFAULT_CENTER.lat);

  // Cinematic intro — tilt into the 3D city
  if (!REDUCED) {
    map.easeTo({ pitch: 56, bearing: -18, zoom: 14.4, duration: 2400 });
  } else {
    map.jumpTo({ pitch: 45, zoom: 14.4 });
  }
});

// Click on the map to move the start point
map.on("click", (e) => {
  setStart(e.lngLat.lat, e.lngLat.lng);
  setStatus("Partida movida. Toque em <b>Gerar caminhada</b>.", "");
});

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");

function setStatus(html, kind) {
  statusEl.className = kind || "";
  statusEl.innerHTML = html;
}

function fmtKm(meters) {
  return `${(meters / 1000).toFixed(2).replace(".", ",")} km`;
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

function setStart(lat, lon) {
  document.getElementById("lat").value = lat.toFixed(6);
  document.getElementById("lon").value = lon.toFixed(6);
  document.getElementById("coords").textContent = `${lat.toFixed(4).replace(".", ",").replace("-", "−")} · ${lon
    .toFixed(4)
    .replace(".", ",")
    .replace("-", "−")}`;
  ensureStartMarker(lon, lat);
}

// ---------------------------------------------------------------------------
// Route rendering — draw-in animation, stats, loop check
// ---------------------------------------------------------------------------
let drawToken = 0;

function animateRoute(coords) {
  const token = ++drawToken;
  const src = map.getSource("route");
  const setSlice = (upto) =>
    src.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords.slice(0, upto) },
          properties: {},
        },
      ],
    });

  if (REDUCED || coords.length < 3) {
    setSlice(coords.length);
    return;
  }
  const t0 = performance.now();
  const DUR = 1300;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function frame(now) {
    if (token !== drawToken) return; // a newer route started drawing
    const t = Math.min(1, (now - t0) / DUR);
    setSlice(Math.max(2, Math.round(ease(t) * coords.length)));
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function fitPadding() {
  return window.innerWidth > 720
    ? { left: 396, top: 84, right: 84, bottom: 84 }
    : { left: 36, right: 36, top: 72, bottom: Math.round(window.innerHeight * 0.55) };
}

function drawRoute(ghResponse, { isSample = false } = {}) {
  const path = ghResponse.paths && ghResponse.paths[0];
  if (!path || !path.points || !path.points.coordinates) {
    throw new Error("Resposta sem paths[0].points.coordinates (points_encoded=false?)");
  }
  const coords = path.points.coordinates; // [lon, lat, (ele)]
  const flat = coords.map((c) => [c[0], c[1]]);

  animateRoute(flat);

  const first = coords[0];
  const last = coords[coords.length - 1];

  // Loop check: haversine gap between first and last coordinate
  const gapMeters = haversine(first[1], first[0], last[1], last[0]);
  const closes = gapMeters < 30;

  ensureStartMarker(first[0], first[1]);
  if (endMarker) {
    endMarker.remove();
    endMarker = null;
  }
  if (!closes) {
    endMarker = new maplibregl.Marker({ color: "#b3402f", scale: 0.8 })
      .setLngLat([last[0], last[1]])
      .addTo(map);
  }

  const bounds = flat.reduce(
    (b, c) => b.extend(c),
    new maplibregl.LngLatBounds(flat[0], flat[0])
  );
  map.fitBounds(bounds, {
    padding: fitPadding(),
    maxZoom: 16.5,
    duration: REDUCED ? 0 : 1400,
  });

  statsEl.hidden = false;
  document.getElementById("stat-distance").textContent = fmtKm(path.distance);
  document.getElementById("stat-duration").textContent = fmtDuration(path.time);

  const loopEl = document.getElementById("stat-loop");
  loopEl.textContent = closes
    ? `✓ Volta ao início · desvio ${gapMeters.toFixed(1).replace(".", ",")} m`
    : `✗ Não fecha o circuito · ${gapMeters.toFixed(0)} m de distância`;
  loopEl.classList.toggle("is-open", !closes);

  const gf = fractionIn(flat, greenAreas);
  document.getElementById("stat-green").textContent =
    gf === null ? "—" : `${Math.round(gf * 100)}%`;
  const sf = fractionIn(flat, activeShade());
  document.getElementById("stat-shade").textContent =
    sf === null ? "—" : `${Math.round(sf * 100)}%`;

  const sampleBadge = isSample
    ? ' <span class="sample-badge">AMOSTRA — não é rota real</span>'
    : "";
  setStatus(
    (isSample ? "Exibindo resposta de exemplo." : "Caminhada gerada.") + sampleBadge,
    isSample ? "warn" : "ok"
  );
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Length-weighted overlap stats (validated methodology — see README)
// ---------------------------------------------------------------------------
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inCollection(lon, lat, fc) {
  if (!fc) return false;
  if (!fc._bboxes) {
    fc._bboxes = fc.features.map((f) => {
      const ring = f.geometry.coordinates[0];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return [minX, minY, maxX, maxY];
    });
  }
  for (let i = 0; i < fc.features.length; i++) {
    const [minX, minY, maxX, maxY] = fc._bboxes[i];
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    if (pointInRing(lon, lat, fc.features[i].geometry.coordinates[0])) return true;
  }
  return false;
}

function fractionIn(coords, fc) {
  if (!fc || coords.length < 2) return null;
  let total = 0, hit = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    const len = haversine(y1, x1, y2, x2);
    total += len;
    if (inCollection((x1 + x2) / 2, (y1 + y2) / 2, fc)) hit += len;
  }
  return total ? hit / total : 0;
}

// ---------------------------------------------------------------------------
// GraphHopper request
// ---------------------------------------------------------------------------
async function generateRoute(lat, lon, distanceKm, seed, profile = "foot") {
  const params = new URLSearchParams({
    point: `${lat},${lon}`,
    profile,
    algorithm: "round_trip",
    "round_trip.distance": String(Math.round(distanceKm * 1000)),
    "round_trip.seed": String(seed),
    points_encoded: "false",
    "ch.disable": "true",
  });

  const res = await fetch(`${GRAPHHOPPER_URL}?${params}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && body.message ? body.message : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Preference state (Phase 1 green / Phase 2 shade) + the sun arc
// ---------------------------------------------------------------------------
const PROFILES = {
  none: "foot",
  green: "foot_green",
  shade_9: "foot_shade_9",
  shade_12: "foot_shade_12",
  shade_15: "foot_shade_15",
};
const PREF_LABELS = {
  green: "verde",
  shade_9: "sombra 9h",
  shade_12: "sombra 12h",
  shade_15: "sombra 15h",
};

let pref = "none"; // none | green | shade
let hour = 15; // 9 | 12 | 15

function currentPref() {
  return pref === "shade" ? `shade_${hour}` : pref;
}

function activeShade() {
  return pref === "shade" ? shadeCache[hour] || null : null;
}

function prefCollection() {
  if (pref === "green") return greenAreas;
  return activeShade();
}

// Sun arc geometry: semicircle r=80 centered at (100, 92) in the SVG viewBox.
// 9h rises on the left, 12h at the top, 15h descends right.
const ARC_ANGLE = { 9: 150, 12: 90, 15: 30 };
const CARDINAL = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];

function updateSunArc() {
  const a = (ARC_ANGLE[hour] * Math.PI) / 180;
  const x = 100 + 80 * Math.cos(a);
  const y = 92 - 80 * Math.sin(a);
  document.getElementById("sun-dot").style.transform = `translate(${x}px, ${y}px)`;

  const sun = SUN[hour];
  const dir = CARDINAL[Math.round(sun.az / 45) % 8];
  document.getElementById("sun-info").textContent =
    `${hour}h · sol a ${dir}, ${Math.round(sun.el)}° acima do horizonte`;
}

async function applyPreferenceOverlays() {
  const isShade = pref === "shade";

  if (isShade && !shadeCache[hour]) {
    try {
      const fc = await fetch(`/shade-${hour}.geojson`).then((r) => r.json());
      shadeCache[hour] = fc;
      // Refresh the baked sun constants from the pipeline's own output
      if (fc.properties?.sun_azimuth_deg != null) {
        SUN[hour] = { az: fc.properties.sun_azimuth_deg, el: fc.properties.sun_elevation_deg };
      }
    } catch {
      shadeCache[hour] = null;
    }
  }
  if (isShade && shadeCache[hour]) {
    const src = map.getSource("shade-areas");
    if (src) src.setData(shadeCache[hour]);
  }

  for (const layer of ["green-fill", "green-outline"]) {
    if (map.getLayer(layer)) {
      map.setLayoutProperty(layer, "visibility", pref === "green" ? "visible" : "none");
    }
  }
  for (const layer of ["shade-fill", "shade-outline"]) {
    if (map.getLayer(layer)) {
      map.setLayoutProperty(layer, "visibility", isShade ? "visible" : "none");
    }
  }
  if (map.getLayer("shade-fill")) {
    map.setPaintProperty("shade-fill", "fill-opacity", isShade ? 0.3 : 0);
  }

  // Ambient hour tint + sun-true 3D lighting
  document.body.dataset.hour = isShade ? String(hour) : "";
  setSunLight(isShade ? hour : null);
  document.getElementById("sun-arc").hidden = !isShade;
  if (isShade) updateSunArc();
}

// Segmented preference control
document.querySelectorAll("#pref-segment .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    pref = btn.dataset.pref;
    document.querySelectorAll("#pref-segment .seg").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-checked", String(active));
    });
    applyPreferenceOverlays();
  });
});

// Hour chips
document.querySelectorAll(".hour").forEach((btn) => {
  btn.addEventListener("click", () => {
    hour = parseInt(btn.dataset.hour, 10);
    document.querySelectorAll(".hour").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-checked", String(active));
    });
    applyPreferenceOverlays();
  });
});

// Distance chips
document.querySelectorAll("#distance-chips .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("distance").value = btn.dataset.km;
    document
      .querySelectorAll("#distance-chips .chip")
      .forEach((b) => b.classList.toggle("is-active", b === btn));
  });
});
document.getElementById("distance").addEventListener("input", (e) => {
  document
    .querySelectorAll("#distance-chips .chip")
    .forEach((b) => b.classList.toggle("is-active", b.dataset.km === e.target.value));
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
      const inside =
        lon >= BBOX.lonMin && lon <= BBOX.lonMax && lat >= BBOX.latMin && lat <= BBOX.latMax;
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

function readForm() {
  return {
    lat: parseFloat(document.getElementById("lat").value),
    lon: parseFloat(document.getElementById("lon").value),
    km: parseFloat(document.getElementById("distance").value),
    seed: parseInt(document.getElementById("seed").value || "0", 10),
    profile: PROFILES[currentPref()] || "foot",
  };
}

function clearAltRoute() {
  const src = map.getSource("route-alt");
  if (src) src.setData({ type: "FeatureCollection", features: [] });
}

function setBusy(btn, busy) {
  btn.disabled = busy;
  btn.classList.toggle("is-busy", busy);
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
document.getElementById("route-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { lat, lon, km, seed, profile } = readForm();

  const btn = document.getElementById("generate");
  setBusy(btn, true);
  clearAltRoute();
  await applyPreferenceOverlays();
  setStatus("Traçando a caminhada…", "");

  try {
    const response = await generateRoute(lat, lon, km, seed, profile);
    drawRoute(response);
  } catch (err) {
    // GraphHopper unreachable → bundled SAMPLE fallback, clearly labeled.
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
// Compare — same start/distance/seed, regular vs. the selected preference
// ---------------------------------------------------------------------------
document.getElementById("compare").addEventListener("click", async () => {
  const { lat, lon, km, seed, profile } = readForm();
  const key = currentPref();
  if (key === "none") {
    setStatus("Escolha uma prioridade (verde ou sombra) para comparar com a rota normal.", "warn");
    return;
  }
  const btn = document.getElementById("compare");
  setBusy(btn, true);
  await applyPreferenceOverlays();
  setStatus("Traçando as duas caminhadas…", "");

  try {
    const [regular, preferred] = await Promise.all([
      generateRoute(lat, lon, km, seed, "foot"),
      generateRoute(lat, lon, km, seed, profile),
    ]);

    // Slate dashed = regular; solid green = preference-aware (on top)
    const regCoords = regular.paths[0].points.coordinates.map((c) => [c[0], c[1]]);
    map.getSource("route-alt").setData({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: regCoords }, properties: {} },
      ],
    });
    drawRoute(preferred);

    const fc = prefCollection();
    const metric = PREF_LABELS[key];
    const fReg = fractionIn(regCoords, fc);
    const fPref = fractionIn(
      preferred.paths[0].points.coordinates.map((c) => [c[0], c[1]]),
      fc
    );
    const pct = (f) => (f === null ? "?" : `${Math.round(f * 100)}%`);
    setStatus(
      `<b>Variação ${seed}:</b> ` +
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

// Initial UI state
setStart(DEFAULT_CENTER.lat, DEFAULT_CENTER.lon);
updateSunArc();
