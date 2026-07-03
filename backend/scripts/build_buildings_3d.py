"""Phase 2b — export building footprints for the 3D map layer.

The map used to extrude OpenMapTiles' `building` layer (OSM-derived, ~2.7k
buildings here), while shadows are cast from 96k Microsoft ML footprints. Two
different building sets → shadows without a block under them and very few
blocks on the map. This script exports the SAME footprints the shadow pipeline
uses (OSM + Microsoft ML, same heights) so the 3D blocks and the shadows line
up and there are far more of them.

Output: frontend/public/buildings.geojson — one Polygon feature per building
with a `h` property (height in meters, same model as build_shade_areas.py).

Stdlib only. Run after fetch_ms_buildings.py:
    python backend/scripts/build_buildings_3d.py
"""

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # backend/
OSM_FILE = BASE / "data" / "guaratingueta.osm"
MS_FILE = BASE / "data" / "ms_buildings.geojsonl"
OUT = BASE.parent / "frontend" / "public" / "buildings.geojson"

CENTER = (-45.1927, -22.8164)  # lon, lat
RADIUS_M = 3200  # a touch under the shade working radius; covers demo loops
MIN_AREA_M2 = 12
COORD_PRECISION = 6

MX = 111_320 * math.cos(math.radians(CENTER[1]))
MY = 110_540

# Height model — kept identical to build_shade_areas.py so blocks and shadows
# agree on how tall each building is.
BUILDING_HEIGHT_DEFAULTS = {
    "church": 12.0, "cathedral": 15.0, "apartments": 9.0, "industrial": 5.5,
    "warehouse": 5.5, "commercial": 5.5, "retail": 5.0, "school": 5.0,
    "university": 6.0, "hospital": 8.0, "roof": 3.0,
}
DEFAULT_BUILDING_HEIGHT = 4.0


def near_center(lon, lat):
    return math.hypot((lon - CENTER[0]) * MX, (lat - CENTER[1]) * MY) <= RADIUS_M


def ring_area_m2(ring):
    if len(ring) < 4:
        return 0.0
    area = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        area += (x1 * MX) * (y2 * MY) - (x2 * MX) * (y1 * MY)
    return abs(area) / 2.0


def parse_height(tags):
    h = tags.get("height")
    if h:
        try:
            return float(h.replace("m", "").strip())
        except ValueError:
            pass
    lv = tags.get("building:levels")
    if lv:
        try:
            return max(3.0, float(lv) * 3.0)
        except ValueError:
            pass
    return BUILDING_HEIGHT_DEFAULTS.get(tags.get("building"), DEFAULT_BUILDING_HEIGHT)


def q(ring):
    return [[round(x, COORD_PRECISION), round(y, COORD_PRECISION)] for x, y in ring]


def main():
    nodes = {}
    features = []
    osm_centroids = []  # to skip MS duplicates near an OSM building

    for _, elem in ET.iterparse(OSM_FILE, events=("end",)):
        if elem.tag == "node":
            nodes[elem.get("id")] = (float(elem.get("lon")), float(elem.get("lat")))
        elif elem.tag == "way":
            tags = {t.get("k"): t.get("v") for t in elem.findall("tag")}
            if "building" in tags:
                refs = [nd.get("ref") for nd in elem.findall("nd")]
                pts = [nodes[r] for r in refs if r in nodes]
                if len(pts) >= 4 and refs[0] == refs[-1]:
                    cx = sum(p[0] for p in pts) / len(pts)
                    cy = sum(p[1] for p in pts) / len(pts)
                    if near_center(cx, cy) and ring_area_m2(pts) >= MIN_AREA_M2:
                        osm_centroids.append((cx, cy))
                        features.append(
                            {
                                "type": "Feature",
                                "properties": {"h": round(parse_height(tags), 1)},
                                "geometry": {"type": "Polygon", "coordinates": [q(pts)]},
                            }
                        )
        if elem.tag in ("node", "way", "relation"):
            elem.clear()

    n_osm = len(features)

    # Grid index of OSM centroids for fast dedup (cell ~30 m)
    cell = 0.0003
    grid = {}
    for cx, cy in osm_centroids:
        grid.setdefault((round(cx / cell), round(cy / cell)), []).append((cx, cy))

    def near_osm(cx, cy):
        gx, gy = round(cx / cell), round(cy / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ox, oy in grid.get((gx + dx, gy + dy), ()):
                    if math.hypot((cx - ox) * MX, (cy - oy) * MY) < 12:
                        return True
        return False

    if MS_FILE.exists():
        with open(MS_FILE, encoding="utf-8") as fh:
            for line in fh:
                feat = json.loads(line)
                ring = feat["geometry"]["coordinates"][0]
                cx = sum(p[0] for p in ring) / len(ring)
                cy = sum(p[1] for p in ring) / len(ring)
                if not near_center(cx, cy) or ring_area_m2(ring) < MIN_AREA_M2:
                    continue
                if near_osm(cx, cy):
                    continue
                h = feat.get("properties", {}).get("height", -1)
                features.append(
                    {
                        "type": "Feature",
                        "properties": {"h": round(h if h and h > 0 else DEFAULT_BUILDING_HEIGHT, 1)},
                        "geometry": {"type": "Polygon", "coordinates": [q(ring)]},
                    }
                )

    OUT.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}),
        encoding="utf-8",
    )
    size_mb = OUT.stat().st_size / 1048576
    print(f"{len(features)} buildings ({n_osm} OSM + {len(features)-n_osm} MS) "
          f"within {RADIUS_M/1000:.1f} km -> {OUT.name} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
