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
var expireMemories = (items) => {
  if (!items.length) return [];
  const drop = pickExpiredMemories(items);
  if (!drop.length) return items;
  const dropIds = new Set(drop.map((d) => d.id));
  return items.filter((it) => !dropIds.has(it.id));
};
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
export {
  COLLAPSE_MAX_MERGES,
  EMPTY_MEMORY_STORE,
  EXPIRE_MULT,
  MAX_DELETED_BIN,
  MAX_MEMORIES,
  MAX_METAS,
  MAX_META_CHARS,
  MAX_SUMMARY_CHARS,
  MEMORY_SCHEMA_VERSION,
  MEMORY_TYPES,
  MEM_BLOCK_MAX_ITEMS,
  MEM_SENTINEL,
  META_EXCERPT_CHARS,
  META_INJECT_LIMIT,
  MIN_IMPORTANCE_KEEP,
  MIN_IMPORTANCE_PASS,
  MIN_IMPORTANCE_SOFT,
  NEAR_DUP_DICE,
  PRUNE_AFTER,
  SUMMARY_BLOCK_BUDGET,
  TOPIC_MAX_CHARS,
  blockIdFor,
  buildLlmAnalyzePrompt,
  buildLlmExtractPrompt,
  buildLlmMemoryDecisionPrompt,
  buildLlmRelevancePrompt,
  buildMemoryBlock,
  buildSummaryBlock,
  buildSummaryPrompt,
  capSummaries,
  collapseDuplicateMemories,
  contentSimilarity,
  decayFactor,
  dedupeByContent,
  defaultDecayDays,
  expireMemories,
  extractMemories,
  findMergeTarget,
  foldDroppedSummaries,
  isActiveMemory,
  isSameContent,
  isWorthRemembering,
  makeMemoryItem,
  makeSummary,
  mergeMemories,
  mergeStores,
  normalizeContent,
  normalizeForCompare,
  overlapCount,
  parseBlockOutput,
  parseLlmAnalyze,
  parseLlmMemories,
  parseLlmMemoryDecision,
  parseLlmRelevance,
  pickExpiredMemories,
  pruneMemories,
  rangeOfSummary,
  recallMemories,
  scoreMemory,
  shouldSkipLlmExtract,
  softTruncate,
  summariesOverlap,
  summaryIdFor,
  tokenize
};
