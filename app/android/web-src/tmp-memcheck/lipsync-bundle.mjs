// ../src/services/live2d/beforeUpdate.ts
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

// ../src/services/live2d/lipSync.ts
var MOUTH_PARAM = "ParamMouthOpenY";
var LIP_STEP_MS = 110;
var LIP_ATTACK = 0.35;
var LIP_MIN = 0.06;
var LIP_MAX = 0.45;
var LIP_RELEASE = 0.35;
var LIP_MAX_RUN_MS = 24e4;
var newLipState = () => ({ open: 0, target: 0, nextChangeAt: 0, startedAt: 0 });
var lipStep = (st, now, speaking, rand = Math.random, audioLevel) => {
  if (!Number.isFinite(now)) return { state: st, open: st.open, write: false };
  if (!speaking) {
    const open2 = st.open > 0.01 ? st.open * (1 - LIP_RELEASE) : 0;
    return { state: { open: open2, target: 0, nextChangeAt: 0, startedAt: 0 }, open: open2, write: st.open > 0 };
  }
  const startedAt = st.startedAt || now;
  if (now - startedAt > LIP_MAX_RUN_MS) {
    const open2 = st.open > 0.01 ? st.open * (1 - LIP_RELEASE) : 0;
    return { state: { open: open2, target: 0, nextChangeAt: 0, startedAt }, open: open2, write: false };
  }
  let target = st.target;
  let nextChangeAt = st.nextChangeAt;
  if (now >= nextChangeAt) {
    if (Number.isFinite(audioLevel)) {
      target = amplitudeToMouthOpen(audioLevel);
    } else {
      target = 0;
    }
    nextChangeAt = now + LIP_STEP_MS;
  }
  const release = target <= 0 ? LIP_RELEASE : LIP_ATTACK;
  const open = Math.max(0, Math.min(1, st.open + (target - st.open) * release));
  return { state: { open, target, nextChangeAt, startedAt }, open, write: true };
};
var defaultHooks = () => {
  if (typeof window === "undefined") return {};
  const w = window;
  return { set: w.__noriSetParam, indexOf: w.__noriParamIndexOf };
};
var nowMs = () => typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
var state = newLipState();
var lastWritten = 0;
var paramMissing = false;
var latestAmplitude = 0;
var lastAmplitudeAt = -1e9;
var playbackAmplitudeSource = false;
var voiceGeneration = 0;
var clamp01 = (n) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
var amplitudeToMouthOpen = (rms) => {
  const n = clamp01(rms);
  const floor = 0.025;
  const span = 0.18;
  if (n <= floor) return 0;
  const shaped = Math.pow(Math.min(1, (n - floor) / span), 0.72);
  return LIP_MIN + shaped * (LIP_MAX - LIP_MIN);
};
var pcmRms = (bytes) => {
  if (!bytes?.length) return 0;
  let data = bytes;
  if (bytes.length >= 16) {
    const view2 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pcmSize = view2.getInt32(4, true);
    const sampleRate = view2.getInt32(8, true);
    if (pcmSize > 0 && sampleRate >= 8e3 && sampleRate <= 48e3 && 16 + pcmSize <= bytes.length) {
      data = bytes.subarray(16, 16 + pcmSize);
    }
  }
  const samples = Math.floor(data.length / 2);
  if (!samples) return 0;
  const view = new DataView(data.buffer, data.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
};
var mouthOpenNow = () => lastWritten;
var applyLipSync = (speaking, now = nowMs(), hooks = defaultHooks()) => {
  const level = Number.isFinite(now) && now - lastAmplitudeAt < AMPLITUDE_TAIL_MS ? latestAmplitude : null;
  const f = lipStep(state, now, speaking, Math.random, level);
  state = f.state;
  if (!f.write) {
    lastWritten = 0;
    return 0;
  }
  const { set, indexOf } = hooks;
  if (typeof set !== "function") {
    lastWritten = 0;
    return 0;
  }
  if (paramMissing) {
    lastWritten = 0;
    return 0;
  }
  if (typeof indexOf === "function" && indexOf(MOUTH_PARAM) < 0) {
    paramMissing = true;
    lastWritten = 0;
    return 0;
  }
  try {
    set(MOUTH_PARAM, f.open);
  } catch {
  }
  lastWritten = f.open;
  return 1;
};
var VOICE_TAIL_MS = 400;
var AMPLITUDE_TAIL_MS = 96;
var lastVoiceAt = -1e9;
var notifyVoiceChunk = (now = nowMs()) => {
  if (Number.isFinite(now)) lastVoiceAt = now;
};
var notifyAmplitude = (rms, now, fromPlayback = false) => {
  if (!Number.isFinite(rms) || !Number.isFinite(now)) return;
  if (playbackAmplitudeSource && !fromPlayback) return;
  latestAmplitude = clamp01(rms);
  lastAmplitudeAt = now;
};
var encodedPending = new Uint8Array(0);
var encodedDecode = Promise.resolve();
var notifyVoiceAudio = (bytes, format, now = nowMs()) => {
  const generation = voiceGeneration;
  notifyVoiceChunk(now);
  if (format === "pcm") {
    notifyAmplitude(pcmRms(bytes), now);
    return;
  }
  if (typeof OfflineAudioContext === "undefined" || !bytes?.length) return;
  const merged = new Uint8Array(encodedPending.length + bytes.length);
  merged.set(encodedPending);
  merged.set(bytes, encodedPending.length);
  encodedPending = merged.length > 1024 * 1024 ? bytes.slice() : merged;
  const pendingSnapshot = encodedPending;
  const input = pendingSnapshot.slice();
  encodedDecode = encodedDecode.then(async () => {
    try {
      const ctx = new OfflineAudioContext(1, 1, 24e3);
      const audio = await ctx.decodeAudioData(input.buffer.slice(0));
      const channels = audio.numberOfChannels;
      const length = audio.length;
      if (generation !== voiceGeneration) return;
      if (channels && length) {
        const tailSamples = Math.max(1, Math.min(length, Math.floor(audio.sampleRate * 0.048)));
        const start = length - tailSamples;
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const samples = audio.getChannelData(c);
          for (let i = start; i < samples.length; i++) sum += samples[i] * samples[i];
        }
        notifyAmplitude(Math.sqrt(sum / (channels * tailSamples)), nowMs());
      }
      if (encodedPending === pendingSnapshot) encodedPending = new Uint8Array(0);
    } catch {
    }
  });
};
var notifyPlaybackAmplitude = (rms, now = nowMs()) => {
  notifyAmplitude(rms, now, true);
};
var setPlaybackAmplitudeSource = (active) => {
  playbackAmplitudeSource = active;
  if (!active) {
    latestAmplitude = 0;
    lastAmplitudeAt = -1e9;
  }
};
var resetVoiceAnalysis = () => {
  voiceGeneration++;
  lastVoiceAt = -1e9;
  latestAmplitude = 0;
  lastAmplitudeAt = -1e9;
  encodedPending = new Uint8Array(0);
};
var voiceActive = (now = nowMs()) => Number.isFinite(now) && now - lastVoiceAt < VOICE_TAIL_MS;
var installLipSync = (isSpeaking) => {
  registerBeforeUpdate(() => {
    applyLipSync(isSpeaking() === true);
  });
  const snap = () => ({
    written: lastWritten,
    missing: paramMissing,
    indexOf: window.__noriParamIndexOf?.(MOUTH_PARAM) ?? null,
    voiceActive: voiceActive(),
    speaking: isSpeaking() === true
  });
  try {
    window.__noriLipDebug = snap;
  } catch {
  }
};
var __resetLipSyncForTest = () => {
  state = newLipState();
  lastWritten = 0;
  paramMissing = false;
  playbackAmplitudeSource = false;
  resetVoiceAnalysis();
};
export {
  AMPLITUDE_TAIL_MS,
  LIP_ATTACK,
  LIP_MAX,
  LIP_MAX_RUN_MS,
  LIP_MIN,
  LIP_RELEASE,
  LIP_STEP_MS,
  MOUTH_PARAM,
  VOICE_TAIL_MS,
  __resetLipSyncForTest,
  amplitudeToMouthOpen,
  applyLipSync,
  installLipSync,
  lipStep,
  mouthOpenNow,
  newLipState,
  notifyPlaybackAmplitude,
  notifyVoiceAudio,
  notifyVoiceChunk,
  pcmRms,
  resetVoiceAnalysis,
  setPlaybackAmplitudeSource,
  voiceActive
};
