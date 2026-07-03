"""Phase 2 — fetch Microsoft Global ML Building Footprints for the bbox.

OSM building coverage in Guaratinguetá is too sparse for a credible shadow
model (measured: ~93 buildings within 1 km of the demo center). Microsoft's
ML-extracted footprints (https://github.com/microsoft/GlobalMLBuildingFootprints,
ODbL) cover Brazil densely. This script:

  1. computes which quadkey tiles (zoom 9) cover the project bbox,
  2. finds their URLs in the dataset index CSV,
  3. downloads each tile (gzipped GeoJSONL) and streams it, keeping only
     buildings inside the bbox,
  4. writes backend/data/ms_buildings.geojsonl (one GeoJSON feature per line).

Stdlib only. Run once:  python backend/scripts/fetch_ms_buildings.py
"""

import csv
import gzip
import io
import json
import math
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # backend/
OUT = BASE / "data" / "ms_buildings.geojsonl"

BBOX = (-45.30, -22.92, -45.08, -22.70)  # lon_min, lat_min, lon_max, lat_max
INDEX_URL = (
    "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
)
ZOOM = 9


def quadkey(lon, lat, zoom):
    lat = max(min(lat, 85.05112878), -85.05112878)
    x = int((lon + 180) / 360 * (1 << zoom))
    s = math.sin(math.radians(lat))
    y = int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * (1 << zoom))
    qk = ""
    for i in range(zoom, 0, -1):
        digit = 0
        mask = 1 << (i - 1)
        if x & mask:
            digit += 1
        if y & mask:
            digit += 2
        qk += str(digit)
    return qk


def bbox_quadkeys():
    lon0, lat0, lon1, lat1 = BBOX
    # sample the corners and center — at zoom 9 a tile is ~78 km, bbox is ~23 km
    keys = {
        quadkey(lon, lat, ZOOM)
        for lon in (lon0, (lon0 + lon1) / 2, lon1)
        for lat in (lat0, (lat0 + lat1) / 2, lat1)
    }
    return keys


def find_tile_urls(keys):
    urls = {}
    print(f"searching index for Brazil tiles {sorted(keys)} …")
    with urllib.request.urlopen(INDEX_URL, timeout=120) as resp:
        text = io.TextIOWrapper(resp, encoding="utf-8")
        for row in csv.DictReader(text):
            if row["Location"] == "Brazil" and row["QuadKey"] in keys:
                urls[row["QuadKey"]] = row["Url"]
    return urls


def in_bbox(lon, lat):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


def stream_tile(url, out_fh):
    kept = total = 0
    with urllib.request.urlopen(url, timeout=600) as resp:
        gz = gzip.GzipFile(fileobj=resp)
        for line in io.TextIOWrapper(gz, encoding="utf-8"):
            total += 1
            feat = json.loads(line)
            ring = feat["geometry"]["coordinates"][0]
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
            if in_bbox(cx, cy):
                out_fh.write(line if line.endswith("\n") else line + "\n")
                kept += 1
    return kept, total


def main():
    keys = bbox_quadkeys()
    urls = find_tile_urls(keys)
    if not urls:
        raise SystemExit(f"no Brazil tiles found for quadkeys {sorted(keys)}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    kept_total = 0
    with open(OUT, "w", encoding="utf-8") as fh:
        for qk, url in sorted(urls.items()):
            print(f"tile {qk}: {url}")
            kept, total = stream_tile(url, fh)
            kept_total += kept
            print(f"  kept {kept} of {total} buildings")
    print(f"wrote {kept_total} buildings to {OUT}")


if __name__ == "__main__":
    main()
