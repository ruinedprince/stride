"""Tree positions for the 3D tree canopy — dense points scattered inside the
green areas. The frontend turns each point into an extruded trunk + canopy
(real 3D geometry, like the buildings), so we ship only compact coordinates.

The region's OSM leaf_type is 19 broadleaved : 1 needleleaved, so every tree is
the dominant broadleaf; the lone conifer isn't dominant and doesn't appear.

Reads frontend/public/green-areas.geojson, writes frontend/public/trees.json
as {"pts": [[lon,lat], ...]}. Deterministic (seeded). Stdlib only.

    python backend/scripts/build_trees.py
"""

import json
import math
import random
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # backend/
GREEN = BASE.parent / "frontend" / "public" / "green-areas.geojson"
OUT = BASE.parent / "frontend" / "public" / "trees.json"

PER_M2 = 260   # ~1 tree per 260 m² — a dense canopy
CAP = 9000     # total ceiling (perf / file size)
random.seed(42)


def ring_area_m2(ring, lat0):
    mx = 111_320 * math.cos(math.radians(lat0))
    my = 110_540
    area = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        area += (x1 * mx) * (y2 * my) - (x2 * mx) * (y1 * my)
    return abs(area) / 2.0


def in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def main():
    green = json.loads(GREEN.read_text(encoding="utf-8"))
    pts = []
    for f in green["features"]:
        ring = f["geometry"]["coordinates"][0]
        lat0 = sum(p[1] for p in ring) / len(ring)
        n = min(700, int(ring_area_m2(ring, lat0) / PER_M2))
        if n < 1:
            continue
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        placed = 0
        tries = 0
        while placed < n and tries < n * 25:
            tries += 1
            lon = random.uniform(min(xs), max(xs))
            lat = random.uniform(min(ys), max(ys))
            if in_ring(lon, lat, ring):
                pts.append([round(lon, 6), round(lat, 6)])
                placed += 1
            if len(pts) >= CAP:
                break
        if len(pts) >= CAP:
            break

    OUT.write_text(json.dumps({"pts": pts}, separators=(",", ":")), encoding="utf-8")
    print(f"{len(pts)} trees (broadleaf, dominant) -> {OUT.name}")


if __name__ == "__main__":
    main()
