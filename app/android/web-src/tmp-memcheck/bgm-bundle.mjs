// src/services/bgm.ts
var BGM_TRACKS = [
  { id: "bgm_memory", name: "\u8BB0\u5FC6", file: "bgm_memory.mp3" },
  { id: "bgm1", name: "\u6570\u636E\u6D77", file: "bgm1.m4a" },
  { id: "nori_daily_manifold", name: "\u65E5\u5E38", file: "nori_daily_manifold.mp3" }
];
var bgmNameOf = (id) => id === "random" ? "\u968F\u673A\u64AD\u653E" : BGM_TRACKS.find((t) => t.id === id)?.name ?? id;
var enabled = false;
var track = "random";
var currentId = null;
var volume = 0.35;
var gestureHooked = false;
var state = "missing";
var downloadPct = 0;
var wantPlay = false;
var DUCK_FACTOR = 0.6;
var DUCK_FADE_IN_MS = 160;
var DUCK_FADE_OUT_MS = 220;
var ducked = false;
var stateHandler = null;
var errorHandler = null;
var busyPoller = null;
var notifyState = () => {
  try {
    stateHandler?.(state, downloadPct);
  } catch {
  }
};
var pollBusyReady = () => {
  if (busyPoller) return;
  let polls = 0;
  busyPoller = setInterval(() => {
    polls += 1;
    const ready = queryReady();
    if (ready || state !== "downloading" || polls > 200) {
      if (busyPoller) {
        clearInterval(busyPoller);
        busyPoller = null;
      }
      if (ready) {
        state = "ready";
        downloadPct = 100;
        notifyState();
        if (enabled && wantPlay) startPlayback();
      } else if (state === "downloading") {
        state = "missing";
        notifyState();
      }
    }
  }, 3e3);
};
var setBgmStateHandler = (cb) => {
  stateHandler = cb;
};
var setBgmErrorHandler = (cb) => {
  errorHandler = cb;
};
var targetVolume = () => ducked ? volume * DUCK_FACTOR : volume;
var duckRaf = 0;
var duckFrom = -1;
var fadeVolume = () => {
  if (!audioEl) return;
  if (duckRaf) {
    cancelAnimationFrame(duckRaf);
    duckRaf = 0;
  }
  const from = audioEl.volume;
  const dur = ducked ? DUCK_FADE_IN_MS : DUCK_FADE_OUT_MS;
  if (from === targetVolume() || dur <= 0) {
    audioEl.volume = targetVolume();
    return;
  }
  const t0 = performance.now();
  duckFrom = from;
  const step = () => {
    duckRaf = 0;
    if (!audioEl) return;
    const p = Math.min(1, (performance.now() - t0) / dur);
    audioEl.volume = Math.min(1, Math.max(0, duckFrom + (targetVolume() - duckFrom) * p));
    if (p < 1) duckRaf = requestAnimationFrame(step);
  };
  duckRaf = requestAnimationFrame(step);
};
var applyVolume = () => {
  if (duckRaf) {
    cancelAnimationFrame(duckRaf);
    duckRaf = 0;
  }
  if (audioEl) audioEl.volume = targetVolume();
};
var setBgmDucking = (on) => {
  if (ducked === on) return;
  ducked = on;
  fadeVolume();
};
var clamp01 = (v) => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.35;
var audioEl = null;
var ensureAudio = () => {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.loop = true;
    audioEl.preload = "auto";
    audioEl.onerror = () => {
      if (enabled) {
        try {
          errorHandler?.("\u97F3\u9891\u8BFB\u53D6\u5931\u8D25, \u8BF7\u5C1D\u8BD5\u91CD\u65B0\u4E0B\u8F7D\u80CC\u666F\u97F3\u4E50\u8D44\u6E90");
        } catch {
        }
      }
    };
  }
  return audioEl;
};
var bridge = () => window.NoriChat ?? null;
var queryReady = () => {
  try {
    const raw = bridge()?.bgmStatus?.();
    if (!raw) return state === "ready";
    const parsed = JSON.parse(raw);
    return !!parsed.ready;
  } catch {
    return state === "ready";
  }
};
var refreshBgmReady = () => {
  if (queryReady()) {
    if (state !== "ready") {
      state = "ready";
      downloadPct = 100;
      notifyState();
    }
    return true;
  }
  if (state === "ready") {
    state = "missing";
    downloadPct = 0;
    notifyState();
  }
  return false;
};
var onDownloadResult = (json) => {
  try {
    const r = JSON.parse(json);
    if (r.stage === "progress") {
      state = "downloading";
      downloadPct = Math.max(0, Math.min(100, Math.round(Number(r.pct) || 0)));
      notifyState();
    } else if (r.stage === "done") {
      state = "ready";
      downloadPct = 100;
      notifyState();
      if (enabled && wantPlay) startPlayback();
    } else if (r.stage === "error") {
      state = queryReady() ? "ready" : "missing";
      downloadPct = 0;
      notifyState();
      try {
        errorHandler?.(r.message ?? "\u4E0B\u8F7D\u5931\u8D25");
      } catch {
      }
    }
  } catch {
  }
};
window.__noriBgmRes = onDownloadResult;
var pickRandom = (avoid) => {
  const ids = BGM_TRACKS.map((t) => t.id);
  const pool = ids.filter((id) => ids.length < 2 || id !== avoid);
  return pool[Math.floor(Math.random() * pool.length)];
};
var resolveId = () => track === "random" ? pickRandom(currentId) : track;
var hookGestureRetry = () => {
  if (gestureHooked) return;
  gestureHooked = true;
  const retry = () => {
    window.removeEventListener("pointerdown", retry);
    gestureHooked = false;
    if (enabled && wantPlay && audioEl) void audioEl.play().catch(() => {
    });
  };
  window.addEventListener("pointerdown", retry, { once: true });
};
var startPlayback = () => {
  const a = ensureAudio();
  currentId = resolveId();
  const t = BGM_TRACKS.find((x) => x.id === currentId) ?? BGM_TRACKS[0];
  a.src = `/bgm-local/${t.file}`;
  a.volume = volume;
  void a.play().catch(() => hookGestureRetry());
};
var syncBgm = (s) => {
  volume = clamp01(Number(s.bgmVolume));
  applyVolume();
  const ready = refreshBgmReady();
  if (!s.bgmEnabled) {
    enabled = false;
    wantPlay = false;
    audioEl?.pause();
    return null;
  }
  enabled = true;
  wantPlay = true;
  track = s.bgmTrack || "random";
  if (!ready) {
    if (state !== "missing") return null;
    state = "downloading";
    downloadPct = 0;
    notifyState();
    const r = bridge()?.bgmDownload?.();
    if (r && r !== "ok") {
      if (r === "err:busy") pollBusyReady();
      else state = "missing";
      notifyState();
    }
    return null;
  }
  startPlayback();
  return currentId;
};
var downloadBgm = (force = false) => {
  if (state === "downloading") return;
  if (!force && queryReady()) {
    state = "ready";
    notifyState();
    if (enabled && wantPlay) startPlayback();
    return;
  }
  state = "downloading";
  downloadPct = 0;
  notifyState();
  const r = bridge()?.bgmDownload?.();
  if (r && r !== "ok") {
    if (r === "err:busy") pollBusyReady();
    else {
      state = "missing";
      notifyState();
      try {
        errorHandler?.("\u4E0B\u8F7D\u89E6\u53D1\u5931\u8D25");
      } catch {
      }
    }
  }
};
var nextBgmTrack = () => {
  const next = pickRandom(currentId);
  currentId = next;
  const a = ensureAudio();
  const t = BGM_TRACKS.find((x) => x.id === next) ?? BGM_TRACKS[0];
  a.src = `/bgm-local/${t.file}`;
  a.volume = volume;
  void a.play().catch(() => hookGestureRetry());
  return next;
};
var setBgmVolume = (v) => {
  volume = clamp01(Number(v));
  applyVolume();
};
var pauseBgm = () => {
  audioEl?.pause();
};
var resumeBgm = () => {
  if (enabled && wantPlay && state === "ready" && audioEl) void audioEl.play().catch(() => hookGestureRetry());
};
var bgmCurrentId = () => currentId;
export {
  BGM_TRACKS,
  bgmCurrentId,
  bgmNameOf,
  downloadBgm,
  nextBgmTrack,
  pauseBgm,
  refreshBgmReady,
  resumeBgm,
  setBgmDucking,
  setBgmErrorHandler,
  setBgmStateHandler,
  setBgmVolume,
  syncBgm
};
