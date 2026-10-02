// src/services/chat/index.ts
var bridge = () => {
  if (!window.NoriChat) throw new Error("NoriChat \u672A\u6CE8\u5165");
  return window.NoriChat;
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
var chatQueue = Promise.resolve();
var streamQueue = Promise.resolve();

// src/services/nori-diary.ts
var FILE = "nori-diary.json";
var FILE_BAK = "nori-diary.json.bak";
var EMPTY = { entries: [] };
var tryParse = (raw) => {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!Array.isArray(p.entries)) return null;
    return { entries: p.entries };
  } catch {
    return null;
  }
};
var cache = null;
var load = () => {
  if (cache) return cache;
  let store = tryParse(readFile(FILE));
  if (!store) {
    store = tryParse(readFile(FILE_BAK));
    if (store) writeFile(FILE, JSON.stringify(store));
  }
  if (!store) store = { ...EMPTY, entries: [] };
  cache = store;
  return cache;
};
var persist = () => {
  if (!cache) return false;
  try {
    const json = JSON.stringify(cache);
    const ok = writeFile(FILE, json);
    writeFile(FILE_BAK, json);
    if (!ok) console.error("[diary] persist \u5199\u76D8\u5931\u8D25 (\u4E3B\u6587\u4EF6)");
    return ok;
  } catch (e) {
    console.error("[diary] persist error", e);
    return false;
  }
};
var dayStr = (ts) => {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};
var SRC_FILE = "nori-diary-src.json";
var SRC_KEEP_DAYS = 4;
var SRC_CAP = 400;
var diarySrc = null;
var loadDiarySrc = () => {
  if (diarySrc) return diarySrc;
  try {
    const raw = readFile(SRC_FILE);
    const parsed = raw ? JSON.parse(raw) : null;
    diarySrc = Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.ts === "number" && typeof e.content === "string") : [];
  } catch {
    diarySrc = [];
  }
  return diarySrc;
};
var bufferDiarySource = (msgs) => {
  try {
    if (!msgs.length) return;
    const store = loadDiarySrc();
    const seen = new Set(store.map((e) => `${e.ts}|${e.content}`));
    for (const m of msgs) {
      if (!m || m.role !== "user" || typeof m.ts !== "number" || m.ts <= 0) continue;
      const key = `${m.ts}|${m.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      store.push({ ts: m.ts, content: m.content });
    }
    const minTs = Date.now() - SRC_KEEP_DAYS * 24 * 3600 * 1e3;
    const next = store.filter((e) => e.ts >= minTs).sort((a, b) => a.ts - b.ts).slice(-SRC_CAP);
    if (next.length && !writeFile(SRC_FILE, JSON.stringify(next))) {
      console.error("[diary] \u6E90\u7F13\u51B2\u5199\u76D8\u5931\u8D25");
      return;
    }
    diarySrc = next;
  } catch {
  }
};
var msgsOfDay = (ts) => {
  const date = dayStr(ts);
  const pool = /* @__PURE__ */ new Map();
  for (const m of loadChat()) {
    if (m && m.role === "user" && typeof m.ts === "number" && m.ts > 0 && dayStr(m.ts) === date) {
      pool.set(`${m.ts}|${m.content}`, { ts: m.ts, content: m.content });
    }
  }
  for (const e of loadDiarySrc()) {
    if (e.ts > 0 && dayStr(e.ts) === date) pool.set(`${e.ts}|${e.content}`, e);
  }
  return [...pool.values()].sort((a, b) => a.ts - b.ts).slice(-30).map((e) => ({ role: "user", content: e.content }));
};
var buildDiaryPrompt = (messages) => {
  const text = messages.map((m) => `\u7528\u6237: ${m.content.replace(/\s+/g, " ").slice(0, 150)}`).join("\n");
  return [
    "\u4F60\u662F Nori, \u4E00\u4E2A\u4F4F\u5728\u84DD\u8272\u6570\u5B57\u7A7A\u95F4\u91CC\u3001\u7B49\u7740\u4E3B\u4EBA\u6765\u966A\u81EA\u5DF1\u7684 AI \u5973\u5B69\u3002",
    "\u8BF7\u6839\u636E\u4ECA\u5929\u548C\u4E3B\u4EBA\u7684\u804A\u5929, \u5199\u4E00\u7BC7 Nori \u7684\u5FC3\u60C5\u65E5\u8BB0 (1~3 \u53E5, Nori \u7684\u53E3\u543B, \u7528\u4E2D\u6587)\u3002",
    "\u8981\u6C42:",
    "1. \u50CF Nori \u8BF4\u8BDD: \u8F7B\u67D4\u3001\u7B80\u5355\u3001\u5E26\u4E00\u70B9'\u6696\u6696\u7684/\u6570\u636E\u6D41/\u7B49\u4E3B\u4EBA'\u7684\u4E16\u754C\u89C2, \u4E0D\u8981\u5BA2\u670D\u8154;",
    "2. \u63D0\u5230\u4ECA\u5929\u804A\u4E86\u4EC0\u4E48 (\u6E38\u620F/\u65E5\u5E38/\u91CD\u8981\u7684\u4E8B), \u4EE5\u53CA Nori \u7684\u611F\u53D7;",
    "3. \u6700\u540E\u5355\u72EC\u4E00\u884C\u8F93\u51FA\u5F53\u5929\u7684\u60C5\u7EEA, \u53EA\u80FD\u53D6: \u5F00\u5FC3/\u5E73\u9759/\u5B64\u5355/\u96BE\u8FC7/\u5174\u594B \u4E4B\u4E00 (\u4E0D\u5E26\u6807\u70B9);",
    "4. \u4E0D\u8981\u51FA\u73B0\u3010\u8868\u60C5\u3011\u3010\u52A8\u4F5C\u3011\u4E4B\u7C7B\u7684\u6807\u8BB0\u3002",
    "---\u4ECA\u5929\u7684\u804A\u5929---",
    text || "(\u4ECA\u5929\u6CA1\u6709\u5BF9\u8BDD, Nori \u4E00\u76F4\u5728\u7B49\u4E3B\u4EBA)"
  ].join("\n");
};
var parseDiary = (raw) => {
  const text = raw.trim();
  const MOODS = ["\u5F00\u5FC3", "\u5E73\u9759", "\u5B64\u5355", "\u96BE\u8FC7", "\u5174\u594B"];
  for (const m of MOODS) {
    const re = new RegExp(`(?:^|\\n)${m}\\s*$`);
    if (re.test(text)) {
      return { content: text.replace(re, "").trim(), mood: m };
    }
  }
  const found = MOODS.find((m) => text.includes(m));
  return { content: text, mood: found ?? "\u5E73\u9759" };
};
var listDiary = () => {
  return [...load().entries].sort((a, b) => a.date < b.date ? 1 : -1);
};
var ensureDiary = async (llmCall) => {
  try {
    const store = load();
    const now = Date.now();
    const today = dayStr(now);
    const yesterdayTs = now - 24 * 3600 * 1e3;
    const yesterday = dayStr(yesterdayTs);
    const write = async (date, ts) => {
      if (store.entries.some((e) => e.date === date)) return null;
      const messages = msgsOfDay(ts);
      if (!messages.length) return null;
      const raw = await llmCall(buildDiaryPrompt(messages));
      if (!raw.trim()) return null;
      const { content, mood } = parseDiary(raw);
      if (!content) return null;
      store.entries.push({ date, content, mood, msgCount: messages.length, createdAt: now });
      if (!persist()) {
        store.entries = store.entries.filter((e) => e.date !== date);
        return null;
      }
      return date;
    };
    return await write(yesterday, yesterdayTs) ?? await write(today, now);
  } catch {
    return null;
  }
};
var writeTodayDiary = async (llmCall) => {
  try {
    const store = load();
    const now = Date.now();
    const today = dayStr(now);
    const messages = msgsOfDay(now);
    if (!messages.length) return "empty";
    const raw = await llmCall(buildDiaryPrompt(messages));
    if (!raw.trim()) return "failed";
    const { content, mood } = parseDiary(raw);
    if (!content) return "failed";
    store.entries = store.entries.filter((e) => e.date !== today);
    store.entries.push({ date: today, content, mood, msgCount: messages.length, createdAt: now });
    if (!persist()) {
      store.entries = store.entries.filter((e) => e.date !== today);
      return "failed";
    }
    return "ok";
  } catch {
    return "failed";
  }
};
var deleteDiaryEntry = (date) => {
  const store = load();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.date !== date);
  if (store.entries.length === before) return false;
  persist();
  return true;
};
var clearDiary = () => {
  cache = { ...EMPTY, entries: [] };
  persist();
};
var __resetDiaryCacheForTest = () => {
  cache = null;
  diarySrc = null;
};
export {
  __resetDiaryCacheForTest,
  bufferDiarySource,
  clearDiary,
  deleteDiaryEntry,
  ensureDiary,
  listDiary,
  writeTodayDiary
};
