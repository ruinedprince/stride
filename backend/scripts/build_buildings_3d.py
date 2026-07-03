"""Phase 4b — export ALL building footprints in the bbox as NDJSON for tiling.

Earlier this wrote a single ~5 MB buildings.geojson limited to 3.2 km around the
centre, so neighbourhoods farther out had no 3D blocks and the whole file loaded
at once. Now it exports every footprint in the bbox (OSM + Microsoft ML, same
height model as the shadow pipeline) as line-delimited GeoJSON, which
`tile_buildings.sh` turns into vector tiles (buildings.pmtiles) that MapLibre
streams per viewport.

Output: backend/data/buildings.ndjson (one Feature per line, `h` = height in m).

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
OUT = BASE / "data" / "buildings.ndjson"

# Full project bbox (lon_min, lat_min, lon_max, lat_max) — same as the OSM extract.
BBOX = (-45.30, -22.92, -45.08, -22.70)
CENTER_LAT = -22.8164
MX = 111_320 * math.cos(math.radians(CENTER_LAT))
MY = 110_540
MIN_AREA_M2 = 12
COORD_PRECISION = 6

# Height model — identical to build_shade_areas.py so blocks and shadows agree.
BUILDING_HEIGHT_DEFAULTS = {
    "church": 12.0, "cathedral": 15.0, "apartments": 9.0, "industrial": 5.5,
    "warehouse": 5.5, "commercial": 5.5, "retail": 5.0, "school": 5.0,
    "university": 6.0, "hospital": 8.0, "roof": 3.0,
}
DEFAULT_BUILDING_HEIGHT = 4.0


def in_bbox(lon, lat):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


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


def feature(ring, height):
    return {
        "type": "Feature",
        "properties": {"h": round(height, 1)},
        "geometry": {"type": "Polygon", "coordinates": [q(ring)]},
    }


def main():
    nodes = {}
    osm_features = []
    osm_centroids = []

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
                    if in_bbox(cx, cy) and ring_area_m2(pts) >= MIN_AREA_M2:
                        osm_centroids.append((cx, cy))
                        osm_features.append(feature(pts, parse_height(tags)))
        if elem.tag in ("node", "way", "relation"):
            elem.clear()

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

    n_ms = 0
    with open(OUT, "w", encoding="utf-8") as out:
        for f in osm_features:
            out.write(json.dumps(f) + "\n")
        if MS_FILE.exists():
            with open(MS_FILE, encoding="utf-8") as fh:
                for line in fh:
                    feat = json.loads(line)
                    ring = feat["geometry"]["coordinates"][0]
                    cx = sum(p[0] for p in ring) / len(ring)
                    cy = sum(p[1] for p in ring) / len(ring)
                    if not in_bbox(cx, cy) or ring_area_m2(ring) < MIN_AREA_M2:
                        continue
                    if near_osm(cx, cy):
                        continue
                    h = feat.get("properties", {}).get("height", -1)
                    out.write(json.dumps(feature(ring, h if h and h > 0 else DEFAULT_BUILDING_HEIGHT)) + "\n")
                    n_ms += 1

    size_mb = OUT.stat().st_size / 1048576
    print(f"{len(osm_features) + n_ms} buildings ({len(osm_features)} OSM + {n_ms} MS) "
          f"in bbox -> {OUT.name} ({size_mb:.1f} MB). Next: scripts/tile_buildings.sh")


if __name__ == "__main__":
    main()
