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

// ../src/services/live2d/renderScale.ts
var RENDER_SCALE_MIN = 0.5;
var RENDER_SCALE_MAX = 3;
var normalizeRenderScale = (value, fallback = 1) => {
  const safeFallback = Number(fallback);
  const base = Number.isFinite(safeFallback) ? Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, safeFallback)) : 1;
  const n = Number(value);
  if (!Number.isFinite(n)) return base;
  return Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, n));
};

// ../src/services/time.ts
var formatLocalTime = (date) => {
  const p = (n) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const zone = `UTC${offset >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(offset) / 60))}:${p(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}\uFF08${zone}\uFF09`;
};
var isValidTimestamp = (ts) => typeof ts === "number" && Number.isFinite(ts) && ts > 0 && Number.isFinite(new Date(ts).getTime());

// ../src/services/chat/index.ts
var localTimeBlock = (now = /* @__PURE__ */ new Date(), gapMs = 0) => {
  const week = ["\u661F\u671F\u65E5", "\u661F\u671F\u4E00", "\u661F\u671F\u4E8C", "\u661F\u671F\u4E09", "\u661F\u671F\u56DB", "\u661F\u671F\u4E94", "\u661F\u671F\u516D"][now.getDay()];
  const hour = now.getHours();
  const period = hour < 5 ? "\u51CC\u6668" : hour < 8 ? "\u6E05\u6668" : hour < 12 ? "\u4E0A\u5348" : hour < 14 ? "\u4E2D\u5348" : hour < 18 ? "\u4E0B\u5348" : "\u665A\u4E0A";
  const gapHint = gapMs >= 5 * 60 * 1e3 ? `\u8DDD\u79BB\u4E0A\u4E00\u6761\u5386\u53F2\u6D88\u606F\u7EA6 ${formatElapsed(gapMs)}\uFF0C\u8BF7\u4EE5\u5F53\u524D\u65F6\u95F4\u4E3A\u51C6\uFF0C\u4E0D\u8981\u628A\u5386\u53F2\u6D88\u606F\u4E2D\u7684\u201C\u73B0\u5728\u3001\u4ECA\u5929\u3001\u6628\u665A\u201D\u5F53\u4F5C\u5F53\u524D\u4E8B\u5B9E\u3002
` : "";
  return `\u3010\u5F53\u524D\u65F6\u95F4\u3011${formatLocalTime(now)} ${week}
\u5F53\u524D\u65F6\u6BB5\uFF1A${period}\u3002
${gapHint}\u8FD9\u662F\u672C\u8F6E\u8BF7\u6C42\u53D1\u51FA\u65F6\u7684\u8BBE\u5907\u672C\u5730\u65F6\u95F4\uFF0C\u662F\u5224\u65AD\u300C\u73B0\u5728\u3001\u4ECA\u5929\u3001\u660E\u5929\u3001\u4E0B\u5468\u4E09\u300D\u7684\u4F9D\u636E\u3002\u5373\u4F7F\u7528\u6237\u6CA1\u95EE\u65F6\u95F4\uFF0C\u95EE\u5019\u3001\u4F5C\u606F\u5EFA\u8BAE\u548C\u6D89\u53CA\u300C\u73B0\u5728\u300D\u7684\u8868\u8FBE\u4E5F\u8981\u4E0E\u672C\u8F6E\u65F6\u95F4\u4E00\u81F4\uFF1B\u81EA\u7136\u804A\u5929\uFF0C\u4E0D\u5FC5\u6BCF\u53E5\u8BDD\u62A5\u65F6\u3002\u5386\u53F2\u6D88\u606F\u7684\u53D1\u9001\u65F6\u95F4\u548C\u6458\u8981\u7684\u539F\u5BF9\u8BDD\u65F6\u95F4\u53EA\u4EE3\u8868\u5F53\u65F6\uFF0C\u5176\u4E2D\u7684\u300C\u4ECA\u5929\u3001\u6628\u665A\u3001\u665A\u5B89\u300D\u4E0D\u80FD\u5F53\u4F5C\u73B0\u5728\uFF1B\u53D1\u9001\u65F6\u95F4\u4E5F\u4E0D\u7B49\u4E8E\u6587\u4E2D\u4E8B\u4EF6\u53D1\u751F\u65F6\u95F4\u3002\u4E0D\u8981\u987A\u7740\u65E7\u7684\u591C\u95F4\u5BF9\u8BDD\u8BA4\u5B9A\u73B0\u5728\u8FD8\u662F\u665A\u4E0A\uFF0C\u4E5F\u4E0D\u8981\u4EC5\u56E0\u7528\u6237\u8BF4\u300C\u56F0\u4E86\u3001\u7D2F\u4E86\u300D\u5C31\u8BA4\u5B9A\u5DF2\u5230\u6DF1\u591C\u3002\u65B9\u62EC\u53F7\u4E2D\u7684\u65F6\u95F4\u6807\u7B7E\u662F\u5185\u90E8\u63D0\u793A\uFF0C\u7EDD\u5BF9\u4E0D\u8981\u5728\u56DE\u590D\u4E2D\u590D\u8FF0\u3001\u5F15\u7528\u6216\u8F93\u51FA\u3002`;
};
var formatElapsed = (ms) => {
  const totalMinutes = Math.max(1, Math.round(ms / 6e4));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} \u5206\u949F`;
  if (minutes <= 0) return `${hours} \u5C0F\u65F6`;
  return `${hours} \u5C0F\u65F6 ${minutes} \u5206\u949F`;
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
  lipSyncEnabled: false,
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
    merged.renderScale = normalizeRenderScale(parsed?.renderScale, DEFAULT_SETTINGS.renderScale);
    merged.floatRenderScale = normalizeRenderScale(parsed?.floatRenderScale, DEFAULT_SETTINGS.floatRenderScale);
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
var imagePickBusy = false;
var imagePickSeq = 0;
var pickImageViaBridge = (method) => new Promise((resolve) => {
  if (imagePickBusy) {
    resolve({ ok: false, message: "\u6B63\u5728\u7B49\u5F85\u4E0A\u4E00\u5F20\u56FE\u7247" });
    return;
  }
  imagePickBusy = true;
  const requestId = ++imagePickSeq;
  const W = window;
  let settled = false;
  let timeout = null;
  const done = (result) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    imagePickBusy = false;
    delete W.__noriImagePickedRes;
    resolve(result);
  };
  W.__noriImagePickedRes = (json) => {
    try {
      const result = JSON.parse(json);
      if (!result || result.requestId !== requestId) return;
      if (result.ok && (typeof result.dataUrl !== "string" || result.dataUrl.length > 2000100 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(result.dataUrl))) {
        done({ ok: false, message: "\u56FE\u7247\u683C\u5F0F\u65E0\u6548\u6216\u8FC7\u5927\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9" });
        return;
      }
      done(result);
    } catch {
      done({ ok: false, message: "\u56FE\u7247\u7ED3\u679C\u89E3\u6790\u5931\u8D25" });
    }
  };
  const nori = window.NoriChat;
  if (!nori || typeof nori[method] !== "function") {
    done({ ok: false, message: "\u539F\u751F\u6865\u4E0D\u652F\u6301\u56FE\u7247\u9009\u62E9 (\u8BF7\u5347\u7EA7\u5E94\u7528)" });
    return;
  }
  timeout = setTimeout(() => done({ ok: false, message: "\u56FE\u7247\u9009\u62E9\u8D85\u65F6\uFF0C\u8BF7\u8FD4\u56DE\u540E\u91CD\u65B0\u9009\u62E9" }), W.__noriImagePickTimeoutMs ?? 3e5);
  try {
    nori[method](requestId);
  } catch (e) {
    done({ ok: false, message: `\u53D1\u8D77\u56FE\u7247\u9009\u62E9\u5931\u8D25: ${String(e)}` });
  }
});
var pickImageFile = () => pickImageViaBridge("pickImageFile");
var captureImage = () => pickImageViaBridge("captureImage");
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
  chatPersistPending = messages.map((m) => {
    const copy = { ...m };
    delete copy.parts;
    return copy;
  });
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
var toApiMessage = (message) => ({
  role: message.role,
  content: message.parts?.length ? message.parts : message.content
});
var buildApiMessages = (messages, options) => {
  if (!options?.timeAware) return messages.map(toApiMessage);
  const result = messages.map((message) => {
    const api = toApiMessage(message);
    if (message.role === "system") return api;
    const label = isValidTimestamp(message.ts) ? `\u3010\u6D88\u606F\u53D1\u9001\u65F6\u95F4\u3011${formatLocalTime(new Date(message.ts))}
` : "\u3010\u6D88\u606F\u53D1\u9001\u65F6\u95F4\u672A\u8BB0\u5F55\u3011\n";
    if (typeof api.content === "string") return { ...api, content: label + api.content };
    const firstText = api.content.findIndex((part) => part.type === "text");
    const parts = api.content.map((part, i) => part.type === "text" && i === firstText ? { ...part, text: label + part.text } : part);
    if (firstText < 0) parts.unshift({ type: "text", text: label.trimEnd() });
    return { ...api, content: parts };
  });
  const latestUser = messages.map((m, i) => m.role === "user" ? i : -1).filter((i) => i >= 0).pop() ?? -1;
  const previousConversation = latestUser > 0 ? [...messages.slice(0, latestUser)].reverse().find((m) => m.role !== "system") : void 0;
  const now = /* @__PURE__ */ new Date();
  const gapMs = previousConversation && isValidTimestamp(previousConversation.ts) && isValidTimestamp(messages[latestUser]?.ts) ? Math.max(0, messages[latestUser].ts - previousConversation.ts) : 0;
  const firstConversation = result.findIndex((m) => m.role !== "system");
  result.splice(firstConversation < 0 ? result.length : firstConversation, 0, { role: "system", content: localTimeBlock(now, gapMs) });
  return result;
};
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
var CHAT_TOTAL_TIMEOUT_MS = 9e4;
var sendChat = (baseUrl, apiKey, model, messages, thinking = false, options) => {
  if (!apiKey.trim()) return Promise.resolve({ ok: false, message: "\u8BF7\u5148\u5728\u8BBE\u7F6E\u91CC\u586B\u5199 API Key" });
  if (!model.trim()) return Promise.resolve({ ok: false, message: "\u8BF7\u5148\u5728\u8BBE\u7F6E\u91CC\u9009\u62E9\u6A21\u578B" });
  return enqueueChat(() => {
    const payload = JSON.stringify(buildApiMessages(messages, options));
    return new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      const done = (result) => {
        if (settled) return;
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        delete window.__noriChatRes;
        resolve(result);
      };
      window.__noriChatRes = (json) => {
        try {
          done(JSON.parse(json));
        } catch {
          done({ ok: false, message: "\u54CD\u5E94\u89E3\u6790\u5931\u8D25" });
        }
      };
      timeout = setTimeout(() => done({ ok: false, message: "\u8BF7\u6C42\u8D85\u65F6, \u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5" }), CHAT_TOTAL_TIMEOUT_MS);
      try {
        bridge().chat(baseUrl, apiKey, model, payload, resolveThinking(baseUrl, thinking));
      } catch {
        done({ ok: false, message: "\u8BF7\u6C42\u5931\u8D25" });
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
var sendChatStream = (baseUrl, apiKey, model, messages, callbacks, thinking = false, signal, options) => {
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
    const nori = window.NoriChat;
    if (nori && typeof nori.chatStream === "function") {
      const payload = JSON.stringify(buildApiMessages(messages, options));
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
    void sendChat(baseUrl, apiKey, model, messages, thinking, options).then((r) => {
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
  captureImage,
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
  pickImageFile,
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
