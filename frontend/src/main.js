import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const GRAPHHOPPER_URL = "http://localhost:8989/route";
const DEFAULT_CENTER = { lat: -22.8164, lon: -45.1927 }; // Guaratinguetá-SP center

// ---------------------------------------------------------------------------
// Map setup — OSM raster tiles (fully open, no API key)
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "&copy; OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
  center: [DEFAULT_CENTER.lon, DEFAULT_CENTER.lat],
  zoom: 14,
});

let startMarker = null;
let endMarker = null;

// Green areas (Phase 1) — polygons extracted from OSM by
// backend/scripts/build_green_areas.py, shown as an overlay and used to
// compute the "% of route in green" stat.
let greenAreas = null;

map.on("load", async () => {
  // Green overlay goes first so routes draw on top of it.
  try {
    greenAreas = await fetch("/green-areas.geojson").then((r) => r.json());
    map.addSource("green-areas", { type: "geojson", data: greenAreas });
    map.addLayer({
      id: "green-fill",
      type: "fill",
      source: "green-areas",
      paint: { "fill-color": "#2f9e44", "fill-opacity": 0.16 },
    });
    map.addLayer({
      id: "green-outline",
      type: "line",
      source: "green-areas",
      paint: { "line-color": "#2f9e44", "line-opacity": 0.45, "line-width": 1 },
    });
  } catch {
    // Overlay is optional — routing still works without it.
  }

  // Comparison route (regular foot profile) — gray, drawn under the main line.
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

  map.addSource("route", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": "#256d46",
      "line-width": 5,
      "line-opacity": 0.85,
    },
  });
});

// Click on the map to move the start point
map.on("click", (e) => {
  document.getElementById("lat").value = e.lngLat.lat.toFixed(6);
  document.getElementById("lon").value = e.lngLat.lng.toFixed(6);
  setStatus("Start point moved. Click “Generate route”.", "");
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

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

// ---------------------------------------------------------------------------
// Route rendering
// ---------------------------------------------------------------------------
function drawRoute(ghResponse, { isSample = false } = {}) {
  const path = ghResponse.paths && ghResponse.paths[0];
  if (!path || !path.points || !path.points.coordinates) {
    throw new Error("Response has no paths[0].points.coordinates (is points_encoded=false set?)");
  }
  const coords = path.points.coordinates; // [lon, lat, (ele)]

  map.getSource("route").setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords.map((c) => [c[0], c[1]]) },
        properties: {},
      },
    ],
  });

  const first = coords[0];
  const last = coords[coords.length - 1];

  if (startMarker) startMarker.remove();
  if (endMarker) endMarker.remove();
  startMarker = new maplibregl.Marker({ color: "#256d46" })
    .setLngLat([first[0], first[1]])
    .setPopup(new maplibregl.Popup().setText("Start"))
    .addTo(map);
  endMarker = new maplibregl.Marker({ color: "#a3271f", scale: 0.8 })
    .setLngLat([last[0], last[1]])
    .setPopup(new maplibregl.Popup().setText("End"))
    .addTo(map);

  // Fit view to route
  const bounds = coords.reduce(
    (b, c) => b.extend([c[0], c[1]]),
    new maplibregl.LngLatBounds([first[0], first[1]], [first[0], first[1]])
  );
  map.fitBounds(bounds, { padding: 60 });

  // Loop check: distance between first and last coordinate (meters, haversine)
  const gapMeters = haversine(first[1], first[0], last[1], last[0]);
  const closes = gapMeters < 30;

  statsEl.hidden = false;
  document.getElementById("stat-distance").textContent = `${(path.distance / 1000).toFixed(2)} km`;
  document.getElementById("stat-duration").textContent = fmtDuration(path.time);
  document.getElementById("stat-loop").textContent = closes
    ? `yes (gap ${gapMeters.toFixed(1)} m)`
    : `NO — gap ${gapMeters.toFixed(1)} m`;

  const gf = greenFraction(coords.map((c) => [c[0], c[1]]));
  document.getElementById("stat-green").textContent =
    gf === null ? "–" : `${Math.round(gf * 100)}% of distance`;

  const sampleBadge = isSample
    ? ' <span class="sample-badge">SAMPLE DATA — not live routing</span>'
    : "";
  setStatus(
    (isSample ? "Rendered bundled sample response." : "Route generated by local GraphHopper.") +
      sampleBadge,
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
// Greenery stats — fraction of route points inside any green polygon
// ---------------------------------------------------------------------------
function pointInRing(lon, lat, ring) {
  // Ray casting
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

function inGreen(lon, lat) {
  if (!greenAreas) return false;
  // Precompute bounding boxes once for cheap rejection
  if (!greenAreas._bboxes) {
    greenAreas._bboxes = greenAreas.features.map((f) => {
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
  for (let i = 0; i < greenAreas.features.length; i++) {
    const [minX, minY, maxX, maxY] = greenAreas._bboxes[i];
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    if (pointInRing(lon, lat, greenAreas.features[i].geometry.coordinates[0])) return true;
  }
  return false;
}

// Length-weighted: fraction of route DISTANCE whose segment midpoint is in a
// green area (point-count fractions are biased by uneven point density).
function greenFraction(coords) {
  if (!greenAreas || coords.length < 2) return null;
  let total = 0, green = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    const len = haversine(y1, x1, y2, x2);
    total += len;
    if (inGreen((x1 + x2) / 2, (y1 + y2) / 2)) green += len;
  }
  return total ? green / total : 0;
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
// Form wiring
// ---------------------------------------------------------------------------
document.querySelectorAll(".preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("distance").value = btn.dataset.km;
  });
});

function readForm() {
  return {
    lat: parseFloat(document.getElementById("lat").value),
    lon: parseFloat(document.getElementById("lon").value),
    km: parseFloat(document.getElementById("distance").value),
    seed: parseInt(document.getElementById("seed").value || "0", 10),
    preferGreen: document.getElementById("prefer-green").checked,
  };
}

function clearAltRoute() {
  const src = map.getSource("route-alt");
  if (src) src.setData({ type: "FeatureCollection", features: [] });
}

document.getElementById("route-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { lat, lon, km, seed, preferGreen } = readForm();

  const btn = document.getElementById("generate");
  btn.disabled = true;
  clearAltRoute();
  setStatus("Generating route…", "");

  try {
    const response = await generateRoute(lat, lon, km, seed, preferGreen ? "foot_green" : "foot");
    drawRoute(response);
  } catch (err) {
    // GraphHopper unreachable → fall back to the bundled SAMPLE response so the
    // map still demonstrates rendering. Clearly labeled; never pretends to be live.
    if (err instanceof TypeError) {
      try {
        const sample = await fetch("/sample-route.json").then((r) => r.json());
        drawRoute(sample, { isSample: true });
        setStatus(
          'Could not reach GraphHopper at <code>localhost:8989</code>. ' +
            'Showing bundled <span class="sample-badge">SAMPLE</span> instead. ' +
            "Start the backend (see README) for live routing.",
          "warn"
        );
      } catch {
        setStatus("GraphHopper unreachable and sample missing: " + err.message, "error");
      }
    } else {
      setStatus("Routing error: " + err.message, "error");
    }
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Compare mode — same start/distance/seed, regular vs. greenery-aware profile
// ---------------------------------------------------------------------------
document.getElementById("compare").addEventListener("click", async () => {
  const { lat, lon, km, seed } = readForm();
  const btn = document.getElementById("compare");
  btn.disabled = true;
  setStatus("Generating both routes…", "");

  try {
    const [regular, green] = await Promise.all([
      generateRoute(lat, lon, km, seed, "foot"),
      generateRoute(lat, lon, km, seed, "foot_green"),
    ]);

    // Gray dashed = regular; solid green = greenery-aware (drawn on top)
    const regCoords = regular.paths[0].points.coordinates.map((c) => [c[0], c[1]]);
    map.getSource("route-alt").setData({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: regCoords }, properties: {} },
      ],
    });
    drawRoute(green);

    const gfReg = greenFraction(regCoords);
    const gfGreen = greenFraction(green.paths[0].points.coordinates.map((c) => [c[0], c[1]]));
    const pct = (f) => (f === null ? "?" : `${Math.round(f * 100)}%`);
    setStatus(
      `<b>Compare (seed ${seed}):</b> ` +
        `<span style="color:#5b6b60">regular ${(regular.paths[0].distance / 1000).toFixed(2)} km, ${pct(gfReg)} green</span> vs. ` +
        `<span style="color:#256d46"><b>green ${(green.paths[0].distance / 1000).toFixed(2)} km, ${pct(gfGreen)} green</b></span>`,
      "ok"
    );
  } catch (err) {
    setStatus(
      err instanceof TypeError
        ? "Compare needs live GraphHopper at <code>localhost:8989</code> (see README)."
        : "Routing error: " + err.message,
      "error"
    );
  } finally {
    btn.disabled = false;
  }
});
