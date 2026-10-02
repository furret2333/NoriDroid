// ../src/services/live2d/markerRules.ts
var EMOTION_RULES = [
  { key: /开心|高兴|happy|哈哈|嘿嘿|太棒|好呀|超棒|真棒|喜欢|笑嘻嘻|耶|太好了|好耶|开心极了|好开心|好高兴|太开心/, match: ["happy", "smile", "kira"] },
  { key: /被夸|夸我|好温柔|温柔|贴心|谢谢你|谢谢|感动|暖心|暖暖的/, match: ["happy", "smile", "kira", "shy"] },
  { key: /想你|想念|回来啦|回来了|终于回来|好想你|等你|盼你/, match: ["happy", "smile", "shy"] },
  { key: /赢了|赢啦|胜利|通关|过关|赢了赢了/, match: ["happy", "smile", "kira", "surprised"] },
  { key: /生气|讨厌|不喜欢|气死|居然|过分|气鼓|好气|气人|太过分|生气了/, match: ["angry"] },
  { key: /难过|伤心|失落|孤单|想念|呜呜|哭了|想哭|难受|好想|好难过|不开心|委屈/, match: ["sad", "tears", "troubled", "worried"] },
  { key: /害羞|不好意思|唔\.\.|诶\.\.|脸红了|害羞了|好害羞/, match: ["shy"] },
  { key: /困了|好困|累|想睡|睡觉|打哈欠|哈欠|困死了/, match: ["sleep"] },
  { key: /惊讶|诶！|哇|不会吧|真的吗|嚇|吓到|居然|天哪|哇塞/, match: ["surprised"] },
  { key: /认真|严肃|重要|承诺|答应|一定|放心/, match: ["serious", "angry"] },
  { key: /无奈|叹气|真是|哎|算了|好吧好吧/, match: ["speechless", "doubt", "troubled"] },
  { key: /别难过|没事|安慰|抱抱|摸摸头|不哭|别怕|不要怕/, match: ["shy", "smile", "happy"] },
  // ---- 以下为按真实模型补的表情 (原来提示词的**表情**词表里没有这三个词, 于是永远触发不到) ----
  { key: /头晕|晕了|晕乎乎|眼花/, match: ["dizzy"] },
  { key: /疑惑|不解|困惑|奇怪|搞不懂|疑问/, match: ["doubt", "troubled"] },
  // 注: 刻意不收「讨厌」—— 它在更前面的"生气"规则里, 会先命中 angry
  { key: /嫌弃|厌恶|恶心|受不了/, match: ["disgust"] }
];
var MOTION_RULES = [
  // 注: 候选名按"先真实存在的"排序 —— 本项目只用 ARGNori / Nori 两个模型,
  // 真实动作名见 docs/动作表情机理.md (Nod / ShakeHead / WakuWaku / Angry / Troubled /
  // Dizzy / Stare / Doubt / Bow / NoNoNo / sleep)。原来表里那批 happy/jump/wave/hug/dance
  // 在两个模型里**一个都不存在**, 导致大量词落空 → 修表。
  { key: /开心|高兴|哈哈|嘿嘿|太棒|好呀|超棒|真棒|喜欢|赢啦|赢了|耶|太好了|好耶|兴奋|期待/, match: ["waku", "happy", "satisfied", "cheerful", "smile", "jump", "victory", "win", "excited"] },
  { key: /难过|伤心|失落|孤单|想念|想哭|呜呜|难受|委屈/, match: ["troubled", "sad", "cry", "worry", "down", "sigh"] },
  { key: /害羞|不好意思|脸红|诶\.\.|唔\.\.|好害羞/, match: ["shy", "embarrass", "flustered", "hide"] },
  { key: /困|好累|想睡|睡觉|哈欠|打哈欠|困死了/, match: ["sleep", "sleepy", "tired", "yawn", "stretch"] },
  // 惊讶: 模型里**没有**"惊讶"动作。原先候选里有 dizzy, 于是"惊讶"被映射成 Dizzy(头晕) —— 语义错误。
  // 现在让它自然落空 → playIdleFallback(中性 idle), 不再演成头晕。
  { key: /惊讶|哇|真的吗|不会吧|居然|天哪|吓到|哇塞/, match: ["surprised", "surprise", "shock", "wow"] },
  { key: /生气|讨厌|过分|气鼓|好气|气人|生气了/, match: ["angry", "pout", "annoyed"] },
  { key: /游戏|玩|来一局|对战|开黑|打游戏/, match: ["game", "play", "fight", "battle"] },
  { key: /摸摸|摸头|摸/, match: ["pet", "headpat", "touch", "happy"] },
  { key: /抱抱|抱一下|拥抱|求抱/, match: ["hug", "embrace", "arms", "happy"] },
  { key: /跳舞|唱歌|音乐|听歌/, match: ["dance", "sing", "music", "happy"] },
  { key: /再见|拜拜|走了|要走了|晚安|下次见/, match: ["wave", "goodbye", "bye", "wavebye", "nono"] },
  { key: /谢谢|感谢|谢谢你/, match: ["bow", "thank", "grateful"] },
  { key: /加油|努力|冲|奋斗|坚持/, match: ["cheer", "encourage", "fight", "excited"] },
  { key: /别难过|没事|安慰|抱抱|不哭|别怕/, match: ["comfort", "pat", "soothe", "shy"] },
  // ---- 以下为按真实模型补的反应动作 (原来完全没有词能触发它们) ----
  // 注: 这些是**正文关键词**兜底用的正则, 必须防子串误命中 ——
  // 例: 不能写成 /点头/, 否则"有**点头**晕""一**点头**绪"都会被判成点头。
  { key: /(?<!有|一)点头|同意|赞成|说得对|(?<!不)好的/, match: ["nod"] },
  { key: /摇头|摆手|拒绝|不要|不行|才不/, match: ["shakehead", "nono"] },
  { key: /疑惑|不解|困惑|奇怪|搞不懂/, match: ["doubt", "troubled"] },
  { key: /鞠躬|道谢|行礼/, match: ["bow"] },
  // 刻意不收「看着」—— 它在日常回复里太常见, 会把普通句子判成凝视
  { key: /盯着|凝视|注视|打量/, match: ["stare"] },
  { key: /头晕|晕了|晕乎乎|眼花/, match: ["dizzy"] }
];
var NEGATION_RE = /(?:不|没|别|勿|莫|不要|不想|没想|不会|不是|没法)/;
var EXPRESSION_DENY = /^(00_default|05_dark\.?|chibi|tailoff|longhairoff|shojo|finale_)/i;
var emotionPool = (available) => available.filter((n) => !EXPRESSION_DENY.test(n));
var EMOTION_ALIAS = {
  // 单字"困": EMOTION_RULES 的 key 是 困了|好困|困死了…, 匹配不到单字;
  // 又**不能**把 key 放宽成 /困/ —— 正文里的"困难""困扰"会被误判成困。所以在这里精确补。
  "\u56F0": ["sleep"],
  "\u7D2F\u4E86": ["sleep"],
  "\u7B4B\u75B2\u529B\u5C3D": ["sleep"],
  // 这三个词对应 ARGNori 上一直触达不到的 02_Dizzy / 10_Doubt / 11_Disgust
  "\u5934\u6655": ["dizzy"],
  "\u7591\u60D1": ["doubt"],
  "\u5ACC\u5F03": ["disgust"]
};
var pickExisting = (rule, available, both) => {
  for (const k of rule.match) {
    const hit = available.find((name) => {
      const n = name.toLowerCase();
      return both ? n.includes(k) || k.includes(n) : n.includes(k);
    });
    if (hit) return hit;
  }
  return null;
};
var detectExpressionByRules = (text, available) => {
  const negated = NEGATION_RE.test(text);
  const pool = emotionPool(available);
  for (const rule of EMOTION_RULES) {
    if (!rule.key.test(text)) continue;
    if (negated && /开心|高兴|喜欢|温柔|贴心|暖心|暖暖|想你|等你|谢谢|感动|好呀|太棒|真棒|超棒|耶|回来|夸我/.test(rule.key.source)) continue;
    const hit = pickExisting(rule, pool, false);
    if (hit) return hit;
  }
  return null;
};
var detectMotionByRules = (text, available) => {
  const negated = NEGATION_RE.test(text);
  for (const rule of MOTION_RULES) {
    if (!rule.key.test(text)) continue;
    if (negated && /开心|高兴|喜欢|太棒|真棒|好呀|耶|赢了|谢谢|加油|抱抱/.test(rule.key.source)) continue;
    const hit = pickExisting(rule, available, true);
    if (hit) return hit;
  }
  return null;
};
var EMOTION_VARIANT_GROUPS = [
  ["13_Happy", "07_Smile", "01_KiraKira"],
  // 正向
  ["08_Tears", "09_Troubled"]
  // 负面
  // 注: Nori 还有一组 Finale_*(Finale_Sad / Finale_Smile / Finale_Farewell …), 从名字看是
  // **结算/结局动画**, 不是日常情绪脸 —— 不确定其语义就不要拿去当情绪用, 故不列入。
];
var pickEmotionVariant = (name, available, rand = Math.random) => {
  const group = EMOTION_VARIANT_GROUPS.find((g) => g.includes(name));
  if (!group) return name;
  const pool = group.filter((n) => available.includes(n));
  if (pool.length <= 1) return name;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
};
var resolveMarkerEmotion = (word, available) => {
  const t = word.trim().toLowerCase();
  if (!t || t === "\u65E0" || t === "none" || t === "null") return null;
  const pool = emotionPool(available);
  const pick = (base) => base ? pickEmotionVariant(base, pool) : null;
  for (const c of EMOTION_ALIAS[t] ?? []) {
    const hit = pool.find((name) => name.toLowerCase().includes(c));
    if (hit) return pick(hit);
  }
  const rule = EMOTION_RULES.find((r) => r.key.test(t) || r.match.some((m) => t.includes(m) || m.includes(t)));
  if (rule) {
    const hit = pickExisting(rule, pool, false);
    if (hit) return pick(hit);
  }
  const last = pool.find((name) => name.toLowerCase() === t || name.toLowerCase().includes(t) || t.includes(name.toLowerCase())) ?? null;
  return pick(last);
};
var resolveMarkerMotion = (word, available) => {
  const t = word.trim().toLowerCase();
  if (!t || t === "\u65E0" || t === "none" || t === "null") return null;
  const direct = available.find((name) => name.toLowerCase() === t);
  if (direct) return direct;
  const ALIAS = {
    "\u5F00\u5FC3": ["waku", "happy", "jump", "cheerful", "excited", "victory"],
    "\u9AD8\u5174": ["waku", "happy", "jump", "cheerful"],
    "\u5174\u594B": ["waku"],
    "\u671F\u5F85": ["waku"],
    "\u96BE\u8FC7": ["troubled", "sad", "cry", "sigh", "down"],
    "\u4F24\u5FC3": ["troubled", "cry", "sad", "sigh"],
    "\u5931\u843D": ["troubled", "sad", "down"],
    "\u5BB3\u7F9E": ["shy", "hide", "embarrass", "flustered"],
    "\u56F0": ["sleep", "sleepy", "tired", "yawn"],
    "\u56F0\u4E86": ["sleep", "sleepy", "tired", "yawn"],
    "\u7D2F\u4E86": ["sleep", "sleepy", "tired"],
    // 惊讶: 模型里**没有**"惊讶"动作。刻意**不**给 dizzy —— 那是头晕, 语义错误。
    "\u60CA\u8BB6": ["surprised", "shock", "wow"],
    "\u751F\u6C14": ["angry", "pout", "annoyed"],
    "\u5934\u6655": ["dizzy"],
    "\u70B9\u5934": ["nod"],
    "\u6447\u5934": ["shakehead", "nono"],
    "\u6446\u624B": ["nono", "shakehead"],
    "\u62D2\u7EDD": ["nono", "shakehead"],
    "\u7591\u60D1": ["doubt", "troubled"],
    "\u4E0D\u89E3": ["doubt"],
    "\u97A0\u8EAC": ["bow"],
    "\u9053\u8C22": ["bow"],
    "\u884C\u793C": ["bow"],
    "\u76EF\u7740": ["stare"],
    "\u51DD\u89C6": ["stare"],
    "\u6CE8\u89C6": ["stare"],
    // 以下这些在两个模型里**没有**对应动作, 保留只为兼容旧标记/旧提示词:
    // 映射失败会走 playIdleFallback() (中性 idle), 不报错。
    "\u6E38\u620F": ["game", "play", "battle", "fight"],
    "\u6478\u5934": ["pet", "headpat", "touch"],
    "\u6478": ["pet", "headpat", "touch"],
    "\u62B1\u62B1": ["hug", "embrace", "arms"],
    "\u62B1": ["hug", "embrace", "arms"],
    "\u8DF3\u821E": ["dance"],
    // 两个模型都没有"挥手"动作; 10_NoNoNo 是唯一的摆手类动作, 作为视觉近似
    "\u518D\u89C1": ["nono", "wave", "goodbye", "bye"],
    "\u62DC\u62DC": ["nono", "wave", "goodbye", "bye"],
    "\u8C22\u8C22": ["bow", "thank"],
    "\u52A0\u6CB9": ["waku", "cheer", "encourage", "fight", "excited"],
    "\u65E0\u804A": ["idle", "bored"],
    "\u601D\u8003": ["doubt", "think", "thinkhard"]
  };
  const cands = ALIAS[t] ?? [];
  for (const c of cands) {
    const hit = available.find((name) => name.toLowerCase().includes(c) || c.includes(name.toLowerCase()));
    if (hit) return hit;
  }
  const rule = MOTION_RULES.find((r) => r.key.test(t) || r.match.some((m) => t.includes(m) || m.includes(t)));
  if (rule) {
    const hit = pickExisting(rule, available, true);
    if (hit) return hit;
  }
  return available.find((name) => name.toLowerCase().includes(t) || t.includes(name.toLowerCase())) ?? null;
};
var pickNeutralIdle = (motions) => {
  const idle = motions.find((g) => /idle/i.test(g.group));
  if (!idle || !idle.names.length) return null;
  const neutral = idle.names.filter((n) => {
    const l = n.toLowerCase();
    return !/sleep|tired|yawn|troubled|worr|sad|cry|angry|pout|shy|surpris|shock|dizzy|sick|hurt|faint|bored|down|sigh/.test(l);
  });
  const pool = neutral.length ? neutral : idle.names;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  return { group: idle.group, index: idle.names.indexOf(chosen) };
};
export {
  EMOTION_RULES,
  EMOTION_VARIANT_GROUPS,
  EXPRESSION_DENY,
  MOTION_RULES,
  NEGATION_RE,
  detectExpressionByRules,
  detectMotionByRules,
  pickEmotionVariant,
  pickNeutralIdle,
  resolveMarkerEmotion,
  resolveMarkerMotion
};
