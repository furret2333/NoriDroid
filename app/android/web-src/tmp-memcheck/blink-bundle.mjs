// src/services/live2d/beforeUpdate.ts
var handlers = [];
var installed = false;
var registerBeforeUpdate = (fn) => {
  if (typeof fn !== "function" || handlers.includes(fn)) return;
  handlers.push(fn);
  installBeforeUpdate();
};
var runBeforeUpdate = () => {
  for (const fn of handlers) {
    try {
      fn();
    } catch {
    }
  }
};
var installBeforeUpdate = (host) => {
  if (installed) return;
  const h = host ?? (typeof window !== "undefined" ? window : null);
  if (!h) return;
  try {
    Object.defineProperty(h, "__noriBeforeModelUpdate", {
      value: runBeforeUpdate,
      writable: false,
      enumerable: false,
      configurable: true
    });
  } catch {
    ;
    h.__noriBeforeModelUpdate = runBeforeUpdate;
  }
  ;
  h.__noriRegisterBeforeUpdate = registerBeforeUpdate;
  h.__noriBeforeUpdateCount = beforeUpdateHandlerCount;
  installed = true;
};
var beforeUpdateHandlerCount = () => handlers.length;

// src/services/live2d/blink.ts
var DEFAULT_BLINK_TUNING = {
  minGapMs: 2400,
  maxGapMs: 6200,
  closeMs: 90,
  closedMs: 40,
  openMs: 130,
  doubleChance: 0.12,
  doubleGapMs: 130
};
var blinkTotalMs = (t = DEFAULT_BLINK_TUNING) => t.closeMs + t.closedMs + t.openMs;
var nextBlinkGap = (rand, t = DEFAULT_BLINK_TUNING) => {
  const v = rand();
  const r = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  return t.minGapMs + r * (t.maxGapMs - t.minGapMs);
};
var blinkClosure = (elapsedMs, t = DEFAULT_BLINK_TUNING) => {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (elapsedMs < t.closeMs) return elapsedMs / t.closeMs;
  if (elapsedMs < t.closeMs + t.closedMs) return 1;
  const o = elapsedMs - t.closeMs - t.closedMs;
  if (o < t.openMs) return t.openMs <= 0 ? 0 : 1 - o / t.openMs;
  return 0;
};
var newBlinkState = (now, rand = Math.random, t = DEFAULT_BLINK_TUNING) => ({
  on: true,
  blinking: false,
  startMs: 0,
  nextAtMs: now + nextBlinkGap(rand, t),
  doublePending: false,
  count: 0
});
var blinkStep = (st, now, rand = Math.random, t = DEFAULT_BLINK_TUNING) => {
  if (!Number.isFinite(now)) return { state: st, closure: 0 };
  if (!st.on) {
    return st.blinking ? { state: { ...st, blinking: false, startMs: 0, doublePending: false, nextAtMs: now + nextBlinkGap(rand, t) }, closure: 0 } : { state: st, closure: 0 };
  }
  if (!st.blinking) {
    if (now < st.nextAtMs) return { state: st, closure: 0 };
    return { state: { ...st, blinking: true, startMs: now, count: st.count + 1 }, closure: blinkClosure(0, t) };
  }
  const elapsed = now - st.startMs;
  const total = blinkTotalMs(t);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > total * 4) {
    return { state: { ...st, blinking: false, startMs: 0, doublePending: false, nextAtMs: now + nextBlinkGap(rand, t) }, closure: 0 };
  }
  if (elapsed >= total) {
    if (!st.doublePending && rand() < t.doubleChance) {
      return { state: { ...st, blinking: false, startMs: 0, doublePending: true, nextAtMs: now + t.doubleGapMs }, closure: 0 };
    }
    return { state: { ...st, blinking: false, startMs: 0, doublePending: false, nextAtMs: now + nextBlinkGap(rand, t) }, closure: 0 };
  }
  return { state: st, closure: blinkClosure(elapsed, t) };
};
var BLINK_PARAMS = ["ParamEyeLOpen", "ParamEyeROpen"];
var defaultHooks = () => {
  if (typeof window === "undefined") return {};
  const w = window;
  return { get: w.__noriGetParam, add: w.__noriAddParam };
};
var nowMs = () => typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
var state = newBlinkState(0);
var lastClosure = 0;
var blinkCount = () => state.count;
var blinkClosureNow = () => lastClosure;
var applyBlink = (now = nowMs(), hooks = defaultHooks()) => {
  const step = blinkStep(state, now);
  state = step.state;
  lastClosure = step.closure;
  const k = step.closure;
  if (k <= 0) return 0;
  const { get, add } = hooks;
  if (typeof get !== "function" || typeof add !== "function") return 0;
  let written = 0;
  for (const id of BLINK_PARAMS) {
    const c = get(id);
    if (typeof c !== "number" || !Number.isFinite(c) || c === 0) continue;
    add(id, -c * k);
    written += 1;
  }
  return written;
};
var installBlink = () => {
  registerBeforeUpdate(() => {
    applyBlink();
  });
};
var __resetBlinkForTest = (now = 0, rand = () => 0.5) => {
  state = newBlinkState(now, rand);
  lastClosure = 0;
};
export {
  BLINK_PARAMS,
  DEFAULT_BLINK_TUNING,
  __resetBlinkForTest,
  applyBlink,
  blinkClosure,
  blinkClosureNow,
  blinkCount,
  blinkStep,
  blinkTotalMs,
  installBlink,
  newBlinkState,
  nextBlinkGap
};
