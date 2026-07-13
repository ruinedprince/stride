"""Tree positions for the 3D canopy — OSM-faithful hybrid.

Reads backend/data/guaratingueta.osm and combines three real signals, then
fills for density:

  1. natural=tree nodes      -> a tree at the exact coordinate, honouring its
                                leaf_type tag (the one tagged conifer shows up
                                as a conifer, where it really stands).
  2. natural=tree_row ways   -> trees sampled along the line (street plantings).
  3. green polygons          -> scatter fill trees, with density by KIND
                                (natural=wood / landuse=forest are dense forest;
                                parks are scattered; grassland/meadow sparse) and
                                TYPE from the polygon's leaf_type (mixed woods get
                                a minority of conifers), else the region-dominant
                                broadleaf (OSM here is 19 broadleaved : 1 needle).

Type is only ever set from a real OSM tag; untagged trees fall back to the
dominant broadleaf — never invented per tree.

Output frontend/public/trees.json = {"trees": [[lon, lat, t], ...]} where t is
0 = broadleaf, 1 = needleleaf. Deterministic (seeded). Stdlib only.

    python backend/scripts/build_trees.py
"""

import json
import math
import random
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # backend/
OSM_FILE = BASE / "data" / "guaratingueta.osm"
OUT = BASE.parent / "frontend" / "public" / "trees.json"

# Same green tags as build_green_areas.py, grouped by how many trees they carry.
GREEN_TAGS = {
    "leisure": {"park", "garden", "nature_reserve", "recreation_ground", "dog_park"},
    "landuse": {"grass", "forest", "meadow", "village_green", "recreation_ground"},
    "natural": {"wood", "grassland", "scrub", "heath"},
}
DENSE = {"natural=wood", "landuse=forest", "leisure=nature_reserve"}      # closed canopy
SPARSE = {"landuse=grass", "landuse=meadow", "natural=grassland", "natural=heath", "natural=scrub"}
PER_M2_DENSE = 150
PER_M2_PARK = 480    # leisure=park / garden and friends — scattered trees on grass
PER_M2_SPARSE = 1300
PER_POLY_CAP = 600
CAP = 11000          # total ceiling (perf / file size)
ROW_SPACING_M = 12   # trees along a tree_row
MIN_AREA_M2 = 500
CENTER = (-45.1927, -22.8164)  # demo start — fill nearer areas first
PROXIMITY_SCALE_KM = 1.5

rnd = random.Random(42)


def area_m2(ring):
    if len(ring) < 4:
        return 0.0
    lat0 = math.radians(sum(c[1] for c in ring) / len(ring))
    mx, my = 111_320 * math.cos(lat0), 110_540
    a = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        a += (x1 * mx) * (y2 * my) - (x2 * mx) * (y1 * my)
    return abs(a) / 2.0


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


def leaf_code(leaf):
    if leaf == "needleleaved":
        return 1
    if leaf == "broadleaved":
        return 0
    return None


def proximity(ring):
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    dx = (cx - CENTER[0]) * 111.32 * math.cos(math.radians(cy))
    dy = (cy - CENTER[1]) * 110.54
    return math.hypot(dx, dy)


def parse_osm():
    nodes = {}
    tree_nodes = []   # (lon, lat, leafcode|None)
    tree_rows = []    # (refs, leafcode|None)
    polygons = []     # (kind, leaf, ring)
    for _, el in ET.iterparse(OSM_FILE, events=("end",)):
        if el.tag == "node":
            nodes[el.get("id")] = (float(el.get("lon")), float(el.get("lat")))
            tg = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tg.get("natural") == "tree":
                tree_nodes.append((float(el.get("lon")), float(el.get("lat")), leaf_code(tg.get("leaf_type"))))
        elif el.tag == "way":
            refs = [nd.get("ref") for nd in el.findall("nd")]
            tg = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tg.get("natural") == "tree_row" and all(r in nodes for r in refs):
                tree_rows.append((refs, leaf_code(tg.get("leaf_type"))))
                continue
            kind = next((f"{k}={tg[k]}" for k, vals in GREEN_TAGS.items() if tg.get(k) in vals), None)
            if kind and len(refs) >= 4 and refs[0] == refs[-1] and all(r in nodes for r in refs):
                ring = [[nodes[r][0], nodes[r][1]] for r in refs]
                if area_m2(ring) >= MIN_AREA_M2:
                    polygons.append((kind, tg.get("leaf_type"), ring))
        if el.tag in ("node", "way", "relation"):
            el.clear()
    return nodes, tree_nodes, tree_rows, polygons


def haversine(a, b):
    R = 6371000
    dlat = math.radians(b[1] - a[1])
    dlon = math.radians(b[0] - a[0])
    x = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[1])) * math.cos(math.radians(b[1])) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def fill_type(poly_leaf):
    c = leaf_code(poly_leaf)
    if c is not None:
        return c
    if poly_leaf == "mixed":
        return 1 if rnd.random() < 0.3 else 0  # honour "mixed": a minority of conifers
    return 0  # region-dominant broadleaf


def per_m2(kind):
    if kind in DENSE:
        return PER_M2_DENSE
    if kind in SPARSE:
        return PER_M2_SPARSE
    return PER_M2_PARK


def main():
    nodes, tree_nodes, tree_rows, polygons = parse_osm()
    out = []

    # 1. real individual trees (exact positions, real leaf_type where tagged)
    real = 0
    for lon, lat, c in tree_nodes:
        out.append([round(lon, 6), round(lat, 6), c if c is not None else 0])
        real += 1

    # 2. trees along tree_row lines
    row_pts = 0
    for refs, c in tree_rows:
        t = c if c is not None else 0
        carry = 0.0
        for r1, r2 in zip(refs, refs[1:]):
            a, b = nodes[r1], nodes[r2]
            seg = haversine(a, b)
            if seg == 0:
                continue
            d = -carry
            while d < seg:
                if d >= 0:
                    f = d / seg
                    out.append([round(a[0] + (b[0] - a[0]) * f, 6), round(a[1] + (b[1] - a[1]) * f, 6), t])
                    row_pts += 1
                d += ROW_SPACING_M
            carry = d - seg

    # 3. density fill inside green polygons — nearest to the demo centre first
    polygons.sort(key=lambda p: proximity(p[2]))
    fill = 0
    for kind, leaf, ring in polygons:
        if len(out) >= CAP:
            break
        n = min(PER_POLY_CAP, int(area_m2(ring) / per_m2(kind)))
        if n < 1:
            continue
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        placed = tries = 0
        while placed < n and tries < n * 25 and len(out) < CAP:
            tries += 1
            lon = rnd.uniform(min(xs), max(xs))
            lat = rnd.uniform(min(ys), max(ys))
            if in_ring(lon, lat, ring):
                out.append([round(lon, 6), round(lat, 6), fill_type(leaf)])
                placed += 1
                fill += 1

    conifers = sum(1 for t in out if t[2] == 1)
    OUT.write_text(json.dumps({"trees": out}, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out)} trees -> {OUT.name}")
    print(f"  {real} real OSM tree nodes, {row_pts} along tree_rows, {fill} density fill")
    print(f"  {conifers} conifers (needleleaved), rest broadleaf")


if __name__ == "__main__":
    main()
