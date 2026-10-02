// ../src/services/sfx.ts
var volume = 0.5;
var SFX_TOTAL = 5;
var getSfxVolume = () => volume;
var downloadHandler = null;
var onDownloadResult = (json) => {
  try {
    const r = JSON.parse(json);
    downloadHandler?.({
      ok: r.ok === true,
      total: Number(r.total) > 0 ? Number(r.total) : SFX_TOTAL,
      done: Number(r.done) > 0 ? Number(r.done) : 0,
      failed: Array.isArray(r.failed) ? r.failed.map(String) : []
    });
  } catch {
  }
};
if (typeof window !== "undefined") {
  ;
  window.__noriSfxDownloadRes = onDownloadResult;
}

// ../src/services/live2d/petAudio.ts
var PET_AUDIO_LEVEL = 0.35;
var PET_AUDIO_VX_FULL = 1;
var PET_TOUCH_PROFILE = { level: 0.35, brightness: 0.15 };
var PET_COMPLETE_PROFILE = { level: 0.5, brightness: 0.3 };
var PET_COMPLETE_ECHO_MS = 150;
var PET_COMPLETE_ECHO_PROFILE = { level: 0.4, brightness: 0.3 };
var FREQ_SCALE = 0.4;
var BODY_GAIN = 0.5;
var NOISE_SECONDS = 2;
var HP1 = 1200;
var HP2 = 3200;
var PEAK = 5200;
var BODY_LP = 350;
var LP_MIN = 8e3;
var LP_MAX = 11500;
var ATTACK_TAU = 0.03;
var RELEASE_TAU = 0.06;
var PARAM_TAU = 0.05;
var HOLD_MS = 140;
var VX_EXP = 1.4;
var clamp01 = (v) => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
var nowMs = () => typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
var petSoundProfile = (vx) => {
  if (!Number.isFinite(vx)) return { level: 0, brightness: 0 };
  const e = clamp01(Math.abs(vx) / PET_AUDIO_VX_FULL);
  return { level: Math.pow(e, VX_EXP), brightness: e };
};
var graph = null;
var holdTimer = 0;
var echoTimer = 0;
var lastKickAt = 0;
var ensureGraph = () => {
  if (graph) return graph;
  try {
    const w = window;
    const Ctor = w.AudioContext || w.webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const len = Math.max(1, Math.floor(NOISE_SECONDS * ctx.sampleRate));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;
    const bq = (type, freq, q, gain) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq * FREQ_SCALE;
      f.Q.value = q;
      if (gain !== void 0) f.gain.value = gain;
      return f;
    };
    const hp1 = bq("highpass", HP1, -3);
    const hp2 = bq("highpass", HP2, -3);
    const peak = bq("peaking", PEAK, 0.9, 4);
    const lowpass = bq("lowpass", LP_MAX, -3);
    const bodyLpA = bq("lowpass", BODY_LP, -3);
    const bodyLpB = bq("lowpass", BODY_LP, -3);
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = BODY_GAIN;
    const strokeGain = ctx.createGain();
    strokeGain.gain.value = 0;
    const master = ctx.createGain();
    master.gain.value = 0;
    source.connect(hp1);
    hp1.connect(hp2);
    hp2.connect(peak);
    peak.connect(lowpass);
    lowpass.connect(strokeGain);
    source.connect(bodyLpA);
    bodyLpA.connect(bodyLpB);
    bodyLpB.connect(bodyGain);
    bodyGain.connect(strokeGain);
    strokeGain.connect(master);
    master.connect(ctx.destination);
    source.start();
    graph = { ctx, source, hp1, hp2, peak, lowpass, bodyLpA, bodyLpB, bodyGain, strokeGain, master };
    return graph;
  } catch {
    return null;
  }
};
var applyParams = (g, brightness) => {
  const now = g.ctx.currentTime;
  const t = PARAM_TAU;
  const vol = PET_AUDIO_LEVEL * clamp01(getSfxVolume());
  g.master.gain.setTargetAtTime(vol, now, t);
  g.bodyGain.gain.setTargetAtTime(BODY_GAIN, now, t);
  g.hp1.frequency.setTargetAtTime(HP1 * FREQ_SCALE, now, t);
  g.hp2.frequency.setTargetAtTime(HP2 * FREQ_SCALE, now, t);
  g.peak.frequency.setTargetAtTime(PEAK * FREQ_SCALE, now, t);
  g.bodyLpA.frequency.setTargetAtTime(BODY_LP * FREQ_SCALE, now, t);
  g.bodyLpB.frequency.setTargetAtTime(BODY_LP * FREQ_SCALE, now, t);
  g.lowpass.frequency.setTargetAtTime((LP_MIN + (LP_MAX - LP_MIN) * clamp01(brightness)) * FREQ_SCALE, now, t);
};
var petAudioPrime = () => {
  const g = ensureGraph();
  if (!g) return;
  try {
    if (g.ctx.state === "suspended") void g.ctx.resume().catch(() => {
    });
  } catch {
  }
};
var scheduleHoldRelease = (g) => {
  if (holdTimer) window.clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => {
    holdTimer = 0;
    if (nowMs() - lastKickAt < HOLD_MS - 10) return;
    try {
      g.strokeGain.gain.setTargetAtTime(0, g.ctx.currentTime, RELEASE_TAU);
    } catch {
    }
  }, HOLD_MS);
};
var kick = (level, brightness) => {
  const g = ensureGraph();
  if (!g) return;
  if (clamp01(getSfxVolume()) <= 0) {
    petAudioRelease();
    return;
  }
  if (g.ctx.state === "suspended") void g.ctx.resume().catch(() => {
  });
  applyParams(g, brightness);
  try {
    g.strokeGain.gain.setTargetAtTime(clamp01(level), g.ctx.currentTime, ATTACK_TAU);
    lastKickAt = nowMs();
    scheduleHoldRelease(g);
  } catch {
  }
};
var petAudioTouch = () => kick(PET_TOUCH_PROFILE.level, PET_TOUCH_PROFILE.brightness);
var petAudioStroke = (velocityX) => {
  const p = petSoundProfile(velocityX);
  kick(p.level, p.brightness);
};
var petAudioComplete = () => {
  kick(PET_COMPLETE_PROFILE.level, PET_COMPLETE_PROFILE.brightness);
  if (echoTimer) window.clearTimeout(echoTimer);
  echoTimer = window.setTimeout(() => {
    echoTimer = 0;
    kick(PET_COMPLETE_ECHO_PROFILE.level, PET_COMPLETE_ECHO_PROFILE.brightness);
  }, PET_COMPLETE_ECHO_MS);
};
var petAudioRelease = (keepEcho = false) => {
  if (holdTimer) {
    window.clearTimeout(holdTimer);
    holdTimer = 0;
  }
  if (!keepEcho && echoTimer) {
    window.clearTimeout(echoTimer);
    echoTimer = 0;
  }
  const g = graph;
  if (!g) return;
  try {
    g.strokeGain.gain.setTargetAtTime(0, g.ctx.currentTime, RELEASE_TAU);
  } catch {
  }
};
var disposePetAudio = () => {
  const g = graph;
  graph = null;
  if (holdTimer) {
    window.clearTimeout(holdTimer);
    holdTimer = 0;
  }
  if (echoTimer) {
    window.clearTimeout(echoTimer);
    echoTimer = 0;
  }
  if (!g) return;
  try {
    g.source.stop();
  } catch {
  }
  try {
    void g.ctx.close();
  } catch {
  }
};
var petAudioState = () => ({
  ready: !!graph,
  volume: clamp01(getSfxVolume()),
  level: PET_AUDIO_LEVEL
});
export {
  PET_AUDIO_LEVEL,
  PET_AUDIO_VX_FULL,
  PET_COMPLETE_ECHO_MS,
  PET_COMPLETE_ECHO_PROFILE,
  PET_COMPLETE_PROFILE,
  PET_TOUCH_PROFILE,
  disposePetAudio,
  petAudioComplete,
  petAudioPrime,
  petAudioRelease,
  petAudioState,
  petAudioStroke,
  petAudioTouch,
  petSoundProfile
};
