// src/services/live2d/markerRules.ts
var EXPRESSION_DENY = /^(00_default|05_dark\.?|chibi|tailoff|longhairoff|shojo|finale_)/i;

// src/services/live2d/petExpression.ts
var PET_EXPRESSION_KEYS = ["shy", "smile"];
var PET_EXPRESSION_GRACE_MS = 1e3;
var pickPetExpression = (available, rand = Math.random) => {
  if (!Array.isArray(available) || !available.length) return null;
  const pool = available.filter((n) => !EXPRESSION_DENY.test(n));
  const hits = pool.filter((n) => PET_EXPRESSION_KEYS.some((k) => n.toLowerCase().includes(k)));
  if (!hits.length) return null;
  const r = rand();
  const i = Number.isFinite(r) ? Math.min(hits.length - 1, Math.max(0, Math.floor(r * hits.length))) : 0;
  return hits[i];
};
var newPetExpressionState = () => ({ name: null, showing: false, lastPetMs: 0 });
var petExpressionStep = (st, now, petting, available, rand = Math.random) => {
  if (!Number.isFinite(now)) return { state: st, show: st.showing, name: st.name };
  if (petting) {
    const keep = st.name !== null && Array.isArray(available) && available.includes(st.name);
    const name = keep ? st.name : pickPetExpression(available, rand);
    return { state: { name, showing: name !== null, lastPetMs: now }, show: name !== null, name };
  }
  if (!st.showing) return { state: st, show: false, name: null };
  if (now - st.lastPetMs < PET_EXPRESSION_GRACE_MS) return { state: st, show: true, name: st.name };
  return { state: { name: null, showing: false, lastPetMs: st.lastPetMs }, show: false, name: null };
};
var state = newPetExpressionState();
var petExpressionName = () => state.name;
var petExpressionShowing = () => state.showing;
var petExpressionHoldsLayer = () => state.showing;
var applyPetExpression = (now, petting, available, hooks = {}, rand = Math.random) => {
  const prev = state;
  const step = petExpressionStep(prev, now, petting, available, rand);
  state = step.state;
  if (step.show && step.name) {
    if (!prev.showing || prev.name !== step.name) {
      try {
        hooks.play?.(step.name);
      } catch {
      }
    }
  } else if (prev.showing) {
    try {
      hooks.stop?.();
    } catch {
    }
  }
  return step.show;
};
var __resetPetExpressionForTest = () => {
  state = newPetExpressionState();
};
export {
  PET_EXPRESSION_GRACE_MS,
  PET_EXPRESSION_KEYS,
  __resetPetExpressionForTest,
  applyPetExpression,
  newPetExpressionState,
  petExpressionHoldsLayer,
  petExpressionName,
  petExpressionShowing,
  petExpressionStep,
  pickPetExpression
};
