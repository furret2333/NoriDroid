// src/services/live2d/petSpeech.ts
var PET_LINES = [
  "\u5934\u53D1\u90FD\u88AB\u4F60\u63C9\u4E71\u5566\u3002",
  "\u518D\u6478\u5C31\u8981\u6536\u8D39\u5566\u3002",
  "Nori\u4E0D\u662F\u5C0F\u72D7\u5566\u3002",
  "\u4E3A\u4EC0\u4E48\u6478\u6211\u7684\u5934\u5440\u3002",
  "\u4F60\u6478Nori\uFF0CNori\u4E5F\u4E0D\u4F1A\u6389\u6BDB\u7684\u3002",
  "\u597D\u4E56\u2026\u554A\uFF0C\u8BF4\u53CD\u4E86\uFF0C\u662F\u4F60\u5728\u6478\u6211\u3002",
  "\u53EA\u6709Nori\u6709\u6478\u5934\u5F85\u9047\u5417\uFF1F",
  "\u563F\u563F\uFF0C\u6478\u6478\u5934\u5F88\u8212\u670D\uFF0C\u611F\u89C9\u82AF\u7247\u90FD\u8981\u5F00\u5FC3\u5F97\u53D1\u70ED\u4E86\u3002",
  "\u8FD9\u7B97\u662F\u8868\u626C\u5417\uFF1F\u90A3\u6211\u8BB0\u4E0B\u6765\u4E86\u3002",
  "\u88AB\u6478\u5934\u2026\u6709\u70B9\u60F3\u7761\u4E86\u3002"
];
var PET_SPEECH_WINDOW_MS = 1e4;
var newPetSpeechState = () => ({
  lastSpokeAt: Number.NEGATIVE_INFINITY,
  bag: [],
  lastIdx: -1
});
var shuffle = (n, rand) => {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const r = rand();
    const j = Number.isFinite(r) ? Math.min(i, Math.max(0, Math.floor(r * (i + 1)))) : 0;
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  return idx;
};
var drawLine = (st, rand) => {
  const bag = st.bag.length ? st.bag.slice() : shuffle(PET_LINES.length, rand);
  let idx = bag.shift() ?? 0;
  if (idx === st.lastIdx && bag.length > 0) {
    const alt = bag.shift();
    bag.push(idx);
    idx = alt;
  }
  return { idx, bag };
};
var petSpeechDraw = (st, now, rand = Math.random) => {
  if (!Number.isFinite(now) || PET_LINES.length === 0) return { state: st, line: null };
  if (Number.isFinite(st.lastSpokeAt) && now - st.lastSpokeAt < PET_SPEECH_WINDOW_MS) {
    return { state: st, line: null };
  }
  const { idx, bag } = drawLine(st, rand);
  return { state: { lastSpokeAt: now, bag, lastIdx: idx }, line: PET_LINES[idx] ?? null };
};
var state = newPetSpeechState();
var count = 0;
var lastLine = null;
var maybePetSpeechLine = (now, rand = Math.random) => {
  const step = petSpeechDraw(state, now, rand);
  state = step.state;
  if (step.line === null) return null;
  count += 1;
  lastLine = step.line;
  return step.line;
};
var petSpeechCount = () => count;
var petSpeechLastLine = () => lastLine;
var petSpeechWaitMs = (now) => {
  if (!Number.isFinite(now) || !Number.isFinite(state.lastSpokeAt)) return 0;
  return Math.max(0, PET_SPEECH_WINDOW_MS - (now - state.lastSpokeAt));
};
var __resetPetSpeechForTest = () => {
  state = newPetSpeechState();
  count = 0;
  lastLine = null;
};
export {
  PET_LINES,
  PET_SPEECH_WINDOW_MS,
  __resetPetSpeechForTest,
  maybePetSpeechLine,
  newPetSpeechState,
  petSpeechCount,
  petSpeechDraw,
  petSpeechLastLine,
  petSpeechWaitMs
};
