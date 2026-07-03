# Stride

Walking-route **generator**: instead of recording a walk (Strava-style), Stride *decides*
the walk. Give it a start point and a target distance and it generates a **loop** route
that ends exactly where it started — and, since Phase 1, it can prefer loops through
**parks, woods and green areas**.

Scope so far: real loop routing in **Guaratinguetá-SP, Brazil** on 100% open-source
infrastructure — no paid APIs, no keys.

- **Routing:** [GraphHopper](https://github.com/graphhopper/graphhopper) 11.0 (Apache 2.0),
  profiles `foot` and `foot_green`, `algorithm=round_trip`, flexible mode (no CH).
- **Data:** OpenStreetMap extract of Guaratinguetá via the Overpass API
  (bbox lon `-45.30..-45.08`, lat `-22.92..-22.70`, ~24 MB XML).
- **Frontend:** [MapLibre GL JS](https://maplibre.org/) + Vite, vanilla JS. OSM raster tiles.

**Phase 1 result (measured, not vibes):** across 8 random seeds at 6 km, the
greenery-aware profile raises the length-weighted share of the route inside/along green
areas from **9.4% to 13.1% on average** (greener in 7/8 seeds, best case 12% → 23%),
while route length stays within ~2% of the regular profile. See *Phase 1* below for how
it works and how it was tuned.

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

Check **🌳 Prefer green areas** to route with the `foot_green` profile, or click
**Compare gray × green** to draw both routes for the same seed — regular in dashed
gray, greenery-aware in solid green — with the green share of each in the status line.

The panel shows distance, estimated duration, a **"Closes the loop"** check
(haversine gap between first and last route coordinate — should be `0.0 m`), and
**"In green areas"** — the length-weighted share of the route inside/along green
polygons.

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
  config.yml                 GraphHopper config: foot + foot_green profiles,
                             flexible mode (no CH)
  custom_models/green.json   generated custom model: green areas + priority rules
  scripts/build_green_areas.py  OSM → green polygons (model + overlay), stdlib-only
  data/guaratingueta.osm     OSM extract (downloaded, gitignored)
  graphhopper-web-11.0.jar   server jar (downloaded, gitignored)
  graph-cache/               generated graph (gitignored)
frontend/
  index.html                 form: start point, distance, presets, seed,
                             prefer-green toggle, compare button
  src/main.js                MapLibre map, GraphHopper call, green overlay,
                             compare mode, length-weighted green stat,
                             loop-closure check, SAMPLE fallback
  src/style.css
  public/green-areas.geojson generated green polygons for display
  public/sample-route.json   offline fallback, clearly labeled SAMPLE
```

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

## Phase 2 hook — shade-aware walks

The heavier, more interesting layer: per-edge **shade share by hour of day**, computed
from building footprints + tree data + solar position (see
[CoolWalks, arXiv:2405.01225](https://arxiv.org/abs/2405.01225)). Same mechanism as
Phase 1 — a generated custom model — but with time-dependent scoring, likely as one
generated model per hour bucket. The demo target: the same 6 km loop "in the sun"
vs. "in the shade at 3 pm", side by side.
