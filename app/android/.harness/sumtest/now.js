// web-src/src/services/chat/index.ts
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
    return bridge().writeFile(name, content) === "ok";
  } catch {
    return false;
  }
};
var chatQueue = Promise.resolve();
var streamQueue = Promise.resolve();

// web-src/src/services/memory/core.ts
var EMPTY_MEMORY_STORE = {
  memories: [],
  summaries: [],
  summarizedMsgCount: 0,
  meta: [],
  tombstones: []
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
var dedupeByContent = (items) => {
  const kept = [];
  for (const item of items) {
    const norm = normalizeContent(item.content);
    const dup = kept.some((k) => {
      const kn = normalizeContent(k.content);
      return kn === norm || kn.includes(norm) || norm.includes(kn);
    });
    if (!dup) kept.push(item);
  }
  return kept;
};
var mergeMemories = (newItems, existing) => {
  const added = [];
  const updated = [];
  const pool = [...existing];
  const now = Date.now();
  for (const item of newItems) {
    const norm = normalizeContent(item.content);
    const idx = pool.findIndex((prev2) => {
      const pn = normalizeContent(prev2.content);
      return pn && (pn === norm || pn.includes(norm) || norm.includes(pn));
    });
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
  '- DELETE: \u65B0\u4E8B\u5B9E\u4E0E\u5E93\u91CC\u65E7\u8BB0\u5FC6**\u77DB\u76FE** (\u5982\u65E7"\u559C\u6B22\u4E0B\u96E8\u5929" vs \u65B0"\u4E0D\u559C\u6B22\u4E0B\u96E8\u5929") \u2192 \u5220\u6389\u65E7\u8BB0\u5FC6;',
  "- NONE: \u5E93\u91CC\u5DF2\u6709\u5B8C\u5168\u76F8\u540C\u7684\u4FE1\u606F, \u4E0D\u9700\u8981\u6539\u52A8\u3002",
  "",
  "\u89C4\u5219:",
  '1. \u53EA\u5904\u7406"\u540C\u4E00\u4EF6\u4E8B"; \u65E0\u5173\u7684\u65E7\u8BB0\u5FC6\u4E0D\u8981\u51FA\u73B0\u5728\u8F93\u51FA\u91CC;',
  "2. UPDATE/DELETE \u5FC5\u987B\u4F7F\u7528\u4E0B\u9762\u300C\u5DF2\u6709\u8BB0\u5FC6\u300D\u4E2D\u7ED9\u51FA\u7684 id, \u4E0D\u8981\u7F16\u9020 id;",
  '3. ADD \u7684 id \u7EDF\u4E00\u5199 "new";',
  "4. text \u5199\u8FD9\u4EF6\u4E8B\u6700\u7EC8\u5E94\u5B58\u7684\u5185\u5BB9 (20 \u5B57\u5185\u3001\u4E3B\u4EBA\u7B2C\u4E00\u4EBA\u79F0\u77ED\u53E5); \u540C\u4E49\u6539\u5199\u65F6\u4F18\u5148\u4FDD\u7559\u4FE1\u606F\u66F4\u5168\u7684\u7248\u672C;",
  "5. UPDATE \u7684 text \u8BF7\u76F4\u63A5\u91C7\u7528\u5BF9\u5E94\u65B0\u4E8B\u5B9E\u7684\u539F\u63AA\u8F9E (\u53EA\u505A\u8F7B\u5FAE\u987A\u53E5), \u4E0D\u8981\u53E6\u8D77\u4E00\u5957\u8BF4\u6CD5 \u2014\u2014 \u5426\u5219\u540C\u4E00\u4EF6\u4E8B\u4F1A\u5728\u5E93\u91CC\u7559\u4E0B\u4E24\u79CD\u5199\u6CD5;",
  '6. \u53EA\u8F93\u51FA JSON, \u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u6587\u5B57\u3002\u683C\u5F0F: {"memory":[{"id":"...","text":"...","event":"ADD"}]}',
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
  const scored = items.filter((item) => overlapCount(tokens, item) > 0).map((item) => ({ item, score: scoreMemory(tokens, item, now) })).sort((a, b) => b.score - a.score);
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
var buildSummaryPrompt = (messages) => {
  const text = messages.map((m) => `${m.role === "user" ? "\u7528\u6237" : "Nori"}: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
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
var makeSummary = (content, msgCount, id) => ({
  // id 可由调用方传区间指纹 (见 summaryIdFor): 双实例对同一区间并发总结时产出相同 id,
  // 落盘合并按 id 去重只留一份; 不传则退回随机 uid (兼容旧调用)
  id: id ?? uid(),
  content: softTruncate(content, MAX_SUMMARY_CHARS),
  createdAt: Date.now(),
  msgCount,
  tokenCount: Math.max(1, Math.ceil(content.length / 4))
});
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
var PRUNE_AFTER = 150;
var STALE_DAYS = 30;
var EXPIRE_MULT = 3;
var expireMemories = (items) => {
  if (!items.length) return [];
  const now = Date.now();
  const drop = items.filter((it) => {
    const days = it.decayDays;
    if (!days || days <= 0) return false;
    if (it.accessCount >= 2) return false;
    const t = Math.max(it.lastAccessedAt, it.updatedAt, it.createdAt);
    if (!t) return false;
    const expireMs = days * EXPIRE_MULT * 24 * 3600 * 1e3;
    return now - t > expireMs;
  });
  if (!drop.length) return items;
  const dropIds = new Set(drop.map((d) => d.id));
  return items.filter((it) => !dropIds.has(it.id));
};
var pruneMemories = (items) => {
  if (items.length <= PRUNE_AFTER) return [];
  let working = items;
  const now = Date.now();
  const staleMs = STALE_DAYS * 24 * 3600 * 1e3;
  const stale = working.filter(
    (it) => it.decayDays !== null && it.importance < 0.6 && now - Math.max(it.lastAccessedAt, it.createdAt) > staleMs && it.accessCount < 2
  );
  if (stale.length) {
    const staleIds = new Set(stale.map((s) => s.id));
    working = working.filter((it) => !staleIds.has(it.id));
  }
  if (working.length > MAX_MEMORIES) {
    const droppable = working.filter((it) => it.decayDays !== null);
    const scored = droppable.map((it) => ({
      it,
      score: (it.importance * 0.6 + recencyScore(it, now) * 0.3 + Math.min(it.accessCount, 10) / 10 * 0.1) * decayFactor(it, now)
    })).sort((a, b) => a.score - b.score);
    const overflow = working.length - MAX_MEMORIES;
    const drop = scored.slice(0, overflow).map((s) => s.it);
    const dropIds = new Set(drop.map((d) => d.id));
    working = working.filter((it) => !dropIds.has(it.id));
  }
  return items.filter((it) => !working.some((w) => w.id === it.id));
};
var newerOf = (x, y) => (x.updatedAt ?? x.createdAt) >= (y.updatedAt ?? y.createdAt) ? x : y;
var newerMemory = (a, b) => {
  const aU = a.updatedAt ?? a.createdAt;
  const bU = b.updatedAt ?? b.createdAt;
  if (aU !== bU) return aU > bU ? a : b;
  if (a.lastAccessedAt !== b.lastAccessedAt) return a.lastAccessedAt > b.lastAccessedAt ? a : b;
  return a.accessCount >= b.accessCount ? a : b;
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
  return {
    memories: [...mem.values()],
    summaries: [...sum.values()],
    summarizedMsgCount: Math.max(a.summarizedMsgCount, b.summarizedMsgCount),
    tombstones: [...tombs.entries()].map(([id, at]) => ({ id, at })),
    meta: [...meta.values()]
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

// web-src/src/services/memory/index.ts
var FILE = "memory.json";
var FILE_BAK = "memory.json.bak";
var RAW_WINDOW = 20;
var SUMMARIZE_THRESHOLD = 25;
var MAX_SUMMARIZE_BATCH = 25;
var MAX_SUMMARIES = 24;
var MEMORY_BLOCK_LIMIT = 6;
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
  const merged = mergeStores(disk, cache);
  cache.memories = merged.memories;
  cache.summaries = merged.summaries;
  cache.summarizedMsgCount = merged.summarizedMsgCount;
  cache.tombstones = merged.tombstones;
};
var trimSummariesToMax = () => {
  if (!cache || cache.summaries.length <= MAX_SUMMARIES) return 0;
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
      tombstones,
      // 折叠归档: 旧数据没有该字段 → 空数组; 同样做形状校验 (坏元素会污染注入块)
      meta: Array.isArray(parsed.meta) ? parsed.meta.filter((m) => !!m && typeof m === "object" && typeof m.id === "string" && m.id && typeof m.content === "string" && m.content) : []
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
var load = () => {
  if (cache) return cache;
  const rawMain = readFile(FILE);
  lastWrittenRaw = rawMain || null;
  let store = tryParse(rawMain);
  if (store) {
    cache = applySessionTombstones(store);
    backfillDecay(cache);
    const trimmed = trimSummariesToMax() > 0;
    if (cache !== store || trimmed) lastWrittenRaw = null;
    if (trimmed) flushPersist();
    return cache;
  }
  store = tryParse(readFile(FILE_BAK));
  if (store) {
    cache = applySessionTombstones(store);
    backfillDecay(cache);
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
    tombstones: []
    // 新数组: 别与 EMPTY_MEMORY_STORE 共享引用, 否则 markDeleted 会污染常量
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
  return { memoryCount: store.memories.length, summaryCount: store.summaries.length };
};
var listAll = () => {
  const store = load();
  return {
    memories: [...store.memories].sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt),
    summaries: [...store.summaries].sort((a, b) => b.createdAt - a.createdAt)
  };
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
var PREF_PREFIXES = ["\u6211", "\u81EA\u5DF1", "\u6700\u8FD1", "\u73B0\u5728", "\u4E00\u76F4", "\u5E73\u65F6", "\u8D85", "\u633A", "\u86EE", "\u5F88", "\u7279\u522B", "\u6700", "\u597D"];
var parsePref = (content) => {
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
  let dir = null;
  for (const [w, like] of PREF_DIR_WORDS) {
    if (rest.startsWith(w)) {
      rest = rest.slice(w.length);
      dir = like;
      break;
    }
  }
  if (dir === null) return null;
  rest = rest.replace(/[。！？!?，,、\s]+$/g, "");
  for (let guard = 0; guard < 4; guard++) {
    const before = rest;
    rest = rest.replace(/(?:了|啊|呢|吧|嘛|哈|哟|哦|啦)+$/g, "");
    if (rest === before) break;
  }
  if (!rest) return null;
  return { obj: rest, like: dir };
};
var isPrefReversal = (oldContent, newContent) => {
  const a = parsePref(oldContent);
  const b = parsePref(newContent);
  if (!a || !b) return false;
  if (a.like === b.like) return false;
  return a.obj === b.obj || a.obj.includes(b.obj) || b.obj.includes(a.obj);
};
var applyMerge = (store, fresh) => {
  const reverseIds = /* @__PURE__ */ new Set();
  for (const it of fresh) {
    if (it.type !== "preference") continue;
    for (const old of store.memories) {
      if (old.type !== "preference") continue;
      if (isPrefReversal(old.content, it.content)) reverseIds.add(old.id);
    }
  }
  if (reverseIds.size) {
    const removed = store.memories.filter((m) => reverseIds.has(m.id));
    markDeleted(removed);
    store.memories = store.memories.filter((m) => !reverseIds.has(m.id));
  }
  const { added, updated } = mergeMemories(fresh, store.memories);
  if (updated.length) {
    const upd = new Map(updated.map((u) => [u.id, u]));
    store.memories = store.memories.map((m) => upd.get(m.id) ?? m);
  }
  if (added.length) {
    store.memories = [...store.memories, ...added];
  }
  const beforeExpire = store.memories;
  store.memories = expireMemories(store.memories);
  const expired = beforeExpire.filter((m) => !store.memories.some((x) => x.id === m.id));
  markDeleted(expired);
  const dropped = pruneMemories(store.memories);
  if (dropped.length) {
    markDeleted(dropped);
    const dropIds = new Set(dropped.map((d) => d.id));
    store.memories = store.memories.filter((it) => !dropIds.has(it.id));
  }
  return {
    added: added.length,
    updated: updated.length,
    changed: added.length > 0 || updated.length > 0 || expired.length > 0 || dropped.length > 0
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
  if (!facts.length) return { added: 0, updated: 0, deleted: 0, usedLlm: false };
  const store = load();
  const candidates = /* @__PURE__ */ new Map();
  const factCands = facts.map(() => /* @__PURE__ */ new Set());
  let keywordHit = false;
  for (let i = 0; i < facts.length; i += 1) {
    const factTokens = new Set(tokenize(facts[i].content));
    for (const hit of recallMemories(store.memories, facts[i].content, 5).hits) {
      candidates.set(hit.id, hit);
      factCands[i].add(hit.id);
      if (!keywordHit && hit.content) {
        let overlap = 0;
        for (const tk of tokenize(hit.content)) {
          if (!factTokens.has(tk)) continue;
          overlap += 1;
          if (overlap >= 2) break;
        }
        if (overlap >= 2 || overlap >= 1 && factTokens.size <= 2) keywordHit = true;
      }
    }
    if (candidates.size >= DECISION_CANDIDATES) break;
  }
  if (candidates.size < DECISION_CANDIDATES && store.memories.length) {
    const byRecent = [...store.memories].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)).slice(0, 6);
    const byImportance = [...store.memories].sort((a, b) => b.importance - a.importance).slice(0, 6);
    for (const m of [...byRecent, ...byImportance]) {
      if (candidates.size >= DECISION_CANDIDATES) break;
      candidates.set(m.id, m);
    }
  }
  const existing = [...candidates.values()].slice(0, DECISION_CANDIDATES);
  if (!existing.length || !keywordHit) {
    const mres2 = applyMerge(store, facts);
    if (mres2.changed) persist();
    return { added: mres2.added, updated: 0, deleted: 0, usedLlm: false };
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
  const absorbed = /* @__PURE__ */ new Set();
  if (decisions.length) {
    const byId = new Map(store.memories.map((m) => [m.id, m]));
    const now = Date.now();
    const delIds = /* @__PURE__ */ new Set();
    const patch = /* @__PURE__ */ new Map();
    const patchedIds = /* @__PURE__ */ new Set();
    for (const d of decisions) {
      const old = byId.get(d.id);
      if (!old) continue;
      if (d.event === "DELETE") {
        const explicit = (old.tags ?? []).some((t) => t === "core" || t === "explicit" || t === "pinned");
        if (explicit || old.importance >= 0.85) continue;
        delIds.add(d.id);
        continue;
      }
      if (d.event === "UPDATE" && d.text && d.text.length >= old.content.length) {
        patch.set(d.id, d.text);
        patchedIds.add(d.id);
      }
    }
    if (patchedIds.size) {
      facts.forEach((_, i) => {
        for (const id of factCands[i]) {
          if (patchedIds.has(id)) {
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
    if (delIds.size) {
      const removed = store.memories.filter((m) => delIds.has(m.id));
      markDeleted(removed);
      store.memories = store.memories.filter((m) => !delIds.has(m.id));
      deleted = removed.length;
    }
  }
  const toWrite = absorbed.size ? facts.filter((_, i) => !absorbed.has(i)) : facts;
  const mres = toWrite.length ? applyMerge(store, toWrite) : { added: 0, updated: 0, changed: false };
  if (mres.changed) persist();
  return { added: mres.added, updated: updated + mres.updated, deleted, usedLlm: decisions.length > 0 };
};
var extractMemoriesSmart = async (userText, llmCall, recentContext = []) => {
  const result = { added: 0, updated: 0, deleted: 0, usedLlm: false, tips: [] };
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
  const all = store.memories;
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
var summarizeIfNeeded = async (messages, summarizeCall) => {
  const store = load();
  const total = messages.length;
  const start = Math.min(store.summarizedMsgCount, Math.max(0, total - RAW_WINDOW));
  const pending = total - RAW_WINDOW - start;
  if (pending <= 0) {
    return false;
  }
  if (pending < SUMMARIZE_THRESHOLD) return false;
  const diskRaw = readFile(FILE);
  const disk = tryParse(diskRaw);
  if (disk && disk.summarizedMsgCount > store.summarizedMsgCount) {
    adoptFromDisk(disk);
    return summarizeIfNeeded(messages, summarizeCall);
  }
  const batch = Math.min(pending, MAX_SUMMARIZE_BATCH);
  const newer = messages.slice(start, start + batch);
  const content = (await summarizeCall(buildSummaryPrompt(newer))).trim();
  if (!content) return false;
  const { summaryText, keyFacts } = splitSummaryKeys(content);
  let storedText = summaryText;
  if (keyFacts.length) {
    const fresh = [];
    for (const fact of keyFacts) fresh.push(...extractMemories(fact));
    if (fresh.length) {
      applyMerge(store, fresh);
    } else {
      storedText = `${summaryText}
${keyFacts.join("\uFF1B")}`;
    }
  }
  store.summaries.push(makeSummary(storedText, batch, summaryIdFor(newer, start)));
  trimSummariesToMax();
  store.summarizedMsgCount = Math.max(store.summarizedMsgCount, start + batch);
  persist();
  return true;
};
var clearMemory = () => {
  const old = cache;
  if (old) {
    markDeleted(old.memories);
    markDeleted(old.summaries);
  }
  skipDiskMerge = true;
  cache = {
    ...EMPTY_MEMORY_STORE,
    memories: [],
    summaries: [],
    summarizedMsgCount: 0,
    // 墓碑保留: 被清掉的 id 不被另一实例的旧 cache 带回来
    tombstones: old?.tombstones ?? []
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
  markDeleted([store.memories[idx]]);
  store.memories.splice(idx, 1);
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
    persist();
    return true;
  } catch {
    return false;
  }
};
var TAG_GOAL = "goal";
var GOAL_CARE_INTERVAL_MS = 3 * 24 * 3600 * 1e3;
var listGoals = () => {
  const store = load();
  return store.memories.filter((m) => (m.tags ?? []).includes(TAG_GOAL)).sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
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
  const goals = store.memories.filter((m) => (m.tags ?? []).includes(TAG_GOAL));
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
var notifyHistoryTrimmed = (keptCount) => {
  const store = load();
  store.summarizedMsgCount = Math.max(0, Math.floor(keptCount) || 0);
  persist();
};
var reloadMemory = () => {
  cache = null;
  load();
};
export {
  addGoal,
  addMemoriesFromText,
  addMemoriesWithLlm,
  applyLlmMemoryDecision,
  backupMemoryNow,
  buildLlmAnalyzePrompt,
  buildLlmExtractPrompt,
  buildLlmMemoryDecisionPrompt,
  buildLlmRelevancePrompt,
  clearMemory,
  deleteMemory,
  extractMemories,
  extractMemoriesSmart,
  flushMemoryPersist,
  goalCarePrompt,
  hasMemoryBackup,
  isMemoryPinned,
  listAll,
  listGoals,
  memoryStats,
  mergeLlmMemories,
  notifyHistoryTrimmed,
  parseLlmAnalyze,
  parseLlmMemories,
  parseLlmMemoryDecision,
  parseLlmRelevance,
  pinMemory,
  pruneStaleMemories,
  pruneStalePreview,
  recallForQuery,
  recallForQuerySmart,
  reloadMemory,
  removeGoal,
  restoreMemoryBackup,
  shouldSkipLlmExtract,
  summarizeIfNeeded,
  summaryBlock
};
