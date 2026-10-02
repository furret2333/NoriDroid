// ../src/services/live2d/motionReturn.ts
var NEUTRAL_RETURN_DELAY_MS = 5e3;
var timer = null;
var scheduleReturnToNeutral = (returnToNeutral, delayMs = NEUTRAL_RETURN_DELAY_MS) => {
  cancelReturnToNeutral();
  timer = setTimeout(() => {
    timer = null;
    try {
      returnToNeutral();
    } catch {
    }
  }, delayMs);
};
var cancelReturnToNeutral = () => {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
};
var hasPendingReturn = () => timer !== null;
export {
  NEUTRAL_RETURN_DELAY_MS,
  cancelReturnToNeutral,
  hasPendingReturn,
  scheduleReturnToNeutral
};
