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
var pickVoiceModel = (voice, cloneVoices) => {
  const id = (voice ?? "").trim();
  if (!id) return "";
  const known = (cloneVoices ?? []).find((v) => v?.id === id)?.model ?? "";
  return known || cosyModelFromVoiceId(id);
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
export {
  COSY_MODELS,
  cosyModelFromVoiceId,
  normalizeCloneVoices,
  pickVoiceModel
};
