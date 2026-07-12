# Stride

Walking-route **generator**: instead of recording a walk (Strava-style), Stride *decides*
the walk. Give it a start point and a target distance and it generates a **loop** route
that ends exactly where it started — preferring **green areas** (Phase 1) or **shade at a
given hour of day** (Phase 2), computed from real building footprints and solar geometry.

Scope so far: real loop routing in **Guaratinguetá-SP, Brazil** on 100% open-source
infrastructure — no paid APIs, no keys.

- **Routing:** [GraphHopper](https://github.com/graphhopper/graphhopper) 11.0 (Apache 2.0),
  profiles `foot`, `foot_green`, `foot_shade_{9,12,15}`, `algorithm=round_trip`,
  flexible mode (no CH).
- **Data:** OpenStreetMap extract via Overpass (bbox lon `-45.30..-45.08`,
  lat `-22.92..-22.70`) + [Microsoft Global ML Building Footprints](https://github.com/microsoft/GlobalMLBuildingFootprints)
  (ODbL) for shadow casting.
- **Frontend:** [MapLibre GL JS](https://maplibre.org/) + Vite, vanilla JS. OSM raster tiles.

**Measured results (8 random seeds, 6 km target, length-weighted metrics):**

| Profile | Metric | Regular | Preference-aware | Wins | Route length |
|---|---|---|---|---|---|
| `foot_green` | share in/along green areas | 9.4% | **13.1%** | 7/8 | ±2% |
| `foot_shade_9` | share in 9 am shade | 10.7% | **18.6%** | **8/8** | +4.5% |
| `foot_shade_15` | share in 3 pm shade | 9.7% | **15.0%** | 7/8 | +5.7% |

Best single cases: a loop that was **0.5% shaded goes to 16.8%** (9 am, seed 0);
**0.9% → 20.9%** (3 pm, seed 5). All loops close with a 0.0 m gap.

---

## Prerequisites

| Tool | Version | Install (if missing) |
|---|---|---|
| Java (JDK) | 17+ | `winget install Microsoft.OpenJDK.17` |
| Node.js | 18+ | `winget install OpenJS.NodeJS.LTS` |

Check: `java -version` and `node --version`.

## Run it (Windows PowerShell)

All commands from the repo root.

### 1. One-time setup — download the big files (not versioned in git)

```powershell
# GraphHopper server jar (~45 MB, Maven Central)
curl.exe -L -o backend/graphhopper-web-11.0.jar https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/11.0/graphhopper-web-11.0.jar

# OSM extract of Guaratinguetá (~24 MB, Overpass API bbox clip)
curl.exe -L -o backend/data/guaratingueta.osm "https://overpass-api.de/api/map?bbox=-45.30,-22.92,-45.08,-22.70"

# Frontend deps
npm install --prefix frontend

# Green-area polygons (generates backend/custom_models/green.json and
# frontend/public/green-areas.geojson from the OSM extract; stdlib-only Python)
python backend/scripts/build_green_areas.py
```

**Phase 2 (shade) — optional regeneration.** The shade custom models and overlays for
2026-07-03 at 9 h/12 h/15 h are committed, so the demo runs without this. To rebuild
for another date (or after changing the bbox):

```powershell
pip install shapely

# Microsoft ML building footprints for the bbox (~36 MB kept locally; the
# script streams one Brazil quadkey tile and filters to the bbox)
python backend/scripts/fetch_ms_buildings.py

# Shadow polygons + custom models for every daylight hour (also writes
# shade-index.json — the manifest the sun slider reads). Hours whose sun is
# below 8° are skipped automatically.
python backend/scripts/build_shade_areas.py --date 2026-07-03 --hours 8,9,10,11,12,13,14,15,16

# 3D buildings → vector tiles. Extract every footprint in the bbox to NDJSON,
# tile it (geojson-vt + vt-pbf), then pack into frontend/public/buildings.pmtiles.
# No Docker/tippecanoe needed.
python backend/scripts/build_buildings_3d.py
npm install --prefix backend/scripts/tiler
node backend/scripts/tiler/tile.js
python backend/scripts/tiler/pack_pmtiles.py   # needs: pip install pmtiles
```

### 2. Start the routing backend

```powershell
cd backend
java -Xmx2g -jar graphhopper-web-11.0.jar server config.yml
```

First start imports the OSM extract into `backend/graph-cache/` (a few seconds for this
extract). Ready when the log prints `Started Server`. Subsequent starts reuse the cache.

Smoke test in a second terminal:

```powershell
curl.exe "http://localhost:8989/route?point=-22.8164,-45.1927&profile=foot&algorithm=round_trip&round_trip.distance=6000&round_trip.seed=0&points_encoded=false&ch.disable=true"
```

### 3. Start the frontend

```powershell
npm run dev --prefix frontend
```

Open **http://localhost:5173**. Pick a distance (presets 3/6/10 km), click
**Generate route**. Click anywhere on the map to move the start point. Change the
**seed** to get a different loop for the same distance.

Pick a **route preference** — 🌳 green areas, or ⛅ shade at 9 h / 12 h / 15 h — and the
matching overlay appears on the map (green polygons or that hour's shadow map). Click
**Compare vs regular** to draw both routes for the same seed — regular in dashed gray,
preference-aware in solid green — with each route's green/shade share in the status line.

The panel shows distance, estimated duration, a **"Closes the loop"** check
(haversine gap between first and last route coordinate — should be `0.0 m`), and the
length-weighted shares **"In green areas"** and **"In shade"**.

## Honesty notes

- The frontend calls the local GraphHopper HTTP API directly
  (`http://localhost:8989/route`). GraphHopper 11 sends `Access-Control-Allow-Origin: *`,
  so no proxy is needed.
- If GraphHopper is **not** running, the app falls back to
  `frontend/public/sample-route.json` and labels the result **SAMPLE** in the UI —
  it never pretends to be live routing. The sample is a real GraphHopper response
  captured once during development.
- `round_trip.distance` is a *target*, not a guarantee — GraphHopper returns a loop
  *around* that length (e.g. a 6 km request may return ~4.3–7 km depending on the
  street graph and seed). The actual distance is always displayed.

## Repo layout

```
backend/
  config.yml                 GraphHopper config: foot, foot_green,
                             foot_shade_{9,12,15} profiles, flexible mode (no CH)
  custom_models/green.json   generated: green areas + priority rules
  custom_models/shade_*.json generated: per-hour shadow areas + priority rules
  scripts/build_green_areas.py   OSM → green polygons (model + overlay), stdlib-only
  scripts/fetch_ms_buildings.py  Microsoft ML footprints for the bbox, stdlib-only
  scripts/build_shade_areas.py   solar position + shadow casting → shade models (shapely)
  data/guaratingueta.osm     OSM extract (downloaded, gitignored)
  data/ms_buildings.geojsonl MS footprints (downloaded, gitignored)
  graphhopper-web-11.0.jar   server jar (downloaded, gitignored)
  graph-cache/               generated graph (gitignored)
frontend/
  index.html                 form: start point, distance, presets, seed,
                             route preference (green / shade@9/12/15), compare
  src/main.js                MapLibre map, GraphHopper call, green + shade
                             overlays, compare mode, length-weighted stats,
                             loop-closure check, SAMPLE fallback
  src/style.css
  public/green-areas.geojson generated green polygons for display
  public/shade-*.geojson     generated per-hour shadow maps (display + routing)
  public/shade-index.json    manifest: baked hours + sun position, read by the slider
  public/buildings.geojson   generated 3D building footprints (same as shadows)
  public/sample-route.json   offline fallback, clearly labeled SAMPLE
```

## Distance faithfulness (best-of-N)

`round_trip.distance` is only a *target*. The heading GraphHopper derives from the seed
can send a loop far past it: a 10 km request, measured across 8 seeds, returned 7.3,
**20.7**, 7.2, 9.0, **23.6**, 11.5, 9.3 and 15.7 km — not a systematic overshoot, just
high variance (some headings hit the river or a dead zone and detour). There is no
"allow overlap" knob in the engine to fix this.

So **Generate** runs 6 seeds and keeps a good loop. With no preference it takes the one
closest to the target (the 10 km case above becomes ~9 km instead of 20+). **With a
shade/green preference it takes the shadiest/greenest of the candidates within +8 pp of
the closest distance** — otherwise round_trip can hit the target distance while walking
away from all the available shade (measured: a 15 km 8 h loop went from 14 % → 29 % shade
just by picking a better candidate). **Compare** picks the seed by distance on the
regular profile, then runs the preference on that seed — faithful *and* a fair
head-to-head. **Surpreenda-me** skips best-of for a single random loop. If even the best
of 6 is >20 % off, the UI says so plainly.

## 3D buildings (vector tiles, streamed per viewport)

The map extrudes building footprints from **`frontend/public/buildings.pmtiles`** — a single
[PMTiles](https://github.com/protomaps/PMTiles) archive of vector tiles (z13–16). MapLibre
streams only the tiles in view via HTTP range requests, so panning to any neighbourhood
loads its blocks on demand ("video-game" loading) instead of downloading one big file.

The footprints are the **same** OSM + Microsoft ML buildings the shadow pipeline uses
(heights from the same model), now covering the **whole bbox** (~97 k buildings) rather
than a 3.2 km radius — earlier, areas a few km from the centre had no blocks at all.

Pipeline, all keyless and Docker-free:
1. `build_buildings_3d.py` → `backend/data/buildings.ndjson` (every footprint in the bbox).
2. `tiler/tile.js` ([geojson-vt](https://github.com/mapbox/geojson-vt) +
   [vt-pbf](https://github.com/mapbox/vt-pbf)) → MVT `.pbf` tiles.
3. `tiler/pack_pmtiles.py` (the `pmtiles` writer) → `buildings.pmtiles` (~5 MB, replaces the
   old 5 MB GeoJSON but with full coverage *and* viewport streaming).

Heights carry a constant ×2.6 vertical exaggeration for presence under the tilted camera —
relative heights stay honest (a church still towers over a house) — and the 3D lighting
follows the chosen hour's real sun azimuth/elevation.

## Why flexible mode (no CH)?

`algorithm=round_trip` is not supported by Contraction Hierarchies. `config.yml` sets
`profiles_ch: []` so no CH is prepared and every request runs flexible. The frontend
also sends `ch.disable=true`, which is a harmless no-op in this setup but keeps the
request correct against a server that *does* prepare CH.

## Phase 1 — greenery-aware walks (how it works)

GraphHopper profiles are driven by [custom models](https://github.com/graphhopper/graphhopper/blob/master/docs/core/custom-models.md)
(JSON `priority`/`speed` rules). Phase 1 uses **custom areas**: green polygons become
`areas` in the model, and edges *outside* all of them get `priority × 0.3`, so
`round_trip` gravitates toward loops through/along green space. No new encoded values,
no architecture change — same server, one more profile (`foot_green`).

`backend/scripts/build_green_areas.py` (stdlib-only) parses the OSM extract and emits
both the custom model and the display overlay. Three design decisions that came out of
**measuring, not guessing** (each was validated against live routing):

1. **Proximity-weighted selection, not raw area.** A pure top-N-by-area cut filled the
   model with rural woods: 92 green polygons lie within 3 km of the city center, but
   only 6 survived that cut — and routes measured ~0% green. Ranking by
   `area / (1 + (dist/1.5 km)²)` keeps the urban praças people actually walk through.
2. **~20 m outward buffer on every polygon.** Streets *along* a park's edge don't
   intersect the raw polygon, so they didn't count as green — but walking beside a park
   is the green experience. The buffer (crude centroid-offset, no dependencies) makes
   bordering streets match.
3. **Penalty tuned on data.** Non-green multipliers 0.55/0.4/0.3/0.2 were compared over
   8 seeds using request-side custom models (no server restarts):
   0.55 → +0.2 pp, 0.4 → +1.2 pp, **0.3 → +3.7 pp (7/8 seeds greener, distance ~same)**,
   0.2 → +4.4 pp with visibly longer routes. 0.3 is baked into the generated model.

Known limits (Phase 1, documented on purpose): multipolygon relations are skipped
(closed ways only); polygon selection is weighted around the demo center; the buffer is
approximate. Greenness is measured as the **length-weighted** share of route segments
whose midpoint falls in a green polygon — point-count shares are biased by uneven
point density and were abandoned.

## Dark mode

A 🌙/☀️ toggle (persisted; defaults to the OS `prefers-color-scheme`) themes the whole UI via
CSS variables and swaps the base map between OpenFreeMap **positron** (light) and **dark**.
Swapping the style drops custom sources/layers, so `buildLayers()` rebuilds them (buildings,
hillshade, shade/green, route, walked) and restores the drawn route; the 3D buildings and
hillshade pick darker palettes in dark mode so they don't wash out the dark base.

## City explored (%)

`build_grid.py` counts the walkable **street cells** in the bbox on a ~150 m grid (8 251 here)
— the denominator. At runtime `exploredStats()` counts the distinct cells the saved walks
touch and shows "🗺️ 0,7% de Guaratinguetá · 58 de 8251 quarteirões" with a progress bar, plus a
green **walked-streets overlay** on the map ("your territory"). All from localStorage, no backend.

## Avoid already-walked streets (discovery)

When there are saved walks, an "Evitar ruas que já andei" toggle appears. `discovery.js`
buffers the saved routes into thin corridor polygons and hands them to GraphHopper as
**penalized areas** (`multiply_by 0.2`), merged with the current preference model. The real
lever is selection: best-of ranks candidates by *least reuse* of those corridors, which drops
the overlap with already-walked streets from ~69 % (penalty alone) to ~1 % — so each walk
explores new ground. Reuses the same areas/custom-model mechanism as shade.

## Saved walks

`storage.js` keeps walks in `localStorage` (no backend). "Salvar" (shown with a route)
stores enough of the GraphHopper path — coordinates, instructions, distance, time — to
redraw and re-navigate it offline. "Minhas caminhadas" lists them with load (tap to
redraw), 👍/👎 rating, ★ favorite, and delete; capped at 30.

## Live navigation

`navigation.js` follows the walker along a generated route. `setRoute` stores the GraphHopper
path (coordinates, cumulative distance, time, and turn instructions); `progressAt` snaps a live
position onto the route for progress / remaining / ETA and off-route detection (>35 m).
Positions come from the Geolocation API (`watchPosition`); `simulate()` fast-forwards a virtual
walker (~40 s) for desktop/demo.

Turn-by-turn requests instructions with `locale=pt`, maps each instruction's point interval to a
cumulative-distance span, and shows the next maneuver (icon + street + distance). **Voice**
(Web Speech API, pt-BR) announces each turn once when ~120 m ahead and again at the maneuver;
a 🔊/🔇 button mutes it. Map recenter is throttled to 1 s so the 3D renderer doesn't thrash.

During navigation the camera enters a **GPS mode** — it zooms onto the walker and follows
(easeTo, throttled), and the panel shows four live metrics: remaining, distance covered,
**pace (min/km)**, and arrival ETA. Pace is real elapsed/covered while walking, or the route's
average during a simulation (sim time is a fast-forward).

**Share** (Web Share API, clipboard fallback): after a route, "Compartilhar caminhada" shares
distance + duration + a Google Maps link to the start; during a walk, "Compartilhar" shares the
remaining distance, arrival ETA, and a Maps link to the live position ("Estou caminhando…").

## Pass by a POI

`build_pois.py` extracts points of interest from the OSM extract into
`frontend/public/pois.geojson` — café, mirante (viewpoint), água (drinking water/fountain),
parque (this extract: 4 / 3 / 8 / 205). The "Passar por" chips pick a type; `pois.js` finds
the nearest one to the start and routes **A → POI → A** (out-and-back via `generateThrough`),
so it closes the loop and marks the POI. Guaratinguetá example: 🌄 Mirante do Cruzeiro is a
12.4 km round trip climbing 522 m to a hilltop viewpoint.

## Loop or A→B

A mode toggle at the top of the form: **Circuito** (the round_trip loop) or **Ida A→B**. In
A→B mode the loop-only controls (objective, distance, variation, compare) hide, a Destino
field appears, and tapping the map sets the destination (B); the start (A) stays your
location. Generate then routes point-to-point (`generatePointToPoint`, no round_trip /
best-of) — green and shade preferences still apply via the profile / per-request custom
model, and the loop-closure pill becomes "➡️ Ida até o destino".

## Distance or duration

The distance control has a **km / min** toggle. In "min" mode the chips become 30/45/60 min
and the input is minutes; on generate it converts to km at GraphHopper's foot pace
(~5 km/h, `MIN_PER_KM = 12`) so "45 min" targets ~3.75 km and the stats show the actual
time. Objectives and the weather card always set km and flip the toggle back.

## Objectives

One-tap "how do you want to walk today" shortcuts (`intent.js`): Relaxar, Treino, Explorar,
Com o cão, Fotografia. Each maps to concrete settings — distance + preference (+ shade hour,
+ a random seed for Explorar) — reusing the same `selectPref()`/`setDistance()` controls the
weather card uses, then generates immediately. Fine-tuning any control afterward de-selects
the objective.

## Weather suggestions

On load (and after geolocating), Stride reads the current conditions near the start point
from [open-meteo](https://open-meteo.com) (free, no key) and shows a one-tap suggestion:
hot + sunny → **prefer shade at the current hour** (straight into the shade engine); rain
likely in the next hours → a **shorter loop**; mild → **explore the green**; night → a note
to stay on familiar streets. `weather.js` fetches and interprets; "Aplicar" wires the
suggestion into the existing preference/distance controls. It's an enhancement — if the
request fails, the card just stays hidden.

## Elevation & relief

GraphHopper imports **CGIAR SRTM** elevation (90 m, open, no key — downloaded on first
import into `backend/elevation-cache/`, gitignored). Routes then carry `ascend`/`descend`
and a 3rd elevation coordinate, so the panel shows **total climb**, the **altitude range**,
and an **elevation profile** chart (area+line, x by real cumulative distance). Guaratinguetá
sits at ~530 m and is fairly flat — a typical 7 km loop climbs ~130 m.

The map adds a **hillshade** layer from open terrarium-encoded DEM tiles (Mapzen/AWS Terrain
Tiles) to show the relief — subtle downtown, clearer toward the river valley and the hills.
`average_slope`/`max_slope` encoded values are imported too, ready for a flat-vs-hilly
routing preference (not yet wired — the terrain here is gentle enough that it's a small
follow-up). 3D terrain (raising the ground mesh) is left out for now because it would need
the building extrusions re-based onto the terrain.

## Phase 2 — shade-aware walks (how it works)

The idea (inspired by [CoolWalks, arXiv:2405.01225](https://arxiv.org/abs/2405.01225)):
walking comfort depends on *when* you walk. For each preset local hour, Stride computes
the city's shadow map and routes through it, using the exact mechanism validated in
Phase 1 — a generated custom model whose areas are the shadows.

Pipeline (`backend/scripts/build_shade_areas.py`, needs shapely):

1. **Sun position** — NOAA solar position (pure Python, ±0.2°). Sanity check that the
   physics is right: on 2026-07-03 (southern winter) at this latitude the noon sun sits
   at azimuth 1.6° — **due north** — elevation 44°, exactly as it should below the
   Tropic of Capricorn in July.
2. **Obstacles** — buildings, trees, tree rows and woods. OSM building coverage here is
   too sparse to be credible (measured: **93 buildings within 1 km** of the demo center,
   2,299 of 2,742 beyond 3 km), so footprints come primarily from **Microsoft's ML
   dataset**: 96,754 buildings in the bbox — 35× OSM — of which ~28k fall in the 4 km
   working radius.
3. **Shadow casting** — each obstacle casts `height / tan(elevation)` meters of shadow
   away from the sun (footprint + translated footprint + a quad per edge), ~208k pieces
   unioned with shapely, simplified, largest 250 polygons kept per hour.
4. **Routing** — edges not touching that hour's shade get `priority × 0.3` (the
   multiplier tuned in Phase 1), via a **per-request custom model** posted in the route
   body. The frontend builds that model in JS from the display geojson itself (verified
   to route identically to the committed `shade_<H>.json`), so any hour routes with no
   server restart and no per-hour profiles.

**Dynamic time-of-day.** Daylight is baked hour by hour (8–17 h on 2026-07-03; hours whose
sun is below 4° — before ~7:30 and after ~17:15 in this winter month — are skipped) and
the sun becomes a **continuous slider**. Dragging it moves the sun, the 3D sunlight and the
UI tint *continuously* (azimuth/elevation interpolated between the two bracketing baked
hours, via `shade-index.json`). The shadow overlay **cross-dissolves** between those two
baked hours across a two-layer blend — so there's no hard snap and, crucially, no per-tick
re-parse: dragging inside an hour only writes two fill-opacities. Routing still snaps to the
nearest baked hour (a route is for one time). Earlier hours (a 6 h summer walk) or arbitrary
dates would need a denser bake per date or an on-demand compute service — a documented next
step, not in this build.

Honest limitations, on purpose:

- **Heights are mostly defaults** (4 m houses, 12 m churches, `building:levels`×3 when
  tagged — only 59 of 2.7k OSM buildings carry height data; MS estimates used when
  present). The shadow map is a *realistic relative preference*, not survey-grade.
- Shade models are **baked per date** (committed: 2026-07-03) at three preset hours;
  regenerate with `--date`/`--hours` for other days. Below 8° sun elevation the hour is
  skipped (everything is shade).
- Same Phase 1 caveats: closed ways only, 250-polygon cap, ~4 km working radius around
  the demo center.
- Microsoft footprints are ML-extracted (ODbL); positional quality varies.
