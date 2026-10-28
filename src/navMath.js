// Pure helpers for live navigation (no React) so they can be unit-tested.

export const STEP_LENGTH_M = 0.7; // average walking step
export const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/**
 * Position along the route = { index, progress }:
 * the user is `progress` (0..1) of the way between node `index` and `index + 1`.
 * Move forward by `meters`, using edgeMeters[i] = length of edge i -> i+1.
 */
export function advancePos(pos, meters, edgeMeters, last) {
  let { index, progress } = pos;
  while (meters > 0 && index < last) {
    const len = Math.max(edgeMeters[index] ?? 1, 0.5);
    const left = len * (1 - progress);
    if (meters >= left) {
      meters -= left;
      index += 1;
      progress = 0;
    } else {
      progress += meters / len;
      meters = 0;
    }
  }
  if (index >= last) return { index: last, progress: 0 };
  return { index, progress };
}

export const posToT = (pos) => pos.index + pos.progress;

export function tToPos(t, last) {
  if (t >= last) return { index: last, progress: 0 };
  const index = Math.max(0, Math.floor(t + 1e-9));
  return { index, progress: clamp(t - index, 0, 1) };
}

/** Map coordinates of the user, interpolated between two nodes when they share a map. */
export function pointAt(pos, meta) {
  const a = meta[pos.index];
  if (!a) return null;
  const b = meta[pos.index + 1];
  if (!b || pos.progress <= 0 || a.mapLevel !== b.mapLevel) return { x: a.x, y: a.y };
  return {
    x: a.x + (b.x - a.x) * pos.progress,
    y: a.y + (b.y - a.y) * pos.progress,
  };
}

/** The consecutive stretch of the route (around `index`) drawn on the same map. */
export function levelRun(meta, index) {
  const level = meta[index].mapLevel;
  let start = index;
  let end = index;
  while (start > 0 && meta[start - 1].mapLevel === level) start--;
  while (end < meta.length - 1 && meta[end + 1].mapLevel === level) end++;
  return { level, start, end };
}

export function parseViewBox(vb) {
  const [x, y, w, h] = String(vb).split(/[\s,]+/).map(Number);
  return { x, y, w, h };
}

/**
 * Simple walking-step detector from accelerometer magnitude (m/s^2).
 * feed(magnitude, timeMs) calls onStep() once per detected step.
 */
export function createStepDetector(onStep, { threshold = 1.2, minIntervalMs = 300 } = {}) {
  let gravity = 9.81;
  let smooth = 0;
  let prev = 0;
  let prev2 = 0;
  let lastStep = -Infinity;
  return function feed(magnitude, tMs) {
    gravity = gravity * 0.95 + magnitude * 0.05;
    const a = magnitude - gravity;
    smooth = smooth * 0.6 + a * 0.4;
    // local maximum above the threshold, with a refractory period
    if (prev > threshold && prev >= prev2 && prev >= smooth && tMs - lastStep >= minIntervalMs) {
      lastStep = tMs;
      onStep();
    }
    prev2 = prev;
    prev = smooth;
  };
}

/** Distance in metres from the start of the route to `pos`. */
export function routeMeters(pos, edgeMeters) {
  let m = 0;
  for (let i = 0; i < pos.index; i++) m += edgeMeters[i] ?? 0;
  return m + (edgeMeters[pos.index] ?? 0) * pos.progress;
}

const EARTH_R = 6371000;
/** Local metres (east, north) of [lat, lon] around an origin [lat0, lon0]. */
function toLocal([lat, lon], [lat0, lon0]) {
  const k = Math.PI / 180;
  return { x: (lon - lon0) * k * EARTH_R * Math.cos(lat0 * k), y: (lat - lat0) * k * EARTH_R };
}

/**
 * Snap a GPS fix onto the route. Only works on outdoor stretches (both ends of a segment need
 * `geo`), from one segment behind `index` to a few ahead. Returns { pos, offM } or null.
 */
export function snapGps(lat, lon, meta, index, { back = 1, ahead = 4 } = {}) {
  if (!meta[index]?.geo || !meta[index + 1]?.geo) return null;
  let best = null;
  for (let i = Math.max(0, index - back); i < Math.min(meta.length - 1, index + ahead + 1); i++) {
    const a = meta[i].geo;
    const b = meta[i + 1].geo;
    if (!a || !b) {
      if (i > index) break; // stop at the first indoor segment ahead
      continue;
    }
    const p = toLocal([lat, lon], a);
    const q = toLocal(b, a);
    const len2 = q.x * q.x + q.y * q.y;
    const f = len2 ? clamp((p.x * q.x + p.y * q.y) / len2, 0, 1) : 0;
    const offM = Math.hypot(p.x - q.x * f, p.y - q.y * f);
    if (!best || offM < best.offM) {
      best = { pos: f >= 1 ? { index: i + 1, progress: 0 } : { index: i, progress: f }, offM };
    }
  }
  return best;
}

/**
 * Place a GPS fix on the map: find the nearest outdoor path (geo.edges), keep the position
 * along it and the sideways offset, so the dot follows the drawn paths and shows real detours.
 * geo = { nodes: { id: { geo: [lat, lon], x, y, mapLevel } }, edges: [[a, b], ...] }
 * Returns { x, y, mapLevel, offM, unitsPerM } or null.
 */
export function gpsToMap(lat, lon, geo) {
  let best = null;
  for (const [ida, idb] of geo.edges) {
    const A = geo.nodes[ida];
    const B = geo.nodes[idb];
    const p = toLocal([lat, lon], A.geo);
    const q = toLocal(B.geo, A.geo);
    const lenM = Math.hypot(q.x, q.y);
    if (lenM < 0.5) continue;
    const f = clamp((p.x * q.x + p.y * q.y) / (lenM * lenM), 0, 1);
    const offM = Math.hypot(p.x - q.x * f, p.y - q.y * f);
    if (best && offM >= best.offM) continue;
    const side = (q.x * p.y - q.y * p.x) / lenM; // metres to the left of A->B
    const mx = B.x - A.x;
    const my = B.y - A.y;
    const lenMap = Math.hypot(mx, my);
    const k = lenMap / lenM; // map units per metre on this path
    best = {
      // map y points down, so "left" of (mx, my) is (my, -mx)
      x: A.x + mx * f + (my / lenMap) * side * k,
      y: A.y + my * f - (mx / lenMap) * side * k,
      mapLevel: A.mapLevel,
      offM,
      unitsPerM: k,
    };
  }
  return best;
}
