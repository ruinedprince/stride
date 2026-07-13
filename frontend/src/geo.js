// Pure geometry helpers (no map, no DOM).

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Initial bearing (degrees, 0=N clockwise) from point 1 to point 2.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// Nearest approach (metres) of a route (coords [lon,lat]) to a point.
export function minDistToRoute(lat, lon, coords) {
  let best = Infinity;
  for (const c of coords) {
    const d = haversine(lat, lon, c[1], c[0]);
    if (d < best) best = d;
  }
  return best;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inCollection(lon, lat, fc) {
  if (!fc) return false;
  if (!fc._bboxes) {
    fc._bboxes = fc.features.map((f) => {
      const ring = f.geometry.coordinates[0];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return [minX, minY, maxX, maxY];
    });
  }
  for (let i = 0; i < fc.features.length; i++) {
    const [minX, minY, maxX, maxY] = fc._bboxes[i];
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    if (pointInRing(lon, lat, fc.features[i].geometry.coordinates[0])) return true;
  }
  return false;
}

// Length-weighted fraction of a route whose segment midpoints fall inside the
// collection (point-count fractions are biased by uneven point density).
export function fractionIn(coords, fc) {
  if (!fc || coords.length < 2) return null;
  let total = 0, hit = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    const len = haversine(y1, x1, y2, x2);
    total += len;
    if (inCollection((x1 + x2) / 2, (y1 + y2) / 2, fc)) hit += len;
  }
  return total ? hit / total : 0;
}
