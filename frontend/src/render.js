// Draw a GraphHopper route: animated draw-in, markers, fit, stats, elevation.
import maplibregl from "maplibre-gl";
import { map, ensureStartMarker, setEndMarker } from "./map.js";
import { REDUCED } from "./config.js";
import { haversine, fractionIn } from "./geo.js";
import { setStatus, fmtKm, fmtDuration } from "./ui.js";
import { activeShade, getGreenAreas } from "./shade.js";

let drawToken = 0;

function animateRoute(coords) {
  const token = ++drawToken;
  const src = map.getSource("route");
  const setSlice = (upto) =>
    src.setData({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: coords.slice(0, upto) }, properties: {} },
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

export function drawRoute(ghResponse, { isSample = false } = {}) {
  const path = ghResponse.paths && ghResponse.paths[0];
  if (!path || !path.points || !path.points.coordinates) {
    throw new Error("Resposta sem paths[0].points.coordinates (points_encoded=false?)");
  }
  const coords = path.points.coordinates; // [lon, lat, (ele)]
  const flat = coords.map((c) => [c[0], c[1]]);

  animateRoute(flat);

  const first = coords[0];
  const last = coords[coords.length - 1];

  const gapMeters = haversine(first[1], first[0], last[1], last[0]);
  const closes = gapMeters < 30;

  ensureStartMarker(first[0], first[1]);
  setEndMarker(closes ? null : [last[0], last[1]]);

  const bounds = flat.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(flat[0], flat[0]));
  map.fitBounds(bounds, { padding: fitPadding(), maxZoom: 16.5, duration: REDUCED ? 0 : 1400 });

  document.getElementById("stats").hidden = false;
  document.getElementById("stat-distance").textContent = fmtKm(path.distance);
  document.getElementById("stat-duration").textContent = fmtDuration(path.time);

  const loopEl = document.getElementById("stat-loop");
  loopEl.textContent = closes
    ? `✓ Volta ao início · desvio ${gapMeters.toFixed(1).replace(".", ",")} m`
    : `✗ Não fecha o circuito · ${gapMeters.toFixed(0)} m de distância`;
  loopEl.classList.toggle("is-open", !closes);

  const gf = fractionIn(flat, getGreenAreas());
  document.getElementById("stat-green").textContent = gf === null ? "—" : `${Math.round(gf * 100)}%`;
  const sf = fractionIn(flat, activeShade());
  document.getElementById("stat-shade").textContent = sf === null ? "—" : `${Math.round(sf * 100)}%`;

  document.getElementById("stat-ascent").textContent =
    path.ascend != null ? `${Math.round(path.ascend)} m` : "—";
  const eles = coords.map((c) => c[2]).filter((v) => typeof v === "number");
  document.getElementById("stat-alt").textContent = eles.length
    ? `${Math.round(Math.min(...eles))}–${Math.round(Math.max(...eles))} m`
    : "—";
  drawElevationProfile(coords, eles);

  const sampleBadge = isSample ? ' <span class="sample-badge">AMOSTRA — não é rota real</span>' : "";
  setStatus(
    (isSample ? "Exibindo resposta de exemplo." : "Caminhada gerada.") + sampleBadge,
    isSample ? "warn" : "ok"
  );
}
