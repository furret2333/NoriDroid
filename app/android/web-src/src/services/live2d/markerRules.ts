/* ---------------- 表情/动作标记映射规则 (主 App 与悬浮窗共用) ----------------
 * AI 回复末尾的隐藏标记 【表情:开心】【动作:jump】 需要映射到当前模型实际的
 * 表情/动作名. 规则只维护这一份, 主 App 和悬浮窗共用, 保证行为一致.
 * 本模块全部是纯函数 (依赖传入的模型能力列表), 不依赖 Vue/模型实例.
 */

export interface MarkerRule {
	key: RegExp
	match: string[]
}

export const EMOTION_RULES: MarkerRule[] = [
	{key: /开心|高兴|happy|哈哈|嘿嘿|太棒|好呀|超棒|真棒|喜欢|笑嘻嘻|耶|太好了|好耶|开心极了|好开心|好高兴|太开心/, match: ["happy", "smile", "kira"]},
	{key: /被夸|夸我|好温柔|温柔|贴心|谢谢你|谢谢|感动|暖心|暖暖的/, match: ["happy", "smile", "kira", "shy"]},
	{key: /想你|想念|回来啦|回来了|终于回来|好想你|等你|盼你/, match: ["happy", "smile", "shy"]},
	{key: /赢了|赢啦|胜利|通关|过关|赢了赢了/, match: ["happy", "smile", "kira", "surprised"]},
	{key: /生气|讨厌|不喜欢|气死|居然|过分|气鼓|好气|气人|太过分|生气了/, match: ["angry"]},
	{key: /难过|伤心|失落|孤单|想念|呜呜|哭了|想哭|难受|好想|好难过|不开心|委屈/, match: ["sad", "tears", "troubled", "worried"]},
	{key: /害羞|不好意思|唔\.\.|诶\.\.|脸红了|害羞了|好害羞/, match: ["shy"]},
	{key: /困了|好困|累|想睡|睡觉|打哈欠|哈欠|困死了/, match: ["sleep"]},
	{key: /惊讶|诶！|哇|不会吧|真的吗|嚇|吓到|居然|天哪|哇塞/, match: ["surprised"]},
	{key: /认真|严肃|重要|承诺|答应|一定|放心/, match: ["serious", "angry"]},
	{key: /无奈|叹气|真是|哎|算了|好吧好吧/, match: ["speechless", "doubt", "troubled"]},
	{key: /别难过|没事|安慰|抱抱|摸摸头|不哭|别怕|不要怕/, match: ["shy", "smile", "happy"]},
	// ---- 以下为按真实模型补的表情 (原来提示词的**表情**词表里没有这三个词, 于是永远触发不到) ----
	{key: /头晕|晕了|晕乎乎|眼花/, match: ["dizzy"]},
	{key: /疑惑|不解|困惑|奇怪|搞不懂|疑问/, match: ["doubt", "troubled"]},
	// 注: 刻意不收「讨厌」—— 它在更前面的"生气"规则里, 会先命中 angry
	{key: /嫌弃|厌恶|恶心|受不了/, match: ["disgust"]},
]

export const MOTION_RULES: MarkerRule[] = [
	// 注: 候选名按"先真实存在的"排序 —— 本项目只用 ARGNori / Nori 两个模型,
	// 真实动作名见 docs/动作表情机理.md (Nod / ShakeHead / WakuWaku / Angry / Troubled /
	// Dizzy / Stare / Doubt / Bow / NoNoNo / sleep)。原来表里那批 happy/jump/wave/hug/dance
	// 在两个模型里**一个都不存在**, 导致大量词落空 → 修表。
	{key: /开心|高兴|哈哈|嘿嘿|太棒|好呀|超棒|真棒|喜欢|赢啦|赢了|耶|太好了|好耶|兴奋|期待/, match: ["waku", "happy", "satisfied", "cheerful", "smile", "jump", "victory", "win", "excited"]},
	{key: /难过|伤心|失落|孤单|想念|想哭|呜呜|难受|委屈/, match: ["troubled", "sad", "cry", "worry", "down", "sigh"]},
	{key: /害羞|不好意思|脸红|诶\.\.|唔\.\.|好害羞/, match: ["shy", "embarrass", "flustered", "hide"]},
	{key: /困|好累|想睡|睡觉|哈欠|打哈欠|困死了/, match: ["sleep", "sleepy", "tired", "yawn", "stretch"]},
	// 惊讶: 模型里**没有**"惊讶"动作。原先候选里有 dizzy, 于是"惊讶"被映射成 Dizzy(头晕) —— 语义错误。
	// 现在让它自然落空 → playIdleFallback(中性 idle), 不再演成头晕。
	{key: /惊讶|哇|真的吗|不会吧|居然|天哪|吓到|哇塞/, match: ["surprised", "surprise", "shock", "wow"]},
	{key: /生气|讨厌|过分|气鼓|好气|气人|生气了/, match: ["angry", "pout", "annoyed"]},
	{key: /游戏|玩|来一局|对战|开黑|打游戏/, match: ["game", "play", "fight", "battle"]},
	{key: /摸摸|摸头|摸/, match: ["pet", "headpat", "touch", "happy"]},
	{key: /抱抱|抱一下|拥抱|求抱/, match: ["hug", "embrace", "arms", "happy"]},
	{key: /跳舞|唱歌|音乐|听歌/, match: ["dance", "sing", "music", "happy"]},
	{key: /再见|拜拜|走了|要走了|晚安|下次见/, match: ["wave", "goodbye", "bye", "wavebye", "nono"]},
	{key: /谢谢|感谢|谢谢你/, match: ["bow", "thank", "grateful"]},
	{key: /加油|努力|冲|奋斗|坚持/, match: ["cheer", "encourage", "fight", "excited"]},
	{key: /别难过|没事|安慰|抱抱|不哭|别怕/, match: ["comfort", "pat", "soothe", "shy"]},
	// ---- 以下为按真实模型补的反应动作 (原来完全没有词能触发它们) ----
	// 注: 这些是**正文关键词**兜底用的正则, 必须防子串误命中 ——
	// 例: 不能写成 /点头/, 否则"有**点头**晕""一**点头**绪"都会被判成点头。
	{key: /(?<!有|一)点头|同意|赞成|说得对|(?<!不)好的/, match: ["nod"]},
	{key: /摇头|摆手|拒绝|不要|不行|才不/, match: ["shakehead", "nono"]},
	{key: /疑惑|不解|困惑|奇怪|搞不懂/, match: ["doubt", "troubled"]},
	{key: /鞠躬|道谢|行礼/, match: ["bow"]},
	// 刻意不收「看着」—— 它在日常回复里太常见, 会把普通句子判成凝视
	{key: /盯着|凝视|注视|打量/, match: ["stare"]},
	{key: /头晕|晕了|晕乎乎|眼花/, match: ["dizzy"]},
]


/** 否定前缀: 命中这些词的句子不能按正向情绪规则判断 (如"不喜欢""不开心") */
export const NEGATION_RE = /(?:不|没|别|勿|莫|不要|不想|没想|不会|不是|没法)/

/** **不能当作"情绪脸"自动选中**的表情名: 默认脸 / 功能开关 / 结算动画。
 *  它们会靠子串误命中被抢走 —— 例如 Nori 的 `Finale_Sad` 是"难过"规则里第一个含 "sad" 的名字,
 *  于是「难过」一直演的是**结算动画**而不是 `08_Tears`。所有表情匹配都要先过这层过滤。
 *  **导出**是为了让"摸头表情"(`petExpression.ts`) 复用同一个正则 —— 两处各写一份必然漂移。 */
export const EXPRESSION_DENY = /^(00_default|05_dark\.?|chibi|tailoff|longhairoff|shojo|finale_)/i
/** 过滤掉不该被自动选中的表情, 只留"日常情绪脸" */
const emotionPool = (available: string[]): string[] => available.filter((n) => !EXPRESSION_DENY.test(n))

/** 标记词 → 表情名 的**精确逐词**映射 (优先于 EMOTION_RULES)。
 *  只收规则表覆盖不到、或放宽正则会带来误判的词。 */
const EMOTION_ALIAS: Record<string, string[]> = {
	// 单字"困": EMOTION_RULES 的 key 是 困了|好困|困死了…, 匹配不到单字;
	// 又**不能**把 key 放宽成 /困/ —— 正文里的"困难""困扰"会被误判成困。所以在这里精确补。
	"困": ["sleep"],
	"累了": ["sleep"],
	"筋疲力尽": ["sleep"],
	// 这三个词对应 ARGNori 上一直触达不到的 02_Dizzy / 10_Doubt / 11_Disgust
	"头晕": ["dizzy"],
	"疑惑": ["doubt"],
	"嫌弃": ["disgust"],
}

/** 从规则匹配到的词里, 挑一个当前模型实际存在的名字.
 *  @param both 双向匹配 (动作用: name 含 k 或 k 含 name);
 *              单向匹配 (表情用: 仅 name 含 k, 与主 App 原逻辑一致) */
const pickExisting = (rule: MarkerRule, available: string[], both: boolean): string | null => {
	for (const k of rule.match) {
		const hit = available.find((name) => {
			const n = name.toLowerCase()
			return both ? (n.includes(k) || k.includes(n)) : n.includes(k)
		})
		if (hit) return hit
	}
	return null
}

/** 正文关键词 → 表情名 (detectExpression 用) */
export const detectExpressionByRules = (text: string, available: string[]): string | null => {
	const negated = NEGATION_RE.test(text)
	const pool = emotionPool(available)
	for (const rule of EMOTION_RULES) {
		if (!rule.key.test(text)) continue
		// 正向规则 (开心/喜欢/温柔等) 遇到否定词时跳过, 交给后面的负面规则或返回 null
		if (negated && /开心|高兴|喜欢|温柔|贴心|暖心|暖暖|想你|等你|谢谢|感动|好呀|太棒|真棒|超棒|耶|回来|夸我/.test(rule.key.source)) continue
		const hit = pickExisting(rule, pool, false)
		if (hit) return hit
	}
	return null
}

/** 正文关键词 → 动作名 (pickMotionByKeyword 用) */
export const detectMotionByRules = (text: string, available: string[]): string | null => {
	const negated = NEGATION_RE.test(text)
	for (const rule of MOTION_RULES) {
		if (!rule.key.test(text)) continue
		if (negated && /开心|高兴|喜欢|太棒|真棒|好呀|耶|赢了|谢谢|加油|抱抱/.test(rule.key.source)) continue
		const hit = pickExisting(rule, available, true)
		if (hit) return hit
	}
	return null
}

/** 同一情绪下可轮换的**变体分组** —— 直接写当前两个模型的实际表情名。
 *  本项目只用 ARGNori / Nori, 所以不做通用抽象。
 *
 *  ⚠️ 只放**情绪类**表情。`00_Default`(默认脸) / `05_Dark` / `Chibi` / `TailOFF` /
 *     `LongHairOFF` / `Shojo` / `Finale_*` 这类"默认脸 / 功能开关 / 结算动画"
 *     **绝不能进组**, 否则会被随机播出来。
 *
 *  为什么需要: 解析用 `available.find(...)` 只取**第一个**命中项, 于是同类的其它表情
 *  (ARGNori 的 07_Smile / 01_KiraKira / 09_Troubled) **永远轮不到**, 看起来"老是同一张脸"。 */
export const EMOTION_VARIANT_GROUPS: string[][] = [
	["13_Happy", "07_Smile", "01_KiraKira"], // 正向
	["08_Tears", "09_Troubled"],             // 负面
	// 注: Nori 还有一组 Finale_*(Finale_Sad / Finale_Smile / Finale_Farewell …), 从名字看是
	// **结算/结局动画**, 不是日常情绪脸 —— 不确定其语义就不要拿去当情绪用, 故不列入。
]

/** 把已解析出的表情名换成同组的随机变体 (组内当前模型没有的名字自动忽略)
 *  @param rand 可注入, 便于测试确定化 */
export const pickEmotionVariant = (name: string, available: string[], rand: () => number = Math.random): string => {
	const group = EMOTION_VARIANT_GROUPS.find((g) => g.includes(name))
	if (!group) return name
	const pool = group.filter((n) => available.includes(n))
	if (pool.length <= 1) return name
	return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
}

/** 标记里的情绪词 → 表情名 (playMarkerEmotion / resolveMarkerEmotion 用) */
export const resolveMarkerEmotion = (word: string, available: string[]): string | null => {
	const t = word.trim().toLowerCase()
	if (!t || t === "无" || t === "none" || t === "null") return null
	// 默认脸 / 功能开关 / 结算动画不参与匹配 (否则会靠子串抢走, 见 EXPRESSION_DENY)
	const pool = emotionPool(available)
	const pick = (base: string | null): string | null => (base ? pickEmotionVariant(base, pool) : null)
	// 0) 精确逐词别名优先 (处理规则表覆盖不到的词, 如单字"困")
	for (const c of EMOTION_ALIAS[t] ?? []) {
		const hit = pool.find((name) => name.toLowerCase().includes(c))
		if (hit) return pick(hit)
	}
	// 1) 按关键词规则表反向找 (规则 match 列表第一个命中即用)
	const rule = EMOTION_RULES.find((r) => r.key.test(t) || r.match.some((m) => t.includes(m) || m.includes(t)))
	if (rule) {
		const hit = pickExisting(rule, pool, false)
		if (hit) return pick(hit)
	}
	// 2) 直接按字面匹配现有表情名
	const last = pool.find((name) => name.toLowerCase() === t || name.toLowerCase().includes(t) || t.includes(name.toLowerCase())) ?? null
	return pick(last)
}

/** 标记里的动作词 → 动作名 (playMarkerMotion / resolveMarkerMotion 用) */
export const resolveMarkerMotion = (word: string, available: string[]): string | null => {
	const t = word.trim().toLowerCase()
	if (!t || t === "无" || t === "none" || t === "null") return null
	// 精确字面匹配优先
	const direct = available.find((name) => name.toLowerCase() === t)
	if (direct) return direct
	// 中文/英文别名 → 动作名 (比规则表更精细的逐词映射)
	// 候选名**按"当前模型真实存在"的排在前面**。本项目只用 ARGNori / Nori 两个模型,
	// 真实动作名见 docs/动作表情机理.md。原来那批 happy/jump/wave/hug/dance/pet 在两个模型里
	// **一个都不存在**, 导致提示词里 9/13 的动作词落空 —— 本表按真实名字重排并补齐。
	const ALIAS: Record<string, string[]> = {
		"开心": ["waku", "happy", "jump", "cheerful", "excited", "victory"],
		"高兴": ["waku", "happy", "jump", "cheerful"],
		"兴奋": ["waku"],
		"期待": ["waku"],
		"难过": ["troubled", "sad", "cry", "sigh", "down"],
		"伤心": ["troubled", "cry", "sad", "sigh"],
		"失落": ["troubled", "sad", "down"],
		"害羞": ["shy", "hide", "embarrass", "flustered"],
		"困": ["sleep", "sleepy", "tired", "yawn"],
		"困了": ["sleep", "sleepy", "tired", "yawn"],
		"累了": ["sleep", "sleepy", "tired"],
		// 惊讶: 模型里**没有**"惊讶"动作。刻意**不**给 dizzy —— 那是头晕, 语义错误。
		"惊讶": ["surprised", "shock", "wow"],
		"生气": ["angry", "pout", "annoyed"],
		"头晕": ["dizzy"],
		"点头": ["nod"],
		"摇头": ["shakehead", "nono"],
		"摆手": ["nono", "shakehead"],
		"拒绝": ["nono", "shakehead"],
		"疑惑": ["doubt", "troubled"],
		"不解": ["doubt"],
		"鞠躬": ["bow"],
		"道谢": ["bow"],
		"行礼": ["bow"],
		"盯着": ["stare"],
		"凝视": ["stare"],
		"注视": ["stare"],
		// 以下这些在两个模型里**没有**对应动作, 保留只为兼容旧标记/旧提示词:
		// 映射失败会走 playIdleFallback() (中性 idle), 不报错。
		"游戏": ["game", "play", "battle", "fight"],
		"摸头": ["pet", "headpat", "touch"],
		"摸": ["pet", "headpat", "touch"],
		"抱抱": ["hug", "embrace", "arms"],
		"抱": ["hug", "embrace", "arms"],
		"跳舞": ["dance"],
		// 两个模型都没有"挥手"动作; 10_NoNoNo 是唯一的摆手类动作, 作为视觉近似
		"再见": ["nono", "wave", "goodbye", "bye"],
		"拜拜": ["nono", "wave", "goodbye", "bye"],
		"谢谢": ["bow", "thank"],
		"加油": ["waku", "cheer", "encourage", "fight", "excited"],
		"无聊": ["idle", "bored"],
		"思考": ["doubt", "think", "thinkhard"],
	}
	const cands = ALIAS[t] ?? []
	for (const c of cands) {
		const hit = available.find((name) => name.toLowerCase().includes(c) || c.includes(name.toLowerCase()))
		if (hit) return hit
	}
	// 再按规则表反向匹配
	const rule = MOTION_RULES.find((r) => r.key.test(t) || r.match.some((m) => t.includes(m) || m.includes(t)))
	if (rule) {
		const hit = pickExisting(rule, available, true)
		if (hit) return hit
	}
	// 英文动作名兜底: 如 jump → jump_left / happy_idle 等子串匹配
	return available.find((name) => name.toLowerCase().includes(t) || t.includes(name.toLowerCase())) ?? null
}

/** idle 组里挑中性动作 (排除情绪/状态词, 避免随机到"睡觉/困惑")
 *
 *  ⚠️ 返回的 `index` 必须是**原始 idle.names 数组**的下标 —— 调用方是
 *  `l2d.playMotionByIndex(p.group, p.index)`, 它按原始数组取动作。
 *  （曾经返回"过滤后 pool"的下标, 于是 Nori 上约 1/3 概率播到本该排除的 00_Sleep,
 *    即待机时"睡着了"; 2026-09-23 修） */
export const pickNeutralIdle = (motions: {group: string; names: string[]}[]): {group: string; index: number} | null => {
	const idle = motions.find((g) => /idle/i.test(g.group))
	if (!idle || !idle.names.length) return null
	const neutral = idle.names.filter((n) => {
		const l = n.toLowerCase()
		return !/sleep|tired|yawn|troubled|worr|sad|cry|angry|pout|shy|surpris|shock|dizzy|sick|hurt|faint|bored|down|sigh/.test(l)
	})
	const pool = neutral.length ? neutral : idle.names
	const chosen = pool[Math.floor(Math.random() * pool.length)]
	return {group: idle.group, index: idle.names.indexOf(chosen)}
}
