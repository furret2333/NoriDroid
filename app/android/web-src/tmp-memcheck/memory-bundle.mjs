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
var chatQueue = Promise.resolve();
var streamQueue = Promise.resolve();

// src/services/memory/diag.ts
var MAX_DIAG_RECORDS = 200;
var DIAG_PROMPT_MAX = 4e3;
var DIAG_RAW_MAX = 2e3;
var enabled = false;
var ring = [];
var diagEnabled = () => enabled;
var setDiagEnabled = (on) => {
  enabled = !!on;
};
var diagCount = () => ring.length;
var clearDiag = () => {
  ring.length = 0;
};
var recordOrganize = (rec) => {
  if (!enabled) return;
  ring.push({ ts: Date.now(), ...rec });
  if (ring.length > MAX_DIAG_RECORDS) ring.splice(0, ring.length - MAX_DIAG_RECORDS);
};
var lastDiagRecord = () => ring.length ? { ...ring[ring.length - 1] } : null;
var buildDiagJsonl = (meta = {}) => {
  const head = {
    kind: "header",
    at: (/* @__PURE__ */ new Date()).toISOString(),
    app: meta.app ?? "NoriDroid",
    model: meta.model ?? "",
    records: ring.length,
    cap: MAX_DIAG_RECORDS,
    promptMax: DIAG_PROMPT_MAX,
    rawMax: DIAG_RAW_MAX,
    ...meta.extra ?? {}
  };
  return [JSON.stringify(head), ...ring.map((r) => JSON.stringify(r))].join("\n") + "\n";
};

// src/services/memory/core.ts
var MEMORY_TYPES = ["fact", "preference", "project", "event", "relationship", "core"];
var isActiveMemory = (m) => !m.invalidAt && !m.fadedAt;
var MEMORY_SCHEMA_VERSION = 2;
var MIN_IMPORTANCE_PASS = 0.5;
var MIN_IMPORTANCE_SOFT = 0.35;
var isWorthRemembering = (input) => {
  const tags = input.tags ?? [];
  if (tags.some((t) => t === "explicit" || t === "pinned" || t === "goal" || t === "identity")) return true;
  const type = input.type ?? "fact";
  if (type === "core") return true;
  const imp = typeof input.importance === "number" ? input.importance : MIN_IMPORTANCE_PASS;
  return imp >= (type === "event" ? MIN_IMPORTANCE_PASS : MIN_IMPORTANCE_SOFT);
};
var MAX_DELETED_BIN = 20;
var EMPTY_MEMORY_STORE = {
  memories: [],
  summaries: [],
  summarizedMsgCount: 0,
  trimmedMsgCount: 0,
  meta: [],
  tombstones: [],
  blocks: [],
  deletedBin: [],
  schemaVersion: MEMORY_SCHEMA_VERSION
};
var uid = () => `m_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
var EXTRACT_RULES = [
  // 显式要求记住 (最高权重)
  // 捕获一律"段级": 遇到逗号/句号/问号即停, 防止把同一句里后面的内容(反问/闲聊)也吸进记忆
  { re: /(?:请)?(?:一直|永远)?记住[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "core", importance: 0.85, confidence: 0.95, tag: "explicit" },
  { re: /(?:记住|记着|不要忘记|别忘了|记牢|一定要记住|帮我记下|记一下)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "fact", importance: 0.8, confidence: 0.9, tag: "explicit" },
  // 身份信息 (名字: 最明确)
  { re: /(?:我叫|我的名字是|我叫做|名字叫)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "fact", importance: 0.9, confidence: 0.95, tag: "identity" },
  // 身份信息 (职业/身份: 需带身份后缀, 避免"我是想问"误提取)
  { re: /(?:^|[,，。；;]|对,?|嗯,?|嗯嗯,?)我是[：:，,\s]*([^，。！？!?,.、]{1,12}(?:的|人|师|员|生|工|学生|老师|程序员|设计师|工程师))/i, type: "fact", importance: 0.7, confidence: 0.75, tag: "identity" },
  // 身份信息 ("我是小明" 等直接报名字: 捕获 2~6 字人名/称呼,
  // 排除"想问/来做/在忙/来问/想问/觉得/不是/不会/有点/还/想"等动词/语气开头, 防误判)
  { re: /(?:^|[,，。；;]|对,?|嗯,?|嗯嗯,?|对了,?)我是[：:，,\s]*(?!想|来|在|还|不|没|会|要|做|觉得|认为|有点|有)([^，。！？!?,.、]{2,6})/i, type: "fact", importance: 0.85, confidence: 0.9, tag: "identity" },
  // 偏好 (正面): 提取内容带"喜欢"方向, 避免"喜欢/讨厌/中性"混淆 (否则只会存下"下雨天")
  { re: /(?:我喜欢|我爱|我超爱|我好喜欢|我最喜欢|超喜欢|特别喜欢|老喜欢|特喜欢|最爱|最喜欢)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "preference", importance: 0.7, confidence: 0.85, tag: "preference", label: "\u559C\u6B22" },
  { re: /(?:我喜欢|我爱|我最喜欢|超喜欢|特别喜欢)[的][：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "preference", importance: 0.65, confidence: 0.8, tag: "preference", label: "\u559C\u6B22" },
  // 偏好 (负面): 带"不喜欢"方向
  { re: /(?:我不喜欢|我讨厌|我反感|我不爱吃|我不喜欢听|受不了|接受不了|最讨厌|特别讨厌|很不喜欢)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "preference", importance: 0.65, confidence: 0.85, tag: "preference", label: "\u4E0D\u559C\u6B22" },
  // 正在做的事 / 项目 (必须带明确动作词, 避免"我在想你"误提取)
  { re: /(?:我在做|我正在做|我在开发|我在搞|我在研究|我最近在做|我负责|我最近在忙|正在做|在忙)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "project", importance: 0.8, confidence: 0.8, tag: "project" },
  { re: /(?:我在学|我正在学|我在读|我在准备|我在备考|最近在学|正在学|在准备)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "project", importance: 0.6, confidence: 0.8, tag: "project" },
  // 住址 / 位置 (用"住在/家在"但要带地点特征: 城市/区/街道/楼/号)
  { re: /(?:我家在|我老家在|我住在|我目前住在)[：:，,\s]*([^，。！？!?,.、]{1,20}?(?:市|区|县|镇|村|街|路|大道|小区|楼|号|省))/i, type: "fact", importance: 0.5, confidence: 0.8 },
  // 习惯 / 频率
  { re: /(?:每天|每晚|每周|总是|经常|习惯了|的习惯是|一般都|平时都)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "preference", importance: 0.5, confidence: 0.7 },
  // 宠物 / 拥有
  { re: /(?:我|我家)(?:养了|养|买了|新买了|有只|有只猫|有只狗|有只)[：:，,\s]*([^，。！？!?,.、]+)/, type: "fact", importance: 0.45, confidence: 0.7 },
  // 工作 / 职业 (补充)
  { re: /(?:我在这|我就职于|我在某|我在一家|我在.*(?:公司|单位))[：:，,\s]*([^，。！？!?,.、]*(?:公司|单位|上班|工作|当|做))/i, type: "fact", importance: 0.6, confidence: 0.7, tag: "work" },
  { re: /(?:我的工作是|我工作是|我职业是|我是做)[：:，,\s]*([^，。！？!?,.、]+)/, type: "fact", importance: 0.65, confidence: 0.75, tag: "work" },
  // 重要事件 / 生活变化
  { re: /(?:我最近|我刚|我昨天|我今天|这周我|下个月我|准备要)[：:，,\s]*([^，。！？!?,.、]{2,40})/, type: "event", importance: 0.6, confidence: 0.7, tag: "event" },
  // 关系
  { re: /(?:我有|我有个|我有一个|我对象|我女朋友|我男朋友|我老婆|我老公|我孩子|我爸妈|我家人)[：:，,\s]*([^，。！？!?,.、]+)/, type: "relationship", importance: 0.6, confidence: 0.7, tag: "relationship" },
  // 健康状态
  { re: /(?:我最近|我有点|我身体|我生病|我感冒|我失眠|我头疼|我胃疼)[：:，,\s]*([^，。！？!?,.、]+)/, type: "fact", importance: 0.55, confidence: 0.7, tag: "health" },
  // 目标 / 计划
  { re: /(?:我的目标|我打算|我计划|我想学|我要去|我准备去|我想去|打算去)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "project", importance: 0.6, confidence: 0.7, tag: "project" }
];
var MAX_MEMORY_LEN = 120;
var cleanContent = (raw) => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.length > MAX_MEMORY_LEN ? `${trimmed.slice(0, MAX_MEMORY_LEN)}\u2026` : trimmed;
};
var defaultDecayDays = (type) => {
  switch (type) {
    case "core":
      return null;
    // 显式"记住X" → 永久
    case "fact":
      return 365;
    // 名字/职业/住址等稳定事实 → 长期
    case "relationship":
      return 180;
    // 家人/朋友/对象 → 长
    case "preference":
      return 90;
    // 随口喜欢/不喜欢 → 3 个月淡化
    case "project":
      return 60;
    // 正在做的事/学习 → 2 个月
    case "event":
      return 30;
  }
};
var guessDecay = (type, tag) => {
  if (tag === "explicit") return null;
  if (tag === "identity") return 365;
  return defaultDecayDays(type);
};
var extractMemories = (text) => {
  const now = Date.now();
  const items = [];
  for (const rule of EXTRACT_RULES) {
    const m = text.match(rule.re);
    if (!m) continue;
    const content = cleanContent(`${rule.label ?? ""}${m[1] ?? ""}`);
    if (!content) continue;
    items.push({
      id: uid(),
      content,
      type: rule.type,
      importance: rule.importance,
      confidence: rule.confidence,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: 0,
      accessCount: 0,
      tags: rule.tag ? [rule.tag] : [],
      decayDays: guessDecay(rule.type, rule.tag)
    });
  }
  return dedupeByContent(items);
};
var normalizeContent = (s) => String(s ?? "").toLowerCase().replace(/[，。！？!?,.、\s"'“”‘’]+/g, "");
var TRAILING_PARTICLES = /(?:啊|呀|哦|哟|啦|呢|吧|嘛|哈|喔|噢)+$/;
var normalizeForCompare = (s) => {
  let p = normalizeContent(s);
  for (let i = 0; i < 4 && p; i += 1) {
    const n = p.replace(TRAILING_PARTICLES, "");
    if (n === p) break;
    p = n;
  }
  return p;
};
var NEAR_DUP_DICE = 0.5;
var bigramCounts = (s) => {
  const m = /* @__PURE__ */ new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  let n = 0;
  for (const v of m.values()) n += v;
  return { m, n };
};
var contentSimilarity = (a, b) => {
  const na = normalizeContent(a);
  const nb = normalizeContent(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (Math.min(na.length, nb.length) < 4) return 0;
  const A = bigramCounts(na);
  const B = bigramCounts(nb);
  if (!A.n || !B.n) return 0;
  let inter = 0;
  for (const [g, n] of B.m) {
    const x = A.m.get(g);
    if (x) inter += Math.min(x, n);
  }
  return 2 * inter / (A.n + B.n);
};
var isSameContent = (a, b) => {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
};
var dedupeByContent = (items) => {
  const kept = [];
  for (const item of items) {
    const dup = kept.some((k) => isSameContent(k.content, item.content));
    if (!dup) kept.push(item);
  }
  return kept;
};
var findMergeTarget = (candidates, content) => candidates.findIndex((prev) => prev.content && isSameContent(prev.content, content));
var mergeMemories = (newItems, existing) => {
  const added = [];
  const updated = [];
  const pool = [...existing.filter(isActiveMemory)];
  const now = Date.now();
  for (const item of newItems) {
    const idx = findMergeTarget(pool, item.content);
    if (idx < 0) {
      added.push(item);
      continue;
    }
    const prev = pool[idx];
    pool.splice(idx, 1);
    const mergedContent = prev.content.length < item.content.length ? item.content : prev.content;
    const decayDays = prev.decayDays === null || item.decayDays === null ? null : prev.decayDays;
    const mergedImportance = Math.max(prev.importance, item.importance);
    const mergedConfidence = Math.max(prev.confidence, item.confidence);
    const mergedTags = [.../* @__PURE__ */ new Set([...prev.tags ?? [], ...item.tags ?? []])];
    const noChange = prev.content === mergedContent && prev.importance === mergedImportance && prev.confidence === mergedConfidence && prev.decayDays === decayDays && mergedTags.length === (prev.tags ?? []).length && mergedTags.every((t) => (prev.tags ?? []).includes(t));
    if (noChange) continue;
    updated.push({
      ...prev,
      content: mergedContent,
      importance: mergedImportance,
      confidence: mergedConfidence,
      updatedAt: now,
      tags: mergedTags,
      decayDays
    });
  }
  return { added, updated };
};
var CHITCHAT_RE = /^(?:在吗|在不在|你好|您好|hi|hello|hey|哈哈+|嘿嘿|呵呵|嗯+|哦+|噢+|好的|好呀|收到|谢谢|多谢|晚安|早安|早上好|晚上好|午安|再见|拜拜|没事|随便|不知道|是吗|真的吗|草|靠|呃+|额+)[\s!！。.~～?？]*$/i;
var shouldSkipLlmExtract = (text) => {
  const t = text.trim();
  if (t.length < 4) return true;
  return CHITCHAT_RE.test(t);
};
var pad2 = (n) => `${n}`.padStart(2, "0");
var localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
var buildLlmExtractPrompt = (userText, recentContext = []) => {
  const ctx = recentContext.length ? recentContext.map((m) => `${m.role === "user" ? "\u4E3B\u4EBA" : "Nori"}: ${String(m.content ?? "").replace(/\s+/g, " ").slice(0, 100)}`).join("\n") : "(\u65E0)";
  return [
    "\u4F60\u662F\u300C\u4E2A\u4EBA\u4FE1\u606F\u6574\u7406\u5458\u300D, \u8D1F\u8D23\u4ECE\u4E3B\u4EBA\u7684\u53D1\u8A00\u91CC\u6311\u51FA\u503C\u5F97\u957F\u671F\u8BB0\u4F4F\u7684\u4FE1\u606F, \u7EC4\u7EC7\u6210\u4E00\u6761\u6761\u72EC\u7ACB\u3001\u6E05\u6670\u7684\u4E8B\u5B9E\u3002",
    "",
    "\u3010\u8BE5\u8BB0\u7684\u4FE1\u606F\u3011",
    "1. \u4E2A\u4EBA\u504F\u597D: \u559C\u6B22/\u4E0D\u559C\u6B22\u7684\u4EBA\u3001\u98DF\u7269\u3001\u4E8B\u7269\u3001\u6D3B\u52A8\u3001\u5A31\u4E50;",
    "2. \u91CD\u8981\u4E2A\u4EBA\u4FE1\u606F: \u540D\u5B57\u3001\u79F0\u547C\u3001\u5E74\u9F84\u3001\u751F\u65E5\u3001\u5BB6\u4EBA\u670B\u53CB\u5BF9\u8C61\u7B49\u5173\u7CFB\u3001\u91CD\u8981\u65E5\u671F;",
    "3. \u8BA1\u5212\u4E0E\u6253\u7B97: \u8FD1\u671F\u8981\u505A\u7684\u4E8B\u3001\u76EE\u6807\u3001\u60F3\u53BB\u7684\u5730\u65B9\u3001\u7B54\u5E94\u8FC7\u7684\u4E8B;",
    "4. \u751F\u6D3B\u4E0E\u6D3B\u52A8\u4E60\u60EF: \u4F5C\u606F\u3001\u7231\u597D\u3001\u5E38\u505A\u7684\u4E8B\u3001\u56FA\u5B9A\u5B89\u6392;",
    "5. \u5065\u5EB7\u76F8\u5173: \u8EAB\u4F53\u72B6\u51B5\u3001\u996E\u98DF\u7981\u5FCC\u3001\u5065\u8EAB\u4E0E\u4F5C\u606F\u4E60\u60EF;",
    "6. \u5DE5\u4F5C\u4E0E\u5B66\u4E60: \u804C\u4E1A\u3001\u4E13\u4E1A\u3001\u5728\u5B66\u4EC0\u4E48\u3001\u5728\u505A\u4EC0\u4E48\u9879\u76EE;",
    "7. \u5176\u4ED6\u6742\u9879: \u5E38\u770B\u7684\u4E66\u5F71\u97F3\u3001\u5E38\u7528\u54C1\u724C\u3001\u5BA0\u7269\u3001\u4F4F\u5904\u7B49\u3002",
    "",
    "\u3010\u4E0D\u8981\u8BB0\u7684\u4FE1\u606F\u3011",
    "1. \u5BD2\u6684\u5BA2\u5957 (\u5728\u5417/\u4F60\u597D/\u8C22\u8C22/\u665A\u5B89);",
    "2. \u63D0\u95EE\u4E0E\u6307\u4F7F (\u5E2E\u6211\u67E5\u4E00\u4E0B/\u4F60\u89C9\u5F97\u5462/\u8BB2\u4E2A\u7B11\u8BDD);",
    "3. \u4E00\u65F6\u7684\u60C5\u7EEA\u548C\u5410\u69FD (\u4ECA\u5929\u597D\u7D2F/\u597D\u65E0\u804A/\u8FD9\u7535\u5F71\u771F\u96BE\u770B);",
    "4. \u4E00\u6B21\u6027\u7684\u7410\u788E\u5F53\u4E0B\u52A8\u4F5C (\u6211\u53BB\u5403\u996D\u4E86/\u521A\u6D17\u5B8C\u6FA1);",
    "5. Nori \u81EA\u5DF1\u8BF4\u8FC7\u7684\u8BDD \u2014\u2014 \u53EA\u8BB0\u4E3B\u4EBA\u7684\u4FE1\u606F, \u7EDD\u4E0D\u8BB0 AI \u7684\u8BDD\u3002",
    "",
    "\u3010\u8F93\u51FA\u8981\u6C42\u3011",
    '- \u6BCF\u6761 20 \u5B57\u4EE5\u5185, \u7528\u4E3B\u4EBA\u7684\u7B2C\u4E00\u4EBA\u79F0\u5B8C\u6574\u77ED\u53E5, \u5982"\u6211\u53EB\u5C0F\u660E""\u559C\u6B22\u4E0B\u96E8\u5929""\u6211\u5728\u51C6\u5907\u8003\u7814""\u4E0B\u5468\u8981\u4EA4\u8BBA\u6587";',
    "- \u4E00\u53E5\u8BDD\u91CC\u6709\u591A\u4E2A\u4FE1\u606F\u5C31\u62C6\u6210\u591A\u6761; \u5939\u5728\u60C5\u7EEA\u6216\u63D0\u95EE\u91CC\u7684\u4E8B\u5B9E\u4E5F\u8981\u62BD\u51FA\u6765;",
    "- type \u53D6 fact(\u8EAB\u4EFD\u4E8B\u5B9E) / preference(\u504F\u597D) / project(\u957F\u671F\u5728\u505A\u7684\u4E8B\u6216\u76EE\u6807) / event(\u8FD1\u671F\u4E8B\u4EF6) / relationship(\u5173\u7CFB) / core(\u4E3B\u4EBA\u660E\u786E\u8981\u6C42\u8BB0\u4F4F\u7684) \u4E4B\u4E00;",
    "- importance 0~1 (\u8D8A\u957F\u671F\u8D8A\u91CD\u8981\u8D8A\u9AD8), confidence 0~1;",
    "- \u6309\u4E3B\u4EBA\u8BF4\u8BDD\u7684\u8BED\u8A00\u8BB0\u5F55;",
    '- \u53EA\u8F93\u51FA JSON, \u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u3002\u683C\u5F0F {"facts":[{"content":"...","type":"fact","importance":0.6,"confidence":0.9}]}; \u6CA1\u6709\u53EF\u8BB0\u7684\u5C31\u8F93\u51FA {"facts":[]}\u3002',
    "",
    "\u3010\u793A\u4F8B\u3011",
    '\u4E3B\u4EBA: \u5728\u5417 \u2192 {"facts":[]}',
    '\u4E3B\u4EBA: \u54C8\u54C8\u4ECA\u5929\u5929\u6C14\u4E0D\u9519 \u2192 {"facts":[]}',
    '\u4E3B\u4EBA: \u4F60\u89C9\u5F97\u6211\u8BE5\u5B66\u4EC0\u4E48 \u2192 {"facts":[]}',
    '\u4E3B\u4EBA: \u6211\u53EB\u5C0F\u660E, \u662F\u4E2A\u7A0B\u5E8F\u5458 \u2192 {"facts":[{"content":"\u6211\u53EB\u5C0F\u660E","type":"fact","importance":0.9,"confidence":0.95},{"content":"\u6211\u662F\u7A0B\u5E8F\u5458","type":"fact","importance":0.75,"confidence":0.9}]}',
    '\u4E3B\u4EBA: \u4ECA\u5929\u597D\u7D2F\u554A, \u4E0D\u8FC7\u4E0B\u5468\u8981\u4EA4\u8BBA\u6587\u4E86 \u2192 {"facts":[{"content":"\u6211\u4E0B\u5468\u8981\u4EA4\u8BBA\u6587","type":"event","importance":0.65,"confidence":0.9}]}',
    '\u4E3B\u4EBA: \u6211\u6700\u559C\u6B22\u7684\u90A3\u90E8\u7535\u5F71\u662F\u661F\u9645\u7A7F\u8D8A, \u4F60\u770B\u8FC7\u5417 \u2192 {"facts":[{"content":"\u6211\u6700\u559C\u6B22\u7684\u7535\u5F71\u662F\u661F\u9645\u7A7F\u8D8A","type":"preference","importance":0.6,"confidence":0.9}]}',
    '\u4E3B\u4EBA: \u6211\u6700\u8FD1\u5728\u51C6\u5907\u8003\u7814, \u6211\u5988\u8BA9\u6211\u522B\u71AC\u591C \u2192 {"facts":[{"content":"\u6211\u5728\u51C6\u5907\u8003\u7814","type":"project","importance":0.75,"confidence":0.9},{"content":"\u6211\u5988\u8BA9\u6211\u522B\u71AC\u591C","type":"relationship","importance":0.5,"confidence":0.8}]}',
    "",
    `\u4ECA\u5929\u65E5\u671F: ${localDateStr(/* @__PURE__ */ new Date())} (\u7528\u4E8E\u6362\u7B97"\u4E0B\u5468\u4E09""\u660E\u5929"\u8FD9\u7C7B\u76F8\u5BF9\u65F6\u95F4)`,
    "",
    "\u3010\u6700\u8FD1\u5BF9\u8BDD (\u53EA\u7528\u4E8E\u7406\u89E3\u6307\u4EE3, \u4E0D\u8981\u4ECE Nori \u7684\u8BDD\u91CC\u63D0\u53D6\u4FE1\u606F)\u3011",
    ctx,
    "",
    "\u3010\u4E3B\u4EBA\u8FD9\u53E5\u8BDD\u3011",
    userText
  ].join("\n");
};
var clamp01 = (n) => Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
var buildLlmRelevancePrompt = (query, candidates) => [
  "\u4F60\u662F\u8BB0\u5FC6\u68C0\u7D22\u52A9\u624B\u3002\u6839\u636E\u7528\u6237\u5F53\u524D\u53D1\u8A00, \u4ECE\u8BB0\u5FC6\u5217\u8868\u91CC\u9009\u51FA**\u771F\u6B63\u76F8\u5173**\u7684\u82E5\u5E72\u6761, \u53EA\u8F93\u51FA JSON \u6570\u7EC4\u3002",
  "\u5224\u65AD\u6807\u51C6:",
  "1. \u8BB0\u5FC6\u80FD\u5E2E\u52A9\u56DE\u7B54/\u7406\u89E3\u5F53\u524D\u53D1\u8A00, \u6216\u7528\u6237\u660E\u663E\u5728\u6307\u4EE3\u4E4B\u524D\u8BF4\u8FC7\u7684\u4E8B;",
  "2. \u540C\u4E49\u8868\u8FBE\u4E5F\u7B97\u76F8\u5173 (\u5982\u7528\u6237\u8BF4'\u90A3\u4E2A\u6E38\u620F' \u8BB0\u5FC6\u662F'\u559C\u6B22\u73A9\u539F\u795E' \u4E5F\u7B97\u547D\u4E2D);",
  "3. \u660E\u663E\u65E0\u5173\u7684\u4E0D\u8981\u9009; \u6CA1\u6709\u76F8\u5173\u7684\u5C31\u8F93\u51FA []\u3002",
  '\u683C\u5F0F: [{"id":"\u8BB0\u5FC6id","reason":"\u4E00\u53E5\u8BDD\u7406\u7531"}], \u4E0D\u8981\u8F93\u51FA\u5176\u4ED6\u4EFB\u4F55\u6587\u5B57\u3002',
  "---\u7528\u6237\u53D1\u8A00---",
  query.slice(0, 200),
  "---\u8BB0\u5FC6\u5217\u8868---",
  candidates.map((c) => `${c.id}: ${c.content.slice(0, 100)}`).join("\n")
].join("\n");
var parseLlmRelevance = (raw, validIds) => {
  let text = raw.trim();
  const FENCE = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (FENCE) text = FENCE[1].trim();
  const START = text.indexOf("[");
  const END = text.lastIndexOf("]");
  if (START === -1 || END <= START) return [];
  try {
    const arr = JSON.parse(text.slice(START, END + 1));
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const id = String(item.id ?? "");
      if (id && validIds.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
};
var parseLlmMemories = (raw) => {
  let text = String(raw ?? "").trim();
  const FENCE = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (FENCE) text = FENCE[1].trim();
  let arr = null;
  const oStart = text.indexOf("{");
  const oEnd = text.lastIndexOf("}");
  if (oStart !== -1 && oEnd > oStart) {
    try {
      const obj = JSON.parse(text.slice(oStart, oEnd + 1));
      const candidate = obj.facts ?? obj.memories ?? obj.memory;
      if (Array.isArray(candidate)) arr = candidate;
    } catch {
    }
  }
  if (!Array.isArray(arr)) {
    const aStart = text.indexOf("[");
    const aEnd = text.lastIndexOf("]");
    if (aStart !== -1 && aEnd > aStart) {
      try {
        const candidate = JSON.parse(text.slice(aStart, aEnd + 1));
        if (Array.isArray(candidate)) arr = candidate;
      } catch {
      }
    }
  }
  if (!Array.isArray(arr)) return [];
  const TYPES = ["fact", "preference", "project", "event", "relationship", "core"];
  const now = Date.now();
  const items = [];
  for (const item of arr) {
    const record = typeof item === "string" ? { content: item } : item && typeof item === "object" ? item : null;
    if (!record) continue;
    const content = String(record.content ?? record.text ?? "").trim().slice(0, MAX_MEMORY_LEN);
    if (!content) continue;
    const type = TYPES.includes(String(record.type ?? "")) ? String(record.type) : "fact";
    items.push({
      id: uid(),
      content,
      type,
      importance: clamp01(Number(record.importance ?? 0.6)),
      confidence: clamp01(Number(record.confidence ?? 0.8)),
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: 0,
      accessCount: 0,
      tags: ["llm"],
      decayDays: defaultDecayDays(type)
    });
  }
  return dedupeByContent(items);
};
var buildLlmMemoryDecisionPrompt = (facts, existing) => [
  "\u4F60\u662F\u8BB0\u5FC6\u5E93\u7BA1\u7406\u5458\u3002\u628A\u300C\u65B0\u63D0\u53D6\u7684\u4E8B\u5B9E\u300D\u4E0E\u300C\u8BB0\u5FC6\u5E93\u91CC\u5DF2\u6709\u7684\u76F8\u4F3C\u8BB0\u5FC6\u300D\u9010\u6761\u5BF9\u7167, \u51B3\u5B9A\u600E\u4E48\u5904\u7406\u3002",
  "",
  "\u56DB\u79CD\u64CD\u4F5C:",
  "- ADD: \u8FD9\u662F\u65B0\u4FE1\u606F, \u5E93\u91CC\u6CA1\u6709 \u2192 \u65B0\u589E;",
  "- UPDATE: \u5E93\u91CC\u5DF2\u6709\u540C\u4E00\u4EF6\u4E8B, \u4F46\u65B0\u4E8B\u5B9E\u4FE1\u606F\u66F4\u5168/\u66F4\u51C6 \u2192 \u7528\u65B0\u4E8B\u5B9E\u6539\u5199\u90A3\u6761\u65E7\u8BB0\u5FC6;",
  '- DELETE: \u65B0\u4E8B\u5B9E\u4E0E\u5E93\u91CC\u65E7\u8BB0\u5FC6**\u77DB\u76FE/\u5DF2\u53D6\u4EE3** (\u5982\u65E7"\u559C\u6B22\u4E0B\u96E8\u5929" vs \u65B0"\u4E0D\u559C\u6B22\u4E0B\u96E8\u5929", \u65E7"\u6211\u53EB\u5C0F\u660E" vs \u65B0"\u6211\u53EB\u5C0F\u521A") \u2192 \u628A\u65E7\u8BB0\u5FC6\u4F5C\u5E9F;',
  "  \u4F5C\u5E9F\u4E0D\u7B49\u4E8E\u62B9\u6389: \u65E7\u8BB0\u5FC6\u4F1A\u8FDB\u300C\u5386\u53F2\u300D\u5E76\u53EF\u88AB\u8FD8\u539F, \u6240\u4EE5**\u8BE5\u7528\u5C31\u7528**, \u4E0D\u8981\u56E0\u4E3A\u820D\u4E0D\u5F97\u800C\u7559\u7740\u77DB\u76FE\u7684\u4E24\u6761;",
  "- NONE: \u5E93\u91CC\u5DF2\u6709**\u540C\u4E00\u4EF6\u4E8B** (\u65B0\u4E8B\u5B9E\u4E0E\u5B83\u8868\u8FF0\u4E0D\u540C\u4F46\u4FE1\u606F\u76F8\u540C, \u6216\u65B0\u4E8B\u5B9E\u53EA\u662F\u5B83\u7684\u4E00\u90E8\u5206) \u2192 \u4E0D\u6539\u52A8;",
  "  \u8FD9\u4E5F\u610F\u5473\u7740\u8FD9\u6761\u65B0\u4E8B\u5B9E**\u4E0D\u9700\u8981\u518D\u5355\u72EC\u5B58\u4E00\u904D** \u2014\u2014 \u4E0D\u8981\u56E0\u4E3A\u63AA\u8F9E\u4E0D\u540C\u5C31\u628A\u540C\u4E00\u4EF6\u4E8B\u5F53\u6210\u65B0\u4FE1\u606F;",
  "",
  "\u89C4\u5219:",
  '1. \u53EA\u5904\u7406"\u540C\u4E00\u4EF6\u4E8B"; \u65E0\u5173\u7684\u65E7\u8BB0\u5FC6\u4E0D\u8981\u51FA\u73B0\u5728\u8F93\u51FA\u91CC;',
  "2. UPDATE/DELETE \u5FC5\u987B\u4F7F\u7528\u4E0B\u9762\u300C\u5DF2\u6709\u8BB0\u5FC6\u300D\u4E2D\u7ED9\u51FA\u7684 id, \u4E0D\u8981\u7F16\u9020 id;",
  '3. ADD \u7684 id \u7EDF\u4E00\u5199 "new";',
  "4. text \u5199\u8FD9\u4EF6\u4E8B\u6700\u7EC8\u5E94\u5B58\u7684\u5185\u5BB9 (20 \u5B57\u5185\u3001\u4E3B\u4EBA\u7B2C\u4E00\u4EBA\u79F0\u77ED\u53E5); \u540C\u4E49\u6539\u5199\u65F6\u4F18\u5148\u4FDD\u7559\u4FE1\u606F\u66F4\u5168\u7684\u7248\u672C;",
  "5. UPDATE \u7684 text \u8BF7\u76F4\u63A5\u91C7\u7528\u5BF9\u5E94\u65B0\u4E8B\u5B9E\u7684\u539F\u63AA\u8F9E (\u53EA\u505A\u8F7B\u5FAE\u987A\u53E5), \u4E0D\u8981\u53E6\u8D77\u4E00\u5957\u8BF4\u6CD5 \u2014\u2014 \u5426\u5219\u540C\u4E00\u4EF6\u4E8B\u4F1A\u5728\u5E93\u91CC\u7559\u4E0B\u4E24\u79CD\u5199\u6CD5;",
  '6. \u53EA\u8F93\u51FA JSON, \u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u6587\u5B57\u3002\u683C\u5F0F: {"memory":[{"id":"...","text":"...","event":"ADD"}]}',
  "7. DELETE \u7684\u95E8\u69DB\u662F**\u4FE1\u606F\u77DB\u76FE**(\u4E24\u6761\u4E0D\u80FD\u540C\u65F6\u6210\u7ACB), \u62FF\u4E0D\u51C6\u5C31\u9009 NONE \u2014\u2014 \u4F5C\u5E9F\u867D\u53EF\u8FD8\u539F,",
  "   \u4F46\u6BCF\u6B21\u8BEF\u5224\u90FD\u8981\u4E3B\u4EBA\u81EA\u5DF1\u52A8\u624B\u6536\u62FE; \u5C24\u5176**\u540D\u5B57/\u8EAB\u4EFD/\u4F4F\u5740**\u8FD9\u7C7B\u9AD8\u91CD\u8981\u8BB0\u5FC6, \u53EA\u6709\u660E\u786E\u6539\u53E3\u624D DELETE\u3002",
  "",
  "\u3010\u65B0\u63D0\u53D6\u7684\u4E8B\u5B9E\u3011",
  facts.map((f) => `- ${f.content} (${f.type})`).join("\n") || "(\u7A7A)",
  "",
  "\u3010\u5DF2\u6709\u8BB0\u5FC6 (\u53EA\u80FD\u5F15\u7528\u8FD9\u4E9B id)\u3011",
  existing.length ? existing.map((e) => `${e.id} | ${e.content} (${e.type})`).join("\n") : "(\u65E0)"
].join("\n");
var parseLlmMemoryDecision = (raw) => {
  let text = String(raw ?? "").trim();
  const FENCE = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (FENCE) text = FENCE[1].trim();
  let arr = null;
  const oStart = text.indexOf("{");
  const oEnd = text.lastIndexOf("}");
  if (oStart !== -1 && oEnd > oStart) {
    try {
      const obj = JSON.parse(text.slice(oStart, oEnd + 1));
      const candidate = obj.memory ?? obj.facts ?? obj.memories ?? obj.decisions;
      if (Array.isArray(candidate)) arr = candidate;
    } catch {
    }
  }
  if (!Array.isArray(arr)) {
    const aStart = text.indexOf("[");
    const aEnd = text.lastIndexOf("]");
    if (aStart !== -1 && aEnd > aStart) {
      try {
        const candidate = JSON.parse(text.slice(aStart, aEnd + 1));
        if (Array.isArray(candidate)) arr = candidate;
      } catch {
      }
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const r = item;
    const id = String(r.id ?? "").trim();
    if (!id) continue;
    const rawEvent = String(r.event ?? r.operation ?? r.action ?? "").trim().toUpperCase();
    const event = rawEvent === "ADD" || rawEvent === "UPDATE" || rawEvent === "DELETE" || rawEvent === "NONE" ? rawEvent : "NONE";
    const content = String(r.text ?? r.content ?? "").trim().slice(0, MAX_MEMORY_LEN);
    out.push({ id, text: content, event });
  }
  return out;
};
var buildLlmAnalyzePrompt = (userText, reply, expressionNames, motionNames = []) => [
  "\u4F60\u662F Nori \u7684\u53CD\u5E94\u52A9\u624B\u3002\u6839\u636E\u4E0B\u9762\u7684\u5BF9\u8BDD\u5B8C\u6210\u4E09\u4EF6\u4E8B\uFF0C\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u8F93\u51FA\u5176\u4ED6\u6587\u5B57\uFF1A",
  "1. emotion: \u4ECE Nori \u7684\u56DE\u590D\u4E2D\u9009\u62E9\u6700\u8D34\u5207\u7684\u60C5\u7EEA\u8868\u60C5\uFF0C\u53EA\u80FD\u6765\u81EA\u53EF\u7528\u8868\u60C5\u5217\u8868\uFF1B\u90FD\u4E0D\u5408\u9002\u8F93\u51FA null\uFF1B",
  `\u53EF\u7528\u8868\u60C5: ${expressionNames.join("\u3001") || "\uFF08\u65E0\uFF09"}`,
  "2. motion: \u4ECE\u53EF\u7528\u52A8\u4F5C\u5217\u8868\u4E2D\u9009\u62E9\u4E00\u4E2A\u4E0E\u60C5\u7EEA/\u8BED\u6C14\u6700\u642D\u7684\u52A8\u4F5C\uFF1B\u90FD\u4E0D\u5408\u9002\u8F93\u51FA null\uFF1B",
  `\u53EF\u7528\u52A8\u4F5C: ${motionNames.join("\u3001") || "\uFF08\u65E0\uFF09"}`,
  "3. memories: \u4ECE\u7528\u6237\u7684\u53D1\u8A00\u4E2D\u63D0\u53D6\u503C\u5F97\u957F\u671F\u8BB0\u4F4F\u7684\u4FE1\u606F\uFF08\u8EAB\u4EFD/\u504F\u597D/\u6B63\u5728\u505A\u7684\u4E8B/\u91CD\u8981\u4E8B\u5B9E/\u627F\u8BFA\uFF09\uFF0C\u6BCF\u6761 20 \u5B57\u5185\u3001\u7B2C\u4E09\u4EBA\u79F0\u9648\u8FF0\uFF0C\u7C7B\u578B fact/preference/project/event/relationship/core\uFF0Cimportance 0~1\u3001confidence 0~1\uFF1B\u6CA1\u6709\u8F93\u51FA\u7A7A\u6570\u7EC4\u3002",
  '\u683C\u5F0F: {"emotion":"happy","motion":"jump","memories":[{"content":"...","type":"preference","importance":0.7,"confidence":0.8}]}',
  "---\u7528\u6237\u53D1\u8A00---",
  userText.slice(0, 300),
  "---Nori\u56DE\u590D---",
  reply.slice(0, 500)
].join("\n");
var parseLlmAnalyze = (raw) => {
  let text = raw.trim();
  const FENCE = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (FENCE) text = FENCE[1].trim();
  const START = text.indexOf("{");
  const END = text.lastIndexOf("}");
  if (START === -1 || END <= START) return { emotion: null, motion: null, memories: [] };
  let obj;
  try {
    obj = JSON.parse(text.slice(START, END + 1));
  } catch {
    return { emotion: null, motion: null, memories: [] };
  }
  if (!obj || typeof obj !== "object") return { emotion: null, motion: null, memories: [] };
  const record = obj;
  let emotion = null;
  const rawEmotion = String(record.emotion ?? "").trim().toLowerCase();
  if (rawEmotion && rawEmotion !== "null" && rawEmotion !== "none" && rawEmotion !== "\u65E0") {
    emotion = rawEmotion;
  }
  let motion = null;
  const rawMotion = String(record.motion ?? "").trim().toLowerCase();
  if (rawMotion && rawMotion !== "null" && rawMotion !== "none" && rawMotion !== "\u65E0") {
    motion = rawMotion;
  }
  const memories = parseLlmMemories(JSON.stringify(record.memories ?? []));
  return { emotion, motion, memories };
};
var tokenCache = /* @__PURE__ */ new Map();
var tokenize = (s) => {
  const hit = tokenCache.get(s);
  if (hit) return hit;
  const lower = s.toLowerCase();
  const words = [];
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    if (w.length >= 2) words.push(w);
  }
  for (const m of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const seg = m[0];
    for (let i = 0; i < seg.length - 1; i++) words.push(seg.slice(i, i + 2));
  }
  const uniq = [...new Set(words)];
  if (tokenCache.size > 800) tokenCache.clear();
  tokenCache.set(s, uniq);
  return uniq;
};
var RECENCY_HALF_LIFE = 30 * 24 * 3600 * 1e3;
var lastActiveAt = (item) => Math.max(item.lastAccessedAt || 0, item.updatedAt || 0, item.createdAt || 0);
var recencyScore = (item, now) => {
  const t = lastActiveAt(item);
  if (!t) return 0;
  return Math.pow(0.5, (now - t) / RECENCY_HALF_LIFE);
};
var decayFactor = (item, now) => {
  const days = item.decayDays;
  if (!days || days <= 0) return 1;
  const t = lastActiveAt(item);
  if (!t) return 1;
  const halfLifeMs = days * 24 * 3600 * 1e3;
  return Math.pow(0.5, (now - t) / halfLifeMs);
};
var overlapCount = (queryTokens, item) => {
  const contentTokens = tokenize(item.content);
  return queryTokens.filter((t) => contentTokens.includes(t)).length;
};
var scoreMemory = (queryTokens, item, now) => {
  if (!queryTokens.length) return 0;
  const overlap = overlapCount(queryTokens, item);
  const semantic = overlap / Math.sqrt(Math.max(queryTokens.length, 1));
  const base = semantic * 2 + item.importance * 0.6 + item.confidence * 0.2 + recencyScore(item, now) * 0.3 + Math.min(item.accessCount, 10) / 10 * 0.1;
  return base * decayFactor(item, now);
};
var recallMemories = (items, query, topK = 8) => {
  const now = Date.now();
  const tokens = tokenize(query);
  if (!tokens.length) return { hits: [], updated: [] };
  const scored = items.filter((item) => isActiveMemory(item)).filter((item) => overlapCount(tokens, item) > 0).map((item) => ({ item, score: scoreMemory(tokens, item, now) })).sort((a, b) => b.score - a.score);
  const hits = scored.filter((s) => s.score > 0.35).slice(0, topK).map((s) => s.item);
  if (!hits.length) return { hits: [], updated: [] };
  const hitIds = new Set(hits.map((h) => h.id));
  const updated = items.map(
    (item) => hitIds.has(item.id) ? { ...item, lastAccessedAt: now, accessCount: item.accessCount + 1 } : item
  );
  return { hits, updated };
};
var buildMemoryBlock = (hits, limit = 6) => {
  if (!hits.length) return "";
  const lines = hits.slice(0, limit).map((item) => `- ${item.content}`);
  return `\u3010\u957F\u671F\u8BB0\u5FC6\u3011(\u6309\u9700\u53C2\u8003)
${lines.join("\n")}`;
};
var buildSummaryPrompt = (messages, withMemoryBlock = true, known = [], examples) => {
  const text = messages.map((m) => `${m.role === "user" ? "\u7528\u6237" : "Nori"}: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
  if (!withMemoryBlock) {
    return [
      "\u4F60\u662F\u8BB0\u5FC6\u538B\u7F29\u52A9\u624B\u3002\u628A\u4E0B\u9762\u8FD9\u6BB5\u5BF9\u8BDD\u5386\u53F2\u538B\u7F29\u6210\u4E00\u6BB5\u7B80\u77ED\u6458\u8981\uFF08100~200 \u5B57\uFF09\uFF0C\u53EA\u4FDD\u7559\uFF1A",
      "1. \u7528\u6237\u7684\u91CD\u8981\u8EAB\u4EFD\u4FE1\u606F\u3001\u504F\u597D\u3001\u6B63\u5728\u505A\u7684\u4E8B\uFF1B",
      "2. \u8BA8\u8BBA\u8FC7\u7684\u91CD\u8981\u4E3B\u9898\u548C\u7ED3\u8BBA\uFF1B",
      "3. \u627F\u8BFA\u8FC7\u7684\u4E8B\u60C5\u3002",
      "\u4E0D\u8981\u6DFB\u52A0\u539F\u6587\u6CA1\u6709\u7684\u4FE1\u606F\uFF0C\u4E0D\u8981\u5199\u6210\u5BF9\u8BDD\u5F62\u5F0F\uFF0C\u76F4\u63A5\u8F93\u51FA\u4E00\u6BB5\u8FDE\u8D2F\u7684\u7B2C\u4E09\u4EBA\u79F0\u6458\u8981\u3002",
      "\u6458\u8981\u5199\u5B8C\u540E\u53E6\u8D77\u4E00\u884C\uFF0C\u8F93\u51FA\u300C\u8BB0\u5FC6\u8981\u70B9\u300D\uFF1A\u53EA\u5217\u51FA\u8FD9\u6BB5\u5BF9\u8BDD\u91CC\u503C\u5F97\u957F\u671F\u8BB0\u4F4F\u7684\u7A33\u5B9A\u65B0\u4FE1\u606F\uFF08\u8EAB\u4EFD\u3001",
      "\u504F\u597D\u3001\u6B63\u5728\u505A\u7684\u4E8B\u3001\u627F\u8BFA\uFF09\uFF0C\u6BCF\u884C\u4E00\u6761\u3001\u7528\u7B2C\u4E00\u4EBA\u79F0\u77ED\u53E5\uFF08\u5982\u300C\u6211\u53EB\u5C0F\u660E\u300D\u300C\u6211\u559C\u6B22\u4E0B\u96E8\u5929\u300D\uFF09\uFF0C",
      "\u6700\u591A 5 \u6761\uFF1B\u82E5\u8FD9\u6BB5\u5BF9\u8BDD\u6CA1\u6709\u8FD9\u6837\u7684\u65B0\u4FE1\u606F\uFF0C\u5C31\u53EA\u8F93\u51FA\u6458\u8981\u672C\u8EAB\uFF0C\u4E0D\u8981\u5199\u8BB0\u5FC6\u8981\u70B9\u3002",
      "---\u5BF9\u8BDD\u5386\u53F2---",
      text
    ].join("\n");
  }
  const lines = [
    "\u4F60\u662F\u8BB0\u5FC6\u6574\u7406\u52A9\u624B\u3002\u8BFB\u5B8C\u4E0B\u9762\u8FD9\u6BB5\u5BF9\u8BDD\u5386\u53F2, \u8F93\u51FA\u4E24\u90E8\u5206\u3002",
    "\u3010\u7B2C\u4E00\u90E8\u5206: \u6458\u8981\u3011100~200 \u5B57\u7B2C\u4E09\u4EBA\u79F0\u53D9\u8FF0\uFF0C\u53EA\u4FDD\u7559\uFF1A\u7528\u6237\u7684\u91CD\u8981\u8EAB\u4EFD\u4FE1\u606F\u3001\u504F\u597D\u3001\u6B63\u5728\u505A\u7684\u4E8B\uFF1B",
    "\u8BA8\u8BBA\u8FC7\u7684\u91CD\u8981\u4E3B\u9898\u548C\u7ED3\u8BBA\uFF1B\u627F\u8BFA\u8FC7\u7684\u4E8B\u60C5\u3002\u4E0D\u8981\u6DFB\u52A0\u539F\u6587\u6CA1\u6709\u7684\u4FE1\u606F\uFF0C\u4E0D\u8981\u5199\u6210\u5BF9\u8BDD\u5F62\u5F0F\u3002",
    `\u3010\u7B2C\u4E8C\u90E8\u5206: \u8BB0\u5FC6\u5757\u3011\u53E6\u8D77\u4E00\u884C\u5199\u4E00\u884C ${MEM_SENTINEL}\uFF0C\u7D27\u63A5\u7740\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF1A`,
    '{"topic":"<8 \u5B57\u4EE5\u5185\u7684\u4E3B\u9898>","items":[{"content":"<\u7B2C\u4E00\u4EBA\u79F0\u77ED\u53E5, 20 \u5B57\u4EE5\u5185>","type":"fact|preference|project|event|relationship|core","importance":0~1}]}',
    "\u8BB0\u5FC6\u5757\u7684\u89C4\u5219\uFF1A",
    "1. \u5148\u5224\u65AD\u300C\u503C\u4E0D\u503C\u5F97\u957F\u671F\u8BB0\u4F4F\u300D\uFF0C\u6807\u51C6\u53EA\u6709\u4E00\u4E2A\uFF1A**\u4E09\u4E2A\u6708\u540E\u5B83\u8FD8\u6210\u7ACB\u3001\u5E76\u4E14\u4EE5\u540E\u4E3B\u4EBA\u63D0\u5230\u76F8\u5173\u7684\u4E8B\u65F6\u6211\u8FD8\u9700\u8981\u5B83\u5417\uFF1F**",
    "\u4E24\u95EE\u90FD\u662F\u300C\u662F\u300D\u624D\u5199\uFF1B\u53EA\u662F\u300C\u73B0\u5728\u6B63\u5728\u53D1\u751F\u300D\u7684\u4E8B\uFF0C\u4E00\u5F8B\u4E0D\u5199\u3002",
    "2. \u8BE5\u5199\u7684\u5C31\u8FD9\u51E0\u7C7B\uFF1A\u8EAB\u4EFD\u4E0E\u79F0\u547C\uFF1B\u7A33\u5B9A\u504F\u597D\uFF08\u559C\u6B22/\u4E0D\u559C\u6B22\uFF09\uFF1B\u957F\u671F\u5728\u505A\u7684\u4E8B\u4E0E\u76EE\u6807\uFF1B\u627F\u8BFA\u4E0E\u7EA6\u5B9A\uFF1B\u91CD\u8981\u5173\u7CFB\uFF1B",
    "\u5065\u5EB7\u4E0E\u7981\u5FCC\uFF1B\u4E3B\u4EBA\u660E\u786E\u8981\u6C42\u8BB0\u4F4F\u7684\uFF08type \u7528 core\uFF0Cimportance \u22650.9\uFF09\u3002",
    "3. \u4E0D\u8BE5\u5199\u7684\uFF08\u4E00\u6761\u90FD\u4E0D\u5199\uFF09\uFF1A\u5F53\u4E0B\u7684\u72B6\u6001\u4E0E\u8EAB\u4F53\u611F\u53D7\uFF08\u56F0\u4E86/\u997F\u4E86/\u7D2F\u4E86/\u5728\u5FD9/\u5728\u6D17\u6FA1\uFF09\uFF1B\u4E00\u6B21\u6027\u7684\u52A8\u4F5C\u4E0E\u6D41\u6C34\u8D26",
    "\uFF08\u4ECA\u5929\u5403\u4E86\u4EC0\u4E48\u3001\u4ECA\u5929\u4E0B\u96E8\u3001\u52A0\u73ED\u5230\u5341\u70B9\uFF09\uFF1B\u4E00\u65F6\u7684\u60C5\u7EEA\uFF08\u5F00\u5FC3/\u70E6\u8E81\uFF09\uFF1B\u5BD2\u6684\u3001\u73A9\u7B11\u4E0E\u63D0\u95EE\uFF1B\u8FD9\u6BB5\u5BF9\u8BDD\u300C\u53D1\u751F\u7684",
    "\u8FC7\u7A0B\u300D\u672C\u8EAB\uFF1B\u4EE5\u53CA\u5DF2\u7ECF\u8BB0\u4F4F\u7684\u5185\u5BB9\u6362\u4E2A\u8BF4\u6CD5\u518D\u8BF4\u4E00\u904D\u3002",
    "\u2014\u2014\u5224\u522B\u7A8D\u95E8\uFF1A**\u4E00\u6B21\u6027\u7684\u4E0D\u5199\uFF0C\u4E00\u8D2F\u7684\u624D\u5199\u3002** \u4F8B\uFF1A\u300C\u6211\u4ECA\u5929\u52A0\u73ED\u5230\u5341\u70B9\u300D\u2192\u4E0D\u5199\uFF1B\u300C\u6211\u6700\u8FD1\u4E00\u76F4\u5728\u52A0\u73ED\u300D\u2192\u5199\u3002",
    "4. \u793A\u4F8B \u2014\u2014 \u5199\uFF1A\u300C\u6211\u53EB\u5C0F\u6867\u300D\u300C\u6211\u4E0D\u559C\u6B22\u4E0B\u96E8\u5929\u300D\u300C\u6211\u6700\u8FD1\u5728\u51C6\u5907\u8003\u7814\u300D\u300C\u8BB0\u4F4F\uFF1A\u6211\u7684\u751F\u65E5\u662F 3 \u6708 2 \u53F7\u300D\uFF1B",
    "\u4E0D\u5199\uFF1A\u300C\u6211\u6709\u70B9\u56F0\uFF0C\u51C6\u5907\u53BB\u7761\u89C9\u300D\u300C\u4ECA\u5929\u4E0B\u96E8\u4E86\u300D\u300C\u6211\u8FD8\u6CA1\u5403\u996D\u300D\u3002",
    "5. importance \u22650.5 \u624D\u8F93\u51FA\u8FD9\u6761\uFF080.9+ \u8EAB\u4EFD\u6216\u660E\u786E\u8981\u6C42\uFF1B0.7 \u7A33\u5B9A\u504F\u597D/\u957F\u671F\u9879\u76EE/\u91CD\u8981\u5173\u7CFB\uFF1B0.5 \u4E00\u822C\u4E8B\u5B9E\uFF09\u3002",
    "**\u4F4E\u4E8E 0.5 \u7684\u76F4\u63A5\u522B\u5199** \u2014\u2014 \u5B81\u53EF\u8FD9\u6761\u4E0D\u5199\uFF0C\u4E5F\u4E0D\u8981\u4E3A\u4E86\u51D1\u6570\u5199\u4E0D\u91CD\u8981\u7684\u4E8B\u3002",
    "6. \u4E3B\u4EBA\u4E2D\u9014\u6539\u53E3\u65F6\uFF0C\u53EA\u8BB0\u6700\u7EC8\u8BF4\u6CD5\uFF0C\u4E0D\u8981\u8BB0\u5DF2\u88AB\u63A8\u7FFB\u7684\u90A3\u4E2A\uFF08\u4F8B\uFF1A\u5148\u8BF4\u300C\u6211\u60F3\u53BB\u4E70\u51B0\u6FC0\u51CC\u300D\uFF0C",
    "\u540E\u9762\u8BF4\u300C\u7A81\u7136\u4E0D\u60F3\u4E70\u4E86\u300D\u2192 \u53EA\u8BB0\u300C\u6211\u4E0D\u60F3\u4E70\u51B0\u6FC0\u51CC\u4E86\u300D\uFF09\uFF1B\u7701\u7565\u5BBE\u8BED\u7684\u53E5\u5B50\u8981\u7ED3\u5408\u4E0A\u4E0B\u6587\u8865\u5168\uFF1B",
    "7. **\u540C\u4E00\u4EF6\u4E8B\u53EA\u5199\u4E00\u6761**\uFF1A\u8BF4\u6CD5\u4E0D\u540C\u4F46\u6307\u7684\u662F\u540C\u4E00\u4EF6\u4E8B\u7684\uFF0C\u4E5F\u53EA\u5199\u4E00\u6761\uFF08\u4F8B\uFF1A\u300C\u6211\uFF08\u5C0F\u6867\uFF09\u60F3\u4E70\u9E21\u86CB\u300D",
    "\u4E0E\u300C\u6211\u60F3\u4E70\u9E21\u86CB\u300D\u662F\u540C\u4E00\u6761\uFF0C\u53EA\u5199\u540E\u8005\u90A3\u79CD\u81EA\u7136\u8BF4\u6CD5\uFF09\uFF1B",
    "8. \u4E0A\u9762\u3010\u5DF2\u7ECF\u8BB0\u4F4F\u7684\u5185\u5BB9\u3011\u91CC\u5DF2\u6709\u7684\uFF0C\u82E5\u8FD9\u6BB5\u5BF9\u8BDD**\u6CA1\u6709\u6539\u53D8\u5B83**\uFF0C\u5C31\u4E0D\u8981\u518D\u5199\u4E00\u904D\uFF1B",
    "\u4F46\u82E5\u8FD9\u6BB5\u5BF9\u8BDD**\u6539\u53D8\u6216\u8865\u5145**\u4E86\u5B83\uFF08\u6539\u53E3\u3001\u7EA0\u6B63\u3001\u8865\u5145\u7EC6\u8282\uFF09\uFF0C**\u5FC5\u987B**\u6309\u6700\u7EC8\u72B6\u6001\u5199\u51FA\u6765 \u2014\u2014",
    "\u8FD9\u624D\u662F\u6700\u65B0\u7684\u4E8B\u5B9E\uFF0C\u65E7\u8BF4\u6CD5\u4F1A\u88AB\u81EA\u52A8\u4F5C\u5E9F\u7559\u6863\uFF0C\u4E0D\u8981\u56E0\u4E3A\u300C\u5DF2\u7ECF\u8BB0\u8FC7\u300D\u5C31\u4E0D\u5199\uFF1B",
    "9. \u5185\u5BB9\u5199\u6210\u81EA\u7136\u7684\u7B2C\u4E00\u4EBA\u79F0\u77ED\u53E5\uFF0C**\u4E0D\u8981\u52A0\u62EC\u53F7\u6CE8\u91CA\u3001\u5F15\u53F7\u6216\u4E66\u540D\u53F7**\uFF0C\u6BCF\u6761 20 \u5B57\u4EE5\u5185\u3002",
    '10. \u6700\u591A 6 \u6761\uFF1B**\u5B81\u53EF 0 \u6761**\uFF08\u8F93\u51FA {"topic":"","items":[]}\uFF09\uFF0C\u4E5F\u4E0D\u8981\u5199\u4E0D\u503C\u5F97\u8BB0\u7684\u3002',
    "\u4E0D\u8981\u8F93\u51FA JSON \u4EE5\u5916\u7684\u89E3\u91CA\u6587\u5B57\u3002"
  ];
  if (examples && ((examples.pos?.length ?? 0) > 0 || (examples.neg?.length ?? 0) > 0)) {
    if (examples.pos?.length) {
      lines.push(
        "\u3010\u4E3B\u4EBA\u8BA4\u53EF\u7684\u8BB0\u6CD5\uFF08\u6765\u81EA\u4E3B\u4EBA\u81EA\u5DF1\u4FDD\u7559\u7684\u8BB0\u5FC6\uFF0C\u7167\u8FD9\u4E2A\u9897\u7C92\u5EA6\u8BB0\uFF09\u3011",
        `\u8BE5\u8BB0\uFF1A${examples.pos.join(" / ")}`
      );
    }
    if (examples.neg?.length) {
      lines.push(
        "\u3010\u4E3B\u4EBA\u5220\u6389\u8FC7\u7684\uFF08\u522B\u518D\u8BB0\u8FD9\u7C7B\uFF09\u3011",
        `\u4E0D\u8BE5\u8BB0\uFF1A${examples.neg.join(" / ")}`
      );
    }
    lines.push("\u203B \u4EE5\u4E0A\u53EA\u662F**\u98CE\u683C\u793A\u4F8B**\uFF0C\u4E0D\u662F\u8FD9\u6BB5\u5BF9\u8BDD\u7684\u5185\u5BB9\uFF0C\u4E0D\u8981\u628A\u5B83\u4EEC\u5199\u8FDB\u6458\u8981\u6216\u8BB0\u5FC6\u5757\u3002");
  }
  if (known.length) {
    lines.push(
      "\u3010\u5DF2\u7ECF\u8BB0\u4F4F\u7684\u5185\u5BB9\uFF08\u4EC5\u4F9B\u907F\u514D\u91CD\u590D\uFF0C**\u4E0D\u662F**\u4E0B\u9762\u8FD9\u6BB5\u5BF9\u8BDD\u7684\u4E00\u90E8\u5206\uFF0C\u4E0D\u8981\u5199\u8FDB\u6458\u8981\uFF09\u3011",
      ...known.map((k) => `- ${k}`)
    );
  }
  lines.push("---\u5BF9\u8BDD\u5386\u53F2---", text);
  return lines.join("\n");
};
var MEM_SENTINEL = "===MEM===";
var MEM_BLOCK_MAX_ITEMS = 6;
var TOPIC_MAX_CHARS = 16;
var extractJsonObject = (raw) => {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
};
var parseBlockOutput = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text) return { summaryText: "", topic: "", items: [] };
  const at = text.indexOf(MEM_SENTINEL);
  if (at < 0) return { summaryText: text, topic: "", items: [] };
  const head = text.slice(0, at).trim();
  const tail = text.slice(at + MEM_SENTINEL.length);
  const jsonText = extractJsonObject(tail);
  if (!jsonText) return { summaryText: head || text, topic: "", items: [] };
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { summaryText: head || text, topic: "", items: [] };
  }
  const obj = parsed && typeof parsed === "object" ? parsed : {};
  const topic = typeof obj.topic === "string" ? obj.topic.trim().slice(0, TOPIC_MAX_CHARS) : "";
  const seen = /* @__PURE__ */ new Set();
  const items = [];
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  for (const it of rawItems) {
    if (items.length >= MEM_BLOCK_MAX_ITEMS) break;
    if (!it || typeof it !== "object") continue;
    const rec = it;
    const content = String(rec.content ?? "").trim().slice(0, MAX_MEMORY_LEN);
    if (!content) continue;
    const key = normalizeForCompare(content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const t = String(rec.type ?? "").trim();
    items.push({
      content,
      type: MEMORY_TYPES.includes(t) ? t : "fact",
      importance: clamp01(Number(rec.importance))
    });
  }
  return { summaryText: head || text, topic, items };
};
var makeMemoryItem = (input) => {
  const content = String(input.content ?? "").trim().slice(0, MAX_MEMORY_LEN);
  const type = input.type && MEMORY_TYPES.includes(input.type) ? input.type : "fact";
  const now = Date.now();
  return {
    id: uid(),
    content,
    type,
    importance: clamp01(input.importance ?? 0.5),
    confidence: clamp01(input.confidence ?? 0.85),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: 0,
    accessCount: 0,
    tags: input.tags ?? [],
    decayDays: defaultDecayDays(type)
  };
};
var MAX_SUMMARY_CHARS = 600;
var softTruncate = (text, max) => {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const from = Math.floor(max * 0.6);
  let cut = -1;
  for (let i = head.length - 1; i >= from; i -= 1) {
    const ch = head[i];
    if (ch === "\u3002" || ch === "\uFF01" || ch === "\uFF1F" || ch === "!" || ch === "?" || ch === "\n" || ch === "\uFF1B" || ch === ";") {
      cut = i + 1;
      break;
    }
  }
  if (cut > 0) return head.slice(0, cut);
  return `${head}\u2026`;
};
var summaryIdFor = (batch, start) => {
  const first = batch[0]?.ts;
  const last = batch[batch.length - 1]?.ts;
  if (typeof first === "number" && typeof last === "number" && (first || last)) {
    return `sum-${first}-${last}`;
  }
  return `sum-${start}-${start + batch.length}`;
};
var blockIdFor = (batch, start) => `blk-${summaryIdFor(batch, start).slice(4)}`;
var makeSummary = (content, msgCount, id) => ({
  // id 可由调用方传区间指纹 (见 summaryIdFor): 双实例对同一区间并发总结时产出相同 id,
  // 落盘合并按 id 去重只留一份; 不传则退回随机 uid (兼容旧调用)
  id: id ?? uid(),
  content: softTruncate(content, MAX_SUMMARY_CHARS),
  createdAt: Date.now(),
  msgCount,
  tokenCount: Math.max(1, Math.ceil(content.length / 4))
});
var rangeOfSummary = (id) => {
  const m = /^sum-(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!(end > start)) return null;
  return { start, end };
};
var summariesOverlap = (a, b) => {
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  if (hi < lo) return false;
  const overlap = hi - lo + 1;
  const shorter = Math.min(a.end - a.start + 1, b.end - b.start + 1);
  if (shorter <= 0) return false;
  return overlap * 2 >= shorter;
};
var SUMMARY_BLOCK_BUDGET = 4e3;
var META_INJECT_LIMIT = 2;
var buildSummaryBlock = (summaries, opts = {}) => {
  const budget = opts.budget ?? SUMMARY_BLOCK_BUDGET;
  const metas = opts.metas ?? [];
  if (!summaries.length && !metas.length) return "";
  const head = `\u3010\u5386\u53F2\u603B\u7ED3\u3011(\u8F83\u65E9\u5BF9\u8BDD\u7684\u538B\u7F29\u8BB0\u5FC6)
`;
  const oldMetas = [...metas].sort((a, b) => a.createdAt - b.createdAt).slice(-META_INJECT_LIMIT);
  const newestFirst = [...summaries].sort((a, b) => b.createdAt - a.createdAt);
  const chosen = [];
  let used = head.length;
  for (const s of newestFirst) {
    const cost = s.content.length + 1;
    if (chosen.length && used + cost > budget) break;
    chosen.push(s);
    used += cost;
  }
  chosen.reverse();
  const lines = [...oldMetas.map((m) => m.content), ...chosen.map((s) => s.content)];
  if (!lines.length) return "";
  return head + lines.join("\n");
};
var MAX_MEMORIES = 300;
var PRUNE_AFTER = 60;
var STALE_DAYS = 30;
var EXPIRE_MULT = 3;
var pickExpiredMemories = (items, now = Date.now()) => items.filter((it) => {
  if (!isActiveMemory(it)) return false;
  const days = it.decayDays;
  if (!days || days <= 0) return false;
  if (it.accessCount >= 2) return false;
  const t = Math.max(it.lastAccessedAt, it.updatedAt, it.createdAt);
  if (!t) return false;
  const expireMs = days * EXPIRE_MULT * 24 * 3600 * 1e3;
  return now - t > expireMs;
});
var liveCount = (list) => list.filter(isActiveMemory).length;
var MIN_IMPORTANCE_KEEP = 0.7;
var isProtectedFromOverflow = (it) => it.type === "core" || (it.importance ?? 0) >= MIN_IMPORTANCE_KEEP || (it.tags ?? []).some((t) => t === "explicit" || t === "pinned" || t === "goal" || t === "identity");
var pruneMemories = (items) => {
  if (liveCount(items) <= PRUNE_AFTER) return [];
  let working = items;
  const now = Date.now();
  const staleMs = STALE_DAYS * 24 * 3600 * 1e3;
  const stale = working.filter(
    (it) => isActiveMemory(it) && // 作废/已收起的不用再判一次
    it.decayDays !== null && it.importance < 0.6 && now - Math.max(it.lastAccessedAt, it.createdAt) > staleMs && it.accessCount < 2
  );
  if (stale.length) {
    const staleIds = new Set(stale.map((s) => s.id));
    working = working.filter((it) => !staleIds.has(it.id));
  }
  if (liveCount(working) > MAX_MEMORIES) {
    const droppable = working.filter((it) => isActiveMemory(it) && it.decayDays !== null && !isProtectedFromOverflow(it));
    const scored = droppable.map((it) => ({
      it,
      score: (it.importance * 0.6 + recencyScore(it, now) * 0.3 + Math.min(it.accessCount, 10) / 10 * 0.1) * decayFactor(it, now)
    })).sort((a, b) => a.score - b.score);
    const overflow = liveCount(working) - MAX_MEMORIES;
    const drop = scored.slice(0, overflow).map((s) => s.it);
    const dropIds = new Set(drop.map((d) => d.id));
    working = working.filter((it) => !dropIds.has(it.id));
  }
  return items.filter((it) => !working.some((w) => w.id === it.id));
};
var COLLAPSE_MAX_MERGES = 50;
var newerOf = (x, y) => (x.updatedAt ?? x.createdAt) >= (y.updatedAt ?? y.createdAt) ? x : y;
var newerMemory = (a, b) => {
  const aU = Math.max(a.updatedAt ?? a.createdAt, a.invalidAt ?? 0, a.fadedAt ?? 0);
  const bU = Math.max(b.updatedAt ?? b.createdAt, b.invalidAt ?? 0, b.fadedAt ?? 0);
  if (aU !== bU) return aU > bU ? a : b;
  const aOff = !!(a.invalidAt || a.fadedAt);
  const bOff = !!(b.invalidAt || b.fadedAt);
  if (aOff !== bOff) return aOff ? a : b;
  if (a.lastAccessedAt !== b.lastAccessedAt) return a.lastAccessedAt > b.lastAccessedAt ? a : b;
  return a.accessCount >= b.accessCount ? a : b;
};
var COLLAPSE_SUBJECT_PREFIXES = ["\u6211\u7684\u540D\u5B57\u662F", "\u6211\u7684\u540D\u5B57\u53EB", "\u6211\u7684\u540D\u5B57", "\u6211\u53EB", "\u6211\u662F", "\u6211", "\u81EA\u5DF1", "\u4E3B\u4EBA"];
var sameNormalized = (x, y) => {
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return COLLAPSE_SUBJECT_PREFIXES.some((p) => long.startsWith(p) && long.slice(p.length) === short);
};
var collapseDuplicateMemories = (store, limit = COLLAPSE_MAX_MERGES) => {
  const list = store.memories;
  if (list.length < 2) return { removed: 0, dropped: [] };
  const kept = [];
  const norms = [];
  const gone = [];
  let removed = 0;
  for (const it of list) {
    const norm = normalizeForCompare(it?.content);
    if (!it || typeof it.content !== "string" || !isActiveMemory(it) || !norm) {
      kept.push(it);
      norms.push(norm);
      continue;
    }
    let hit = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (!isActiveMemory(kept[i])) continue;
      if (sameNormalized(norms[i], norm)) {
        hit = i;
        break;
      }
    }
    if (hit < 0 || removed >= limit) {
      kept.push(it);
      norms.push(norm);
      continue;
    }
    removed += 1;
    gone.push(it);
    const a = kept[hit];
    const merged = {
      ...a,
      content: it.content.length > a.content.length ? it.content : a.content,
      importance: Math.max(a.importance, it.importance),
      confidence: Math.max(a.confidence, it.confidence),
      decayDays: a.decayDays === null || it.decayDays === null ? null : a.decayDays,
      tags: [.../* @__PURE__ */ new Set([...a.tags ?? [], ...it.tags ?? []])],
      updatedAt: Date.now()
    };
    kept[hit] = merged;
    norms[hit] = merged.content === a.content ? norms[hit] : norm;
  }
  if (!removed) return { removed: 0, dropped: [] };
  store.memories = kept;
  return { removed, dropped: gone };
};
var mergeStores = (a, b) => {
  const tombs = /* @__PURE__ */ new Map();
  for (const t of [...a.tombstones ?? [], ...b.tombstones ?? []]) {
    if (!t || !t.id) continue;
    const at = Number(t.at) || 0;
    tombs.set(t.id, Math.max(tombs.get(t.id) ?? 0, at));
  }
  const mem = /* @__PURE__ */ new Map();
  for (const it of [...a.memories, ...b.memories]) {
    if (tombs.has(it.id)) continue;
    const old = mem.get(it.id);
    mem.set(it.id, old ? newerMemory(old, it) : it);
  }
  const sum = /* @__PURE__ */ new Map();
  for (const s of [...a.summaries, ...b.summaries]) {
    if (tombs.has(s.id)) continue;
    const old = sum.get(s.id);
    sum.set(s.id, old ? newerOf(old, s) : s);
  }
  const meta = /* @__PURE__ */ new Map();
  for (const m of [...a.meta ?? [], ...b.meta ?? []]) {
    if (tombs.has(m.id)) continue;
    const old = meta.get(m.id);
    meta.set(m.id, old ? newerOf(old, m) : m);
  }
  const blk = /* @__PURE__ */ new Map();
  for (const one of [...a.blocks ?? [], ...b.blocks ?? []]) {
    if (!one || typeof one.id !== "string" || !one.id) continue;
    if (tombs.has(one.id)) continue;
    const old = blk.get(one.id);
    if (!old) {
      blk.set(one.id, { ...one, itemIds: [...new Set(one.itemIds ?? [])] });
      continue;
    }
    blk.set(one.id, {
      ...newerOf(old, one),
      fromTs: Math.min(old.fromTs, one.fromTs),
      toTs: Math.max(old.toTs, one.toTs),
      msgCount: Math.max(old.msgCount ?? 0, one.msgCount ?? 0),
      itemIds: [.../* @__PURE__ */ new Set([...old.itemIds ?? [], ...one.itemIds ?? []])]
    });
  }
  for (const [id, one] of blk) {
    const kept = one.itemIds.filter((x) => mem.has(x));
    if (kept.length !== one.itemIds.length) blk.set(id, { ...one, itemIds: kept });
  }
  return {
    memories: [...mem.values()],
    summaries: [...sum.values()],
    summarizedMsgCount: Math.max(a.summarizedMsgCount, b.summarizedMsgCount),
    // 两个计数都**只增不减** (已摘要的总条数 / 已被裁掉的总条数) ⇒ 取 max 是对的;
    // 当前数组里的"下一个要摘要的下标"由两者相减得出 (见 trimmedMsgCount 注释)
    trimmedMsgCount: Math.max(a.trimmedMsgCount ?? 0, b.trimmedMsgCount ?? 0),
    tombstones: [...tombs.entries()].map(([id, at]) => ({ id, at })),
    // 示例集: 取 builtAt 较新的那份; **平局取本地(b)** —— 本地刚做过的摘除/清除不能被
    // 磁盘上那份还没更新的旧副本顶回去 (T34-M6 实测: 点了「清除示例」又被合并复活)
    exampleSet: (() => {
      const x = a.exampleSet;
      const y = b.exampleSet;
      if (!x) return y;
      if (!y) return x;
      return (x.builtAt ?? 0) > (y.builtAt ?? 0) ? x : y;
    })(),
    // 回收站: 按 id 并集, 同 id 取 deletedAt 较新的; 超出上限丢最旧的。
    // ⚠ 不按墓碑过滤 —— 回收站里的条目**本来就是被删的**(带墓碑), 过滤掉就没法还原了。
    deletedBin: (() => {
      const bin = /* @__PURE__ */ new Map();
      for (const it of [...a.deletedBin ?? [], ...b.deletedBin ?? []]) {
        if (!it || typeof it.id !== "string" || !it.id) continue;
        const old = bin.get(it.id);
        if (!old || (it.deletedAt ?? 0) > (old.deletedAt ?? 0)) bin.set(it.id, it);
      }
      return [...bin.values()].sort((x, y) => (y.deletedAt ?? 0) - (x.deletedAt ?? 0)).slice(0, MAX_DELETED_BIN);
    })(),
    meta: [...meta.values()],
    // 按区间正序, 让块视图的时间线顺序稳定 (Map 的插入序取决于 a/b 谁先, 不可依赖)
    blocks: [...blk.values()].sort((x, y) => x.fromTs - y.fromTs || x.id.localeCompare(y.id)),
    schemaVersion: MEMORY_SCHEMA_VERSION
  };
};
var capSummaries = (summaries, max) => {
  if (summaries.length <= max) return summaries;
  return [...summaries].sort((x, y) => y.createdAt - x.createdAt).slice(0, max);
};
var META_EXCERPT_CHARS = 80;
var MAX_METAS = 6;
var MAX_META_CHARS = 500;
var dayOf = (ts) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
var foldDroppedSummaries = (dropped) => {
  if (!dropped.length) return null;
  const asc = [...dropped].sort((a, b) => a.createdAt - b.createdAt);
  const from = dayOf(asc[0].createdAt);
  const to = dayOf(asc[asc.length - 1].createdAt);
  const parts = [];
  let used = 0;
  for (const s of asc) {
    const one = s.content.replace(/\s+/g, " ").trim().slice(0, META_EXCERPT_CHARS);
    if (!one) continue;
    if (used + one.length + 1 > MAX_META_CHARS - 40) break;
    parts.push(one);
    used += one.length + 1;
  }
  if (!parts.length) return null;
  const content = softTruncate(`\u3014${from}\u2013${to}\u3015${parts.join("\uFF1B")}`, MAX_META_CHARS);
  return {
    // 区间指纹: 双实例对同一批被丢弃摘要折叠时产出相同 id → 合并去重只留一份
    id: `meta-${asc[0].createdAt}-${asc[asc.length - 1].createdAt}`,
    content,
    createdAt: asc[0].createdAt,
    // 用最早的创建时间: 它在时间轴上位于这些摘要之前
    msgCount: asc.reduce((n, s) => n + (s.msgCount || 0), 0),
    tokenCount: Math.max(1, Math.ceil(content.length / 4))
  };
};

// src/services/memory/index.ts
var FILE = "memory.json";
var FILE_BAK = "memory.json.bak";
var FILE_V1 = "memory.v1-backup.json";
var RAW_WINDOW = 20;
var SUMMARIZE_THRESHOLD = 25;
var MAX_SUMMARIZE_BATCH = 25;
var MAX_SUMMARIES = 24;
var MEMORY_BLOCK_LIMIT = 6;
var MAX_BLOCKS = 200;
var cache = null;
var lastWrittenRaw = null;
var deletedIds = /* @__PURE__ */ new Set();
var MAX_TOMBSTONES = 800;
var markDeleted = (items) => {
  if (!items.length) return;
  for (const it of items) deletedIds.add(it.id);
  const store = cache;
  if (!store) return;
  const at = Date.now();
  const list = store.tombstones ?? (store.tombstones = []);
  const seen = new Set(list.map((t) => t.id));
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    list.push({ id: it.id, at });
  }
  if (list.length > MAX_TOMBSTONES) {
    list.sort((x, y) => y.at - x.at);
    store.tombstones = list.slice(0, MAX_TOMBSTONES);
  }
};
var removeTombstone = (id) => {
  deletedIds.delete(id);
  restoredIds.add(id);
  const store = cache;
  if (!store?.tombstones?.length) return;
  store.tombstones = store.tombstones.filter((t) => t.id !== id);
};
var restoredIds = /* @__PURE__ */ new Set();
var purgedIds = /* @__PURE__ */ new Set();
var examplesCleared = false;
var skipDiskMerge = false;
var adoptFromDisk = (disk) => {
  if (!cache) return;
  if (deletedIds.size) {
    disk = {
      ...disk,
      memories: disk.memories.filter((m) => !deletedIds.has(m.id)),
      summaries: disk.summaries.filter((s) => !deletedIds.has(s.id))
    };
  }
  if (restoredIds.size || purgedIds.size || examplesCleared) {
    disk = {
      ...disk,
      tombstones: (disk.tombstones ?? []).filter((t) => !restoredIds.has(t.id)),
      deletedBin: (disk.deletedBin ?? []).filter((m) => !restoredIds.has(m.id) && !purgedIds.has(m.id)),
      exampleSet: examplesCleared ? void 0 : disk.exampleSet
    };
  }
  const merged = mergeStores(disk, cache);
  cache.memories = merged.memories;
  cache.summaries = merged.summaries;
  cache.summarizedMsgCount = merged.summarizedMsgCount;
  cache.trimmedMsgCount = merged.trimmedMsgCount;
  cache.tombstones = merged.tombstones;
  cache.meta = merged.meta;
  cache.blocks = merged.blocks;
  cache.deletedBin = merged.deletedBin;
  cache.exampleSet = merged.exampleSet;
  cache.schemaVersion = merged.schemaVersion;
};
var dropOverlappingSummaries = (store) => {
  const list = store.summaries;
  if (list.length < 2) return false;
  const keptRev = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const s = list[i];
    const r = rangeOfSummary(s.id);
    if (r && keptRev.some((k) => {
      const kr = rangeOfSummary(k.id);
      return !!kr && summariesOverlap(kr, r);
    })) continue;
    keptRev.push(s);
  }
  if (keptRev.length === list.length) return false;
  store.summaries = keptRev.reverse();
  console.log(`[mem] \u540C\u6BB5\u91CD\u590D\u6458\u8981\u5DF2\u6536\u655B: ${list.length} \u2192 ${keptRev.length} \u6761`);
  return true;
};
var replaceOverlappingSummary = (store, newId) => {
  const next = rangeOfSummary(newId);
  if (!next) return;
  const merged = dropOverlappingSummaries(store);
  const kept = store.summaries.filter((s) => {
    const r = rangeOfSummary(s.id);
    return !r || !summariesOverlap(r, next);
  });
  const removed = store.summaries.length - kept.length;
  store.summaries = kept;
  if (removed) {
    console.log(`[mem] \u540C\u6BB5\u6458\u8981\u5DF2\u88AB\u65B0\u6458\u8981\u66FF\u6362: \u5408\u5E76\u6389 ${removed} \u6761${merged ? " (\u542B\u5386\u53F2\u91CD\u590D)" : ""}`);
  }
};
var trimSummariesToMax = () => {
  if (!cache) return 0;
  const mergedDup = dropOverlappingSummaries(cache);
  if (cache.summaries.length <= MAX_SUMMARIES) return mergedDup ? 1 : 0;
  const kept = capSummaries(cache.summaries, MAX_SUMMARIES);
  const dropped = cache.summaries.filter((s) => !kept.some((k) => k.id === s.id));
  markDeleted(dropped);
  try {
    const meta = foldDroppedSummaries(dropped);
    if (meta) {
      const metas = cache.meta ?? (cache.meta = []);
      if (!metas.some((m) => m.id === meta.id)) metas.push(meta);
      if (metas.length > MAX_METAS) {
        metas.sort((x, y) => y.createdAt - x.createdAt);
        const evicted = metas.slice(MAX_METAS);
        markDeleted(evicted);
        cache.meta = metas.slice(0, MAX_METAS);
      }
    }
  } catch (e) {
    console.error("[mem] fold summaries failed", e);
  }
  cache.summaries = kept;
  return dropped.length;
};
var trimBlocksToMax = () => {
  if (!cache) return 0;
  const list = cache.blocks;
  if (!list || list.length <= MAX_BLOCKS) return 0;
  const dropped = list.length - MAX_BLOCKS;
  cache.blocks = list.slice(dropped);
  console.log(`[mem] \u8BB0\u5FC6\u5757\u8D85\u51FA\u4E0A\u9650 ${MAX_BLOCKS}: \u4E22\u5F03\u6700\u65E7 ${dropped} \u4E2A\u5757 (\u6761\u76EE\u4E0E\u6458\u8981\u4E0D\u53D7\u5F71\u54CD)`);
  return dropped;
};
var tryParse = (raw) => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.memories) && !Array.isArray(parsed.summaries)) return null;
    const tombstones = Array.isArray(parsed.tombstones) ? parsed.tombstones.filter((t) => t && typeof t.id === "string" && t.id).map((t) => ({ id: String(t.id), at: Number(t.at) || 0 })) : [];
    return {
      // 坏元素防御: 单个 null/缺 content 的元素曾让 tokenize 在召回时整表抛错
      memories: Array.isArray(parsed.memories) ? parsed.memories.filter((m) => !!m && typeof m === "object" && typeof m.content === "string") : [],
      summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
      summarizedMsgCount: typeof parsed.summarizedMsgCount === "number" ? parsed.summarizedMsgCount : 0,
      trimmedMsgCount: typeof parsed.trimmedMsgCount === "number" ? parsed.trimmedMsgCount : 0,
      tombstones,
      // 折叠归档: 旧数据没有该字段 → 空数组; 同样做形状校验 (坏元素会污染注入块)
      meta: Array.isArray(parsed.meta) ? parsed.meta.filter((m) => !!m && typeof m === "object" && typeof m.id === "string" && m.id && typeof m.content === "string" && m.content) : [],
      // 记忆块 (P1): 旧数据没有该字段 → 空数组; 坏元素必须过滤, 否则块视图/注入会抛错
      blocks: Array.isArray(parsed.blocks) ? parsed.blocks.filter((b) => !!b && typeof b === "object" && typeof b.id === "string" && b.id).map((b) => ({
        id: String(b.id),
        fromTs: Number(b.fromTs) || 0,
        toTs: Number(b.toTs) || 0,
        msgCount: Number(b.msgCount) || 0,
        topic: typeof b.topic === "string" ? b.topic : "",
        summary: typeof b.summary === "string" ? b.summary : "",
        createdAt: Number(b.createdAt) || 0,
        itemIds: Array.isArray(b.itemIds) ? b.itemIds.filter((x) => typeof x === "string" && x) : []
      })) : [],
      // 回收站 (2026-09-28): 手删的条目连内容一起留着, 才能还原。旧数据没有该字段 → 空数组
      deletedBin: Array.isArray(parsed.deletedBin) ? parsed.deletedBin.filter((m) => !!m && typeof m === "object" && typeof m.content === "string") : [],
      // 示例集 (整理优化): 形状不对就当没有
      exampleSet: (() => {
        const e = parsed.exampleSet;
        if (!e || typeof e !== "object" || typeof e.builtAt !== "number") return void 0;
        return {
          builtAt: e.builtAt,
          basedOn: Number(e.basedOn) || 0,
          pos: Array.isArray(e.pos) ? e.pos.filter((x) => typeof x === "string" && x) : [],
          neg: Array.isArray(e.neg) ? e.neg.filter((x) => typeof x === "string" && x) : []
        };
      })(),
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1
    };
  } catch {
    return null;
  }
};
var applySessionTombstones = (store) => {
  if (!deletedIds.size) return store;
  return {
    ...store,
    memories: store.memories.filter((m) => !deletedIds.has(m.id)),
    summaries: store.summaries.filter((s) => !deletedIds.has(s.id))
  };
};
var collapseMemories = (store) => {
  const { removed, dropped } = collapseDuplicateMemories(store);
  if (!removed) return false;
  markDeleted(dropped);
  console.log(`[mem] \u5B58\u91CF\u91CD\u590D\u8BB0\u5FC6\u5DF2\u6536\u655B: \u5408\u5E76\u6389 ${removed} \u6761`);
  return true;
};
var collapseReversals = (store) => {
  const active = store.memories.filter(isActiveMemory);
  if (active.length < 2) return 0;
  const ordered = [...active].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const hit = /* @__PURE__ */ new Set();
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (hit.has(ordered[i].id)) break;
      if (ordered[i].createdAt === ordered[j].createdAt) continue;
      if (isReversal(ordered[i].content, ordered[j].content)) hit.add(ordered[i].id);
    }
  }
  if (!hit.size) return 0;
  const now = Date.now();
  store.memories = store.memories.map(
    (m) => hit.has(m.id) ? { ...m, invalidAt: now, updatedAt: Math.max(now, (m.updatedAt ?? m.createdAt ?? 0) + 1) } : m
  );
  console.log(`[mem] \u5B58\u91CF\u6539\u53E3\u6536\u655B: \u4F5C\u5E9F\u65E7\u8BF4\u6CD5 ${hit.size} \u6761 (\u53EF\u8FD8\u539F)`);
  return hit.size;
};
var pruneBlockRefs = (store) => {
  const blocks = store.blocks;
  if (!blocks?.length) return false;
  const alive = new Set(store.memories.map((m) => m.id));
  let changed = false;
  for (const b of blocks) {
    const kept = b.itemIds.filter((id) => alive.has(id));
    if (kept.length !== b.itemIds.length) {
      b.itemIds = kept;
      changed = true;
    }
  }
  return changed;
};
var migrateToBlocks = (store, rawMain) => {
  if ((store.schemaVersion ?? 0) >= MEMORY_SCHEMA_VERSION) {
    if (!Array.isArray(store.blocks)) store.blocks = [];
    return false;
  }
  if (rawMain && !readFile(FILE_V1)) writeFile(FILE_V1, rawMain);
  if (!Array.isArray(store.blocks)) store.blocks = [];
  if (!store.blocks.length && store.memories.length) {
    const times = store.memories.map((m) => m.createdAt || 0).filter((t) => t > 0);
    store.blocks.push({
      id: "blk-legacy",
      fromTs: times.length ? Math.min(...times) : 0,
      toTs: times.length ? Math.max(...times) : 0,
      msgCount: 0,
      // 0 = 不是由某段对话总结出来的 (迁移块)
      topic: "\u65E9\u671F\u8BB0\u5FC6",
      summary: "",
      createdAt: Date.now(),
      // 含已作废条目: 它仍属于这段历史 (记忆库的「已作废」区照旧单独展示、可还原)
      itemIds: store.memories.map((m) => m.id)
    });
  }
  store.schemaVersion = MEMORY_SCHEMA_VERSION;
  console.log(`[mem] \u8BB0\u5FC6\u7ED3\u6784\u5DF2\u8FC1\u79FB\u5230 v${MEMORY_SCHEMA_VERSION}: \u6302\u8D77 ${store.memories.length} \u6761\u65E7\u8BB0\u5FC6`);
  return true;
};
var load = () => {
  if (cache) return cache;
  const rawMain = readFile(FILE);
  lastWrittenRaw = rawMain || null;
  let store = tryParse(rawMain);
  if (store) {
    cache = applySessionTombstones(store);
    backfillDecay(cache);
    const collapsed = collapseMemories(cache);
    const reversalFixed = collapseReversals(cache) > 0;
    const migrated = migrateToBlocks(cache, rawMain);
    const pruned = pruneBlockRefs(cache);
    const trimmed = trimSummariesToMax() > 0;
    if (cache !== store || trimmed || collapsed || reversalFixed || migrated || pruned) lastWrittenRaw = null;
    if (trimmed || collapsed || reversalFixed || migrated || pruned) flushPersist();
    return cache;
  }
  store = tryParse(readFile(FILE_BAK));
  if (store) {
    cache = applySessionTombstones(store);
    backfillDecay(cache);
    collapseMemories(cache);
    collapseReversals(cache);
    migrateToBlocks(cache, readFile(FILE_BAK));
    pruneBlockRefs(cache);
    trimSummariesToMax();
    const json = JSON.stringify(cache);
    if (writeFile(FILE, json)) lastWrittenRaw = json;
    if (rawMain) writeFile(`${FILE}.corrupt-${Date.now()}`, rawMain);
    return cache;
  }
  if (rawMain) writeFile(`${FILE}.corrupt-${Date.now()}`, rawMain);
  cache = {
    ...EMPTY_MEMORY_STORE,
    memories: [],
    summaries: [],
    summarizedMsgCount: 0,
    trimmedMsgCount: 0,
    tombstones: [],
    // 新数组: 别与 EMPTY_MEMORY_STORE 共享引用, 否则 markDeleted 会污染常量
    blocks: [],
    // 同理: 共享引用会让 push 污染常量
    deletedBin: []
  };
  return cache;
};
var backfillDecay = (store) => {
  let changed = false;
  store.memories = store.memories.map((m) => {
    if (m && m.decayDays !== void 0) return m;
    changed = true;
    return { ...m, decayDays: m ? defaultDecayDays(m.type) : null };
  });
  if (changed) {
    lastWrittenRaw = null;
    persist();
  }
};
var PERSIST_DEBOUNCE_MS = 400;
var persistTimer = null;
var writeQueue = Promise.resolve();
var persist = () => {
  if (!cache) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersist();
  }, PERSIST_DEBOUNCE_MS);
};
var flushPersist = () => {
  if (!cache) return;
  writeQueue = writeQueue.then(async () => {
    try {
      let diskRaw = null;
      if (!skipDiskMerge) {
        diskRaw = readFile(FILE);
        const disk = tryParse(diskRaw);
        if (disk && diskRaw !== lastWrittenRaw) {
          adoptFromDisk(disk);
          trimSummariesToMax();
          const tombs = cache?.tombstones;
          if (tombs && tombs.length > MAX_TOMBSTONES) {
            tombs.sort((x, y) => y.at - x.at);
            if (cache) cache.tombstones = tombs.slice(0, MAX_TOMBSTONES);
          }
        }
      } else {
        skipDiskMerge = false;
      }
      const json = JSON.stringify(cache);
      if (diskRaw !== null && json === diskRaw) {
        lastWrittenRaw = json;
        return;
      }
      const ok1 = writeFile(FILE, json);
      const ok2 = writeFile(FILE_BAK, json);
      if (ok1) lastWrittenRaw = json;
      if (!ok1 || !ok2) {
        console.error("[mem] persist write failed", { ok1, ok2, file: FILE });
      }
    } catch (e) {
      console.error("[mem] persist error", e);
    }
  });
};
var flushMemoryPersist = async () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    flushPersist();
  }
  await writeQueue;
};
var memoryStats = () => {
  const store = load();
  return {
    // memoryCount 保持旧语义 (库里条目总数, 含作废/已收起), 免得改动既有调用方的预期
    memoryCount: store.memories.length,
    summaryCount: store.summaries.length,
    fadedCount: store.memories.filter((m) => !!m.fadedAt && !m.invalidAt).length,
    deletedCount: (store.deletedBin ?? []).length
  };
};
var listInvalidMemories = () => {
  const store = load();
  return store.memories.filter((m) => !!m.invalidAt).sort((a, b) => (b.invalidAt ?? 0) - (a.invalidAt ?? 0));
};
var listBlocks = () => {
  const store = load();
  const byId = new Map(store.memories.map((m) => [m.id, m]));
  return (store.blocks ?? []).map((block) => ({
    block,
    items: block.itemIds.map((id) => byId.get(id)).filter((m) => !!m)
  }));
};
var listUnblockedMemories = (includeInvalid = false) => {
  const store = load();
  const used = /* @__PURE__ */ new Set();
  for (const b of store.blocks ?? []) for (const id of b.itemIds) used.add(id);
  return store.memories.filter((m) => !used.has(m.id) && (includeInvalid || isActiveMemory(m))).sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt);
};
var listAll = (includeInvalid = false) => {
  const store = load();
  const mems = includeInvalid ? [...store.memories] : store.memories.filter(isActiveMemory);
  return {
    memories: mems.sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt),
    summaries: [...store.summaries].sort((a, b) => b.createdAt - a.createdAt)
  };
};
var invalidateMemory = (id) => {
  const store = load();
  const m = store.memories.find((x) => x.id === id);
  if (!m || m.invalidAt) return false;
  const now = Math.max(Date.now(), (m.updatedAt ?? m.createdAt ?? 0) + 1);
  store.memories = store.memories.map((x) => x.id === id ? { ...x, invalidAt: now, updatedAt: now } : x);
  persist();
  return true;
};
var restoreMemory = (id) => {
  const store = load();
  const m = store.memories.find((x) => x.id === id);
  if (!m || !m.invalidAt) return false;
  store.memories = store.memories.map((x) => {
    if (x.id !== id) return x;
    const { invalidAt: _drop, ...rest } = x;
    const base = Math.max(x.updatedAt ?? 0, x.invalidAt ?? 0);
    return { ...rest, updatedAt: Math.max(Date.now(), base + 1) };
  });
  persist();
  return true;
};
var listFadedMemories = () => {
  const store = load();
  return store.memories.filter((m) => !!m.fadedAt && !m.invalidAt).sort((a, b) => (b.fadedAt ?? 0) - (a.fadedAt ?? 0));
};
var restoreFadedMemory = (id) => {
  const store = load();
  const m = store.memories.find((x) => x.id === id);
  if (!m || !m.fadedAt) return false;
  store.memories = store.memories.map((x) => {
    if (x.id !== id) return x;
    const { fadedAt: _f, fadedReason: _r, ...rest } = x;
    const base = Math.max(x.updatedAt ?? 0, x.fadedAt ?? 0);
    return { ...rest, updatedAt: Math.max(Date.now(), base + 1) };
  });
  persist();
  return true;
};
var stripFromExamples = (store, content, alsoNeg) => {
  const e = store.exampleSet;
  if (!e || !content) return;
  const norm = normalizeForCompare(content);
  if (!norm) return;
  const hit = (t) => {
    const x = normalizeForCompare(t.replace(/…$/, ""));
    return !!x && (x === norm || norm.startsWith(x));
  };
  e.pos = e.pos.filter((t) => !hit(t));
  if (alsoNeg) e.neg = e.neg.filter((t) => !hit(t));
  if (!e.pos.length && !e.neg.length) store.exampleSet = void 0;
  else e.builtAt = Math.max((e.builtAt ?? 0) + 1, Date.now());
};
var fadeMemoryManually = (id) => {
  const store = load();
  const m = store.memories.find((x) => x.id === id);
  if (!m || !isActiveMemory(m)) return false;
  fadeItems(store, [m], "manual");
  stripFromExamples(store, m.content, false);
  persist();
  return true;
};
var listDeletedMemories = () => {
  const store = load();
  return [...store.deletedBin ?? []].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
};
var restoreDeletedMemory = (id) => {
  const store = load();
  const bin = store.deletedBin ?? (store.deletedBin = []);
  const idx = bin.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  const { deletedAt: _d, ...item } = bin[idx];
  bin.splice(idx, 1);
  removeTombstone(id);
  store.memories = [
    ...store.memories,
    { ...item, updatedAt: Math.max(Date.now(), (item.updatedAt ?? item.createdAt ?? 0) + 1) }
  ];
  persist();
  return true;
};
var deleteMemoryForever = (id) => {
  const store = load();
  const bin = store.deletedBin ?? [];
  const item = bin.find((m) => m.id === id);
  const before = bin.length;
  store.deletedBin = bin.filter((m) => m.id !== id);
  if (store.deletedBin.length === before) return false;
  purgedIds.add(id);
  markDeleted([{ id }]);
  if (item?.content) stripFromExamples(store, item.content, true);
  persist();
  return true;
};
var addMemoriesFromText = (text) => {
  const store = load();
  const before = store.memories.length;
  const res = applyMerge(store, extractMemories(text));
  if (res.changed) persist();
  return Math.max(0, store.memories.length - before);
};
var PREF_DIR_WORDS = [
  // 不喜欢侧 (长词优先)
  ["\u4E0D\u559C\u6B22", false],
  ["\u4E0D\u7231\u5403", false],
  ["\u4E0D\u7231\u559D", false],
  ["\u4E0D\u7231", false],
  ["\u8BA8\u538C", false],
  ["\u53CD\u611F", false],
  ["\u53D7\u4E0D\u4E86", false],
  ["\u63A5\u53D7\u4E0D\u4E86", false],
  ["\u65E0\u611F", false],
  // 喜欢侧
  ["\u559C\u6B22", true],
  ["\u6700\u7231", true],
  ["\u8D85\u7231", true],
  ["\u70ED\u7231", true],
  ["\u597D\u7231", true],
  ["\u5F88\u7231", true],
  ["\u7231", true]
];
var PREF_PREFIXES = ["\u6211", "\u81EA\u5DF1", "\u6700\u8FD1", "\u73B0\u5728", "\u4E00\u76F4", "\u5E73\u65F6", "\u8D85", "\u633A", "\u86EE", "\u5F88", "\u7279\u522B", "\u6700", "\u597D", "\u53C8", "\u8FD8\u662F", "\u771F\u7684", "\u5DF2\u7ECF", "\u672C\u6765", "\u5176\u5B9E"];
var WILL_NEG_WORDS = ["\u4E0D\u518D", "\u4E0D"];
var WILL_MODAL_WORDS = ["\u60F3\u8981", "\u60F3", "\u6253\u7B97", "\u51C6\u5907", "\u8BA1\u5212", "\u51B3\u5B9A", "\u8981"];
var WILL_OBJ_BLOCK = /^(?:在|有|是|叫|姓)/;
var parseWill = (content) => {
  let rest = stripSubjectPrefix(content);
  let neg = false;
  for (const w of WILL_NEG_WORDS) {
    if (rest.startsWith(w)) {
      rest = rest.slice(w.length);
      neg = true;
      break;
    }
  }
  let modal = false;
  for (const w of WILL_MODAL_WORDS) {
    if (rest.startsWith(w)) {
      rest = rest.slice(w.length);
      modal = true;
      break;
    }
  }
  if (!neg && !modal) return null;
  rest = stripTail(rest);
  if (!rest || WILL_OBJ_BLOCK.test(rest)) return null;
  return { obj: rest, dir: !neg };
};
var stripSubjectPrefix = (content) => {
  let rest = content.replace(/^[\s，,。.、]+/, "");
  for (let guard = 0; guard < 3; guard++) {
    const before = rest;
    for (const p of PREF_PREFIXES) {
      if (rest.startsWith(p)) {
        rest = rest.slice(p.length);
        break;
      }
    }
    if (rest === before) break;
  }
  return rest;
};
var stripTail = (content) => {
  let rest = content.replace(/[。！？!?，,、\s]+$/g, "");
  for (let guard = 0; guard < 4; guard += 1) {
    const before = rest;
    rest = rest.replace(/(?:了|啊|呢|吧|嘛|哈|哟|哦|啦)+$/g, "");
    if (rest === before) break;
  }
  return rest;
};
var parseDirection = (content, table) => {
  const rest0 = stripSubjectPrefix(content);
  let dir = null;
  let rest = rest0;
  for (const [w, d] of table) {
    if (rest.startsWith(w)) {
      rest = rest.slice(w.length);
      dir = d;
      break;
    }
  }
  if (dir === null) return null;
  rest = stripTail(rest);
  if (!rest) return null;
  return { obj: rest, dir };
};
var isPrefReversal = (oldContent, newContent) => {
  const a = parseDirection(oldContent, PREF_DIR_WORDS);
  const b = parseDirection(newContent, PREF_DIR_WORDS);
  if (!a || !b) return false;
  if (a.dir === b.dir) return false;
  return a.obj === b.obj || a.obj.includes(b.obj) || b.obj.includes(a.obj);
};
var isWillReversal = (oldContent, newContent) => {
  const a = parseWill(oldContent);
  const b = parseWill(newContent);
  if (!a || !b) return false;
  if (a.dir === b.dir) return false;
  const na = normalizeForCompare(a.obj);
  const nb = normalizeForCompare(b.obj);
  return !!na && na.length >= 2 && na === nb;
};
var isReversal = (oldContent, newContent) => isPrefReversal(oldContent, newContent) || isWillReversal(oldContent, newContent);
var invalidateReversals = (store, fresh) => {
  const now = Date.now();
  const hit = /* @__PURE__ */ new Set();
  for (const it of fresh) {
    if (!it.content || !isActiveMemory(it)) continue;
    for (const old of store.memories) {
      if (!isActiveMemory(old) || !old.content) continue;
      if (hit.has(old.id)) continue;
      if (isReversal(old.content, it.content)) hit.add(old.id);
    }
  }
  if (!hit.size) return 0;
  store.memories = store.memories.map(
    (m) => hit.has(m.id) ? { ...m, invalidAt: now, updatedAt: Math.max(now, (m.updatedAt ?? m.createdAt ?? 0) + 1) } : m
  );
  console.log(`[mem] \u6539\u53E3\u6D88\u89E3: \u4F5C\u5E9F\u65E7\u8BF4\u6CD5 ${hit.size} \u6761 (\u53EF\u8FD8\u539F)`);
  return hit.size;
};
var invalidateIntraBatchReversals = (fresh) => {
  if (fresh.length < 2) return 0;
  const now = Date.now();
  const hit = /* @__PURE__ */ new Set();
  for (let i = 0; i < fresh.length; i += 1) {
    for (let j = i + 1; j < fresh.length; j += 1) {
      if (hit.has(fresh[i].id)) break;
      if (!fresh[i].content || !fresh[j].content) continue;
      if (isReversal(fresh[i].content, fresh[j].content)) hit.add(fresh[i].id);
    }
  }
  if (!hit.size) return 0;
  for (const it of fresh) {
    if (!hit.has(it.id)) continue;
    it.invalidAt = now;
    it.updatedAt = Math.max(now, (it.updatedAt ?? it.createdAt ?? 0) + 1);
  }
  console.log(`[mem] \u6BB5\u5185\u6539\u53E3: \u4F5C\u5E9F\u540C\u6279\u5185\u88AB\u63A8\u7FFB\u7684 ${hit.size} \u6761 (\u53EF\u8FD8\u539F)`);
  return hit.size;
};
var applyMerge = (store, fresh) => {
  const invalidated = invalidateReversals(store, fresh);
  const revived = reviveFaded(store, fresh);
  const { added, updated } = mergeMemories(fresh, store.memories);
  if (updated.length) {
    const upd = new Map(updated.map((u) => [u.id, u]));
    store.memories = store.memories.map((m) => upd.get(m.id) ?? m);
  }
  if (added.length) {
    store.memories = [...store.memories, ...added];
  }
  const expired = pickExpiredMemories(store.memories);
  if (expired.length) fadeItems(store, expired, "expired");
  const dropped = pruneMemories(store.memories);
  if (dropped.length) fadeItems(store, dropped, "lowvalue");
  return {
    added: added.length,
    updated: updated.length,
    invalidated,
    // 诊断日志用 (P1): 本批触发的"收起"与"复活"各有几条 —— 此前只打 console, 设备上看不见
    expired: expired.length,
    lowvalue: dropped.length,
    revived,
    changed: added.length > 0 || updated.length > 0 || invalidated > 0 || expired.length > 0 || dropped.length > 0 || revived > 0,
    // 供块归属用 (P2): 本段**真正进库**的条目 (新增 + 被升级), 不是"请求写入的"
    addedItems: added,
    updatedItems: updated
  };
};
var fadeItems = (store, items, reason) => {
  if (!items.length) return 0;
  const now = Date.now();
  const ids = new Set(items.map((it) => it.id));
  store.memories = store.memories.map(
    (m) => ids.has(m.id) && isActiveMemory(m) ? { ...m, fadedAt: now, fadedReason: reason, updatedAt: Math.max(now, (m.updatedAt ?? m.createdAt ?? 0) + 1) } : m
  );
  console.log(`[mem] \u5DF2\u6536\u8D77 ${ids.size} \u6761 (\u539F\u56E0: ${reason}; \u53EF\u4E00\u952E\u300C\u7559\u4E0B\u300D)`);
  return ids.size;
};
var reviveFaded = (store, fresh) => {
  if (!fresh.length) return 0;
  const faded = store.memories.filter((m) => !!m.fadedAt && !m.invalidAt);
  if (!faded.length) return 0;
  const now = Date.now();
  const hits = /* @__PURE__ */ new Set();
  for (const f of faded) {
    if (!f.content) continue;
    for (const it of fresh) {
      if (!it.content) continue;
      if (isSameContent(f.content, it.content)) {
        hits.add(f.id);
        break;
      }
    }
  }
  if (!hits.size) return 0;
  store.memories = store.memories.map(
    (m) => hits.has(m.id) ? { ...m, fadedAt: void 0, fadedReason: void 0, updatedAt: Math.max(now, (m.updatedAt ?? m.createdAt ?? 0) + 1) } : m
  );
  console.log(`[mem] \u4E4B\u524D\u6536\u8D77\u7684 ${hits.size} \u6761\u53C8\u88AB\u63D0\u5230, \u5DF2\u653E\u56DE\u751F\u6548`);
  return hits.size;
};
var writeBlock = (store, block, fresh) => {
  const res = applyMerge(store, fresh);
  const alive = new Set(store.memories.map((m) => m.id));
  const inAnyBlock = /* @__PURE__ */ new Set();
  for (const b of store.blocks ?? []) for (const id of b.itemIds) inAnyBlock.add(id);
  block.itemIds = [...new Set([...res.addedItems, ...res.updatedItems].map((m) => m.id))].filter((id) => alive.has(id) && !inAnyBlock.has(id));
  const list = store.blocks ?? (store.blocks = []);
  const exist = list.find((b) => b.id === block.id);
  if (exist) {
    exist.itemIds = [.../* @__PURE__ */ new Set([...exist.itemIds, ...block.itemIds])];
    exist.topic = block.topic || exist.topic;
    exist.summary = block.summary;
    exist.createdAt = Math.max(exist.createdAt, block.createdAt);
  } else {
    list.push(block);
    list.sort((a, b) => a.fromTs - b.fromTs || a.id.localeCompare(b.id));
  }
  trimBlocksToMax();
  return {
    added: res.added,
    updated: res.updated,
    invalidated: res.invalidated,
    expired: res.expired,
    lowvalue: res.lowvalue,
    revived: res.revived
  };
};
var LLM_TIMEOUT_MS = 3e3;
var withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout")), ms);
  p.then(
    (v) => {
      clearTimeout(t);
      resolve(v);
    },
    (e) => {
      clearTimeout(t);
      reject(e);
    }
  );
});
var addMemoriesWithLlm = async (text, llmCall) => {
  const store = load();
  const before = store.memories.length;
  let changed = applyMerge(store, extractMemories(text)).changed;
  try {
    changed = applyMerge(store, parseLlmMemories(await llmCall(buildLlmExtractPrompt(text)))).changed || changed;
  } catch {
  }
  if (changed) persist();
  return Math.max(0, store.memories.length - before);
};
var mergeLlmMemories = (items) => {
  if (!items.length) return 0;
  const store = load();
  const before = store.memories.length;
  if (applyMerge(store, items).changed) persist();
  return Math.max(0, store.memories.length - before);
};
var DECISION_TIMEOUT_MS = 4e3;
var DECISION_CANDIDATES = 10;
var applyLlmMemoryDecision = async (facts, llmCall) => {
  if (!facts.length) return { added: 0, updated: 0, deleted: 0, invalidated: 0, usedLlm: false };
  const store = load();
  const reversalInvalidated = invalidateReversals(store, facts);
  const pool = store.memories.filter(isActiveMemory);
  const candidates = /* @__PURE__ */ new Map();
  const factCands = facts.map(() => /* @__PURE__ */ new Set());
  const nearCands = facts.map(() => /* @__PURE__ */ new Set());
  let keywordHit = false;
  for (let i = 0; i < facts.length; i += 1) {
    const factTokens = new Set(tokenize(facts[i].content));
    for (const hit of recallMemories(store.memories, facts[i].content, 5).hits) {
      candidates.set(hit.id, hit);
      factCands[i].add(hit.id);
      if (hit.content) {
        let overlap = 0;
        for (const tk of tokenize(hit.content)) {
          if (factTokens.has(tk)) overlap += 1;
        }
        if (overlap >= 2 || overlap >= 1 && factTokens.size <= 2) keywordHit = true;
      }
    }
    if (candidates.size >= DECISION_CANDIDATES) break;
  }
  if (pool.length) {
    const cap = DECISION_CANDIDATES * 2;
    for (let i = 0; i < facts.length && candidates.size < cap; i += 1) {
      for (const m of pool) {
        if (candidates.size >= cap) break;
        if (!m.content) continue;
        if (contentSimilarity(m.content, facts[i].content) < NEAR_DUP_DICE) continue;
        candidates.set(m.id, m);
        nearCands[i].add(m.id);
        keywordHit = true;
      }
    }
  }
  let typeFallbackHit = false;
  if (pool.length && !keywordHit) {
    for (const m of pool) {
      for (let i = 0; i < facts.length; i += 1) {
        if (m.type !== facts[i].type) continue;
        candidates.set(m.id, m);
        nearCands[i].add(m.id);
        typeFallbackHit = true;
      }
    }
  }
  const existing = [...candidates.values()].slice(0, DECISION_CANDIDATES);
  const factOwner = facts.map((f) => {
    let hit = null;
    for (const m of pool) {
      if (!m.content || !isSameContent(m.content, f.content)) continue;
      if (hit) return null;
      hit = m.id;
    }
    return hit;
  });
  if (!existing.length || !(keywordHit || typeFallbackHit)) {
    const mres2 = applyMerge(store, facts);
    if (mres2.changed || reversalInvalidated) persist();
    return {
      added: mres2.added,
      updated: 0,
      deleted: 0,
      invalidated: mres2.invalidated + reversalInvalidated,
      usedLlm: false
    };
  }
  let decisions = [];
  try {
    const raw = await withTimeout(
      llmCall(buildLlmMemoryDecisionPrompt(
        facts.map((f) => ({ content: f.content, type: f.type })),
        existing.map((m) => ({ id: m.id, content: m.content, type: m.type }))
      )),
      DECISION_TIMEOUT_MS
    );
    decisions = parseLlmMemoryDecision(raw);
  } catch {
    decisions = [];
  }
  let updated = 0;
  let deleted = 0;
  let invalidated = reversalInvalidated;
  const absorbed = /* @__PURE__ */ new Set();
  if (decisions.length) {
    const byId = new Map(pool.map((m) => [m.id, m]));
    const now = Date.now();
    const delIds = /* @__PURE__ */ new Set();
    const invIds = /* @__PURE__ */ new Set();
    const patch = /* @__PURE__ */ new Map();
    const resolvedIds = /* @__PURE__ */ new Set();
    for (const d of decisions) {
      const old = byId.get(d.id);
      if (!old) continue;
      if (d.event === "DELETE") {
        invIds.add(d.id);
        continue;
      }
      if (d.event === "NONE") {
        resolvedIds.add(d.id);
        continue;
      }
      if (d.event !== "UPDATE" || !d.text) continue;
      if (d.text.length >= old.content.length) patch.set(d.id, d.text);
      resolvedIds.add(d.id);
    }
    if (resolvedIds.size) {
      facts.forEach((_, i) => {
        for (const id of [...factCands[i], ...nearCands[i]]) {
          if (resolvedIds.has(id)) {
            absorbed.add(i);
            break;
          }
        }
      });
    }
    if (patch.size) {
      store.memories = store.memories.map(
        (m) => patch.has(m.id) ? { ...m, content: patch.get(m.id), updatedAt: now } : m
      );
      updated = patch.size;
    }
    if (invIds.size) {
      const nowInv = Date.now();
      store.memories = store.memories.map(
        (m) => invIds.has(m.id) && !m.invalidAt ? { ...m, invalidAt: nowInv, updatedAt: Math.max(nowInv, (m.updatedAt ?? m.createdAt ?? 0) + 1) } : m
      );
      invalidated += invIds.size;
    }
    if (delIds.size) {
      const removed = store.memories.filter((m) => delIds.has(m.id));
      markDeleted(removed);
      store.memories = store.memories.filter((m) => !delIds.has(m.id));
      deleted = removed.length;
    }
  }
  for (let i = 0; i < facts.length; i += 1) {
    if (absorbed.has(i)) continue;
    const owner = factOwner[i];
    if (!owner) continue;
    absorbed.add(i);
    store.memories = store.memories.map((m) => m.id === owner ? { ...m, updatedAt: Date.now() } : m);
  }
  const toWrite = absorbed.size ? facts.filter((_, i) => !absorbed.has(i)) : facts;
  const mres = toWrite.length ? applyMerge(store, toWrite) : { added: 0, updated: 0, changed: false, invalidated: 0 };
  if (mres.changed) persist();
  return {
    added: mres.added,
    updated: updated + mres.updated,
    deleted,
    invalidated: invalidated + mres.invalidated,
    usedLlm: decisions.length > 0
  };
};
var extractMemoriesSmart = async (userText, llmCall, recentContext = []) => {
  const result = { added: 0, updated: 0, deleted: 0, invalidated: 0, usedLlm: false, tips: [] };
  try {
    const ruleItems = extractMemories(userText);
    result.added = addMemoriesFromText(userText);
    if (result.added > 0) result.tips = ruleItems.slice(0, 2).map((i) => i.content);
  } catch (e) {
    console.error("[mem] rule extract failed:", e);
  }
  if (!llmCall || shouldSkipLlmExtract(userText)) return result;
  try {
    const raw = await llmCall(buildLlmExtractPrompt(userText, recentContext));
    const facts = parseLlmMemories(raw);
    if (!facts.length) return result;
    const write = await applyLlmMemoryDecision(facts, llmCall);
    result.added += write.added;
    result.updated += write.updated;
    result.deleted += write.deleted;
    result.invalidated += write.invalidated;
    result.usedLlm = write.usedLlm;
    if (write.added > 0 || write.updated > 0) {
      result.tips = facts.slice(0, 2).map((f) => f.content);
    }
  } catch (e) {
    console.error("[mem] llm extract failed:", e);
  }
  return result;
};
var staleDrop = (store, staleDays, minImportance) => {
  if (!store.memories.length) return [];
  const now = Date.now();
  const staleMs = staleDays * 24 * 3600 * 1e3;
  return store.memories.filter(
    (it) => it.importance < minImportance && now - Math.max(it.lastAccessedAt, it.createdAt) > staleMs && it.accessCount < 2
  );
};
var pruneStalePreview = (staleDays = 30, minImportance = 0.6) => staleDrop(load(), staleDays, minImportance).length;
var pruneStaleMemories = (staleDays = 30, minImportance = 0.6) => {
  const store = load();
  const drop = staleDrop(store, staleDays, minImportance);
  if (!drop.length) return 0;
  markDeleted(drop);
  const dropIds = new Set(drop.map((d) => d.id));
  store.memories = store.memories.filter((it) => !dropIds.has(it.id));
  pruneBlockRefs(store);
  persist();
  return drop.length;
};
var recallForQuery = (query) => {
  const store = load();
  if (!store.memories.length) return "";
  const { hits, updated } = recallMemories(store.memories, query, MEMORY_BLOCK_LIMIT);
  if (!hits.length) return "";
  store.memories = updated;
  persist();
  return buildMemoryBlock(hits, MEMORY_BLOCK_LIMIT);
};
var recallForQuerySmart = async (query, llmCall, topK = MEMORY_BLOCK_LIMIT) => {
  const store = load();
  if (!store.memories.length) return "";
  const all = store.memories.filter(isActiveMemory);
  if (!all.length) return "";
  let picked = [];
  let llmOk = false;
  try {
    let pre;
    if (all.length <= 20) {
      pre = all;
    } else {
      const kw = recallMemories(all, query, 15).hits;
      const byNew = [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
      const byImp = [...all].sort((a, b) => b.importance - a.importance).slice(0, 6);
      const seen = /* @__PURE__ */ new Set();
      pre = [];
      for (const m of [...kw, ...byNew, ...byImp]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          pre.push(m);
        }
        if (pre.length >= 20) break;
      }
    }
    if (pre.length) {
      const raw = await withTimeout(llmCall(buildLlmRelevancePrompt(query, pre.map((m) => ({ id: m.id, content: m.content })))), LLM_TIMEOUT_MS);
      llmOk = true;
      const valid = new Set(pre.map((m) => m.id));
      const llmIds = parseLlmRelevance(raw, valid);
      picked = llmIds.map((id) => all.find((m) => m.id === id)).filter((m) => !!m);
    }
  } catch {
  }
  if (!llmOk && picked.length < 3) {
    const kw = recallMemories(all, query, topK).hits;
    for (const m of kw) {
      if (!picked.some((p) => p.id === m.id)) picked.push(m);
      if (picked.length >= topK) break;
    }
  } else if (llmOk && picked.length === 0) {
    const qt = tokenize(query);
    const scored = all.filter((m) => overlapCount(qt, m) > 0).map((m) => ({ m, score: scoreMemory(qt, m, Date.now()) })).filter((s) => s.score > 1.5).sort((a, b) => b.score - a.score);
    for (const { m } of scored.slice(0, 2)) {
      if (!picked.some((p) => p.id === m.id)) picked.push(m);
    }
  }
  picked = picked.slice(0, Math.min(topK, MEMORY_BLOCK_LIMIT));
  if (!picked.length) return "";
  const hitIds = new Set(picked.map((p) => p.id));
  store.memories = store.memories.map(
    (m) => hitIds.has(m.id) ? { ...m, lastAccessedAt: Date.now(), accessCount: m.accessCount + 1 } : m
  );
  persist();
  return buildMemoryBlock(picked, MEMORY_BLOCK_LIMIT);
};
var OPENING_LIMIT = 8;
var openingMemoryBlock = (query = "", limit = OPENING_LIMIT) => {
  const store = load();
  if (!store.memories.length) return "";
  const picked = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (it) => {
    if (it && it.content && !seen.has(it.id)) {
      seen.add(it.id);
      picked.push(it);
    }
  };
  const q = (query ?? "").trim();
  if (q) for (const it of recallMemories(store.memories, q, limit).hits) push(it);
  const byValue = store.memories.filter(isActiveMemory).sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt);
  for (const it of byValue) {
    if (picked.length >= limit) break;
    const t = it.tags ?? [];
    const identity = t.includes("identity") || t.includes("explicit");
    if (it.type === "core" || identity || it.importance >= 0.8) push(it);
  }
  return buildMemoryBlock(picked, limit);
};
var summaryBlock = () => {
  const store = load();
  return buildSummaryBlock(store.summaries, { metas: store.meta ?? [] });
};
var splitSummaryKeys = (text) => {
  const m = text.match(/\n\s*\**【?记忆要点】?\**[:：]?\s*/);
  if (!m || m.index === void 0) return { summaryText: text, keyFacts: [] };
  const summaryText = text.slice(0, m.index).trim();
  const keysText = text.slice(m.index + m[0].length);
  const facts = [];
  for (const part of keysText.split(/\n+|；|;/)) {
    const f = part.replace(/^[\s\-*·•\d.、]+/, "").replace(/[。！？!?…]+$/, "").trim();
    if (!f || f.length > 80) continue;
    if (/^(无|没有|暂无|略|空|none|n\/a|无新增|没有新增)/i.test(f)) {
      return { summaryText: summaryText || text, keyFacts: [] };
    }
    facts.push(f);
    if (facts.length >= 5) break;
  }
  if (!facts.length) return { summaryText: summaryText || text, keyFacts: [] };
  return { summaryText: summaryText || text, keyFacts: facts };
};
var matchesInvalidated = (store, content) => store.memories.some((m) => !isActiveMemory(m) && isSameContent(m.content, content));
var KNOWN_MEMORY_LIMIT = 40;
var KNOWN_MEMORY_ITEM_CHARS = 24;
var KNOWN_MEMORY_TOTAL_CHARS = 900;
var knownMemoryList = (store) => {
  const items = store.memories.filter(isActiveMemory).filter((m) => !!m.content).sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt).slice(0, KNOWN_MEMORY_LIMIT);
  const out = [];
  let total = 0;
  for (const m of items) {
    const t = m.content.length > KNOWN_MEMORY_ITEM_CHARS ? `${m.content.slice(0, KNOWN_MEMORY_ITEM_CHARS)}\u2026` : m.content;
    if (total + t.length > KNOWN_MEMORY_TOTAL_CHARS) break;
    total += t.length;
    out.push(t);
  }
  return out;
};
var EXAMPLE_COLD_START = 12;
var EXAMPLE_REBUILD_AFTER = 20;
var EXAMPLE_POS_MAX = 8;
var EXAMPLE_NEG_MAX = 4;
var EXAMPLE_ITEM_CHARS = 24;
var EXAMPLE_TOTAL_CHARS = 400;
var clipExample = (s) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > EXAMPLE_ITEM_CHARS ? `${t.slice(0, EXAMPLE_ITEM_CHARS)}\u2026` : t;
};
var pickExamplePos = (store) => {
  const items = store.memories.filter(isActiveMemory).filter((m) => !!m.content && !(m.tags ?? []).includes("goal")).filter((m) => m.type !== "event" || m.importance >= 0.7).sort((a, b) => b.importance - a.importance || b.accessCount - a.accessCount || b.createdAt - a.createdAt);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of items) {
    if (out.length >= EXAMPLE_POS_MAX) break;
    const t = clipExample(m.content);
    const key = normalizeForCompare(t);
    if (!t || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
};
var pickExampleNeg = (store) => {
  const bin = [...store.deletedBin ?? []].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of bin) {
    if (out.length >= EXAMPLE_NEG_MAX) break;
    const t = clipExample(m.content);
    const key = normalizeForCompare(t);
    if (!t || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
};
var getMemoryExamples = () => {
  const e = load().exampleSet;
  return e && (e.pos?.length || e.neg?.length) ? e : null;
};
var rebuildMemoryExamples = () => {
  const store = load();
  const active = store.memories.filter(isActiveMemory);
  if (active.length < EXAMPLE_COLD_START) {
    console.log(`[mem] \u8BB0\u5FC6\u592A\u5C11 (${active.length} < ${EXAMPLE_COLD_START}), \u5148\u4E0D\u751F\u6210\u793A\u4F8B`);
    return false;
  }
  const pos = pickExamplePos(store);
  const neg = pickExampleNeg(store);
  let used = pos.reduce((n, s) => n + s.length, 0);
  const negFit = neg.filter((s) => {
    if (used + s.length > EXAMPLE_TOTAL_CHARS) return false;
    used += s.length;
    return true;
  });
  store.exampleSet = { builtAt: Date.now(), basedOn: active.length, pos, neg: negFit };
  persist();
  console.log(`[mem] \u793A\u4F8B\u5DF2\u91CD\u5EFA: \u6B63\u4F8B ${pos.length} \u6761 / \u53CD\u4F8B ${negFit.length} \u6761`);
  return true;
};
var shouldRebuildMemoryExamples = () => {
  const store = load();
  const active = store.memories.filter(isActiveMemory).length;
  if (active < EXAMPLE_COLD_START) return false;
  const e = store.exampleSet;
  if (!e) return true;
  return active - (e.basedOn ?? 0) >= EXAMPLE_REBUILD_AFTER;
};
var clearMemoryExamples = () => {
  const store = load();
  if (!store.exampleSet) return;
  store.exampleSet = void 0;
  examplesCleared = true;
  persist();
};
var NO_WRITE = { added: 0, updated: 0, invalidated: 0, intra: 0, expired: 0, lowvalue: 0, revived: 0 };
var diagLibSnapshot = (store) => ({
  active: store.memories.filter(isActiveMemory).length,
  faded: store.memories.filter((m) => !!m.fadedAt && !m.invalidAt).length,
  invalid: store.memories.filter((m) => !!m.invalidAt).length,
  total: store.memories.length,
  blocks: (store.blocks ?? []).length
});
var summarizeIfNeeded = async (messages, summarizeCall, withMemoryBlock = true, force = false) => {
  const store = load();
  const total = messages.length;
  const start = resumeIndex(store, messages);
  const pending = total - RAW_WINDOW - start;
  if (pending <= 0) {
    return false;
  }
  if (!force && pending < SUMMARIZE_THRESHOLD) return false;
  const diskRaw = readFile(FILE);
  const disk = tryParse(diskRaw);
  if (disk && disk.summarizedMsgCount > store.summarizedMsgCount) {
    adoptFromDisk(disk);
    return summarizeIfNeeded(messages, summarizeCall);
  }
  const batch = Math.min(pending, MAX_SUMMARIZE_BATCH);
  const newer = messages.slice(start, start + batch);
  const prompt = buildSummaryPrompt(
    newer,
    withMemoryBlock,
    withMemoryBlock ? knownMemoryList(store) : [],
    withMemoryBlock ? store.exampleSet : null
  );
  const content = (await summarizeCall(prompt)).trim();
  const diagBase = {
    msgs: batch,
    startIndex: start,
    promptChars: prompt.length,
    prompt: prompt.slice(0, DIAG_PROMPT_MAX),
    rawChars: content.length,
    raw: content.slice(0, DIAG_RAW_MAX)
  };
  if (!content) {
    recordOrganize({
      ...diagBase,
      topic: "",
      items: [],
      gated: [],
      deadLink: [],
      write: { ...NO_WRITE },
      summaryChars: 0,
      blockId: null,
      lib: diagLibSnapshot(store),
      note: "\u6A21\u578B\u8FD4\u56DE\u7A7A"
    });
    return false;
  }
  const parsedBlock = parseBlockOutput(content);
  const { summaryText, keyFacts } = splitSummaryKeys(parsedBlock.summaryText || content);
  let storedText = summaryText;
  const blockItems = parsedBlock.items;
  const worth = blockItems.filter((it) => isWorthRemembering({ type: it.type, importance: it.importance }));
  const gatedItems = blockItems.filter((it) => !isWorthRemembering({ type: it.type, importance: it.importance }));
  const gatedOut = gatedItems.length;
  if (gatedOut > 0) console.log(`[mem] \u5199\u5165\u95E8\u69DB\u6321\u4E0B ${gatedOut} \u6761\u4E0D\u91CD\u8981\u5185\u5BB9 (\u53EA\u7559\u5728\u6458\u8981\u91CC)`);
  const fresh = [];
  const deadLink = [];
  if (worth.length) {
    for (const it of worth) {
      if (matchesInvalidated(store, it.content)) {
        deadLink.push(it.content);
        continue;
      }
      fresh.push(makeMemoryItem({ content: it.content, type: it.type, importance: it.importance }));
    }
  } else if (!blockItems.length && keyFacts.length) {
    for (const fact of keyFacts) {
      for (const it of extractMemories(fact)) {
        if (matchesInvalidated(store, it.content)) {
          deadLink.push(it.content);
          continue;
        }
        fresh.push(it);
      }
    }
  }
  let write = { ...NO_WRITE };
  let diagBlockId = null;
  let diagNote = "";
  if (!blockItems.length) diagNote = keyFacts.length ? "\u8BB0\u5FC6\u5757 JSON \u672A\u89E3\u6790\u51FA\u6765 \u2192 \u8BB0\u5FC6\u8981\u70B9\u6587\u672C\u901A\u9053" : "\u8BB0\u5FC6\u5757 JSON \u672A\u89E3\u6790\u51FA\u6765\u4E14\u65E0\u8981\u70B9";
  if (worth.length) {
    const intra = invalidateIntraBatchReversals(fresh);
    const block = {
      id: blockIdFor(newer, start),
      fromTs: newer[0]?.ts ?? 0,
      toTs: newer[newer.length - 1]?.ts ?? 0,
      msgCount: batch,
      topic: parsedBlock.topic,
      summary: storedText,
      createdAt: Date.now(),
      itemIds: []
    };
    const wres = writeBlock(store, block, fresh);
    write = {
      added: wres.added,
      updated: wres.updated,
      invalidated: wres.invalidated,
      intra,
      expired: wres.expired,
      lowvalue: wres.lowvalue,
      revived: wres.revived
    };
    diagBlockId = block.id;
    if (!fresh.length) {
      storedText = `${summaryText}
${worth.map((i) => i.content).join("\uFF1B")}`;
      block.summary = storedText;
      diagNote = "\u5019\u9009\u5168\u88AB\u4F5C\u5E9F\u62A4\u680F\u6321\u4E0B \u2192 \u8981\u70B9\u9644\u56DE\u6458\u8981";
    } else {
      console.log(`[mem] \u8BB0\u5FC6\u5757\u5DF2\u5199\u5165 ${block.id}: ${worth.length} \u6761\u5019\u9009 \u2192 \u65B0\u589E ${wres.added} / \u5347\u7EA7 ${wres.updated} / \u4F5C\u5E9F ${wres.invalidated + intra}`);
    }
  } else if (fresh.length) {
    const mres = applyMerge(store, fresh);
    write = {
      added: mres.added,
      updated: mres.updated,
      invalidated: mres.invalidated,
      intra: 0,
      expired: mres.expired,
      lowvalue: mres.lowvalue,
      revived: mres.revived
    };
  } else if (keyFacts.length) {
    storedText = `${summaryText}
${keyFacts.join("\uFF1B")}`;
  }
  const newId = summaryIdFor(newer, start);
  replaceOverlappingSummary(store, newId);
  store.summaries.push(makeSummary(storedText, batch, newId));
  trimSummariesToMax();
  store.summarizedMsgCount = Math.max(store.summarizedMsgCount, (store.trimmedMsgCount ?? 0) + start + batch);
  recordOrganize({
    ...diagBase,
    topic: parsedBlock.topic,
    items: blockItems.map((it) => ({ c: it.content, t: it.type, i: it.importance })),
    gated: gatedItems.map((it) => ({ c: it.content, t: it.type, i: it.importance })),
    deadLink,
    write,
    summaryChars: storedText.length,
    blockId: diagBlockId,
    lib: diagLibSnapshot(store),
    note: diagNote
  });
  persist();
  return true;
};
var resumeIndex = (store, messages) => {
  let i = Math.min(
    Math.max(0, (store.summarizedMsgCount ?? 0) - (store.trimmedMsgCount ?? 0)),
    Math.max(0, messages.length - RAW_WINDOW)
  );
  while (i < messages.length && messages[i]?.role === "system") i += 1;
  return i;
};
var safeTrimDrop = (total) => {
  const store = load();
  const prefix = Math.max(0, (store.summarizedMsgCount ?? 0) - (store.trimmedMsgCount ?? 0));
  return Math.max(0, Math.min(prefix, Math.max(0, total - RAW_WINDOW)));
};
var organizeProgress = (messages) => {
  const store = load();
  const start = resumeIndex(store, messages);
  return { pending: Math.max(0, messages.length - RAW_WINDOW - start), threshold: SUMMARIZE_THRESHOLD };
};
var CONTEXT_RAW_MAX = RAW_WINDOW + MAX_SUMMARIZE_BATCH;
var contextHistory = (messages) => messages.filter((m) => !m.error).slice(-CONTEXT_RAW_MAX);
var recentTopicsBlock = (limit = 2) => {
  const store = load();
  const topics = (store.blocks ?? []).slice(-limit).map((b) => String(b.topic ?? "").trim()).filter(Boolean);
  if (!topics.length) return "";
  return `\u3010\u6700\u8FD1\u804A\u8FC7\u3011${topics.reverse().join(" \xB7 ")}`;
};
var clearMemory = () => {
  const old = cache;
  if (old) {
    markDeleted(old.memories);
    markDeleted(old.summaries);
    markDeleted(old.blocks ?? []);
  }
  skipDiskMerge = true;
  cache = {
    ...EMPTY_MEMORY_STORE,
    memories: [],
    summaries: [],
    summarizedMsgCount: 0,
    trimmedMsgCount: 0,
    // 墓碑保留: 被清掉的 id 不被另一实例的旧 cache 带回来
    tombstones: old?.tombstones ?? [],
    blocks: [],
    // 新数组: 别与常量共享引用 (push 会污染 EMPTY_MEMORY_STORE)
    deletedBin: []
  };
  persist();
};
var TAG_PIN = "pinned";
var isPinned = (m) => (m.tags ?? []).includes(TAG_PIN);
var hasPermanentTag = (m) => (m.tags ?? []).some((t) => t === "explicit" || t === "core");
var deleteMemory = (id) => {
  const store = load();
  const idx = store.memories.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  const [item] = store.memories.splice(idx, 1);
  markDeleted([item]);
  const bin = store.deletedBin ?? (store.deletedBin = []);
  bin.unshift({ ...item, deletedAt: Date.now() });
  if (bin.length > MAX_DELETED_BIN) {
    bin.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    store.deletedBin = bin.slice(0, MAX_DELETED_BIN);
  }
  pruneBlockRefs(store);
  stripFromExamples(store, item.content, false);
  persist();
  return true;
};
var pinMemory = (id, pin) => {
  const store = load();
  const m = store.memories.find((x) => x.id === id);
  if (!m) return false;
  store.memories = store.memories.map((x) => {
    if (x.id !== id) return x;
    const tags = new Set(x.tags ?? []);
    if (pin) tags.add(TAG_PIN);
    else tags.delete(TAG_PIN);
    const decayDays = pin ? null : hasPermanentTag(x) ? null : defaultDecayDays(x.type);
    return {
      ...x,
      tags: [...tags],
      decayDays,
      updatedAt: Date.now()
    };
  });
  persist();
  return true;
};
var isMemoryPinned = (id) => {
  const store = load();
  const m = store.memories.find((x) => x.id === id);
  return !!m && isPinned(m);
};
var BACKUP_FILE = "memory.before-clear.json";
var backupMemoryNow = () => {
  try {
    const store = load();
    if (!store.memories.length && !store.summaries.length) return false;
    return writeFile(BACKUP_FILE, JSON.stringify(store));
  } catch {
    return false;
  }
};
var hasMemoryBackup = () => {
  try {
    return !!tryParse(readFile(BACKUP_FILE));
  } catch {
    return false;
  }
};
var restoreMemoryBackup = () => {
  try {
    const backup = tryParse(readFile(BACKUP_FILE));
    if (!backup) return false;
    skipDiskMerge = true;
    deletedIds.clear();
    cache = backup;
    migrateToBlocks(cache, "");
    pruneBlockRefs(cache);
    persist();
    return true;
  } catch {
    return false;
  }
};
var TAG_GOAL = "goal";
var GOAL_CARE_INTERVAL_MS = 3 * 24 * 3600 * 1e3;
var GOAL_DONE_TIMEOUT_MS = 4e3;
var listGoals = () => {
  const store = load();
  return store.memories.filter((m) => (m.tags ?? []).includes(TAG_GOAL) && isActiveMemory(m)).sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
};
var addGoal = (text) => {
  const content = text.trim().slice(0, 120);
  if (!content) return false;
  const store = load();
  const item = {
    id: `g_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`,
    content,
    type: "project",
    importance: 0.85,
    confidence: 0.9,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: 0,
    accessCount: 0,
    tags: [TAG_GOAL],
    decayDays: null
  };
  applyMerge(store, [item]);
  const mergedAway = !store.memories.some((m) => m.id === item.id);
  const goalNorm = normalizeContent(content);
  store.memories = store.memories.map((m) => {
    const wasGoal = (m.tags ?? []).includes(TAG_GOAL);
    const mn = normalizeContent(m.content);
    const absorbed = !wasGoal && mergedAway && !!mn && !!goalNorm && (mn === goalNorm || mn.includes(goalNorm) || goalNorm.includes(mn));
    if (!wasGoal && !absorbed) return m;
    return {
      ...m,
      tags: wasGoal ? m.tags : [.../* @__PURE__ */ new Set([...m.tags ?? [], TAG_GOAL])],
      decayDays: null,
      updatedAt: Date.now()
      // 刷新: 双实例合并按 updatedAt 取新, 防旧副本把标签盖回去
    };
  });
  persist();
  return true;
};
var removeGoal = (id) => deleteMemory(id);
var goalCarePrompt = () => {
  const store = load();
  const now = Date.now();
  const goals = store.memories.filter((m) => (m.tags ?? []).includes(TAG_GOAL) && isActiveMemory(m));
  if (!goals.length) return "";
  let oldest = null;
  let oldestT = Infinity;
  for (const g of goals) {
    const t = Math.max(g.updatedAt ?? 0, g.createdAt ?? 0);
    if (t < oldestT) {
      oldestT = t;
      oldest = g;
    }
  }
  if (!oldest || now - oldestT < GOAL_CARE_INTERVAL_MS) return "";
  store.memories = store.memories.map(
    (m) => m.id === oldest.id ? { ...m, updatedAt: now } : m
  );
  persist();
  const days = Math.max(1, Math.round((now - oldestT) / 864e5));
  return `\u3010\u81EA\u7136\u5730\u5173\u5FC3\u3011\u4E3B\u4EBA\u6709\u4E2A\u76EE\u6807\u300C${oldest.content}\u300D\uFF0C\u5DF2\u7ECF ${days} \u5929\u6CA1\u95EE\u8FC7\u8FDB\u5C55\u4E86\u3002\u53EF\u4EE5\u5728\u56DE\u590D\u91CC\u81EA\u7136\u5730\u5E26\u4E00\u53E5\u95EE\u95EE\u8FDB\u5C55\uFF0C\u522B\u8BF4\u6559\uFF0C\u522B\u6BCF\u6B21\u90FD\u95EE\u3002`;
};
var buildLlmGoalDonePrompt = (goals, userText, recent = []) => {
  const ctx = recent.length ? recent.map((m) => `${m.role === "user" ? "\u4E3B\u4EBA" : "Nori"}: ${String(m.content ?? "").replace(/\s+/g, " ").slice(0, 100)}`).join("\n") : "(\u65E0)";
  return [
    "\u4F60\u5728\u7EF4\u62A4\u300C\u966A\u7740\u4F60\u7684\u4E8B\u300D\u8FD9\u4EFD\u76EE\u6807\u6E05\u5355\u3002\u5224\u65AD\u4E3B\u4EBA**\u521A\u521A\u8FD9\u53E5\u8BDD**\u662F\u5426\u8868\u793A\u67D0\u4E2A\u76EE\u6807\u5DF2\u7ECF\u6536\u5C3E\u3002",
    "",
    "\u3010\u4EC0\u4E48\u7B97\u6536\u5C3E\u3011(\u53EA\u6709\u8FD9\u4E24\u79CD)",
    "- \u5DF2\u5B8C\u6210: \u660E\u786E\u8BF4\u505A\u5B8C\u4E86/\u8003\u5B8C\u4E86/\u7ED3\u675F\u4E86/\u641E\u5B9A\u4E86/\u8FBE\u6210\u7B49;",
    "- \u5DF2\u653E\u5F03: \u660E\u786E\u8BF4\u4E0D\u505A\u4E86/\u653E\u5F03\u4E86/\u4E0D\u6253\u7B97\u4E86/\u6CA1\u5FC5\u8981\u4E86/\u7B97\u4E86\u4E0D\u5F04\u4E86\u7B49\u3002",
    "",
    "\u3010\u4EC0\u4E48\u4E0D\u7B97 **\u4E00\u5F8B\u4E0D\u8981\u5220**\u3011",
    '- \u53EA\u662F\u63D0\u5230\u3001\u804A\u5230\u3001\u95EE\u8FDB\u5EA6 (\u5982"\u8FD8\u5728\u5F04"/"\u5FEB\u4E86"/"\u6700\u8FD1\u6709\u70B9\u5FD9");',
    "- \u53EA\u662F\u62B1\u6028\u3001\u60C5\u7EEA\u3001\u73A9\u7B11\u3001\u53CD\u95EE;",
    "- \u542B\u7CCA\u4E0D\u6E05\u3001\u4F60\u4E0D\u786E\u5B9A \u2014\u2014 \u4E0D\u786E\u5B9A\u5C31**\u4E0D\u8981\u5220**\u3002",
    "",
    "\u3010\u8F93\u51FA\u8981\u6C42\u3011",
    '- \u53EA\u8F93\u51FA JSON, \u4E0D\u8981\u89E3\u91CA\u3002\u683C\u5F0F: {"done":[{"id":"\u76EE\u6807id","reason":"\u4E00\u53E5\u8BDD\u4F9D\u636E"}]};',
    '- \u6CA1\u6709\u6536\u5C3E\u7684\u76EE\u6807\u5C31\u8F93\u51FA {"done":[]};',
    "- id \u53EA\u80FD\u7528\u4E0B\u9762\u6E05\u5355\u91CC\u7ED9\u51FA\u7684, **\u4E0D\u8981\u7F16\u9020**\u3002",
    "",
    "\u3010\u76EE\u6807\u6E05\u5355 (\u53EA\u80FD\u5F15\u7528\u8FD9\u4E9B id)\u3011",
    goals.length ? goals.map((g) => `${g.id} | ${g.content}`).join("\n") : "(\u65E0)",
    "",
    "\u3010\u6700\u8FD1\u5BF9\u8BDD (\u53EA\u7528\u4E8E\u7406\u89E3\u6307\u4EE3)\u3011",
    ctx,
    "",
    "\u3010\u4E3B\u4EBA\u521A\u521A\u8BF4\u3011",
    userText
  ].join("\n");
};
var parseLlmGoalDone = (raw, validIds) => {
  let text = String(raw ?? "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1].trim();
  let arr = null;
  const oStart = text.indexOf("{");
  const oEnd = text.lastIndexOf("}");
  if (oStart !== -1 && oEnd > oStart) {
    try {
      const obj = JSON.parse(text.slice(oStart, oEnd + 1));
      const candidate = obj.done ?? obj.finished ?? obj.completed ?? obj.goals;
      if (Array.isArray(candidate)) arr = candidate;
    } catch {
    }
  }
  if (!Array.isArray(arr)) {
    const aStart = text.indexOf("[");
    const aEnd = text.lastIndexOf("]");
    if (aStart !== -1 && aEnd > aStart) {
      try {
        const candidate = JSON.parse(text.slice(aStart, aEnd + 1));
        if (Array.isArray(candidate)) arr = candidate;
      } catch {
      }
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of arr) {
    const id = typeof item === "string" ? item.trim() : String(item?.id ?? "").trim();
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const reason = typeof item === "string" ? "" : String(item?.reason ?? "").slice(0, 60);
    out.push({ id, reason });
  }
  return out;
};
var pruneDoneGoals = async (userText, llmCall, recent = []) => {
  if (!llmCall) return [];
  const goals = listGoals();
  if (!goals.length) return [];
  let raw = "";
  try {
    raw = await withTimeout(
      llmCall(buildLlmGoalDonePrompt(goals.map((g) => ({ id: g.id, content: g.content })), userText, recent)),
      GOAL_DONE_TIMEOUT_MS
    );
  } catch {
    return [];
  }
  const valid = new Set(goals.map((g) => g.id));
  const hits = parseLlmGoalDone(raw, valid);
  if (!hits.length) return [];
  const removed = [];
  for (const h of hits) {
    const g = goals.find((x) => x.id === h.id);
    if (!g) continue;
    if (removeGoal(h.id)) removed.push(g.content);
  }
  return removed;
};
var notifyHistoryTrimmed = (droppedCount) => {
  const store = load();
  const n = Math.max(0, Math.floor(droppedCount) || 0);
  if (!n) return;
  store.trimmedMsgCount = (store.trimmedMsgCount ?? 0) + n;
  persist();
};
var __isReversalForTest = (oldContent, newContent) => isReversal(oldContent, newContent);
var __getSummaryCursorForTest = () => load().summarizedMsgCount;
var __setSummaryCursorForTest = (n) => {
  load().summarizedMsgCount = Math.max(0, Math.floor(n) || 0);
};
var reloadMemory = () => {
  cache = null;
  load();
};
export {
  CONTEXT_RAW_MAX,
  MAX_DIAG_RECORDS,
  __getSummaryCursorForTest,
  __isReversalForTest,
  __setSummaryCursorForTest,
  addGoal,
  addMemoriesFromText,
  addMemoriesWithLlm,
  applyLlmMemoryDecision,
  backupMemoryNow,
  buildDiagJsonl,
  buildLlmAnalyzePrompt,
  buildLlmExtractPrompt,
  buildLlmGoalDonePrompt,
  buildLlmMemoryDecisionPrompt,
  buildLlmRelevancePrompt,
  clearDiag,
  clearMemory,
  clearMemoryExamples,
  contextHistory,
  deleteMemory,
  deleteMemoryForever,
  diagCount,
  diagEnabled,
  extractMemories,
  extractMemoriesSmart,
  fadeMemoryManually,
  flushMemoryPersist,
  getMemoryExamples,
  goalCarePrompt,
  hasMemoryBackup,
  invalidateMemory,
  isMemoryPinned,
  lastDiagRecord,
  listAll,
  listBlocks,
  listDeletedMemories,
  listFadedMemories,
  listGoals,
  listInvalidMemories,
  listUnblockedMemories,
  memoryStats,
  mergeLlmMemories,
  notifyHistoryTrimmed,
  openingMemoryBlock,
  organizeProgress,
  parseLlmAnalyze,
  parseLlmGoalDone,
  parseLlmMemories,
  parseLlmMemoryDecision,
  parseLlmRelevance,
  pinMemory,
  pruneBlockRefs,
  pruneDoneGoals,
  pruneStaleMemories,
  pruneStalePreview,
  rebuildMemoryExamples,
  recallForQuery,
  recallForQuerySmart,
  recentTopicsBlock,
  recordOrganize,
  reloadMemory,
  removeGoal,
  restoreDeletedMemory,
  restoreFadedMemory,
  restoreMemory,
  restoreMemoryBackup,
  safeTrimDrop,
  setDiagEnabled,
  shouldRebuildMemoryExamples,
  shouldSkipLlmExtract,
  summarizeIfNeeded,
  summaryBlock
};
