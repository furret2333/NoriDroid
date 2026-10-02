// ../src/services/live2d/petEffect.ts
var LAYER_ID = "nori-pet-fx";
var MAX_LIVE = 28;
var Z_INDEX = "3";
var MOTE_GLOW = "radial-gradient(circle, rgba(255,255,255,0.92) 0%, rgba(190,235,255,0.48) 42%, rgba(190,235,255,0) 100%)";
var MOTE_SIZE_MIN = 10;
var MOTE_SIZE_MAX = 20;
var layer = null;
var live = 0;
var spawned = { mote: 0, star: 0, ripple: 0 };
var petFxSpawned = () => ({ ...spawned });
var release = (anim, el) => {
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    live = Math.max(0, live - 1);
    el.remove();
  };
  anim.addEventListener("finish", done);
  anim.addEventListener("cancel", done);
};
var ensureLayer = () => {
  if (typeof document === "undefined" || !document.body) return null;
  if (layer && layer.isConnected) return layer;
  layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = `position:fixed;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:${Z_INDEX}`;
  document.body.appendChild(layer);
  return layer;
};
var spawnPetMotes = (x, y, opts = {}) => {
  const host = ensureLayer();
  if (!host) return;
  const room = MAX_LIVE - live;
  if (room <= 0) return;
  const count = Math.max(1, Math.min(opts.count ?? 1, room));
  const spread = opts.spread ?? 24;
  const rise = opts.rise ?? 52;
  for (let i = 0; i < count; i += 1) {
    const el = document.createElement("span");
    el.className = "nori-pet-mote";
    el.dataset.kind = "mote";
    const size = MOTE_SIZE_MIN + Math.random() * (MOTE_SIZE_MAX - MOTE_SIZE_MIN);
    el.style.cssText = [
      "position:absolute",
      `left:${(x + (Math.random() - 0.5) * spread).toFixed(1)}px`,
      `top:${(y + (Math.random() - 0.5) * spread * 0.5).toFixed(1)}px`,
      `width:${size.toFixed(1)}px`,
      `height:${size.toFixed(1)}px`,
      "border-radius:50%",
      `background:${MOTE_GLOW}`,
      "will-change:transform,opacity",
      "user-select:none",
      "-webkit-user-select:none"
    ].join(";");
    host.appendChild(el);
    live += 1;
    spawned.mote += 1;
    const peak = 0.42 + Math.random() * 0.24;
    const dx = (Math.random() - 0.5) * 22;
    const dy = -(rise + Math.random() * 22);
    const anim = el.animate(
      [
        { transform: "translate(-50%,-50%) scale(0.82)", opacity: 0 },
        { transform: `translate(calc(-50% + ${(dx * 0.45).toFixed(1)}px), calc(-50% + ${(dy * 0.45).toFixed(1)}px)) scale(1)`, opacity: peak, offset: 0.3 },
        { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(0.92)`, opacity: 0 }
      ],
      // 慢一点 (1.2~1.7s) 才"柔和"; 快闪会显突兀
      { duration: 1200 + Math.random() * 500, easing: "cubic-bezier(0.25,0.46,0.45,0.94)", fill: "forwards" }
    );
    release(anim, el);
  }
};
var clearPetFx = () => {
  generation += 1;
  for (const id of timers) window.clearTimeout(id);
  timers.clear();
  live = 0;
  if (layer) {
    layer.remove();
    layer = null;
  }
};
var petFxCount = () => layer ? layer.childElementCount : 0;
var petFxLayerId = () => LAYER_ID;
var petMoteGlow = () => MOTE_GLOW;
var PET_FX_UNIT_PX = 60;
var PET_FX_COLORS = {
  lu: "rgba(107,219,255,",
  zf: "rgba(199,240,255,",
  mint: "rgba(158,250,222,"
};
var STAR_GLOW = (color) => `radial-gradient(circle, rgba(255,255,255,0.98) 0%, ${color}0.55) 30%, ${color}0) 72%)`;
var generation = 0;
var timers = /* @__PURE__ */ new Set();
var later = (ms, fn) => {
  const g = generation;
  const id = window.setTimeout(() => {
    timers.delete(id);
    if (g !== generation) return;
    fn();
  }, ms);
  timers.add(id);
};
var rand = (a, b) => a + (b - a) * Math.random();
var spawnSpark = (x, y, s) => {
  const host = ensureLayer();
  if (!host || live >= MAX_LIVE) return;
  const el = document.createElement("span");
  el.className = s.kind === "star" ? "nori-pet-star" : "nori-pet-mote";
  el.dataset.kind = s.kind;
  const size = Math.max(3, s.size * PET_FX_UNIT_PX);
  const dist = Math.max(4, s.speed * s.lifespan * PET_FX_UNIT_PX);
  const dx = Math.cos(s.angle) * dist;
  const dy = -Math.sin(s.angle) * dist;
  el.style.cssText = [
    "position:absolute",
    `left:${x.toFixed(1)}px`,
    `top:${y.toFixed(1)}px`,
    `width:${size.toFixed(1)}px`,
    `height:${size.toFixed(1)}px`,
    "border-radius:50%",
    `background:${s.kind === "star" ? STAR_GLOW(s.color) : MOTE_GLOW}`,
    "will-change:transform,opacity",
    "user-select:none",
    "-webkit-user-select:none"
  ].join(";");
  host.appendChild(el);
  live += 1;
  if (s.kind === "star") spawned.star += 1;
  else spawned.mote += 1;
  const peak = s.kind === "star" ? 0.85 : 0.6;
  const anim = el.animate(
    [
      { transform: "translate(-50%,-50%) scale(0.5)", opacity: 0 },
      { transform: `translate(calc(-50% + ${(dx * 0.5).toFixed(1)}px), calc(-50% + ${(dy * 0.5).toFixed(1)}px)) scale(1)`, opacity: peak, offset: 0.25 },
      { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(0.6)`, opacity: 0 }
    ],
    { duration: Math.max(120, s.lifespan * 1e3), easing: "cubic-bezier(0.25,0.46,0.45,0.94)", fill: "forwards" }
  );
  release(anim, el);
};
var spawnRipple = (x, y, r) => {
  const host = ensureLayer();
  if (!host || live >= MAX_LIVE) return;
  const el = document.createElement("span");
  el.className = "nori-pet-ripple";
  el.dataset.kind = "ripple";
  const size = Math.max(12, r.radius * PET_FX_UNIT_PX * 2);
  const bw = Math.max(1, r.width * PET_FX_UNIT_PX);
  const flash = r.flash > 0 ? Math.min(1, r.flash * 2.4) : 0;
  el.style.cssText = [
    "position:absolute",
    `left:${x.toFixed(1)}px`,
    `top:${y.toFixed(1)}px`,
    `width:${size.toFixed(1)}px`,
    `height:${size.toFixed(1)}px`,
    "border-radius:50%",
    "background:transparent",
    `border:${bw.toFixed(1)}px solid ${r.color}0.85)`,
    `box-shadow:0 0 ${(bw * 2).toFixed(1)}px ${r.color}0.3)`,
    "will-change:transform,opacity",
    "user-select:none",
    "-webkit-user-select:none"
  ].join(";");
  host.appendChild(el);
  live += 1;
  spawned.ripple += 1;
  const anim = el.animate(
    [
      { transform: "translate(-50%,-50%) scale(0.12)", opacity: flash },
      { transform: "translate(-50%,-50%) scale(0.62)", opacity: Math.min(1, r.intensity), offset: 0.22 },
      { transform: "translate(-50%,-50%) scale(1)", opacity: 0 }
    ],
    { duration: Math.max(160, r.lifespan * 1e3), easing: "cubic-bezier(0.16,0.62,0.36,1)", fill: "forwards" }
  );
  release(anim, el);
};
var spawnPetTouchBurst = (x, y) => {
  const lu = PET_FX_COLORS.lu;
  const zf = PET_FX_COLORS.zf;
  for (let i = 0; i < 3; i += 1) {
    spawnSpark(x, y, {
      kind: "star",
      color: Math.random() < 0.5 ? lu : zf,
      angle: i / 3 * Math.PI * 2 + rand(-0.4, 0.4),
      speed: rand(0.35, 0.7),
      size: rand(0.08, 0.12),
      lifespan: rand(0.35, 0.55)
    });
  }
  spawnRipple(x, y, { color: lu, radius: 0.34, lifespan: 0.55, flash: 0.22, intensity: 0.48, width: 0.06 });
  later(110, () => spawnRipple(x, y, { color: zf, radius: 0.52, lifespan: 0.65, flash: 0, intensity: 0.24, width: 0.05 }));
};
var spawnPetComplete = (x, y) => {
  const lu = PET_FX_COLORS.lu;
  const zf = PET_FX_COLORS.zf;
  const mint = PET_FX_COLORS.mint;
  spawnRipple(x, y, { color: lu, radius: 0.6, lifespan: 0.65 + 0.6 * 0.35, flash: 0.28, intensity: 0.5, width: 0.065 });
  later(130, () => spawnRipple(x, y, { color: zf, radius: 1, lifespan: 0.65 + 1 * 0.35, flash: 0, intensity: 0.36, width: 0.055 }));
  later(280, () => spawnRipple(x, y, { color: zf, radius: 1.45, lifespan: 0.65 + 1.45 * 0.35, flash: 0, intensity: 0.24, width: 0.048 }));
  for (let i = 0; i < 8; i += 1) {
    later(i * 70, () => {
      const star = i % 3 === 0;
      spawnSpark(x, y, {
        kind: star ? "star" : "mote",
        color: star ? zf : Math.random() < 0.5 ? lu : mint,
        angle: Math.PI / 2 + rand(-0.16, 0.16),
        // 一律向上
        speed: rand(0.55, 0.85),
        size: star ? rand(0.09, 0.13) : rand(0.055, 0.09),
        lifespan: rand(0.75, 1.1)
      });
    });
  }
};
var PET_SWAY_AMP_MIN = 5;
var PET_SWAY_AMP_MAX = 9;
var PET_SWAY_RAMP_MS = 2500;
var petSwayAmp = (elapsedMs) => {
  const p = Math.max(0, Math.min(1, (Number.isFinite(elapsedMs) ? elapsedMs : 0) / PET_SWAY_RAMP_MS));
  return PET_SWAY_AMP_MIN + (PET_SWAY_AMP_MAX - PET_SWAY_AMP_MIN) * p;
};
export {
  PET_FX_COLORS,
  PET_FX_UNIT_PX,
  PET_SWAY_AMP_MAX,
  PET_SWAY_AMP_MIN,
  PET_SWAY_RAMP_MS,
  clearPetFx,
  petFxCount,
  petFxLayerId,
  petFxSpawned,
  petMoteGlow,
  petSwayAmp,
  spawnPetComplete,
  spawnPetMotes,
  spawnPetTouchBurst
};
