import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  STEP_LENGTH_M,
  clamp,
  advancePos,
  posToT,
  tToPos,
  pointAt,
  levelRun,
  parseViewBox,
  createStepDetector,
} from './navMath.js';

const DEMO_SPEED_MPS = 5;
const MOTION_TIMEOUT_MS = 3500;

// iOS only grants motion sensors from a user tap, so AdminChat calls this from the "send" tap;
// the route then waits on the answer before listening to the accelerometer.
let motionReady = null;
export function requestMotionPermission() {
  const DME = typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null;
  if (DME && typeof DME.requestPermission === 'function') {
    motionReady = DME.requestPermission().then((r) => r === 'granted').catch(() => false);
  } else {
    motionReady = Promise.resolve(true);
  }
  return motionReady;
}
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 8;
const FOLLOW_ZOOM = 3.5;


const planCache = new Map();
const planDone = new Map();
function loadPlan(level) {
  if (!planCache.has(level)) {
    planCache.set(
      level,
      fetch(`/api/floorplan/${level}`)
        .then((r) => r.json())
        .then((plan) => {
          planDone.set(level, plan);
          // warm the browser cache for the SVG so floor switches are instant
          if (plan && plan.file) {
            const img = new Image();
            img.src = plan.file;
          }
          return plan;
        })
        .catch((e) => {
          planCache.delete(level);
          throw e;
        })
    );
  }
  return planCache.get(level);
}

function usePlan(level) {
  const [, force] = useState(0);
  const done = planDone.get(level);
  useEffect(() => {
    if (planDone.has(level)) return;
    let alive = true;
    loadPlan(level)
      .catch(() => planDone.set(level, { error: 'load' }))
      .finally(() => alive && force((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [level]);
  if (!done) return { plan: null, error: false };
  return { plan: done.error || !done.file ? null : done, error: !!done.error || !done.file };
}

/** Eases a path parameter t (node index + progress) so the marker glides instead of jumping. */
function useSmoothT(target) {
  const [t, setT] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(now - last, 64);
      last = now;
      const d = target - cur.current;
      if (Math.abs(d) < 0.003) {
        cur.current = target;
        setT(target);
        return;
      }
      cur.current += d * (1 - Math.exp(-dt / 150));
      setT(cur.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return t;
}

export function placeLabel(m, t) {
  if (!m) return '';
  if (m.outdoor) return t.outdoor;
  if (m.numFloors > 1) {
    const f = m.floorNumber === 0 ? t.groundFloor : `${t.floor} ${m.floorNumber}`;
    return `${m.building} · ${f}`;
  }
  return m.building || '';
}

function stairsHint(a, b, t) {
  if (!a || !b || a.outdoor || b.outdoor) return null;
  if (a.building !== b.building || a.floorNumber === b.floorNumber) return null;
  const up = b.floorNumber > a.floorNumber;
  return {
    up,
    text: (up ? t.stairsUp : t.stairsDown)(b.building, b.floorNumber === 0 ? t.groundFloor : `${t.floor} ${b.floorNumber}`),
  };
}

function dist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}


function LiveMap({ meta, target, t }) {
  const last = meta.length - 1;
  const tt = useSmoothT(target);
  const pos = tToPos(tt, last);
  const me = pointAt(pos, meta);
  const level = meta[pos.index].mapLevel;
  const { plan, error } = usePlan(level);

  const containerRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(FOLLOW_ZOOM);
  const [follow, setFollow] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [plan]);

  // ---- camera ----
  const vb = plan ? parseViewBox(plan.viewBox) : null;
  const s0 = vb && size.w ? Math.min(size.w / vb.w, size.h / vb.h) : 0.02;
  let followPan = { x: 0, y: 0 };
  if (vb && size.w && me) {
    const qx = (size.w - vb.w * s0) / 2 + (me.x - vb.x) * s0;
    const qy = (size.h - vb.h * s0) / 2 + (me.y - vb.y) * s0;
    followPan = { x: -(qx - size.w / 2) * zoom, y: -(qy - size.h / 2) * zoom };
  }
  const effPan = follow ? followPan : pan;
  const effPanRef = useRef(effPan);
  effPanRef.current = effPan;
  const u = 1 / (s0 * zoom); // map units per screen pixel (keeps markers a constant size)

  // ---- gestures (pointer events: mouse + touch + pinch) ----
  const pointers = useRef(new Map());
  const gesture = useRef(null);

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, e);
    if (pointers.current.size === 1) {
      gesture.current = { type: 'drag', x: e.clientX, y: e.clientY, pan: { ...effPanRef.current }, moved: false };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { type: 'pinch', d0: dist(a, b), zoom0: zoom };
    }
  };
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, e);
    const g = gesture.current;
    if (!g) return;
    if (g.type === 'drag') {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.moved && Math.hypot(dx, dy) > 4) {
        g.moved = true;
        setFollow(false);
        setDragging(true);
      }
      if (g.moved) setPan({ x: g.pan.x + dx, y: g.pan.y + dy });
    } else if (g.type === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      setZoom(clamp(g.zoom0 * (dist(a, b) / g.d0), MIN_ZOOM, MAX_ZOOM));
    }
  };
  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      setDragging(false);
    } else if (pointers.current.size === 1) {
      const p = [...pointers.current.values()][0];
      gesture.current = { type: 'drag', x: p.clientX, y: p.clientY, pan: { ...effPanRef.current }, moved: true };
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.15 : 0.87), MIN_ZOOM, MAX_ZOOM));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [plan]);

  if (error) return <div style={styles.mapMsg}>{t.noMap}</div>;
  if (!plan) return <div style={styles.mapMsg}>{t.loadingMap}</div>;

  const run = levelRun(meta, pos.index);
  const ahead = [me, ...meta.slice(pos.index + 1, run.end + 1)];
  const behind = [...meta.slice(run.start, pos.index + 1), me];
  const pts = (arr) => arr.map((p) => `${p.x},${p.y}`).join(' ');
  const endsHere = run.end === last; // destination is on this map
  const exitNode = meta[run.end];
  const nextLevelNode = !endsHere ? meta[run.end + 1] : null;
  const exitUp = nextLevelNode && nextLevelNode.floorNumber > exitNode.floorNumber;
  const exitDown = nextLevelNode && nextLevelNode.floorNumber < exitNode.floorNumber;
  const dest = meta[last];

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        ...styles.mapBox,
        cursor: dragging ? 'grabbing' : 'grab',
      }}
    >
      <div style={styles.zoomCol} onPointerDown={(e) => e.stopPropagation()}>
        <button style={styles.mapBtn} onClick={() => setZoom((z) => clamp(z * 1.3, MIN_ZOOM, MAX_ZOOM))}>+</button>
        <button style={styles.mapBtn} onClick={() => setZoom((z) => clamp(z / 1.3, MIN_ZOOM, MAX_ZOOM))}>−</button>
      </div>

      {!follow && (
        <button
          style={styles.recenter}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            setFollow(true);
            setZoom(FOLLOW_ZOOM);
          }}
        >
          {t.recenter}
        </button>
      )}

      <div
        key={level}
        style={{
          width: '100%',
          height: '100%',
          transform: `translate(${effPan.x}px, ${effPan.y}px) scale(${zoom})`,
          transformOrigin: 'center center',
          willChange: 'transform',
        }}
      >
        <img
          src={plan.file}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none', userSelect: 'none' }}
        />
        <svg
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          viewBox={plan.viewBox}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* already walked: faint trail */}
          {behind.length > 1 && (
            <polyline
              points={pts(behind)}
              fill="none"
              stroke="#8d9bb0"
              strokeOpacity="0.55"
              strokeWidth={5 * u}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* remaining route: starts AT the user and shrinks as they move */}
          {ahead.length > 1 && (
            <>
              <polyline points={pts(ahead)} fill="none" stroke="#fff" strokeWidth={12 * u} strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />
              <polyline points={pts(ahead)} fill="none" stroke="#1D6FD1" strokeWidth={7.5 * u} strokeLinecap="round" strokeLinejoin="round" />
              <polyline
                points={pts(ahead)}
                fill="none"
                stroke="#fff"
                strokeOpacity="0.9"
                strokeWidth={2 * u}
                strokeLinecap="round"
                strokeDasharray={`${2 * u} ${14 * u}`}
              >
                <animate attributeName="stroke-dashoffset" from="0" to={-16 * u} dur="0.9s" repeatCount="indefinite" />
              </polyline>
            </>
          )}

          {/* destination pin (only on the map that contains the destination) */}
          {endsHere && (
            <g transform={`translate(${dest.x},${dest.y}) scale(${u})`}>
              <path
                d="M0,0 C-4,-8 -12,-14 -12,-22 A12,12 0 1 1 12,-22 C12,-14 4,-8 0,0 Z"
                fill="#D94A2B"
                stroke="#fff"
                strokeWidth="2"
              />
              <circle cx="0" cy="-22" r="4.5" fill="#fff" />
            </g>
          )}

          {/* stairs marker where the route leaves this map */}
          {!endsHere && (
            <g transform={`translate(${exitNode.x},${exitNode.y}) scale(${u})`}>
              <circle r="13" fill="#E8890C" stroke="#fff" strokeWidth="2.5" />
              <text textAnchor="middle" dominantBaseline="central" fontSize="15" fontWeight="700" fill="#fff">
                {exitUp ? '↑' : exitDown ? '↓' : '➜'}
              </text>
            </g>
          )}

          {/* you are here */}
          {me && (
            <g transform={`translate(${me.x},${me.y}) scale(${u})`}>
              <circle r="14" fill="#1D6FD1" opacity="0.28">
                <animate attributeName="r" values="10;22;10" dur="1.8s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.35;0;0.35" dur="1.8s" repeatCount="indefinite" />
              </circle>
              <circle r="8" fill="#1D6FD1" stroke="#fff" strokeWidth="3" />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Route card (instruction + map + controls)                           */
/* ------------------------------------------------------------------ */

export default function LiveRoute({ route, t, onPositionChange, onArrived }) {
  const { path, pathMeta: meta, edgeMeters, steps, destination } = route;
  const last = path.length - 1;

  const [pos, setPos] = useState({ index: 0, progress: 0 });
  const [auto, setAuto] = useState(true); // step tracking is always on
  const [demo, setDemo] = useState(false);
  const [motionMsg, setMotionMsg] = useState('');

  const arrived = pos.index >= last;
  const advance = useCallback((m) => setPos((p) => advancePos(p, m, edgeMeters, last)), [edgeMeters, last]);

  // preload the maps of every floor this route crosses
  useEffect(() => {
    [...new Set(meta.map((m) => m.mapLevel))].forEach((lv) => loadPlan(lv).catch(() => {}));
  }, [meta]);

  // keep the parent informed of the user's current node (new questions start from here)
  useEffect(() => {
    onPositionChange?.(path[pos.index]);
  }, [pos.index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (arrived) {
      setDemo(false);
      setAuto(false);
      onArrived?.();
    }
  }, [arrived]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the phone awake while navigating
  useEffect(() => {
    let lock = null;
    navigator.wakeLock?.request?.('screen').then((l) => (lock = l)).catch(() => {});
    return () => {
      lock?.release?.().catch(() => {});
    };
  }, []);

  // demo mode: simulated walk
  useEffect(() => {
    if (!demo) return;
    const id = setInterval(() => advance(DEMO_SPEED_MPS * 0.1), 100);
    return () => clearInterval(id);
  }, [demo, advance]);

  // step counting with the phone's accelerometer (on by default)
  useEffect(() => {
    if (!auto) return;
    let alive = true;
    let timer = 0;
    const feed = createStepDetector(() => advance(STEP_LENGTH_M));
    let gotEvent = false;
    const onMotion = (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      gotEvent = true;
      feed(Math.hypot(a.x, a.y, a.z), performance.now());
    };
    const stop = (msg) => {
      setMotionMsg(msg);
      setAuto(false);
    };
    (motionReady || Promise.resolve(true)).then((granted) => {
      if (!alive) return;
      if (!granted) return stop(t.motionDenied);
      window.addEventListener('devicemotion', onMotion);
      timer = setTimeout(() => !gotEvent && stop(t.motionNone), MOTION_TIMEOUT_MS);
    });
    return () => {
      alive = false;
      window.removeEventListener('devicemotion', onMotion);
      clearTimeout(timer);
    };
  }, [auto, advance, t.motionNone, t.motionDenied]);

  const cur = meta[pos.index];
  const hint = stairsHint(cur, meta[pos.index + 1], t);
  const instruction = arrived ? t.arrived : steps[pos.index + 1];
  const remainingM = Math.round(
    edgeMeters.slice(pos.index).reduce((s, m) => s + m, 0) - (edgeMeters[pos.index] ?? 0) * pos.progress
  );
  const pct = Math.round(((pos.index + pos.progress) / Math.max(last, 1)) * 100);

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>
        {t.routeTo} {destination}
      </div>

      {/* current instruction */}
      <div style={{ ...styles.instruction, borderLeftColor: arrived ? '#2e9e5b' : hint ? '#e8d90c' : '#1D6FD1' }}>
        <div style={styles.where}>
           {t.youAreHere}: <strong>{placeLabel(cur, t)}</strong>
        </div>
        <div style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.4 }}>{instruction}</div>
        {hint && !arrived && (
          <div style={styles.stairs}>
            {hint.up ? '⬆' : '⬇'} {hint.text}
          </div>
        )}
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressBar, width: `${pct}%`, background: arrived ? '#2e9e5b' : '#1D6FD1' }} />
        </div>
        <div style={{ fontSize: 11.5, color: 'oklch(0.5 0.02 258)', marginTop: 4 }}>
          {arrived ? '' : `≈ ${remainingM} m ${t.remaining} · ${t.step} ${pos.index + 2}/${steps.length}`}
        </div>
      </div>

      <LiveMap meta={meta} target={posToT(pos)} t={t} />

      {/* sensor unavailable: explain, and keep a simulated walk for presentations */}
      {motionMsg && !arrived && (
        <div style={styles.warn}>
          <div>{motionMsg}</div>
          <button style={{ ...styles.chip, ...(demo ? styles.chipOn : null), marginTop: 8 }} onClick={() => setDemo((d) => !d)}>
            {demo ? '⏸' : '▶'} {t.demo}
          </button>
        </div>
      )}

      {/* all directions, always visible */}
      <div style={styles.stepsTitle}>{t.stepsTitle}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {steps.map((text, i) => {
          const state = i <= pos.index ? 'done' : i === pos.index + 1 ? 'current' : 'todo';
          return (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', opacity: state === 'done' ? 0.45 : 1 }}>
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  flex: 'none',
                  marginTop: 1,
                  fontSize: 11.5,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: state === 'current' ? '#1D6FD1' : 'oklch(0.94 0.03 258)',
                  color: state === 'current' ? '#fff' : 'oklch(0.45 0.13 258)',
                }}
              >
                {state === 'done' ? '✓' : i + 1}
              </div>
              <div style={{ fontSize: 15, lineHeight: 1.5, fontWeight: state === 'current' ? 600 : 400 }}>{text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


const styles = {
  mapBox: {
    position: 'relative',
    width: '100%',
    height: 'min(52vh, 520px)',
    overflow: 'hidden',
    background: 'oklch(0.97 0.008 258)',
    border: '1px solid oklch(0.88 0.015 258)',
    borderRadius: 10,
    touchAction: 'none',
    userSelect: 'none',
  },
  mapMsg: { padding: 16, fontSize: 13, color: '#888' },
  zoomCol: { position: 'absolute', top: 10, right: 10, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 6 },
  mapBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    border: '1px solid #ccc',
    background: '#fff',
    fontWeight: 700,
    fontSize: 17,
    cursor: 'pointer',
    boxShadow: '0 2px 4px rgba(0,0,0,0.12)',
  },
  recenter: {
    position: 'absolute',
    bottom: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 10,
    border: 'none',
    borderRadius: 20,
    background: '#1D6FD1',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 16px',
    cursor: 'pointer',
    boxShadow: '0 3px 10px rgba(29,111,209,0.45)',
  },
  instruction: {
    background: 'oklch(0.97 0.012 258)',
    borderLeft: '5px solid #1D6FD1',
    borderRadius: 10,
    padding: '12px 14px',
    marginBottom: 10,
  },
  where: { fontSize: 12, color: 'oklch(0.45 0.03 258)', marginBottom: 4 },
  stairs: {
    marginTop: 8,
    display: 'inline-block',
    background: '#FFF1DC',
    color: '#9A5A00',
    borderRadius: 8,
    padding: '5px 10px',
    fontSize: 13,
    fontWeight: 600,
  },
  progressTrack: { height: 5, borderRadius: 3, background: 'oklch(0.9 0.015 258)', marginTop: 10, overflow: 'hidden' },
  progressBar: { height: '100%', borderRadius: 3, transition: 'width .3s' },
  stepsTitle: { fontSize: 13, fontWeight: 700, color: 'oklch(0.4 0.05 258)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '16px 0 10px' },
  chip: {
    border: '1px solid oklch(0.88 0.03 258)',
    borderRadius: 20,
    background: 'oklch(0.94 0.02 258)',
    color: 'oklch(0.4 0.1 258)',
    fontSize: 12.5,
    fontWeight: 600,
    padding: '7px 12px',
    cursor: 'pointer',
  },
  chipOn: { background: 'oklch(0.5 0.15 258)', color: '#fff', border: '1px solid oklch(0.5 0.15 258)' },
  warn: { marginTop: 10, fontSize: 13, lineHeight: 1.45, color: '#9A5A00', background: '#FFF1DC', borderRadius: 10, padding: '10px 12px' },
};
