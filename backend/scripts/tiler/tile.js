// Tile backend/data/buildings.ndjson into MVT .pbf tiles (z13–16) with geojson-vt
// + vt-pbf. pack_pmtiles.py then bundles them into frontend/public/buildings.pmtiles.
// No Docker/tippecanoe needed. Run: node tile.js
const fs = require("fs");
const path = require("path");
const _gvt = require("geojson-vt");
const geojsonvt = typeof _gvt === "function" ? _gvt : _gvt.default;
const _vtpbf = require("vt-pbf");
const fromGeojsonVt = _vtpbf.fromGeojsonVt || (_vtpbf.default && _vtpbf.default.fromGeojsonVt);

const NDJSON = path.resolve(__dirname, "../../data/buildings.ndjson");
const OUT = path.resolve(__dirname, "_tiles");
const BBOX = [-45.30, -22.92, -45.08, -22.70]; // W, S, E, N
const MINZOOM = 13, MAXZOOM = 16;

const features = [];
for (const line of fs.readFileSync(NDJSON, "utf8").split("\n")) {
  if (line.trim()) features.push(JSON.parse(line));
}
console.log("features:", features.length);

const index = geojsonvt(
  { type: "FeatureCollection", features },
  { maxZoom: MAXZOOM, indexMaxZoom: MAXZOOM, tolerance: 3, extent: 4096, buffer: 64 }
);

const lon2t = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2t = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

fs.rmSync(OUT, { recursive: true, force: true });
let count = 0;
for (let z = MINZOOM; z <= MAXZOOM; z++) {
  const x0 = lon2t(BBOX[0], z), x1 = lon2t(BBOX[2], z);
  const y0 = lat2t(BBOX[3], z), y1 = lat2t(BBOX[1], z); // north → south
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const tile = index.getTile(z, x, y);
      if (!tile || !tile.features || !tile.features.length) continue;
      const buf = fromGeojsonVt({ buildings: tile }, { version: 2 });
      const dir = path.join(OUT, String(z), String(x));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, y + ".pbf"), Buffer.from(buf));
      count++;
    }
  }
}
console.log("tiles written:", count, "->", OUT);
