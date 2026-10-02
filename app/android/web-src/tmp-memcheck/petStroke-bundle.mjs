// ../src/services/live2d/petStroke.ts
var DEFAULT_PET_STROKE_TUNING = {
  requiredMs: 1e3,
  horizontalDominance: 1,
  minSpeedX: 0.05,
  maxSampleGapMs: 250
};
var PET_STROKE_IDLE = Object.freeze({
  completed: false,
  progressMs: 0,
  qualifying: false,
  velocityX: 0
});
var createPetStrokeDetector = (getTuning = () => DEFAULT_PET_STROKE_TUNING) => {
  let active = false;
  let latched = false;
  let progress = 0;
  let lastT = 0;
  let lastX = 0;
  let lastY = 0;
  const rejected = () => ({ completed: false, progressMs: progress, qualifying: false, velocityX: 0 });
  return {
    get active() {
      return active;
    },
    get progressMs() {
      return progress;
    },
    start(nowMs, x, y) {
      active = true;
      latched = false;
      progress = 0;
      lastT = nowMs;
      lastX = x;
      lastY = y;
    },
    move(nowMs, x, y) {
      if (!active) return PET_STROKE_IDLE;
      const t = getTuning();
      if (!Number.isFinite(nowMs) || !Number.isFinite(x) || !Number.isFinite(y)) return rejected();
      const dt = nowMs - lastT;
      const dx = x - lastX;
      const dy = y - lastY;
      lastT = nowMs;
      lastX = x;
      lastY = y;
      if (dt <= 0 || dt > t.maxSampleGapMs) return rejected();
      const vx = dx / (dt / 1e3);
      const horizontal = Math.abs(dx) >= t.horizontalDominance * Math.abs(dy);
      const fastEnough = Math.abs(vx) >= t.minSpeedX;
      if (!horizontal || !fastEnough) return rejected();
      progress = Math.min(t.requiredMs, progress + dt);
      const completed = !latched && progress >= t.requiredMs;
      if (completed) latched = true;
      return { completed, progressMs: progress, qualifying: true, velocityX: vx };
    },
    end() {
      active = false;
      latched = false;
      progress = 0;
    }
  };
};
export {
  DEFAULT_PET_STROKE_TUNING,
  PET_STROKE_IDLE,
  createPetStrokeDetector
};
