import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const GRAPHHOPPER_URL = "http://localhost:8989/route";
const DEFAULT_CENTER = { lat: -22.8164, lon: -45.1927 }; // Guaratinguetá-SP center
const BBOX = { lonMin: -45.3, latMin: -22.92, lonMax: -45.08, latMax: -22.7 };
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Shade is pre-baked at whole hours (build_shade_areas.py). shade-index.json
// lists each baked hour with the real sun azimuth/elevation from the pipeline.
// The slider is continuous; the sun dot/light interpolate between baked hours,
// while the shadow polygons snap to the nearest baked hour.
let BAKED_HOURS = [9, 12, 15]; // replaced by the manifest on load
const SUN_BY_HOUR = { 9: { az: 47.7, el: 25.8 }, 12: { az: 1.6, el: 44.2 }, 15: { az: 314.1, el: 27.6 } };

function nearestBaked(h) {
  return BAKED_HOURS.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
}

// Continuous sun az/el, linearly interpolated between the two baked hours that
// bracket `h`. Azimuth is unwrapped so it doesn't jump across 360→0 at noon.
function sunAt(h) {
  const lo = [...BAKED_HOURS].reverse().find((x) => x <= h) ?? BAKED_HOURS[0];
  const hi = BAKED_HOURS.find((x) => x >= h) ?? BAKED_HOURS[BAKED_HOURS.length - 1];
  const a = SUN_BY_HOUR[lo], b = SUN_BY_HOUR[hi];
  if (!a || !b) return a || b || { az: 0, el: 30 };
  if (lo === hi) return a;
  const t = (h - lo) / (hi - lo);
  let az0 = a.az, az1 = b.az;
  if (Math.abs(az1 - az0) > 180) az1 += az1 < az0 ? 360 : -360; // shortest arc
  return { az: (az0 + (az1 - az0) * t + 360) % 360, el: a.el + (b.el - a.el) * t };
}

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

// Vertical exaggeration for the 3D blocks — the footprints are mostly 1-story
// houses (~4 m); a straight extrusion is invisible under a tilted camera. A
// constant multiplier keeps the *relative* heights honest (a church still
// towers over a house) while giving the city real presence.
const HEIGHT_EXAGGERATION = 2.6;

async function add3dBuildings() {
  // Hide OpenMapTiles' own sparse building layer — we replace it with the same
  // footprints that cast the shadows, so blocks and shade line up.
  for (const layer of map.getStyle().layers) {
    if (layer.id.includes("building")) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }

  let buildings;
  try {
    buildings = await fetch("/buildings.geojson").then((r) => r.json());
  } catch {
    return; // routing still works without the 3D layer
  }
  map.addSource("buildings", { type: "geojson", data: buildings });

  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addLayer(
    {
      id: "stride-3d-buildings",
      type: "fill-extrusion",
      source: "buildings",
      minzoom: 12.5,
      paint: {
        // Warm-to-cool by height so volume reads even in flat afternoon light
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
    firstSymbol
  );
}

function setSunLight(hourOrNull) {
  // Light the 3D buildings from the real sun direction of the chosen hour.
  if (hourOrNull != null) {
    const { az, el } = sunAt(hourOrNull);
    map.setLight({ anchor: "map", position: [1.3, az, 90 - el], intensity: 0.35 });
  } else {
    map.setLight({ anchor: "viewport", position: [1.15, 210, 30], intensity: 0.25 });
  }
}

function addHillshade() {
  // Terrain relief (Phase 4) — the city sits at ~530 m with the Serra da
  // Mantiqueira around it. Open, keyless terrarium-encoded DEM tiles.
  try {
    map.addSource("dem", {
      type: "raster-dem",
      tiles: ["https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 15,
      attribution: "Elevation: Mapzen/AWS Terrain Tiles",
    });
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
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
      firstSymbol
    );
  } catch {
    // Optional — the map works without relief.
  }
}

map.on("load", async () => {
  addHillshade();
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

  // Shade overlay (Phase 2) — two layers cross-dissolve between the baked hours
  // that bracket the slider, so dragging the sun is continuous (no hard snap and
  // no per-tick re-parse: only cheap opacity changes while inside an hour span).
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

  // Elevation (Phase 4): total climb, altitude range, profile chart
  document.getElementById("stat-ascent").textContent =
    path.ascend != null ? `${Math.round(path.ascend)} m` : "—";
  const eles = coords.map((c) => c[2]).filter((v) => typeof v === "number");
  document.getElementById("stat-alt").textContent = eles.length
    ? `${Math.round(Math.min(...eles))}–${Math.round(Math.max(...eles))} m`
    : "—";
  drawElevationProfile(coords, eles);

  const sampleBadge = isSample
    ? ' <span class="sample-badge">AMOSTRA — não é rota real</span>'
    : "";
  setStatus(
    (isSample ? "Exibindo resposta de exemplo." : "Caminhada gerada.") + sampleBadge,
    isSample ? "warn" : "ok"
  );
}

// Elevation profile — area+line chart of altitude along the route, x by real
// cumulative distance so climbs sit where they happen.
function drawElevationProfile(coords, eles) {
  const fig = document.getElementById("elev-profile");
  if (eles.length < 2) {
    fig.hidden = true;
    return;
  }
  const W = 260, H = 60, TOP = 6, BOT = 52;
  const minE = Math.min(...eles), maxE = Math.max(...eles);
  const span = Math.max(1, maxE - minE);

  const dist = [0];
  for (let i = 1; i < coords.length; i++) {
    dist.push(dist[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  const total = dist[dist.length - 1] || 1;

  const pts = coords.map((c, i) => {
    const x = (dist[i] / total) * W;
    const y = TOP + (1 - (c[2] - minE) / span) * (BOT - TOP);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const line = "M" + pts.join(" L");
  document.getElementById("elev-line").setAttribute("d", line);
  document.getElementById("elev-area").setAttribute("d", `${line} L${W} ${BOT} L0 ${BOT} Z`);
  fig.hidden = false;
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
async function generateRoute(lat, lon, distanceKm, seed, spec = {}) {
  const profile = spec.profile || "foot";
  const cm = spec.customModel || null;
  const base = {
    profile,
    algorithm: "round_trip",
    "round_trip.distance": Math.round(distanceKm * 1000),
    "round_trip.seed": seed,
    points_encoded: false,
    "ch.disable": true,
    elevation: true, // 3rd coordinate + ascend/descend for the profile chart
  };

  let res;
  if (cm) {
    // Per-request shade model → POST with custom_model in the body.
    res = await fetch(GRAPHHOPPER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [[lon, lat]], ...base, custom_model: cm }),
    });
  } else {
    const params = new URLSearchParams({ point: `${lat},${lon}` });
    for (const [k, v] of Object.entries(base)) params.set(k, String(v));
    res = await fetch(`${GRAPHHOPPER_URL}?${params}`);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && body.message ? body.message : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// GraphHopper's round_trip only *targets* a distance — the heading it picks
// from the seed can send a loop wildly over (a 10 km request measured anywhere
// from 7 to 24 km). So try N seeds and keep a good one.
//
// When a preference is active (rankFC = the shade/green polygons), don't just
// take the distance-closest: among the candidates within a distance band of the
// closest, take the one that overlaps the preference most. Otherwise a loop can
// hit the target distance while walking away from all the available shade.
const BEST_OF = 6;
const DIST_BAND = 0.08; // candidates within +8pp of the best distance error qualify

async function generateFaithful(lat, lon, distanceKm, baseSeed, spec, rankFC = null) {
  const target = distanceKm * 1000;
  const seeds = Array.from({ length: BEST_OF }, (_, i) => baseSeed + i);
  const settled = await Promise.all(
    seeds.map((s) =>
      generateRoute(lat, lon, distanceKm, s, spec).then((r) => {
        const coords = r.paths[0].points.coordinates.map((c) => [c[0], c[1]]);
        return {
          response: r,
          seed: s,
          distance: r.paths[0].distance,
          distErr: Math.abs(r.paths[0].distance - target) / target,
          metric: rankFC ? fractionIn(coords, rankFC) : null,
        };
      }, () => null)
    )
  );
  const ok = settled.filter(Boolean);
  if (!ok.length) throw new TypeError("no route"); // let caller show SAMPLE

  let chosen;
  if (rankFC) {
    const bestErr = Math.min(...ok.map((c) => c.distErr));
    const acceptable = ok.filter((c) => c.distErr <= bestErr + DIST_BAND);
    chosen = acceptable.sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0))[0];
  } else {
    chosen = ok.slice().sort((a, b) => a.distErr - b.distErr)[0];
  }
  return { ...chosen, tried: ok.length };
}

// ---------------------------------------------------------------------------
// Preference state (Phase 1 green / Phase 2 shade) + the sun arc
// ---------------------------------------------------------------------------
const shadeModelCache = {}; // integer hour -> GraphHopper custom_model (built from geojson)

let pref = "none"; // none | green | shade
let hour = 15; // continuous 8..17 while pref === shade

// Two-layer shade blend: source shade-a holds the baked hour below the slider,
// shade-b the one above; opacity cross-dissolves between them.
const SHADE_OPACITY = 0.32;
let aHour = null, bHour = null;

function shadeHour() {
  return nearestBaked(hour);
}

// The two baked hours bracketing the current slider position.
function bracket(h) {
  const lo = [...BAKED_HOURS].reverse().find((x) => x <= h) ?? BAKED_HOURS[0];
  const hi = BAKED_HOURS.find((x) => x >= h) ?? BAKED_HOURS[BAKED_HOURS.length - 1];
  return [lo, hi];
}

// Cross-dissolve the shade overlay to the slider's position. Loads the bracket
// hours if needed (async), then sets opacity by the fractional position — the
// per-tick work while dragging inside an hour is just two cheap opacity writes.
function updateShadeBlend() {
  const [lo, hi] = bracket(hour);
  const frac = hi > lo ? (hour - lo) / (hi - lo) : 0;

  const paint = () => {
    if (aHour !== lo && shadeCache[lo]) { map.getSource("shade-a").setData(shadeCache[lo]); aHour = lo; }
    if (bHour !== hi && shadeCache[hi]) { map.getSource("shade-b").setData(shadeCache[hi]); bHour = hi; }
    map.setPaintProperty("shade-a-fill", "fill-opacity", SHADE_OPACITY * (1 - frac));
    map.setPaintProperty("shade-b-fill", "fill-opacity", SHADE_OPACITY * frac);
  };

  if (shadeCache[lo] !== undefined && shadeCache[hi] !== undefined) {
    paint(); // both cached → synchronous, smooth while dragging
  } else {
    Promise.all([ensureShade(lo), ensureShade(hi)]).then(paint);
  }
}

function activeShade() {
  return pref === "shade" ? shadeCache[shadeHour()] || null : null;
}

function prefCollection() {
  if (pref === "green") return greenAreas;
  return activeShade();
}

// What to send GraphHopper for the current preference: green uses the static
// foot_green profile; shade uses foot + a per-request custom model (so any hour
// routes with no server restart), none uses plain foot.
function routingSpec() {
  if (pref === "green") return { profile: "foot_green", customModel: null };
  if (pref === "shade") return { profile: "foot", customModel: shadeModelCache[shadeHour()] || null };
  return { profile: "foot", customModel: null };
}

function prefLabel() {
  if (pref === "green") return "verde";
  if (pref === "shade") return `sombra ${fmtHour(hour)}`;
  return "";
}

// Build a GraphHopper custom model from a shade display geojson — polygons
// become `areas`, edges outside them get priority × 0.3. Verified to route
// identically to the committed shade_<h>.json files.
function buildShadeModel(fc) {
  const priority = fc.features.map((f, i) => ({
    [i === 0 ? "if" : "else_if"]: `in_${f.id}`,
    multiply_by: 1.0,
  }));
  priority.push({ else: "", multiply_by: 0.3 });
  return { priority, areas: { type: "FeatureCollection", features: fc.features } };
}

async function ensureShade(h) {
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

// --- continuous sun visuals --------------------------------------------------
const CARDINAL = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];

function fmtHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm === 0 ? `${hh}h` : `${hh}h${String(mm).padStart(2, "0")}`;
}

// Warm near the horizon (dawn/dusk), bright amber at high sun.
function sunColor(el) {
  const t = Math.max(0, Math.min(1, el / 45));
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  const low = [210, 105, 30], high = [242, 169, 59]; // #d2691e → #f2a93b
  return `rgb(${lerp(low[0], high[0])}, ${lerp(low[1], high[1])}, ${lerp(low[2], high[2])})`;
}

function updateSunArc() {
  const { az, el } = sunAt(hour);
  const x = 20 + 160 * ((hour - 7) / 10); // 7h left → 17h right
  const y = 92 - 80 * Math.max(0, Math.min(1, el / 50)); // height by real elevation
  document.getElementById("sun-dot").style.transform = `translate(${x}px, ${y}px)`;
  const dir = CARDINAL[Math.round(az / 45) % 8];
  document.getElementById("sun-info").textContent =
    `${fmtHour(hour)} · sol a ${dir}, ${Math.round(el)}° acima do horizonte`;
}

function applySunVisuals() {
  document.documentElement.style.setProperty("--sun", sunColor(sunAt(hour).el));
  setSunLight(hour);
  updateSunArc();
}

async function applyPreferenceOverlays() {
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

// Continuous sun slider — moves the sun, ambient tint and 3D light every frame,
// and cross-dissolves the shadow overlay between the bracketing baked hours.
const sunSlider = document.getElementById("sun-slider");
sunSlider.addEventListener("input", () => {
  hour = parseFloat(sunSlider.value);
  applySunVisuals();
  updateShadeBlend();
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
  const { lat, lon, km, seed } = readForm();

  const btn = document.getElementById("generate");
  setBusy(btn, true);
  clearAltRoute();
  await applyPreferenceOverlays();
  setStatus("Traçando a caminhada…", "");

  try {
    // Pass the preference polygons so best-of prefers the shadiest/greenest of
    // the distance-acceptable candidates, not just the distance-closest.
    const best = await generateFaithful(lat, lon, km, seed, routingSpec(), prefCollection());
    drawRoute(best.response);
    const offBy = Math.abs(best.distance - km * 1000) / (km * 1000);
    const note =
      offBy > 0.2
        ? " — a malha da região não tem um circuito mais próximo"
        : ` (melhor de ${best.tried} variações)`;
    setStatus(`Alvo ${km} km → ${fmtKm(best.distance)}${note}.`, "ok");
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
  const { lat, lon, km, seed } = readForm();
  if (pref === "none") {
    setStatus("Escolha uma prioridade (verde ou sombra) para comparar com a rota normal.", "warn");
    return;
  }
  const btn = document.getElementById("compare");
  setBusy(btn, true);
  await applyPreferenceOverlays();
  setStatus("Traçando as duas caminhadas…", "");

  try {
    // Pick the seed whose regular loop is closest to the target, then run the
    // preference on that SAME seed — faithful distance and a fair head-to-head.
    const best = await generateFaithful(lat, lon, km, seed, { profile: "foot", customModel: null });
    const regular = best.response;
    const preferred = await generateRoute(lat, lon, km, best.seed, routingSpec());

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
    const metric = prefLabel();
    const fReg = fractionIn(regCoords, fc);
    const fPref = fractionIn(
      preferred.paths[0].points.coordinates.map((c) => [c[0], c[1]]),
      fc
    );
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

// Initial UI state
setStart(DEFAULT_CENTER.lat, DEFAULT_CENTER.lon);
updateSunArc();

// Load the baked-hours manifest: which hours exist + their real sun az/el.
fetch("/shade-index.json")
  .then((r) => r.json())
  .then((idx) => {
    if (!Array.isArray(idx.hours) || !idx.hours.length) return;
    BAKED_HOURS = idx.hours.map((e) => e.h).sort((a, b) => a - b);
    for (const e of idx.hours) SUN_BY_HOUR[e.h] = { az: e.az, el: e.el };
    sunSlider.min = String(BAKED_HOURS[0]);
    sunSlider.max = String(BAKED_HOURS[BAKED_HOURS.length - 1]);
    updateSunArc();
  })
  .catch(() => {}); // falls back to the built-in 9/12/15
