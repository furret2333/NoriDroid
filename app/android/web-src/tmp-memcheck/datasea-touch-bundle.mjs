// src/services/datasea-touch.ts
var DATASEA_TOUCH_RADIUS = 170;
var DATASEA_TOUCH_PULL_RATE = 0.18;
var DATASEA_TOUCH_RAMP_MS = 350;
var DATASEA_TOUCH_RELEASE_MS = 400;
var DATASEA_TOUCH_GLIDE_RATE = 8;
var newDataseaTouchState = () => ({
  down: false,
  startAt: 0,
  pressFrom: 0,
  releasedAt: 0,
  releaseFrom: 0,
  rawX: 0,
  rawY: 0,
  x: 0,
  y: 0,
  strength: 0
});
var smoothstep = (t) => {
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
};
var finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;
var dataseaTouchStart = (st, x, y, now) => {
  const nx = finite(x);
  const ny = finite(y);
  return {
    ...st,
    down: true,
    startAt: finite(now),
    /** 从**当前**强度接着往 1 涨：释放过程中再次按下时不会先跳回 0 */
    pressFrom: Math.min(1, Math.max(0, finite(st.strength))),
    rawX: nx,
    rawY: ny,
    x: nx,
    y: ny
  };
};
var dataseaTouchMove = (st, x, y) => {
  if (!st.down) return st;
  return { ...st, rawX: finite(x), rawY: finite(y) };
};
var dataseaTouchEnd = (st, now) => {
  if (!st.down) return st;
  return { ...st, down: false, releasedAt: finite(now), releaseFrom: st.strength };
};
var dataseaTouchStep = (st, now, dt) => {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const k = d > 0 ? 1 - Math.exp(-DATASEA_TOUCH_GLIDE_RATE * d) : 0;
  const x = st.x + (st.rawX - st.x) * k;
  const y = st.y + (st.rawY - st.y) * k;
  let strength;
  if (st.down) {
    const from = Math.min(1, Math.max(0, finite(st.pressFrom)));
    strength = from + (1 - from) * smoothstep((finite(now) - st.startAt) / DATASEA_TOUCH_RAMP_MS);
  } else {
    const from = Math.min(1, Math.max(0, finite(st.releaseFrom)));
    strength = from * (1 - smoothstep((finite(now) - st.releasedAt) / DATASEA_TOUCH_RELEASE_MS));
  }
  if (!Number.isFinite(strength) || strength < 0) strength = 0;
  if (strength > 1) strength = 1;
  const active = st.down || strength > 0;
  return { state: { ...st, x, y, strength }, strength, x, y, active };
};
var dataseaTouchPull = (dt, dist, strength) => {
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  if (!Number.isFinite(dist) || dist <= 1 || dist >= DATASEA_TOUCH_RADIUS) return 0;
  if (!Number.isFinite(strength) || strength <= 0) return 0;
  const s = Math.min(1, strength);
  return Math.min(1, DATASEA_TOUCH_PULL_RATE * dt) * (1 - dist / DATASEA_TOUCH_RADIUS) * s;
};
export {
  DATASEA_TOUCH_GLIDE_RATE,
  DATASEA_TOUCH_PULL_RATE,
  DATASEA_TOUCH_RADIUS,
  DATASEA_TOUCH_RAMP_MS,
  DATASEA_TOUCH_RELEASE_MS,
  dataseaTouchEnd,
  dataseaTouchMove,
  dataseaTouchPull,
  dataseaTouchStart,
  dataseaTouchStep,
  newDataseaTouchState
};
