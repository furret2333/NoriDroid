// ../src/services/tts/cosy-models.ts
var COSY_MODELS = ["cosyvoice-v3.5-plus", "cosyvoice-v3.5-flash", "cosyvoice-v3-plus", "cosyvoice-v3-flash", "cosyvoice-v2", "qwen-audio-3.1-tts-flash", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"];
var cosyModelFromVoiceId = (id) => {
  const v = (id ?? "").trim();
  if (!v) return "";
  for (const m of COSY_MODELS) {
    if (v.startsWith(m + "-")) return m;
  }
  return "";
};
var normalizeCloneVoices = (v) => {
  if (!Array.isArray(v)) return [];
  const byId = /* @__PURE__ */ new Map();
  for (const it of v) {
    let id = "";
    let model = "";
    if (typeof it === "string") {
      id = it.trim();
    } else if (it && typeof it === "object") {
      const o = it;
      id = typeof o.id === "string" ? o.id.trim() : "";
      model = typeof o.model === "string" ? o.model.trim() : "";
    }
    if (!id) continue;
    if (!model) model = cosyModelFromVoiceId(id);
    const prev = byId.get(id);
    if (!prev || !prev.model && model) byId.set(id, { id, model });
  }
  return [...byId.values()];
};

// ../src/services/chat/index.ts
var localTimeBlock = (now = /* @__PURE__ */ new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  const week = ["\u661F\u671F\u65E5", "\u661F\u671F\u4E00", "\u661F\u671F\u4E8C", "\u661F\u671F\u4E09", "\u661F\u671F\u56DB", "\u661F\u671F\u4E94", "\u661F\u671F\u516D"][now.getDay()];
  const off = -now.getTimezoneOffset();
  const tz = `UTC${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `\u3010\u5F53\u524D\u65F6\u95F4\u3011${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${week} ${p(now.getHours())}:${p(now.getMinutes())}\uFF08${tz}\uFF09
\u8FD9\u662F\u8BBE\u5907\u7684\u771F\u5B9E\u65F6\u95F4\uFF08\u4E0D\u662F\u731C\u6D4B\uFF0C\u53EF\u4EE5\u76F4\u63A5\u7528\u6765\u56DE\u7B54\u65F6\u95F4\u7C7B\u95EE\u9898\uFF09\uFF0C\u4E5F\u7528\u5B83\u6765\u6362\u7B97\u300C\u4ECA\u5929/\u660E\u5929/\u4E0B\u5468\u4E09\u300D\u8FD9\u7C7B\u76F8\u5BF9\u65F6\u95F4\u3002\u81EA\u7136\u4F7F\u7528\u5373\u53EF\uFF0C\u4E0D\u5FC5\u6BCF\u53E5\u8BDD\u90FD\u63D0\u65F6\u95F4\u3002`;
};
var DEFAULT_SETTINGS = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  live2dModel: "",
  bubbleScale: 1,
  bubbleWidth: 82,
  renderScale: 1,
  ttsEnabled: false,
  ttsProvider: "fish",
  ttsApiKey: "",
  ttsBaseUrl: "https://api.fish.audio",
  ttsReferenceId: "",
  ttsModel: "s2.1-pro",
  ttsFormat: "mp3",
  ttsChunkLength: 120,
  ttsLatency: "balanced",
  ttsVolume: 1,
  bgmEnabled: false,
  bgmTrack: "random",
  bgmVolume: 0.35,
  sfxVolume: 0.5,
  dataseaBg: true,
  timeAware: true,
  ambientEnabled: true,
  quietMode: "off",
  quietOn: false,
  cosyApiKey: "",
  cosyBaseUrl: "https://dashscope.aliyuncs.com",
  cosyModel: "cosyvoice-v3.5-flash",
  cosyVoice: "",
  cosyRate: 1,
  cosyCloneVoices: [],
  trimHistory: true,
  memoryLlmExtract: true,
  memoryRealtimeExtract: false,
  memoryAutoTuneExamples: false,
  memoryDiagnostics: false,
  smartRecall: true,
  emotionLlm: true,
  deepseekThinking: true,
  lookFlipX: false,
  lookFlipY: false,
  lookSens: 0.2,
  floatEnabled: false,
  floatBubbleW: 82,
  floatRenderScale: 2
};
var bridge = () => {
  if (!window.NoriChat) throw new Error("NoriChat \u672A\u6CE8\u5165");
  return window.NoriChat;
};
var loadSettings = () => {
  try {
    const raw = bridge().readFile("settings.json");
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    merged.cosyCloneVoices = normalizeCloneVoices(parsed?.cosyCloneVoices);
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};
var readFile = (name) => {
  try {
    return bridge().readFile(name);
  } catch {
    return "";
  }
};
var writeFile = (name, content) => {
  try {
    const raw = bridge().writeFile(name, content);
    if (raw !== "ok") console.error(`[writeFile] ${name} \u5199\u76D8\u5931\u8D25: ${raw}`);
    return raw === "ok";
  } catch (e) {
    console.error(`[writeFile] ${name} \u5199\u76D8\u5F02\u5E38:`, e);
    return false;
  }
};
var PERSONA_FILE = "persona.md";
var pickPersonaFile = () => new Promise((resolve) => {
  const W = window;
  W.__noriPersonaPickedRes = (json) => {
    delete W.__noriPersonaPickedRes;
    try {
      resolve(JSON.parse(json));
    } catch {
      resolve({ ok: false, message: "\u9009\u62E9\u7ED3\u679C\u89E3\u6790\u5931\u8D25" });
    }
  };
  const nori = window.NoriChat;
  if (!nori || typeof nori.pickPersonaFile !== "function") {
    resolve({ ok: false, message: "\u539F\u751F\u6865\u4E0D\u652F\u6301\u6587\u4EF6\u9009\u62E9 (\u8BF7\u5347\u7EA7\u5E94\u7528)" });
    return;
  }
  try {
    nori.pickPersonaFile();
  } catch (e) {
    resolve({ ok: false, message: `\u53D1\u8D77\u9009\u62E9\u5931\u8D25: ${String(e)}` });
  }
});
var customPersonaCache = null;
var loadCustomPersona = () => {
  if (customPersonaCache !== null) return customPersonaCache;
  customPersonaCache = readFile(PERSONA_FILE).trim();
  return customPersonaCache;
};
var saveCustomPersona = (text) => {
  customPersonaCache = text.trim();
  writeFile(PERSONA_FILE, text);
};
var personaPrompt = () => loadCustomPersona();
var saveSettingsRaw = (s) => {
  try {
    return String(bridge().writeFile("settings.json", JSON.stringify(s)));
  } catch (e) {
    return `err:throw:${e?.message ?? String(e)}`;
  }
};
var saveSettings = (s) => saveSettingsRaw(s) === "ok";
var PLACEHOLDER_PREFIX = "\uFF08\u66F4\u65E9\u7684\u5BF9\u8BDD\u5DF2\u538B\u7F29";
var isPlaceholderMsg = (m) => m.role === "system" && (m.placeholder === true || m.content.startsWith(PLACEHOLDER_PREFIX));
var filterChatMsgs = (arr) => {
  let placeholderKept = false;
  return arr.filter((m) => {
    if (!m || typeof m !== "object") return false;
    const role = m.role;
    const content = m.content;
    if (typeof content !== "string") return false;
    if (m.error || content.startsWith("\u26A0 ")) return false;
    if (role === "system") {
      if (!isPlaceholderMsg(m)) return false;
      if (placeholderKept) return false;
      placeholderKept = true;
      return true;
    }
    return role === "user" || role === "assistant";
  });
};
var readChatFile = () => {
  try {
    const raw = bridge().readFile("chat.json");
    if (!raw) return { cutoff: 0, msgs: [] };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { cutoff: 0, msgs: filterChatMsgs(parsed) };
    if (!parsed || !Array.isArray(parsed.msgs)) return { cutoff: 0, msgs: [] };
    return {
      cutoff: typeof parsed.cutoff === "number" ? parsed.cutoff : 0,
      msgs: filterChatMsgs(parsed.msgs)
    };
  } catch {
    return { cutoff: 0, msgs: [] };
  }
};
var chatCutoff = 0;
var loadChat = () => {
  const file = readChatFile();
  if (file.cutoff > chatCutoff) chatCutoff = file.cutoff;
  return file.msgs;
};
var chatPersistTimer = null;
var chatPersistPending = null;
var setChatTrimCutoff = (cutoffTs) => {
  if (cutoffTs > chatCutoff) chatCutoff = cutoffTs;
};
var __resetChatCutoffForTest = () => {
  chatCutoff = 0;
};
var persistChat = (messages) => {
  chatPersistPending = messages.map((m) => ({ ...m }));
  if (chatPersistTimer) clearTimeout(chatPersistTimer);
  chatPersistTimer = setTimeout(() => {
    chatPersistTimer = null;
    flushChatPersist();
  }, 3e3);
};
var identityOf = (m) => `${m.ts}\0${m.role}`;
var dedupeByIdentity = (msgs) => {
  const map = /* @__PURE__ */ new Map();
  for (const m of msgs) {
    if (isPlaceholderMsg(m)) {
      let has = false;
      for (const [, v] of map) if (isPlaceholderMsg(v)) {
        has = true;
        break;
      }
      if (has) continue;
    }
    const k = identityOf(m);
    const prev = map.get(k);
    if (!prev || m.content.length > prev.content.length) map.set(k, m);
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
};
var mergeChatLists = (disk, local) => {
  const map = /* @__PURE__ */ new Map();
  const add = (m) => {
    if (isPlaceholderMsg(m)) {
      for (const [, v] of map) if (isPlaceholderMsg(v)) return;
    }
    const k = `${m.ts}\0${m.role}`;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, m);
      return;
    }
    if (m.content.length > prev.content.length) map.set(k, m);
  };
  for (const m of disk) {
    if (m.ts < chatCutoff) continue;
    add(m);
  }
  for (const m of local) add(m);
  return [...map.values()].sort((a, b) => a.ts - b.ts);
};
var PERSIST_RETRY_MS = 1e3;
var buildChatFile = () => {
  const data = (chatPersistPending ?? []).filter((m) => !m.error);
  const diskFile = readChatFile();
  if (diskFile.cutoff > chatCutoff) chatCutoff = diskFile.cutoff;
  const sys = data.filter((m) => m.role === "system");
  const local = data.filter((m) => m.role !== "system");
  let out = data;
  if (local.length) {
    const disk = filterChatMsgs(diskFile.msgs);
    out = [...sys, ...disk.length ? mergeChatLists(disk, local) : dedupeByIdentity(local)];
  }
  return { v: 1, cutoff: chatCutoff, msgs: dedupePlaceholders(out) };
};
var dedupePlaceholders = (msgs) => {
  let seen = false;
  let dup = false;
  for (const m of msgs) {
    if (!isPlaceholderMsg(m)) continue;
    if (seen) {
      dup = true;
      break;
    }
    seen = true;
  }
  if (!dup) return msgs;
  seen = false;
  return msgs.filter((m) => {
    if (!isPlaceholderMsg(m)) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
};
var flushChatPersist = () => {
  if (chatPersistTimer) {
    clearTimeout(chatPersistTimer);
    chatPersistTimer = null;
  }
  if (!chatPersistPending) return;
  try {
    const file = buildChatFile();
    if (writeFile("chat.json", JSON.stringify(file))) {
      chatPersistPending = null;
      return;
    }
    console.error("[chat] persist write failed, will retry");
  } catch (e) {
    console.error("[chat] persist error", e);
  }
  if (!chatPersistTimer) {
    chatPersistTimer = setTimeout(() => {
      chatPersistTimer = null;
      flushChatPersist();
    }, PERSIST_RETRY_MS);
  }
};
var readMemory = () => {
  try {
    return bridge().readMemory();
  } catch {
    return "";
  }
};
var appendMemory = (text) => {
  try {
    if (text.trim()) bridge().appendMemory(text.trim());
  } catch {
  }
};
var isStorageReady = () => {
  try {
    return !!bridge().isStorageReady();
  } catch {
    return false;
  }
};
var requestStoragePermission = () => {
  try {
    bridge().requestStoragePermission();
  } catch {
  }
};
var getStorageDir = () => {
  try {
    return bridge().getStorageDir();
  } catch {
    return "Download/DeepEr";
  }
};
var probePublicFiles = (name) => {
  try {
    return bridge().probePublicFiles(name);
  } catch (e) {
    return `err:${String(e)}`;
  }
};
var hasAllFilesAccess = () => {
  try {
    return !!bridge().hasAllFilesAccessJs();
  } catch {
    return false;
  }
};
var requestAllFilesAccess = () => {
  try {
    bridge().requestAllFilesAccess();
  } catch {
  }
};
var bridgeTimeoutMs = () => window.__noriBridgeTimeoutMs ?? 12e3;
var fetchModels = (baseUrl, apiKey) => new Promise((resolve) => {
  let settled = false;
  const done = (r) => {
    if (settled) return;
    settled = true;
    delete window.__noriModelsRes;
    resolve(r);
  };
  window.__noriModelsRes = (json) => {
    try {
      done(JSON.parse(json));
    } catch {
      done({ ok: false, message: "\u54CD\u5E94\u89E3\u6790\u5931\u8D25" });
    }
  };
  setTimeout(() => done({ ok: false, message: "\u8BF7\u6C42\u8D85\u65F6, \u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5" }), bridgeTimeoutMs());
  try {
    bridge().fetchModels(baseUrl, apiKey);
  } catch {
    done({ ok: false, message: "NoriChat \u672A\u6CE8\u5165" });
  }
});
var checkFishBalance = (baseUrl, apiKey) => new Promise((resolve) => {
  let settled = false;
  const done = (r) => {
    if (settled) return;
    settled = true;
    delete window.__noriFishBalanceRes;
    resolve(r);
  };
  window.__noriFishBalanceRes = (json) => {
    try {
      done(JSON.parse(json));
    } catch {
      done({ ok: false, message: "\u54CD\u5E94\u89E3\u6790\u5931\u8D25" });
    }
  };
  setTimeout(() => done({ ok: false, message: "\u8BF7\u6C42\u8D85\u65F6, \u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5" }), bridgeTimeoutMs());
  try {
    bridge().checkFishBalance(apiKey, baseUrl);
  } catch {
    done({ ok: false, message: "NoriChat \u672A\u6CE8\u5165" });
  }
});
var checkDeepSeekBalance = (baseUrl, apiKey) => new Promise((resolve) => {
  let settled = false;
  const done = (r) => {
    if (settled) return;
    settled = true;
    delete window.__noriDeepseekBalanceRes;
    resolve(r);
  };
  window.__noriDeepseekBalanceRes = (json) => {
    try {
      done(JSON.parse(json));
    } catch {
      done({ ok: false, message: "\u54CD\u5E94\u89E3\u6790\u5931\u8D25" });
    }
  };
  setTimeout(() => done({ ok: false, message: "\u8BF7\u6C42\u8D85\u65F6, \u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5" }), bridgeTimeoutMs());
  try {
    bridge().checkDeepSeekBalance(apiKey, baseUrl);
  } catch {
    done({ ok: false, message: "NoriChat \u672A\u6CE8\u5165" });
  }
});
var checkCosyBalance = (baseUrl, apiKey) => new Promise((resolve) => {
  let settled = false;
  const done = (r) => {
    if (settled) return;
    settled = true;
    delete window.__noriCosyBalanceRes;
    resolve(r);
  };
  window.__noriCosyBalanceRes = (json) => {
    try {
      done(JSON.parse(json));
    } catch {
      done({ ok: false, message: "\u54CD\u5E94\u89E3\u6790\u5931\u8D25" });
    }
  };
  setTimeout(() => done({ ok: false, message: "\u8BF7\u6C42\u8D85\u65F6, \u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5" }), bridgeTimeoutMs());
  try {
    bridge().checkCosyBalance(apiKey, baseUrl);
  } catch {
    done({ ok: false, message: "NoriChat \u672A\u6CE8\u5165" });
  }
});
var fetchVoices = (baseUrl, apiKey) => new Promise((resolve) => {
  let settled = false;
  const done = (r) => {
    if (settled) return;
    settled = true;
    delete window.__noriVoicesRes;
    resolve(r);
  };
  window.__noriVoicesRes = (json) => {
    try {
      done(JSON.parse(json));
    } catch {
      done({ ok: false, message: "\u54CD\u5E94\u89E3\u6790\u5931\u8D25" });
    }
  };
  setTimeout(() => done({ ok: false, message: "\u8BF7\u6C42\u8D85\u65F6, \u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5" }), bridgeTimeoutMs());
  try {
    bridge().listVoices(apiKey, baseUrl);
  } catch {
    done({ ok: false, message: "NoriChat \u672A\u6CE8\u5165" });
  }
});
var sendChat = (baseUrl, apiKey, model, messages, thinking = false) => {
  if (!apiKey.trim()) return Promise.resolve({ ok: false, message: "\u8BF7\u5148\u5728\u8BBE\u7F6E\u91CC\u586B\u5199 API Key" });
  if (!model.trim()) return Promise.resolve({ ok: false, message: "\u8BF7\u5148\u5728\u8BBE\u7F6E\u91CC\u9009\u62E9\u6A21\u578B" });
  return enqueueChat(() => {
    const payload = JSON.stringify(messages.map(({ role, content }) => ({ role, content })));
    return new Promise((resolve) => {
      window.__noriChatRes = (json) => {
        delete window.__noriChatRes;
        try {
          resolve(JSON.parse(json));
        } catch {
          resolve({ ok: false, message: "\u54CD\u5E94\u89E3\u6790\u5931\u8D25" });
        }
      };
      try {
        bridge().chat(baseUrl, apiKey, model, payload, resolveThinking(baseUrl, thinking));
      } catch {
        resolve({ ok: false, message: "\u8BF7\u6C42\u5931\u8D25" });
      }
    });
  });
};
var chatQueue = Promise.resolve();
var enqueueChat = (task) => {
  const run = chatQueue.then(task, task);
  chatQueue = run.catch(() => {
  });
  return run;
};
var resolveThinking = (baseUrl, thinking) => /deepseek/i.test(baseUrl) ? thinking ? "enabled" : "disabled" : "";
var STREAM_IDLE_TIMEOUT_MS = 3e4;
var streamIdleTimeoutMs = () => window.__noriStreamTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
var streamQueue = Promise.resolve();
var sendChatStream = (baseUrl, apiKey, model, messages, callbacks, thinking = false, signal) => {
  if (!apiKey.trim()) {
    callbacks.onError("\u8BF7\u5148\u5728\u8BBE\u7F6E\u91CC\u586B\u5199 API Key");
    return;
  }
  if (!model.trim()) {
    callbacks.onError("\u8BF7\u5148\u5728\u8BBE\u7F6E\u91CC\u9009\u62E9\u6A21\u578B");
    return;
  }
  const task = () => new Promise((resolveTask) => {
    let idleTimer = null;
    const finish = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      resolveTask();
    };
    const payload = JSON.stringify(messages.map(({ role, content }) => ({ role, content })));
    const nori = window.NoriChat;
    if (nori && typeof nori.chatStream === "function") {
      const onAbort = () => {
        try {
          nori.chatStop?.();
        } catch {
        }
        cleanup();
        callbacks.onError("\u5DF2\u505C\u6B62");
        finish();
      };
      const cleanup = () => {
        delete window.__noriChatDelta;
        delete window.__noriChatDone;
        delete window.__noriChatError;
        signal?.removeEventListener("abort", onAbort);
      };
      const armIdleWatchdog = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimer = null;
          cleanup();
          callbacks.onError("\u54CD\u5E94\u8D85\u65F6\uFF08\u957F\u65F6\u95F4\u6CA1\u6709\u6570\u636E\uFF09");
          finish();
        }, streamIdleTimeoutMs());
      };
      window.__noriChatDelta = (delta) => {
        armIdleWatchdog();
        callbacks.onDelta(delta);
      };
      window.__noriChatDone = (json) => {
        cleanup();
        try {
          const r = JSON.parse(json);
          callbacks.onDone(r.content ?? "");
        } catch {
          callbacks.onDone("");
        }
        finish();
      };
      window.__noriChatError = (json) => {
        cleanup();
        try {
          const r = JSON.parse(json);
          callbacks.onError(r.message ?? "\u8BF7\u6C42\u5931\u8D25");
        } catch {
          callbacks.onError("\u8BF7\u6C42\u5931\u8D25");
        }
        finish();
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort);
      }
      armIdleWatchdog();
      try {
        nori.chatStream(baseUrl, apiKey, model, payload, resolveThinking(baseUrl, thinking));
      } catch (e) {
        cleanup();
        callbacks.onError(`\u53D1\u8D77\u6D41\u5F0F\u8BF7\u6C42\u5931\u8D25: ${String(e)}`);
        finish();
      }
      return;
    }
    void sendChat(baseUrl, apiKey, model, messages, thinking).then((r) => {
      if (r.ok) {
        const content = r.content ?? "";
        callbacks.onDelta(content);
        callbacks.onDone(content);
      } else {
        callbacks.onError(r.message ?? "\u8BF7\u6C42\u5931\u8D25");
      }
      finish();
    });
  });
  streamQueue = streamQueue.then(task, task);
};
var cancelChatStream = () => {
  try {
    window.NoriChat?.chatStop?.();
  } catch {
  }
};
export {
  DEFAULT_SETTINGS,
  PERSONA_FILE,
  __resetChatCutoffForTest,
  appendMemory,
  cancelChatStream,
  checkCosyBalance,
  checkDeepSeekBalance,
  checkFishBalance,
  fetchModels,
  fetchVoices,
  flushChatPersist,
  getStorageDir,
  hasAllFilesAccess,
  isStorageReady,
  loadChat,
  loadCustomPersona,
  loadSettings,
  localTimeBlock,
  normalizeCloneVoices,
  persistChat,
  personaPrompt,
  pickPersonaFile,
  probePublicFiles,
  readFile,
  readMemory,
  requestAllFilesAccess,
  requestStoragePermission,
  resolveThinking,
  saveCustomPersona,
  saveSettings,
  saveSettingsRaw,
  sendChat,
  sendChatStream,
  setChatTrimCutoff,
  writeFile
};
