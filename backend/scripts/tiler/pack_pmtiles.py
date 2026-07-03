"""Bundle the .pbf tiles from tile.js into frontend/public/buildings.pmtiles.

One archive → MapLibre streams only the tiles in view (no 23 MB up-front load).
Run after `node tile.js`:  python pack_pmtiles.py
"""

import glob
import gzip
import os

from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

HERE = os.path.dirname(os.path.abspath(__file__))
TILES = os.path.join(HERE, "_tiles")
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "frontend", "public", "buildings.pmtiles"))
BBOX = (-45.30, -22.92, -45.08, -22.70)  # W, S, E, N

entries = []
for f in glob.glob(os.path.join(TILES, "*", "*", "*.pbf")):
    parts = f.replace("\\", "/").split("/")
    z, x, y = int(parts[-3]), int(parts[-2]), int(parts[-1][:-4])
    entries.append((zxy_to_tileid(z, x, y), z, f))
entries.sort(key=lambda e: e[0])  # PMTiles needs ascending tile ids (clustered)

with open(OUT, "wb") as fh:
    wr = Writer(fh)
    for tid, _z, f in entries:
        with open(f, "rb") as tf:
            wr.write_tile(tid, gzip.compress(tf.read()))
    minz = min(e[1] for e in entries)
    maxz = max(e[1] for e in entries)
    e7 = lambda v: int(v * 1e7)
    header = {
        "version": 3,
        "tile_type": TileType.MVT,
        "tile_compression": Compression.GZIP,
        "min_zoom": minz,
        "max_zoom": maxz,
        "min_lon_e7": e7(BBOX[0]),
        "min_lat_e7": e7(BBOX[1]),
        "max_lon_e7": e7(BBOX[2]),
        "max_lat_e7": e7(BBOX[3]),
        "center_zoom": 14,
        "center_lon_e7": e7((BBOX[0] + BBOX[2]) / 2),
        "center_lat_e7": e7((BBOX[1] + BBOX[3]) / 2),
    }
    metadata = {
        "name": "stride-buildings",
        "vector_layers": [
            {"id": "buildings", "fields": {"h": "Number"}, "minzoom": minz, "maxzoom": maxz}
        ],
    }
    wr.finalize(header, metadata)

print(f"wrote {OUT} ({os.path.getsize(OUT) / 1048576:.1f} MB, {len(entries)} tiles, z{minz}-{maxz})")
