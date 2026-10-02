// ../src/services/live2d/petHeadZone.ts
var SKULL_TOP_BAND = 0.6;
var HEAD_TOP_EPS_RATIO = 0.03;
var clamp01 = (v) => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
var isBox = (b) => {
  const x = b;
  return !!x && Number.isFinite(x.top) && Number.isFinite(x.bottom) && Number.isFinite(x.left) && Number.isFinite(x.right);
};
var pickHeadBox = (parts, modelBox, epsRatio = HEAD_TOP_EPS_RATIO) => {
  if (!modelBox || !isBox(modelBox) || !Array.isArray(parts) || !parts.length) return null;
  const modelH = modelBox.top - modelBox.bottom;
  if (!(modelH > 0)) return null;
  const valid = parts.filter(isBox);
  if (!valid.length) return null;
  let maxTop = -Infinity;
  for (const p of valid) if (p.top > maxTop) maxTop = p.top;
  const cut = maxTop - modelH * clamp01(epsRatio);
  let box = null;
  for (const p of valid) {
    if (p.top < cut) continue;
    if (p.bottom > modelBox.top) continue;
    box = box ? {
      left: Math.min(box.left, p.left),
      right: Math.max(box.right, p.right),
      top: Math.max(box.top, p.top),
      bottom: Math.min(box.bottom, p.bottom)
    } : { ...p };
  }
  return box;
};
var inHeadBand = (headBox, y, band = SKULL_TOP_BAND) => {
  if (!headBox || !isBox(headBox) || !Number.isFinite(y)) return false;
  const h = headBox.top - headBox.bottom;
  if (!(h > 0)) return false;
  return y >= headBox.top - h * clamp01(band);
};
var headBandLine = (headBox, band = SKULL_TOP_BAND) => {
  if (!headBox || !isBox(headBox)) return null;
  const h = headBox.top - headBox.bottom;
  if (!(h > 0)) return null;
  return headBox.top - h * clamp01(band);
};
var HEAD_ZONE_RATIO = 0.32;
var headZoneLine = (headBox, modelBox, band = SKULL_TOP_BAND, ratio = HEAD_ZONE_RATIO) => {
  const a = headBandLine(headBox, band);
  let b = null;
  if (modelBox && isBox(modelBox)) {
    const h = modelBox.top - modelBox.bottom;
    if (h > 0) b = modelBox.top - h * clamp01(ratio);
  }
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
};
var inHeadZone = (headBox, modelBox, y, band = SKULL_TOP_BAND, ratio = HEAD_ZONE_RATIO) => {
  if (!Number.isFinite(y)) return false;
  const line = headZoneLine(headBox, modelBox, band, ratio);
  return line !== null && y >= line;
};
var HEAD_LEASH_RATIO = 0.06;
var HEAD_LEASH_MARGIN_RATIO = 0.02;
var inHeadZoneHysteresis = (headBox, modelBox, x, y, wasIn, band = SKULL_TOP_BAND, ratio = HEAD_ZONE_RATIO, leash = HEAD_LEASH_RATIO, margin = HEAD_LEASH_MARGIN_RATIO) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const line = headZoneLine(headBox, modelBox, band, ratio);
  if (line === null) return false;
  if (!wasIn) return y >= line;
  if (!modelBox || !isBox(modelBox)) return false;
  const h = modelBox.top - modelBox.bottom;
  if (!(h > 0)) return false;
  const m = h * clamp01(margin);
  return x >= modelBox.left - m && x <= modelBox.right + m && y >= line - h * clamp01(leash) && y <= modelBox.top + m;
};
export {
  HEAD_LEASH_MARGIN_RATIO,
  HEAD_LEASH_RATIO,
  HEAD_TOP_EPS_RATIO,
  HEAD_ZONE_RATIO,
  SKULL_TOP_BAND,
  headBandLine,
  headZoneLine,
  inHeadBand,
  inHeadZone,
  inHeadZoneHysteresis,
  pickHeadBox
};
