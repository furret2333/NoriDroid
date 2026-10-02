// src/services/live2d/frameCap.ts
var L2D_FRAME_TOLERANCE_MS = 2;
var L2D_FPS_OPTIONS = [0, 60, 30, 20, 15];
var L2D_FPS_DEFAULT = 60;
var frameThreshold = (fps) => fps > 0 ? 1e3 / fps - L2D_FRAME_TOLERANCE_MS : 0;
var frameGate = (now, last, minInterval) => {
  const safeLast = typeof last === "number" && Number.isFinite(last) ? last : void 0;
  if (!Number.isFinite(now)) return { draw: true, last: safeLast ?? 0 };
  if (!(minInterval > 0)) return { draw: true, last: now };
  if (safeLast === void 0) return { draw: true, last: now };
  return now - safeLast < minInterval ? { draw: false, last: safeLast } : { draw: true, last: now };
};
var L2D_DT_CAP_BASE_MS = 50;
var frameDtCapMs = (minIntervalMs, baseMs = L2D_DT_CAP_BASE_MS) => Math.max(baseMs, (Number.isFinite(minIntervalMs) ? minIntervalMs : 0) * 2);
var normalizeFps = (v) => {
  const n = Number(v);
  return L2D_FPS_OPTIONS.includes(n) ? n : L2D_FPS_DEFAULT;
};
var setFrameCap = (host, fps) => {
  host.__noriL2dMinInterval = frameThreshold(fps);
  host.__noriL2dLast = void 0;
};
var setRenderPaused = (host, paused) => {
  host.__noriL2dPaused = !!paused;
  host.__noriL2dLast = void 0;
};
var installFrameCap = (host, fps = L2D_FPS_DEFAULT, now = () => performance.now()) => {
  setFrameCap(host, fps);
  host.__noriL2dTick = (updater, model) => {
    if (host.__noriL2dPaused) return;
    const gate = frameGate(now(), host.__noriL2dLast, host.__noriL2dMinInterval || 0);
    host.__noriL2dLast = gate.last;
    if (!gate.draw) return;
    updater.updateTime();
    model.update();
    host.__noriL2dDraws = (host.__noriL2dDraws || 0) + 1;
  };
};
export {
  L2D_DT_CAP_BASE_MS,
  L2D_FPS_DEFAULT,
  L2D_FPS_OPTIONS,
  L2D_FRAME_TOLERANCE_MS,
  frameDtCapMs,
  frameGate,
  frameThreshold,
  installFrameCap,
  normalizeFps,
  setFrameCap,
  setRenderPaused
};
