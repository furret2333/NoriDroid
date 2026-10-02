// src/services/tts/clone-gate.ts
var CLONE_GATE_QUESTION = "Nori \u5199\u7684\u8BD7\u7B2C\u4E00\u53E5\uFF1F\uFF088 \u5B57\uFF09";
var CLONE_GATE_HINT = "\u61D2\u5F97\u627E\u7B54\u6848\u7684\u8BDD\u8BF7\u6233\u6211\u2026\u2026 \u53E6\u5916\uFF1A\u514B\u9686\u6548\u679C\u4E0D\u4E00\u5B9A\u597D\uFF0C\u5EFA\u8BAE\u7528 audio 3.1 \u6A21\u578B\u3002";
var MODEL_GATE_HINT = "\u61D2\u5F97\u627E\u7B54\u6848\u7684\u8BDD\u8BF7\u6233\u6211\u2026\u2026 \u53E6\u5916\uFF1A\u6A21\u578B\u5305\u5341\u51E0 MB\uFF0C\u4E0B\u8F7D\u524D\u8BF7\u786E\u8BA4\u7F51\u7EDC\uFF08\u56FD\u5185\u53EF\u80FD\u9700\u8981\u9B54\u6CD5\uFF09\u3002";
var ANSWER = "\u6C34\u6BCD\u662F\u6C34\u91CC\u7684\u6708\u4EAE";
var PUNCT = /[\s，。、！？；：,.!?;:""''‘’“”「」『』（）()［］【】\[\]《》〈〉<>·~～^_\-—–]/g;
var normalizeCloneAnswer = (s) => String(s ?? "").replace(PUNCT, "").toLowerCase();
var checkCloneAnswer = (input) => normalizeCloneAnswer(input) !== "" && normalizeCloneAnswer(input) === normalizeCloneAnswer(ANSWER);
export {
  CLONE_GATE_HINT,
  CLONE_GATE_QUESTION,
  MODEL_GATE_HINT,
  checkCloneAnswer,
  normalizeCloneAnswer
};
