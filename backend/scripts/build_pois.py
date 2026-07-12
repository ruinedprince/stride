"""Fase A/POIs — extract points of interest from the OSM extract.

Writes frontend/public/pois.geojson (Point features with type + name) for the
"Passar por" feature: café, mirante (viewpoint), água (drinking water/fountain),
parque. Ways (parks) are reduced to their centroid. Stdlib only.

    python backend/scripts/build_pois.py
"""

import json
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # backend/
OSM_FILE = BASE / "data" / "guaratingueta.osm"
OUT = BASE.parent / "frontend" / "public" / "pois.geojson"

# type -> list of (key, value) tag matches
CATEGORIES = {
    "cafe": [("amenity", "cafe")],
    "viewpoint": [("tourism", "viewpoint")],
    "water": [("amenity", "drinking_water"), ("amenity", "fountain"), ("natural", "spring")],
    "park": [("leisure", "park")],
}


def match_type(tags):
    for t, pairs in CATEGORIES.items():
        if any(tags.get(k) == v for k, v in pairs):
            return t
    return None


def main():
    nodes = {}
    features = []
    counts = {t: 0 for t in CATEGORIES}

    for _, elem in ET.iterparse(OSM_FILE, events=("end",)):
        if elem.tag == "node":
            lon, lat = float(elem.get("lon")), float(elem.get("lat"))
            nodes[elem.get("id")] = (lon, lat)
            tags = {t.get("k"): t.get("v") for t in elem.findall("tag")}
            typ = match_type(tags)
            if typ:
                features.append(_feat(typ, tags.get("name", ""), lon, lat))
                counts[typ] += 1
        elif elem.tag == "way":
            tags = {t.get("k"): t.get("v") for t in elem.findall("tag")}
            typ = match_type(tags)
            if typ:
                pts = [nodes[nd.get("ref")] for nd in elem.findall("nd") if nd.get("ref") in nodes]
                if pts:
                    cx = sum(p[0] for p in pts) / len(pts)
                    cy = sum(p[1] for p in pts) / len(pts)
                    features.append(_feat(typ, tags.get("name", ""), cx, cy))
                    counts[typ] += 1
        if elem.tag in ("node", "way", "relation"):
            elem.clear()

    OUT.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8"
    )
    print(f"{len(features)} POIs -> {OUT.name}: " + ", ".join(f"{t} {n}" for t, n in counts.items()))


def _feat(typ, name, lon, lat):
    return {
        "type": "Feature",
        "properties": {"type": typ, "name": name},
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
    }


if __name__ == "__main__":
    main()
