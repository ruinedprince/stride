# Stride — Phase 0

Walking-route **generator**: instead of recording a walk (Strava-style), Stride *decides*
the walk. Give it a start point and a target distance and it generates a **loop** route
that ends exactly where it started.

Phase 0 scope: real loop routing in **Guaratinguetá-SP, Brazil** on 100% open-source
infrastructure — no paid APIs, no keys.

- **Routing:** [GraphHopper](https://github.com/graphhopper/graphhopper) 11.0 (Apache 2.0),
  profile `foot`, `algorithm=round_trip`, flexible mode (no CH).
- **Data:** OpenStreetMap extract of Guaratinguetá via the Overpass API
  (bbox lon `-45.30..-45.08`, lat `-22.92..-22.70`, ~24 MB XML).
- **Frontend:** [MapLibre GL JS](https://maplibre.org/) + Vite, vanilla JS. OSM raster tiles.

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

The panel shows distance, estimated duration, and a **"Closes the loop"** check
(haversine gap between first and last route coordinate — should be `0.0 m`).

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
  config.yml                 GraphHopper config: foot profile, flexible mode (no CH),
                             encoded values for the built-in foot custom model
  data/guaratingueta.osm     OSM extract (downloaded, gitignored)
  graphhopper-web-11.0.jar   server jar (downloaded, gitignored)
  graph-cache/               generated graph (gitignored)
frontend/
  index.html                 form: start point, distance, presets, seed
  src/main.js                MapLibre map, GraphHopper call, polyline + markers,
                             loop-closure check, SAMPLE fallback
  src/style.css
  public/sample-route.json   offline fallback, clearly labeled SAMPLE
```

## Why flexible mode (no CH)?

`algorithm=round_trip` is not supported by Contraction Hierarchies. `config.yml` sets
`profiles_ch: []` so no CH is prepared and every request runs flexible. The frontend
also sends `ch.disable=true`, which is a harmless no-op in this setup but keeps the
request correct against a server that *does* prepare CH.

## Phase 1 hook — greenery-aware walks

GraphHopper profiles are driven by [custom models](https://github.com/graphhopper/graphhopper/blob/master/docs/core/custom-models.md)
(JSON `priority`/`speed` rules over encoded values). The plan:

1. Pre-process the OSM extract to score edges by greenery — proximity to
   `natural=tree` / `natural=wood`, `leisure=park`, `landuse=grass|forest`, and
   pleasant `surface` values.
2. Expose the score as a custom encoded value (GraphHopper supports importing
   external edge attributes) or map it from tags at import time.
3. Add a `foot_green` profile whose `custom_model` multiplies `priority` by the
   greenery score — `round_trip` then naturally prefers greener loops.
4. UI: a "prefer green" toggle that switches `profile=foot` → `profile=foot_green`.

No architecture change needed: same server, one more profile.
