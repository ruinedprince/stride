"""Phase 2 — compute per-hour shade polygons and emit GraphHopper custom models.

For each requested local hour, this script:
  1. computes the sun's azimuth/elevation (NOAA solar position, pure Python),
  2. casts a shadow polygon for every obstacle — buildings (OSM + Microsoft ML
     footprints), individual trees, tree rows, and woods — with shadow length
     height / tan(elevation),
  3. unions everything with shapely, simplifies, keeps the MAX_POLYGONS largest,
  4. writes backend/custom_models/shade_<H>.json (GraphHopper custom model:
     edges NOT touching shade get priority × NON_SHADE_PRIORITY) and
     frontend/public/shade-<H>.geojson (display overlay).

Height model (documented limitation): OSM height/building:levels tags are used
when present (rare here: 9 + 50 of ~2.7k), otherwise defaults by building type.
Microsoft footprints carry ML height estimates for some buildings (-1 = unknown
→ default). Shadows are therefore approximate — the point is a *realistic*
relative preference, not a survey-grade shadow map.

Requires: shapely (pip install shapely). Run after fetch_ms_buildings.py:

    python backend/scripts/build_shade_areas.py --date 2026-07-03 --hours 9,12,15
"""

import argparse
import json
import math
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

BASE = Path(__file__).resolve().parent.parent  # backend/
OSM_FILE = BASE / "data" / "guaratingueta.osm"
MS_FILE = BASE / "data" / "ms_buildings.geojsonl"

CENTER = (-45.1927, -22.8164)  # demo center (lon, lat)
WORK_RADIUS_M = 4000  # only cast shadows near where demo loops actually run
TZ_OFFSET = -3  # America/Sao_Paulo (no DST)

MAX_POLYGONS = 250
NON_SHADE_PRIORITY = 0.3  # same mechanism tuned in Phase 1
MIN_SHADE_AREA_M2 = 120
SIMPLIFY_M = 2.0
MIN_SUN_ELEVATION_DEG = 8  # below this, shadows are city-wide → skip the hour

# Default heights (m) by OSM building type when height/levels tags are absent
BUILDING_HEIGHT_DEFAULTS = {
    "church": 12.0,
    "cathedral": 15.0,
    "apartments": 9.0,
    "industrial": 5.5,
    "warehouse": 5.5,
    "commercial": 5.5,
    "retail": 5.0,
    "school": 5.0,
    "university": 6.0,
    "hospital": 8.0,
    "roof": 3.0,
}
DEFAULT_BUILDING_HEIGHT = 4.0  # mostly 1-story houses in this region
TREE_HEIGHT, TREE_CANOPY_R = 6.0, 3.5
TREE_ROW_HEIGHT, TREE_ROW_BUFFER = 7.0, 3.0
WOOD_HEIGHT = 9.0
WOOD_TAGS = {("natural", "wood"), ("landuse", "forest")}


# ---------------------------------------------------------------------------
# Solar position — NOAA general solar position calculations (±0.2° accuracy)
# ---------------------------------------------------------------------------
def solar_position(lat_deg, lon_deg, dt_utc):
    """Return (azimuth_deg from N clockwise, elevation_deg)."""
    d = dt_utc - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)
    jc = (d.days + d.seconds / 86400) / 36525  # Julian century from J2000

    gmls = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360
    gmas = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    eeo = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    seoc = (
        math.sin(math.radians(gmas)) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
        + math.sin(math.radians(2 * gmas)) * (0.019993 - 0.000101 * jc)
        + math.sin(math.radians(3 * gmas)) * 0.000289
    )
    stl = gmls + seoc
    sal = stl - 0.00569 - 0.00478 * math.sin(math.radians(125.04 - 1934.136 * jc))
    moe = (
        23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60
    )
    oc = moe + 0.00256 * math.cos(math.radians(125.04 - 1934.136 * jc))
    decl = math.degrees(
        math.asin(math.sin(math.radians(oc)) * math.sin(math.radians(sal)))
    )
    var_y = math.tan(math.radians(oc / 2)) ** 2
    eot = 4 * math.degrees(
        var_y * math.sin(2 * math.radians(gmls))
        - 2 * eeo * math.sin(math.radians(gmas))
        + 4 * eeo * var_y * math.sin(math.radians(gmas)) * math.cos(2 * math.radians(gmls))
        - 0.5 * var_y**2 * math.sin(4 * math.radians(gmls))
        - 1.25 * eeo**2 * math.sin(2 * math.radians(gmas))
    )

    minutes = dt_utc.hour * 60 + dt_utc.minute + dt_utc.second / 60
    tst = (minutes + eot + 4 * lon_deg) % 1440
    ha = tst / 4 - 180 if tst / 4 >= 0 else tst / 4 + 180

    lat = math.radians(lat_deg)
    zenith = math.degrees(
        math.acos(
            math.sin(lat) * math.sin(math.radians(decl))
            + math.cos(lat) * math.cos(math.radians(decl)) * math.cos(math.radians(ha))
        )
    )
    elevation = 90 - zenith

    az = math.degrees(
        math.acos(
            (
                (math.sin(lat) * math.cos(math.radians(zenith)))
                - math.sin(math.radians(decl))
            )
            / (math.cos(lat) * math.sin(math.radians(zenith)))
        )
    )
    azimuth = (az + 180) % 360 if ha > 0 else (540 - az) % 360
    return azimuth, elevation


# ---------------------------------------------------------------------------
# Local projection (meters around CENTER)
# ---------------------------------------------------------------------------
MX = 111_320 * math.cos(math.radians(CENTER[1]))
MY = 110_540


def to_m(lon, lat):
    return ((lon - CENTER[0]) * MX, (lat - CENTER[1]) * MY)


def to_deg(x, y):
    return (round(x / MX + CENTER[0], 6), round(y / MY + CENTER[1], 6))


def near_center(x, y):
    return math.hypot(x, y) <= WORK_RADIUS_M


# ---------------------------------------------------------------------------
# Obstacle loading — (shapely geometry in meters, height)
# ---------------------------------------------------------------------------
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


def load_obstacles():
    nodes = {}
    buildings, woods, trees, tree_rows = [], [], [], []

    for _, elem in ET.iterparse(OSM_FILE, events=("end",)):
        if elem.tag == "node":
            lon, lat = float(elem.get("lon")), float(elem.get("lat"))
            nodes[elem.get("id")] = (lon, lat)
            for t in elem.findall("tag"):
                if t.get("k") == "natural" and t.get("v") == "tree":
                    x, y = to_m(lon, lat)
                    if near_center(x, y):
                        trees.append(Point(x, y).buffer(TREE_CANOPY_R, 8))
        elif elem.tag == "way":
            refs = [nd.get("ref") for nd in elem.findall("nd")]
            tags = {t.get("k"): t.get("v") for t in elem.findall("tag")}
            pts = [to_m(*nodes[r]) for r in refs if r in nodes]
            if len(pts) < 2 or not any(near_center(x, y) for x, y in pts):
                elem.clear()
                continue
            closed = refs[0] == refs[-1] and len(pts) >= 4
            if "building" in tags and closed:
                poly = Polygon(pts)
                if poly.is_valid and poly.area > 4:
                    buildings.append((poly, parse_height(tags)))
            elif closed and any((k, tags.get(k)) in WOOD_TAGS for k in ("natural", "landuse")):
                poly = Polygon(pts)
                if poly.is_valid:
                    woods.append(poly)
            elif tags.get("natural") == "tree_row":
                tree_rows.append(LineString(pts).buffer(TREE_ROW_BUFFER, 4))
        if elem.tag in ("node", "way", "relation"):
            elem.clear()

    n_osm = len(buildings)

    # Microsoft ML footprints — dense coverage where OSM has none. Skip any
    # whose centroid falls inside an OSM building (avoid double obstacles).
    n_ms = 0
    if MS_FILE.exists():
        osm_tree = STRtree([b for b, _ in buildings]) if buildings else None
        with open(MS_FILE, encoding="utf-8") as fh:
            for line in fh:
                feat = json.loads(line)
                ring = [to_m(x, y) for x, y in feat["geometry"]["coordinates"][0]]
                if not any(near_center(x, y) for x, y in ring):
                    continue
                poly = Polygon(ring)
                if not poly.is_valid or poly.area <= 4:
                    continue
                if osm_tree is not None:
                    hits = osm_tree.query(poly.centroid, predicate="within")
                    if len(hits):
                        continue
                h = feat.get("properties", {}).get("height", -1)
                buildings.append((poly, h if h and h > 0 else DEFAULT_BUILDING_HEIGHT))
                n_ms += 1

    print(
        f"obstacles within {WORK_RADIUS_M/1000:.0f} km: "
        f"{n_osm} OSM + {n_ms} MS buildings, {len(woods)} woods, "
        f"{len(trees)} trees, {len(tree_rows)} tree rows"
    )
    return buildings, woods, trees, tree_rows


# ---------------------------------------------------------------------------
# Shadow casting
# ---------------------------------------------------------------------------
def shadow_pieces(geom, height, dx_unit, dy_unit, shadow_len):
    """Footprint + translated footprint + a quad per exterior edge."""
    dx, dy = dx_unit * shadow_len * height, dy_unit * shadow_len * height
    coords = list(geom.exterior.coords)
    pieces = [geom, Polygon([(x + dx, y + dy) for x, y in coords])]
    for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
        quad = Polygon([(x1, y1), (x2, y2), (x2 + dx, y2 + dy), (x1 + dx, y1 + dy)])
        if not quad.is_valid:
            quad = quad.buffer(0)
        pieces.append(quad)
    return pieces


def build_hour(buildings, woods, trees, tree_rows, date, hour_local):
    dt_utc = datetime(date.year, date.month, date.day, tzinfo=timezone.utc) + timedelta(
        hours=hour_local - TZ_OFFSET
    )
    az, el = solar_position(CENTER[1], CENTER[0], dt_utc)
    print(f"{hour_local:02d}h local -> sun azimuth {az:.1f} deg, elevation {el:.1f} deg")
    if el < MIN_SUN_ELEVATION_DEG:
        print("  sun too low — skipping this hour")
        return None, az, el

    # Shadow extends away from the sun; length per meter of height
    shadow_az = math.radians((az + 180) % 360)
    dx_unit, dy_unit = math.sin(shadow_az), math.cos(shadow_az)
    len_per_m = 1 / math.tan(math.radians(el))

    pieces = []
    for poly, h in buildings:
        pieces.extend(shadow_pieces(poly, h, dx_unit, dy_unit, len_per_m))
    for poly in woods:
        pieces.extend(shadow_pieces(poly, WOOD_HEIGHT, dx_unit, dy_unit, len_per_m))
    for geom in trees:
        pieces.extend(shadow_pieces(geom, TREE_HEIGHT, dx_unit, dy_unit, len_per_m))
    for geom in tree_rows:
        pieces.extend(shadow_pieces(geom, TREE_ROW_HEIGHT, dx_unit, dy_unit, len_per_m))

    print(f"  unioning {len(pieces)} shadow pieces ...")
    merged = unary_union(pieces).simplify(SIMPLIFY_M)
    polys = list(merged.geoms) if merged.geom_type == "MultiPolygon" else [merged]
    polys = [p for p in polys if p.area >= MIN_SHADE_AREA_M2]
    polys.sort(key=lambda p: p.area, reverse=True)
    dropped = max(0, len(polys) - MAX_POLYGONS)
    polys = polys[:MAX_POLYGONS]
    total_km2 = sum(p.area for p in polys) / 1e6
    print(f"  {len(polys)} shade polygons kept ({total_km2:.2f} km2), {dropped} small ones dropped")
    return polys, az, el


def write_outputs(polys, hour_local, date, az, el):
    model_features, display_features, statements = [], [], []
    for i, p in enumerate(polys):
        fid = f"shade_{i}"
        ring = [list(to_deg(x, y)) for x, y in p.exterior.coords]
        geometry = {"type": "Polygon", "coordinates": [ring]}
        model_features.append(
            {"type": "Feature", "id": fid, "properties": {}, "geometry": geometry}
        )
        display_features.append(
            {
                "type": "Feature",
                "id": fid,
                "properties": {"area_m2": round(p.area)},
                "geometry": geometry,
            }
        )
        statements.append(
            {("if" if i == 0 else "else_if"): f"in_{fid}", "multiply_by": 1.0}
        )
    statements.append({"else": "", "multiply_by": NON_SHADE_PRIORITY})

    model_path = BASE / "custom_models" / f"shade_{hour_local}.json"
    model_path.write_text(
        json.dumps(
            {
                "priority": statements,
                "areas": {"type": "FeatureCollection", "features": model_features},
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    geo_path = BASE.parent / "frontend" / "public" / f"shade-{hour_local}.geojson"
    geo_path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "properties": {
                    "date": date.isoformat(),
                    "hour_local": hour_local,
                    "sun_azimuth_deg": round(az, 1),
                    "sun_elevation_deg": round(el, 1),
                },
                "features": display_features,
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"  wrote {model_path.name} + {geo_path.name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None, help="YYYY-MM-DD (default: today)")
    ap.add_argument("--hours", default="9,12,15", help="local hours, comma-separated")
    args = ap.parse_args()
    date = (
        datetime.strptime(args.date, "%Y-%m-%d").date()
        if args.date
        else datetime.now().date()
    )
    hours = [int(h) for h in args.hours.split(",")]

    print(f"shade model for {date} (UTC{TZ_OFFSET:+d}), hours {hours}")
    obstacles = load_obstacles()
    for hour in hours:
        polys, az, el = build_hour(*obstacles, date, hour)
        if polys:
            write_outputs(polys, hour, date, az, el)
    write_index(date)


def write_index(date):
    """Manifest of every baked hour + its sun position — the frontend reads this
    to know which hours exist and to interpolate the sun between them."""
    import glob, re

    pub = BASE.parent / "frontend" / "public"
    hours = []
    for f in sorted(glob.glob(str(pub / "shade-*.geojson"))):
        m = re.search(r"shade-(\d+)\.geojson$", f)
        props = json.loads(Path(f).read_text(encoding="utf-8")).get("properties", {})
        if m and props.get("sun_azimuth_deg") is not None:
            hours.append(
                {
                    "h": int(m.group(1)),
                    "az": round(props["sun_azimuth_deg"], 1),
                    "el": round(props["sun_elevation_deg"], 1),
                }
            )
    hours.sort(key=lambda e: e["h"])
    (pub / "shade-index.json").write_text(
        json.dumps({"date": date.isoformat(), "hours": hours}, indent=1),
        encoding="utf-8",
    )
    print(f"wrote shade-index.json ({len(hours)} hours: {[e['h'] for e in hours]})")


if __name__ == "__main__":
    main()
