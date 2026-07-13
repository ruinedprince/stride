"""Phase 1 — extract green-area polygons from the local OSM extract.

Reads backend/data/guaratingueta.osm and produces:
  1. backend/custom_models/green.json   — GraphHopper custom model: edges inside
     a green polygon keep priority 1.0, everything else is multiplied by
     NON_GREEN_PRIORITY, so round_trip prefers loops through parks/woods/grass.
  2. frontend/public/green-areas.geojson — the same polygons for map display.

Only closed ways are considered (multipolygon relations are skipped — good
enough for Phase 1, documented in the README). Stdlib only, no dependencies:

    python backend/scripts/build_green_areas.py
"""

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # backend/
OSM_FILE = BASE / "data" / "region.osm"
OUT_MODEL = BASE / "custom_models" / "green.json"
OUT_GEOJSON = BASE.parent / "frontend" / "public" / "green-areas.geojson"

# OSM tags that mark an area as "green" for walking purposes.
GREEN_TAGS = {
    "leisure": {"park", "garden", "nature_reserve", "recreation_ground", "dog_park"},
    "landuse": {"grass", "forest", "meadow", "village_green", "recreation_ground"},
    "natural": {"wood", "grassland", "scrub", "heath"},
}

MIN_AREA_M2 = 500  # keep small urban squares (praças) — they matter for walking
MAX_POLYGONS = 300  # keep the custom model statement chain bounded (regional now)
# Tuned on 8 seeds (length-weighted green fraction, request-side custom models):
# 0.55 → +0.2pp, 0.4 → +1.2pp, 0.3 → +3.7pp (7/8 seeds greener, distance ~same),
# 0.2 → +4.4pp but diminishing. 0.3 is the sweet spot.
NON_GREEN_PRIORITY = 0.3  # priority multiplier for edges OUTSIDE green areas
BUFFER_M = 20  # expand polygons so streets ALONG a park edge count as green
CENTER = (-45.20, -22.775)  # region centre — used to weight selection

# Ranking: raw area alone floods the list with rural woods far from where
# people actually walk (measured: 92 green polygons within 3 km of the center,
# only 6 survived a pure top-80-by-area cut). Weight area by proximity instead.
PROXIMITY_SCALE_KM = 12  # gentle weighting so green counts across the whole region


def polygon_area_m2(coords):
    """Approximate area of a lon/lat ring in m² (equirectangular shoelace)."""
    if len(coords) < 4:
        return 0.0
    lat0 = math.radians(sum(c[1] for c in coords) / len(coords))
    mx = 111_320 * math.cos(lat0)  # meters per degree lon at this latitude
    my = 110_540  # meters per degree lat
    area = 0.0
    for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
        area += (x1 * mx) * (y2 * my) - (x2 * mx) * (y1 * my)
    return abs(area) / 2.0


def buffer_ring(ring, meters):
    """Crude outward buffer: push each vertex away from the centroid.

    Not a true geometric buffer (no shapely dependency), but good enough to
    make streets bordering a park intersect the polygon, which is how
    pedestrians actually experience green space.
    """
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    lat0 = math.radians(cy)
    mx = 111_320 * math.cos(lat0)
    my = 110_540
    out = []
    for x, y in ring:
        dx, dy = (x - cx) * mx, (y - cy) * my
        d = math.hypot(dx, dy) or 1.0
        f = (d + meters) / d
        out.append([round(cx + (x - cx) * f, 6), round(cy + (y - cy) * f, 6)])
    return out


def proximity_score(area_m2, ring):
    """Area weighted down by squared distance from the demo center."""
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    dx = (cx - CENTER[0]) * 111.32 * math.cos(math.radians(cy))
    dy = (cy - CENTER[1]) * 110.54
    dist_km = math.hypot(dx, dy)
    return area_m2 / (1 + (dist_km / PROXIMITY_SCALE_KM) ** 2)


def extract_green_polygons():
    nodes = {}  # id -> (lon, lat)
    polygons = []  # (score, area_m2, kind, name, ring)

    # Nodes precede ways in OSM XML, so a single streaming pass works.
    for _, elem in ET.iterparse(OSM_FILE, events=("end",)):
        if elem.tag == "node":
            nodes[elem.get("id")] = (float(elem.get("lon")), float(elem.get("lat")))
        elif elem.tag == "way":
            refs = [nd.get("ref") for nd in elem.findall("nd")]
            tags = {t.get("k"): t.get("v") for t in elem.findall("tag")}
            kind = next(
                (
                    f"{k}={tags[k]}"
                    for k, values in GREEN_TAGS.items()
                    if tags.get(k) in values
                ),
                None,
            )
            # Closed way (ring) with a green tag and all nodes present
            if (
                kind
                and len(refs) >= 4
                and refs[0] == refs[-1]
                and all(r in nodes for r in refs)
            ):
                ring = [
                    [round(nodes[r][0], 6), round(nodes[r][1], 6)] for r in refs
                ]
                area = polygon_area_m2(ring)
                if area >= MIN_AREA_M2:
                    polygons.append(
                        (proximity_score(area, ring), area, kind, tags.get("name", ""), ring)
                    )
        if elem.tag in ("node", "way", "relation"):
            elem.clear()

    polygons.sort(key=lambda p: p[0], reverse=True)
    return polygons[:MAX_POLYGONS]


def build_outputs(polygons):
    model_features = []
    display_features = []
    statements = []

    for i, (score, area, kind, name, ring) in enumerate(polygons):
        fid = f"green_{i}"
        buffered = buffer_ring(ring, BUFFER_M)
        geometry = {"type": "Polygon", "coordinates": [buffered]}
        model_features.append(
            {"type": "Feature", "id": fid, "properties": {}, "geometry": geometry}
        )
        display_features.append(
            {
                "type": "Feature",
                "id": fid,
                "properties": {"kind": kind, "name": name, "area_m2": round(area)},
                "geometry": geometry,
            }
        )
        statements.append(
            {("if" if i == 0 else "else_if"): f"in_{fid}", "multiply_by": 1.0}
        )

    # Everything NOT inside a green polygon gets penalized, which makes
    # round_trip gravitate toward greener loops.
    statements.append({"else": "", "multiply_by": NON_GREEN_PRIORITY})

    custom_model = {
        "priority": statements,
        "areas": {"type": "FeatureCollection", "features": model_features},
    }

    OUT_MODEL.parent.mkdir(parents=True, exist_ok=True)
    OUT_MODEL.write_text(json.dumps(custom_model, indent=1), encoding="utf-8")
    OUT_GEOJSON.write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": display_features}, indent=1
        ),
        encoding="utf-8",
    )


def main():
    polygons = extract_green_polygons()
    build_outputs(polygons)
    total_km2 = sum(p[1] for p in polygons) / 1e6
    print(f"kept {len(polygons)} green polygons (total {total_km2:.2f} km²)")
    for score, area, kind, name, _ in polygons[:10]:
        print(f"  {area/1e4:8.1f} ha  {kind:24s} {name}")
    print(f"wrote {OUT_MODEL}")
    print(f"wrote {OUT_GEOJSON}")


if __name__ == "__main__":
    main()
