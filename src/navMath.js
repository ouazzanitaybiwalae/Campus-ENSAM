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
