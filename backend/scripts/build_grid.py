"""Fase C/explored — count the walkable street cells in the bbox.

The frontend computes "% of the city explored" as (distinct grid cells your
saved walks touch) / (total grid cells that contain a walkable street). This
script produces the denominator. Writes frontend/public/street-grid.json
{ cellDeg, total }. Stdlib only.

    python backend/scripts/build_grid.py
"""

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # backend/
OSM_FILE = BASE / "data" / "guaratingueta.osm"
OUT = BASE.parent / "frontend" / "public" / "street-grid.json"

CELL_DEG = 0.0014  # ~150 m; MUST match discovery.js
SKIP = {"motorway", "trunk", "motorway_link", "trunk_link"}
MY = 110540


def cell(lon, lat):
    return (math.floor(lon / CELL_DEG), math.floor(lat / CELL_DEG))


def main():
    nodes = {}
    cells = set()

    for _, elem in ET.iterparse(OSM_FILE, events=("end",)):
        if elem.tag == "node":
            nodes[elem.get("id")] = (float(elem.get("lon")), float(elem.get("lat")))
        elif elem.tag == "way":
            tags = {t.get("k"): t.get("v") for t in elem.findall("tag")}
            hw = tags.get("highway")
            if hw and hw not in SKIP:
                refs = [nd.get("ref") for nd in elem.findall("nd")]
                pts = [nodes[r] for r in refs if r in nodes]
                for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
                    # interpolate so long segments don't skip cells (~75 m step)
                    mx = 111320 * math.cos(math.radians(y1))
                    seg = math.hypot((x2 - x1) * mx, (y2 - y1) * MY)
                    steps = max(1, int(seg / 75))
                    for k in range(steps + 1):
                        t = k / steps
                        cells.add(cell(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
        if elem.tag in ("node", "way", "relation"):
            elem.clear()

    OUT.write_text(json.dumps({"cellDeg": CELL_DEG, "total": len(cells)}), encoding="utf-8")
    print(f"{len(cells)} walkable street cells ({CELL_DEG}° ~150 m) -> {OUT.name}")


if __name__ == "__main__":
    main()
