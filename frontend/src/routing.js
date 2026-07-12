// GraphHopper round_trip requests and the best-of-N selection.
import { GRAPHHOPPER_URL, BEST_OF, DIST_BAND } from "./config.js";
import { fractionIn } from "./geo.js";

export async function generateRoute(lat, lon, distanceKm, seed, spec = {}) {
  const profile = spec.profile || "foot";
  const cm = spec.customModel || null;
  const base = {
    profile,
    algorithm: "round_trip",
    "round_trip.distance": Math.round(distanceKm * 1000),
    "round_trip.seed": seed,
    points_encoded: false,
    "ch.disable": true,
    elevation: true, // 3rd coordinate + ascend/descend for the profile chart
  };

  let res;
  if (cm) {
    // Per-request shade model → POST with custom_model in the body.
    res = await fetch(GRAPHHOPPER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [[lon, lat]], ...base, custom_model: cm }),
    });
  } else {
    const params = new URLSearchParams({ point: `${lat},${lon}` });
    for (const [k, v] of Object.entries(base)) params.set(k, String(v));
    res = await fetch(`${GRAPHHOPPER_URL}?${params}`);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && body.message ? body.message : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// round_trip only *targets* a distance and its variance is huge, so try N seeds.
// With a preference active (rankFC = shade/green polygons), take the shadiest/
// greenest candidate within a distance band of the closest rather than the
// distance-closest — otherwise a loop can hit the target while avoiding all shade.
export async function generateFaithful(lat, lon, distanceKm, baseSeed, spec, rankFC = null) {
  const target = distanceKm * 1000;
  const seeds = Array.from({ length: BEST_OF }, (_, i) => baseSeed + i);
  const settled = await Promise.all(
    seeds.map((s) =>
      generateRoute(lat, lon, distanceKm, s, spec).then((r) => {
        const coords = r.paths[0].points.coordinates.map((c) => [c[0], c[1]]);
        return {
          response: r,
          seed: s,
          distance: r.paths[0].distance,
          distErr: Math.abs(r.paths[0].distance - target) / target,
          metric: rankFC ? fractionIn(coords, rankFC) : null,
        };
      }, () => null)
    )
  );
  const ok = settled.filter(Boolean);
  if (!ok.length) throw new TypeError("no route"); // let caller show SAMPLE

  let chosen;
  if (rankFC) {
    const bestErr = Math.min(...ok.map((c) => c.distErr));
    const acceptable = ok.filter((c) => c.distErr <= bestErr + DIST_BAND);
    chosen = acceptable.sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0))[0];
  } else {
    chosen = ok.slice().sort((a, b) => a.distErr - b.distErr)[0];
  }
  return { ...chosen, tried: ok.length };
}
