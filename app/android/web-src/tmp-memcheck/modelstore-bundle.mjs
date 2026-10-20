// src/services/gateway/api.ts
var MODELS = [
  { id: "ARGNori", name: "ARGNori" },
  { id: "Nori", name: "Nori" }
];
var fetchLive2dList = async () => ({ list: MODELS });

// src/services/live2d/modelStore.ts
var bridge = () => {
  if (!window.NoriBridge) throw new Error("\u6A21\u578B\u4E0B\u8F7D\u7EC4\u4EF6\u4E0D\u53EF\u7528 (NoriBridge \u672A\u6CE8\u5165)");
  return window.NoriBridge;
};
var parseBridgeResult = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, message: "\u539F\u751F\u8FD4\u56DE\u683C\u5F0F\u9519\u8BEF" };
  }
};
var fetchModelList = async () => {
  const body = await fetchLive2dList();
  return body.list ?? [];
};
var listInstalled = async () => {
  try {
    const raw = bridge().listInstalled();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((i) => i && typeof i.id === "string" && typeof i.entryBase === "string");
  } catch {
    return [];
  }
};
var getInstalled = async (id) => (await listInstalled()).find((i) => i.id === id);
var DOWNLOAD_TIMEOUT_MS = 12e4;
var ensureModel = async (id, _name) => {
  const cached = await getInstalled(id);
  if (cached?.entryBase) return cached.entryBase;
  if (!window.NoriBridge) throw new Error("NoriBridge \u672A\u6CE8\u5165");
  if (window.__noriModelRes) throw new Error("\u5DF2\u6709\u6A21\u578B\u6B63\u5728\u4E0B\u8F7D, \u8BF7\u7A0D\u5019");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      const w = window;
      if (w.__noriModelRes === onRes) delete w.__noriModelRes;
      clearTimeout(timer);
      fn();
    };
    const onRes = (json) => {
      const res = parseBridgeResult(json);
      if (res.ok && res.entryBase) finish(() => resolve(res.entryBase));
      else finish(() => reject(new Error(res.message || "\u6A21\u578B\u4E0B\u8F7D\u5931\u8D25")));
    };
    window.__noriModelRes = onRes;
    const timer = setTimeout(
      () => finish(() => reject(new Error("\u6A21\u578B\u4E0B\u8F7D\u8D85\u65F6\uFF08\u7F51\u7EDC\u4E0D\u7A33\u5B9A\u6216\u539F\u751F\u4E0B\u8F7D\u5668\u65E0\u54CD\u5E94\uFF09"))),
      DOWNLOAD_TIMEOUT_MS
    );
    try {
      bridge().download(id);
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
};
var modelsDirOf = () => "models";
export {
  ensureModel,
  fetchModelList,
  getInstalled,
  listInstalled,
  modelsDirOf
};
