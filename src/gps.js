// GPS helpers for outdoor navigation (pure functions, no React).
// All geometry is done in LOCAL METRES from real lat/lon, never in draw.io coordinates,
// because the draw.io map is schematic (not to scale).

export const GPS_MAX_ACCURACY_M = 35; // ignore fixes worse than this
export const GPS_MAX_OFFROUTE_M = 30; // fixes farther than this from the route trigger a reroute
const LAT0 = 33.969; // campus reference latitude
const M_PER_DEG_LAT = 110540;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
export const hasGeo = (m) => !!m && m.lat != null && m.lon != null;

export const toXY = (lat, lon) => ({ x: lon * mPerDegLon(LAT0), y: lat * M_PER_DEG_LAT });
export const fromXY = (x, y) => ({ lat: y / M_PER_DEG_LAT, lon: x / mPerDegLon(LAT0) });

/**
 * Snap a GPS fix {lat, lon} onto the route.
 * Only looks at edges [index - back, index + ahead] so the marker can't jump to another
 * part of the route that happens to pass nearby. Only outdoor edges whose two ends both
 * have lat/lon are considered.
 * Returns { index, progress, d } (d = distance from fix to route, metres) or null.
 */
export function snapToRoute(fix, meta, edgeTypes, index, { back = 1, ahead = 3 } = {}) {
  const p = toXY(fix.lat, fix.lon);
  let best = null;
  const lo = Math.max(0, index - back);
  const hi = Math.min(meta.length - 2, index + ahead);
  for (let i = lo; i <= hi; i++) {
    if (edgeTypes[i] !== 'outdoor' || !hasGeo(meta[i]) || !hasGeo(meta[i + 1])) continue;
    const a = toXY(meta[i].lat, meta[i].lon);
    const b = toXY(meta[i + 1].lat, meta[i + 1].lon);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (!best || d < best.d - 1e-6) best = { index: i, progress: t, d };
  }
  if (!best) return null;
  // close enough to the end of the edge = we reached the next node
  if (best.progress >= 0.97) return { index: best.index + 1, progress: 0, d: best.d };
  return best;
}

/** Real GPS, or a fake source when `fake` is given. Returns a stop() function. */
export function watchGps(onFix, onError, fake) {
  if (fake) return fake(onFix);
  if (!navigator.geolocation) {
    onError?.({ code: 2 });
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(onFix, onError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
  return () => navigator.geolocation.clearWatch(id);
}

/**
 * Test helper (?fakegps): a simulated walker that follows the outdoor part of the route
 * from `startIndex`, with random GPS noise, one fix per second.
 */
export function makeFakeGps(meta, edgeTypes, startIndex, { speed = 1.4, noise = 6 } = {}) {
  return (onFix) => {
    const pts = [];
    if (hasGeo(meta[startIndex])) pts.push(toXY(meta[startIndex].lat, meta[startIndex].lon));
    for (let i = startIndex; i < meta.length - 1; i++) {
      if (edgeTypes[i] !== 'outdoor' || !hasGeo(meta[i + 1])) break;
      pts.push(toXY(meta[i + 1].lat, meta[i + 1].lon));
    }
    if (pts.length < 2) return () => {};
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    let walked = 0;
    const id = setInterval(() => {
      walked = Math.min(walked + speed, total);
      let left = walked;
      let q = pts[pts.length - 1];
      for (let i = 1; i < pts.length; i++) {
        const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (left <= len) {
          const f = len ? left / len : 0;
          q = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f };
          break;
        }
        left -= len;
      }
      const ll = fromXY(q.x + (Math.random() - 0.5) * 2 * noise, q.y + (Math.random() - 0.5) * 2 * noise);
      onFix({ coords: { latitude: ll.lat, longitude: ll.lon, accuracy: 10 } });
    }, 1000);
    return () => clearInterval(id);
  };
}
