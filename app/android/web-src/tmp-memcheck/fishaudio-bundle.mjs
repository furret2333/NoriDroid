// src/services/tts/fishaudio.ts
var DEFAULT_FISH_TTS = {
  enabled: false,
  apiKey: "",
  baseUrl: "https://api.fish.audio",
  referenceId: "",
  model: "s2.1-pro",
  format: "mp3",
  chunkLength: 120,
  latency: "balanced"
};
var FISH_MODELS = ["s2.1-pro", "s2-pro", "s1", "s2.1-pro-free"];
var FISH_FORMATS = ["mp3", "pcm", "opus", "wav"];
var FISH_LATENCIES = ["normal", "balanced", "relaxed"];
var streamFishTTS = async (text, cfg, onChunk, signal) => {
  if (!cfg.apiKey.trim()) return { ok: false, error: "\u672A\u914D\u7F6E Fish Audio API Key" };
  const clean = cleanSpeechText(text);
  if (!clean) return { ok: false, error: "TTS \u6587\u672C\u4E3A\u7A7A" };
  const nori = window.NoriChat;
  if (nori && typeof nori.ttsStream === "function") {
    return streamViaBridge(clean, cfg, onChunk, signal);
  }
  return streamViaFetch(clean, cfg, onChunk, signal);
};
var streamViaBridge = async (clean, cfg, onChunk, signal) => {
  const W = window;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };
    const cleanup = () => {
      delete W.__noriTtsChunk;
      delete W.__noriTtsDone;
      delete W.__noriTtsError;
      signal?.removeEventListener("abort", abort);
    };
    W.__noriTtsChunk = (b64) => {
      try {
        onChunk(base64ToBytes(b64));
      } catch {
      }
    };
    W.__noriTtsDone = (json) => {
      try {
        const r = JSON.parse(json);
        finish({ ok: !!r.ok });
      } catch {
        finish({ ok: true });
      }
    };
    W.__noriTtsError = (json) => {
      try {
        const r = JSON.parse(json);
        finish({ ok: false, error: r.message ?? "TTS \u8BF7\u6C42\u5931\u8D25" });
      } catch {
        finish({ ok: false, error: "TTS \u8BF7\u6C42\u5931\u8D25" });
      }
    };
    const abort = () => finish({ ok: false, error: "\u5DF2\u505C\u6B62" });
    signal?.addEventListener("abort", abort);
    if (signal?.aborted) {
      finish({ ok: false, error: "\u5DF2\u505C\u6B62" });
      return;
    }
    try {
      const nori = window.NoriChat;
      nori.ttsStream(
        cfg.baseUrl.trim().replace(/\/+$/, "") || "https://api.fish.audio",
        cfg.apiKey.trim(),
        cfg.model || "s2.1-pro",
        cfg.referenceId.trim(),
        cfg.format || "mp3",
        cfg.chunkLength || 200,
        cfg.latency || "normal",
        clean
      );
    } catch (e) {
      finish({ ok: false, error: `\u53D1\u8D77\u8BF7\u6C42\u5931\u8D25: ${e?.message ?? String(e)}` });
    }
  });
};
var base64ToBytes = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
var streamViaFetch = async (clean, cfg, onChunk, signal) => {
  const base = cfg.baseUrl.trim().replace(/\/+$/, "") || "https://api.fish.audio";
  let res;
  try {
    res = await fetch(`${base}/v1/tts`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey.trim()}`,
        model: cfg.model || "s2.1-pro"
      },
      body: JSON.stringify({
        text: clean,
        ...cfg.referenceId.trim() ? { reference_id: cfg.referenceId.trim() } : {},
        format: cfg.format || "mp3",
        streaming: true,
        chunk_length: cfg.chunkLength || 200,
        latency: cfg.latency || "normal"
      })
    });
  } catch (e) {
    return { ok: false, error: `\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25: ${e?.message ?? String(e)}` };
  }
  if (!res.ok) {
    let detail = "";
    try {
      const json = await res.json();
      detail = json.message ?? json.detail ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
  }
  if (!res.body) return { ok: false, error: "\u54CD\u5E94\u65E0\u5185\u5BB9" };
  const reader = res.body.getReader();
  let total = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        total += value.length;
        onChunk(value);
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, error: "\u5DF2\u505C\u6B62" };
    return { ok: false, error: `\u6D41\u8BFB\u53D6\u5931\u8D25: ${e?.message ?? String(e)}` };
  }
  return { ok: true, bytes: total };
};
var testFishTTS = async (cfg) => {
  let gotBytes = false;
  const res = await streamFishTTS("\u6D4B\u8BD5", cfg, () => {
    gotBytes = true;
  });
  if (res.ok && gotBytes) return { ok: true, bytes: res.bytes };
  if (res.ok && !gotBytes) return { ok: false, error: "\u670D\u52A1\u8FDE\u901A\u4F46\u672A\u8FD4\u56DE\u97F3\u9891" };
  return res;
};
var cleanSpeechText = (raw) => {
  let text = raw;
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`\n]*)`/g, "$1");
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, " ");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s{0,3}([-*+]\s|\d{1,9}[.、]\s)/gm, "");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/__([^_\n]+)__/g, "$1");
  text = text.replace(/~~([^~\n]+)~~/g, "$1");
  text = text.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "");
  return text.replace(/\s+/g, " ").trim();
};
export {
  DEFAULT_FISH_TTS,
  FISH_FORMATS,
  FISH_LATENCIES,
  FISH_MODELS,
  cleanSpeechText,
  streamFishTTS,
  testFishTTS
};
