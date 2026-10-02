/**
 * 记忆系统核心逻辑 (平台无关)
 *
 * 设计参照 docs/记忆.md, 落地为三层:
 * - 长期记忆 (memories): 从对话中按规则/LLM 提取的重要信息, 带 importance/confidence/tags
 * - 历史摘要 (summaries): 超出近期窗口的旧对话, 由 LLM 压缩成摘要
 * - 召回 (recall): 每次用户发言前, 按关键词 + 重要性 + 新鲜度 + 使用次数打分, 取 Top K 注入上下文
 *
 * 存储由各平台提供 (Android 走 NoriChat 文件桥 / 桌面走 Tauri 命令), 本模块只负责纯逻辑.
 */

/** 记忆类型全集 (运行时可枚举: 校验模型给的 type 用; 类型本身由它派生, 避免两处漂移) */
export const MEMORY_TYPES = ["fact", "preference", "project", "event", "relationship", "core"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemoryItem {
	/** 唯一 id (时间戳 + 随机数) */
	id: string
	/** 记忆内容 (一句话) */
	content: string
	/** 记忆类型 */
	type: MemoryType
	/** 重要性 0~1 (0.9+ 核心事实 / 0.7 重要 / 0.5 普通) */
	importance: number
	/** 置信度 0~1 (是否确定) */
	confidence: number
	createdAt: number
	updatedAt: number
	/** 最近一次被召回时间 (用于新鲜度加权) */
	lastAccessedAt: number
	/** 被召回次数 (强化) */
	accessCount: number
	tags: string[]
	/** 衰减半衰期 (天): 超过该时长未被提及时, 新鲜度折半; null = 永不衰减 (显式记住) */
	decayDays?: number | null
	/**
	 * **作废时间** (2026-09-27 新增, 借鉴 Zep/Graphiti 的 edge invalidation):
	 * 非空 = 这条记忆已被新信息取代 (改口/纠正), **不再参与召回与注入**, 但**保留在文件里**。
	 *
	 * 为什么用"作废"而不是"删除":
	 * - 删除不可逆, 一句判错就永久丢信息; 作废可一键还原;
	 * - 删除要过"显式/高重要记忆保护"那道闸 (importance ≥ 0.85), 而**名字/身份**这类最需要纠正的
	 *   记忆规则给的 importance 恰恰是 0.9 —— 实测下来它们**正好纠正不了**
	 *   (证据: tmp-memcheck/probe-mem-correction.mjs); 作废可还原后那道保护闸不再必要, 死结自解;
	 * - 保留历史才能回答"当时是什么" (Zep 四时间戳的思路, 这里只落一个 invalidAt, 够用且省事)。
	 *
	 * 与 `tombstones` 的分工: 墓碑 = **用户显式删除**(不该复活); invalidAt = **被取代**(可还原)。
	 */
	invalidAt?: number
	/**
	 * **收起时间**（2026-09-28 加，用户的"暂时收起"）：
	 * 非空 = 这条**不再参与注入/召回**，但它**没有被推翻**（与 `invalidAt` 的区别就在这里：
	 * 作废 = 有新的说法取代了它；收起 = 它可能还是真的，只是不再重要/太久没提）。
	 *
	 * 为什么要有它：用户明确担心「误删之后模型一点都不记了」。所以**自动路径（到期 / 低频）
	 * 永不真删**，只收起 —— 留在库里可见、可一键「留下」，两者都能还原。
	 */
	fadedAt?: number
	/** 收起原因（给 UI 一句人话：为什么它被收起来了） */
	fadedReason?: "expired" | "lowvalue" | "manual"
	/**
	 * **删除时间**（仅存在于"回收站" `deletedBin` 里的条目上）：
	 * 用户手删的条目会带着它进回收站，可一键还原；确认不要了再「永久删除」。
	 */
	deletedAt?: number
}

/**
 * 这条记忆是否仍然有效（会注入 / 会召回 / 参与判重）。
 *
 * **作废（invalidAt）与收起（fadedAt）都算"不生效"**，但两者语义不同：
 * - 作废 = 被新说法取代（有替代者），进「已作废」，可还原；
 * - 收起 = 不再重要 / 太久没提（无替代者），进「已收起」，可「留下」。
 * 两者都**留在文件里**，也都能一键救回 —— 自动路径永不真删（见 index.ts 的 fadeMemory）。
 */
export const isActiveMemory = (m: MemoryItem): boolean => !m.invalidAt && !m.fadedAt

export interface MemorySummary {
	id: string
	content: string
	createdAt: number
	/** 本次摘要覆盖的消息数 */
	msgCount: number
	tokenCount: number
}

/**
 * **记忆块** (2026-09-27 重构 P1 新增): 长期记忆的"组织方式"。
 *
 * 为什么要有块: 逐句实时提取时, 每条记忆都是孤立的; 改成"每次历史总结顺手筛出这段值得记的"
 * 之后, 记忆天然按"一次总结覆盖的对话区间"成组 —— 块就是这个组, 它让记忆库能按
 * 「时间段 + 主题」展示, 也让"近况注入"(指代类提问)有了现成的抓手。
 *
 * ⚠ **块只存条目 id, 不存条目副本**(与最初方案稿的差别):
 * 条目(含 invalidAt 作废/还原、固定、删除、清理低频、双实例落盘合并)的**唯一事实来源仍是
 * `memories`**。若块里再存一份副本, 上述 6 条既有路径全都要同时维护两处, 任一处漏改就是
 * "改了没生效 / 删了又复活"这类 bug —— 而这正是这两天踩过的 bug 类型。只存 id 则
 * memories 依旧派生自唯一来源, 召回/注入/导出/作废/合并**零改动**。
 * 代价: 渲染块视图时要按 id 解析一次 (毫秒级)。
 */
export interface MemoryBlock {
	/**
	 * 区间指纹 id: `blk-<fromTs>-<toTs>`。
	 * 用时间戳区间而不是自增/随机: 双实例(主界面/悬浮窗)对同一段对话并发总结时会算出
	 * **同一个 id**, 落盘合并按 id 去重就只留一份 (与 summaries 的 id 策略同源)。
	 */
	id: string
	/** 本块覆盖的消息区间起止 (消息时间戳) */
	fromTs: number
	toTs: number
	/** 本块覆盖的消息条数 */
	msgCount: number
	/** 模型给的短主题 (≤8 字), 供记忆库分组标题与"近况注入" */
	topic: string
	/** 这段对话的摘要 (与 summaries 同源; 供块视图展开与近况注入) */
	summary: string
	createdAt: number
	/** 成员条目 id (**只存 id**); 悬空 id (条目被用户删除) 由 pruneBlockRefs 清理 */
	itemIds: string[]
}

/** 当前存储结构版本。1 = 只有 memories/summaries(重构前); 2 = 增加 blocks (P1) */
export const MEMORY_SCHEMA_VERSION = 2

/* ---------------- 写入门槛 (S2, 2026-09-28) ---------------- */

/** 通用下限: 低于它的条目不值得长期记住 */
export const MIN_IMPORTANCE_PASS = 0.5
/** "软信息"(偏好/项目/普通事实)的下限: 比通用下限再松一点 —— 门槛是**兜底**, 不是主过滤器 */
export const MIN_IMPORTANCE_SOFT = 0.35

/**
 * 这条候选**值不值得进长期记忆**（确定性兜底，不靠模型自觉）。
 *
 * 为什么要有它：提示词里已经给了判据（三个月后还成立 / 以后还会被问起 / 一次性的不写），
 * 但模型的 importance 很不稳、也爱凑数。这里用**结构特征**兜一道：
 * - `event`（一次性事件）是最容易变垃圾的一类 ⇒ 门槛 0.5；
 * - 偏好/项目/普通事实/关系 ⇒ 门槛 0.35（低于这个基本是随口一提）；
 * - **永远豁免**：core（明确要求记住）、带 explicit / pinned / goal / identity 标签的
 *   —— 那是用户显式要保留的，门槛不许碰。
 *
 * 被挡下的条目**不是丢弃**：它们仍会出现在历史总结里（叙事不丢），只是不占长期记忆的位置。
 */
export const isWorthRemembering = (input: {type?: MemoryType; importance?: number; tags?: readonly string[]}): boolean => {
	const tags = input.tags ?? []
	if (tags.some(t => t === "explicit" || t === "pinned" || t === "goal" || t === "identity")) return true
	const type: MemoryType = input.type ?? "fact"
	if (type === "core") return true
	const imp = typeof input.importance === "number" ? input.importance : MIN_IMPORTANCE_PASS
	return imp >= (type === "event" ? MIN_IMPORTANCE_PASS : MIN_IMPORTANCE_SOFT)
}

/** 持久化结构 */
export interface MemoryStoreData {
	memories: MemoryItem[]
	summaries: MemorySummary[]
	/** 已摘要到的消息条数 (下一个需要摘要的起始位置) */
	summarizedMsgCount: number
	/**
	 * **被自动裁剪丢掉的消息条数** (P5 新增, 单调递增, 可选 → 兼容旧数据)。
	 *
	 * 为什么需要它: `summarizedMsgCount` 是相对**整个聊天历史**的累计条数, 而聊天数组会被
	 * 裁剪 (只留近端 20 条) —— 于是"下一个要摘要的消息"在当前数组里的**下标**必须是
	 * `summarizedMsgCount - trimmedMsgCount`。两者都只增不减, 所以双实例落盘合并照旧取 max。
	 *
	 * 旧的写法是裁剪时把游标**重置成保留条数**, 等于宣称"保留的这 20 条已经摘要过了" ——
	 * 而它们恰恰是最新、从没被总结过的那批, 于是被永久跳过 (实测见
	 * tmp-memcheck/probe-trim-skip.mjs)。实时通道默认关之后这就是实打实的"记不住"。
	 */
	trimmedMsgCount?: number
	/** 删除墓碑 (持久化): 任一实例删过的 id 都不再复活 (主界面/悬浮窗各持 cache 时的删除一致性) */
	tombstones?: {id: string; at: number}[]
	/** 折叠归档 (两级压缩的第二级): 逐条摘要超出上限时, 把最旧的几条折成一条存这里。
	 *  让"更久远的叙事脉络"能保留到远超 summaries 覆盖范围, 而注入成本有界。
	 *  可选 → 兼容旧数据。 */
	meta?: MemorySummary[]
	/** 记忆块 (P1 新增, 可选 → 兼容旧数据; 载入时由 migrateToBlocks 补齐) */
	blocks?: MemoryBlock[]
	/**
	 * **回收站**（2026-09-28 加）：用户手删的条目先放这里（带 `deletedAt`），可一键还原；
	 * 确认不要了再「永久删除」。上限 `MAX_DELETED_BIN` 条（超出丢最旧的）。
	 *
	 * 为什么要有它：用户明确担心「误删之后模型一点都不记了」。此前删除只留墓碑（id + 时间），
	 * 内容当场就没了、**无法还原** —— 这是"怕误删"最实的一处缺口。
	 */
	deletedBin?: MemoryItem[]
	/**
	 * **示例集**（2026-09-28，用户的"整理优化/口味自学习"）：从**主人自己保留/删掉的**记忆里
	 * 提炼的 few-shot 例子，写进整理提示词，让模型照着主人的口味挑。
	 * - `pos` 正例 = 生效中的记忆（照这个颗粒度记）；
	 * - `neg` 反例 = 回收站里被主人删掉的内容（别再记这类）；
	 * - `builtAt` / `basedOn` 用于刷新判定（生效条数比 `basedOn` 多 20 条就重建）与双实例合并取新。
	 */
	exampleSet?: {
		builtAt: number
		/** 生成时的"生效记忆条数"，用来判断该不该重建（新增 ≥20 条就重建） */
		basedOn: number
		pos: string[]
		neg: string[]
	}
	/** 结构版本 (旧数据没有该字段 ⇒ 视为 1) */
	schemaVersion?: number
}

/** 回收站上限 (超出丢最旧的；一条记忆很小, 20 条约 4KB) */
export const MAX_DELETED_BIN = 20

export const EMPTY_MEMORY_STORE: MemoryStoreData = {
	memories: [],
	summaries: [],
	summarizedMsgCount: 0,
	trimmedMsgCount: 0,
	meta: [],
	tombstones: [],
	blocks: [],
	deletedBin: [],
	schemaVersion: MEMORY_SCHEMA_VERSION,
}

const uid = (): string =>
	`m_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`

/* ------------------------------------------------------------------ */
/* 1. 提取: 规则匹配用户消息中的重要信息                                */
/* ------------------------------------------------------------------ */

interface ExtractRule {
	re: RegExp
	type: MemoryType
	importance: number
	confidence: number
	tag?: string
	/** 存库时拼在捕获内容前的内容标签 (偏好方向等), 防止方向性信息在提取时丢失 */
	label?: string
}

/**
 * 规则表: 从「记住/我叫/我喜欢/我在做…」等句式里抽取记忆.
 * 越明确的要求 (记住/我叫) 权重越高, 越模糊的偏好权重越低.
 */
const EXTRACT_RULES: ExtractRule[] = [
	// 显式要求记住 (最高权重)
	// 捕获一律"段级": 遇到逗号/句号/问号即停, 防止把同一句里后面的内容(反问/闲聊)也吸进记忆
	{re: /(?:请)?(?:一直|永远)?记住[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "core", importance: 0.85, confidence: 0.95, tag: "explicit"},
	{re: /(?:记住|记着|不要忘记|别忘了|记牢|一定要记住|帮我记下|记一下)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "fact", importance: 0.8, confidence: 0.9, tag: "explicit"},
	// 身份信息 (名字: 最明确)
	{re: /(?:我叫|我的名字是|我叫做|名字叫)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "fact", importance: 0.9, confidence: 0.95, tag: "identity"},
	// 身份信息 (职业/身份: 需带身份后缀, 避免"我是想问"误提取)
	{re: /(?:^|[,，。；;]|对,?|嗯,?|嗯嗯,?)我是[：:，,\s]*([^，。！？!?,.、]{1,12}(?:的|人|师|员|生|工|学生|老师|程序员|设计师|工程师))/i, type: "fact", importance: 0.7, confidence: 0.75, tag: "identity"},
	// 身份信息 ("我是小明" 等直接报名字: 捕获 2~6 字人名/称呼,
	// 排除"想问/来做/在忙/来问/想问/觉得/不是/不会/有点/还/想"等动词/语气开头, 防误判)
	{re: /(?:^|[,，。；;]|对,?|嗯,?|嗯嗯,?|对了,?)我是[：:，,\s]*(?!想|来|在|还|不|没|会|要|做|觉得|认为|有点|有)([^，。！？!?,.、]{2,6})/i, type: "fact", importance: 0.85, confidence: 0.9, tag: "identity"},
	// 偏好 (正面): 提取内容带"喜欢"方向, 避免"喜欢/讨厌/中性"混淆 (否则只会存下"下雨天")
	{re: /(?:我喜欢|我爱|我超爱|我好喜欢|我最喜欢|超喜欢|特别喜欢|老喜欢|特喜欢|最爱|最喜欢)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "preference", importance: 0.7, confidence: 0.85, tag: "preference", label: "喜欢"},
	{re: /(?:我喜欢|我爱|我最喜欢|超喜欢|特别喜欢)[的][：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "preference", importance: 0.65, confidence: 0.8, tag: "preference", label: "喜欢"},
	// 偏好 (负面): 带"不喜欢"方向
	{re: /(?:我不喜欢|我讨厌|我反感|我不爱吃|我不喜欢听|受不了|接受不了|最讨厌|特别讨厌|很不喜欢)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "preference", importance: 0.65, confidence: 0.85, tag: "preference", label: "不喜欢"},
	// 正在做的事 / 项目 (必须带明确动作词, 避免"我在想你"误提取)
	{re: /(?:我在做|我正在做|我在开发|我在搞|我在研究|我最近在做|我负责|我最近在忙|正在做|在忙)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "project", importance: 0.8, confidence: 0.8, tag: "project"},
	{re: /(?:我在学|我正在学|我在读|我在准备|我在备考|最近在学|正在学|在准备)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "project", importance: 0.6, confidence: 0.8, tag: "project"},
	// 住址 / 位置 (用"住在/家在"但要带地点特征: 城市/区/街道/楼/号)
	{re: /(?:我家在|我老家在|我住在|我目前住在)[：:，,\s]*([^，。！？!?,.、]{1,20}?(?:市|区|县|镇|村|街|路|大道|小区|楼|号|省))/i, type: "fact", importance: 0.5, confidence: 0.8},
	// 习惯 / 频率
	{re: /(?:每天|每晚|每周|总是|经常|习惯了|的习惯是|一般都|平时都)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "preference", importance: 0.5, confidence: 0.7},
	// 宠物 / 拥有
	{re: /(?:我|我家)(?:养了|养|买了|新买了|有只|有只猫|有只狗|有只)[：:，,\s]*([^，。！？!?,.、]+)/, type: "fact", importance: 0.45, confidence: 0.7},
	// 工作 / 职业 (补充)
	{re: /(?:我在这|我就职于|我在某|我在一家|我在.*(?:公司|单位))[：:，,\s]*([^，。！？!?,.、]*(?:公司|单位|上班|工作|当|做))/i, type: "fact", importance: 0.6, confidence: 0.7, tag: "work"},
	{re: /(?:我的工作是|我工作是|我职业是|我是做)[：:，,\s]*([^，。！？!?,.、]+)/, type: "fact", importance: 0.65, confidence: 0.75, tag: "work"},
	// 重要事件 / 生活变化
	{re: /(?:我最近|我刚|我昨天|我今天|这周我|下个月我|准备要)[：:，,\s]*([^，。！？!?,.、]{2,40})/, type: "event", importance: 0.6, confidence: 0.7, tag: "event"},
	// 关系
	{re: /(?:我有|我有个|我有一个|我对象|我女朋友|我男朋友|我老婆|我老公|我孩子|我爸妈|我家人)[：:，,\s]*([^，。！？!?,.、]+)/, type: "relationship", importance: 0.6, confidence: 0.7, tag: "relationship"},
	// 健康状态
	{re: /(?:我最近|我有点|我身体|我生病|我感冒|我失眠|我头疼|我胃疼)[：:，,\s]*([^，。！？!?,.、]+)/, type: "fact", importance: 0.55, confidence: 0.7, tag: "health"},
	// 目标 / 计划
	{re: /(?:我的目标|我打算|我计划|我想学|我要去|我准备去|我想去|打算去)[：:，,\s]*([^，。！？!?,.、]{1,60})/, type: "project", importance: 0.6, confidence: 0.7, tag: "project"},
]

/** 单条记忆最长保留字符数 (超长截断, 避免污染上下文) */
const MAX_MEMORY_LEN = 120

const cleanContent = (raw: string): string => {
	const trimmed = raw.trim()
	if (!trimmed) return ""
	return trimmed.length > MAX_MEMORY_LEN ? `${trimmed.slice(0, MAX_MEMORY_LEN)}…` : trimmed
}

/**
 * 按类型给默认衰减半衰期 (天). null = 永不衰减.
 * core(显式记住)/identity 类: 永久; 随口偏好: 衰减; 一次性事件: 快速过期.
 */
export const defaultDecayDays = (type: MemoryType): number | null => {
	switch (type) {
		case "core": return null          // 显式"记住X" → 永久
		case "fact": return 365           // 名字/职业/住址等稳定事实 → 长期
		case "relationship": return 180   // 家人/朋友/对象 → 长
		case "preference": return 90      // 随口喜欢/不喜欢 → 3 个月淡化
		case "project": return 60         // 正在做的事/学习 → 2 个月
		case "event": return 30           // 一次性事件/最近 → 1 个月过期
	}
}

/** 从内容判断是否"身份/核心"类 (规则打标 identity/explicit 的已归 core/fact, 这里兜底) */
const guessDecay = (type: MemoryType, tag?: string): number | null => {
	// 显式"记住"标签或身份标签 → 永久/超长
	if (tag === "explicit") return null
	if (tag === "identity") return 365
	return defaultDecayDays(type)
}

/**
 * 从一条用户消息中提取候选记忆 (规则法).
 * @param text 用户消息
 * @returns 提取到的记忆 (可能为空数组)
 */
export const extractMemories = (text: string): MemoryItem[] => {
	const now = Date.now()
	const items: MemoryItem[] = []
	for (const rule of EXTRACT_RULES) {
		const m = text.match(rule.re)
		if (!m) continue
		// label (偏好方向等) 拼在捕获前, 防方向性信息丢失 (如"喜欢下雨天" vs"不喜欢下雨天")
		const content = cleanContent(`${rule.label ?? ""}${m[1] ?? ""}`)
		if (!content) continue
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
			decayDays: guessDecay(rule.type, rule.tag),
		})
	}
	// 去重: 同一句可能被多条规则命中且内容重叠 ("我是程序员小明" → 职业规则得"程序员",
	// 名字规则得"程序员小明") —— 归一化后一方包含另一方时只保留先命中的一条 (更精确/高权重),
	// 否则同一条信息会以多个标签重复入库.
	return dedupeByContent(items)
}

/**
 * 内容归一化 (用于去重): 去标点/空白, 统一为小写
 * 防御: 历史脏数据 content 可能非字符串, 强转避免抛错导致整条记忆丢失
 */
export const normalizeContent = (s: unknown): string =>
	String(s ?? "").toLowerCase().replace(/[，。！？!?,.、\s"'“”‘’]+/g, "")

/** 句尾语气词 (反复剥, 见 normalizeForCompare) */
const TRAILING_PARTICLES = /(?:啊|呀|哦|哟|啦|呢|吧|嘛|哈|喔|噢)+$/

/**
 * 判重用的更宽容一档归一化: 在 normalizeContent 之上再剥掉**句尾语气词**。
 *
 * 为什么需要: 同一句话带不带句尾语气词会被抽成两种写法 ——
 * 「我的名字是小明哦」的规则通道抽出「小明哦」, 而 AI 通道给出「我的名字是小明」/「是小明哦」,
 * 归一化后互不包含 ⇒ 库里两条并存 (用户 2026-09-26 实测反馈的形态)。
 * 剥掉句尾语气词后「小明哦」→「小明」, 与「我的名字是小明」构成前缀关系, 才能判重。
 *
 * 为什么只剥**句尾**、不剥句首/句中: 句首的「我/我的名字是」是主语而不是语气词, 剥了会把
 * 「喜欢下雨天」和「不喜欢下雨天」这类方向相反的句子归一成同一串。
 * 为什么反复剥且限 4 次: 「好了吧」「小明哦哦」这类叠用语气词要一次剥净, 但要有上限防异常串。
 */
export const normalizeForCompare = (s: unknown): string => {
	let p = normalizeContent(s)
	for (let i = 0; i < 4 && p; i += 1) {
		const n = p.replace(TRAILING_PARTICLES, "")
		if (n === p) break
		p = n
	}
	return p
}

/* ---------------- 近重复判据 (软相似只用于"要不要请 AI 判重", 不用于判重本身) ---------------- */

/**
 * 近重复相似度阈值 (归一化双字组 Dice): 达到它就把旧记忆作为"判重候选"交给 AI。
 *
 * ## 为什么**不能**拿它当合并判据 (实测: tmp-memcheck/probe-mem-dup-tuning2.mjs)
 * 字符级相似度分辨不了"同一件事换说法"与"两个不同的值": 19 组**不该合并**的样本里,
 * t=0.65 就有 11 组会被误并, 包括方向相反的
 *   「我喜欢下雨天」/「我讨厌下雨天」= 0.727、「我不喜欢下雨天」/「我喜欢下雨天」= 0.727
 * 和只差一两个字的
 *   「我喜欢猫」/「我喜欢猫毛」= 0.857、「我女朋友叫小美」/「我女朋友叫小丽」= 0.833、
 *   「我在准备考研」/「我在准备考公」= 0.800、「我养了一只猫」/「我养了一只狗」= 0.800
 * 反过来 15 组**该合并**的样本它只覆盖 5 组 (t=0.65) —— 收益小、代价是静默丢信息。
 * 结论: 判重只认原文包含 (isSameContent); 近重复只用来**召回候选**, 让 AI 去判
 * (applyLlmMemoryDecision); 存量收敛 (collapseDuplicateMemories) 也只认原文包含。
 */
export const NEAR_DUP_DICE = 0.5

/** 双字组指纹 (归一化后按字符相邻双字计数, 支持重复字符) */
const bigramCounts = (s: string): {m: Map<string, number>; n: number} => {
	const m = new Map<string, number>()
	for (let i = 0; i < s.length - 1; i++) {
		const g = s.slice(i, i + 2)
		m.set(g, (m.get(g) ?? 0) + 1)
	}
	let n = 0
	for (const v of m.values()) n += v
	return {m, n}
}

/**
 * 归一化后双字组 Dice 相似度 (0~1), 用于**召回近重复候选**:
 * 同一件事换说法 / 只差一两个字的两条记忆, 词面 bigram 往往只重叠 1 个,
 * 过不了 recallMemories 的相关性门槛, 于是 AI 判重根本看不到它们 ——
 * 实测: 旧「我在准备考研考试」+ 新「我准备考研」时 usedLlm=false, 库里并存两条。
 * 把它作为"候选来源"补上, 判重仍然由 AI 做 (见 applyLlmMemoryDecision)。
 *
 * 归一化后不足 4 个字的短记忆不参与 (「我叫小明」/「我叫小刚」这类只差一字的短句
 * 相似度极高却语义不同, 不能靠字面判) → 返回 0 (完全相等仍返回 1)。
 */
export const contentSimilarity = (a: string, b: string): number => {
	const na = normalizeContent(a)
	const nb = normalizeContent(b)
	if (!na || !nb) return 0
	if (na === nb) return 1
	if (Math.min(na.length, nb.length) < 4) return 0
	const A = bigramCounts(na)
	const B = bigramCounts(nb)
	if (!A.n || !B.n) return 0
	let inter = 0
	for (const [g, n] of B.m) {
		const x = A.m.get(g)
		if (x) inter += Math.min(x, n)
	}
	return (2 * inter) / (A.n + B.n)
}

/**
 * 两条记忆是否"同一件事的同一说法" —— **可以确定的**判据, 只有原文包含:
 * 归一化 (含剥句尾语气词, 见 normalizeForCompare) 后完全相等, 或一方包含另一方
 * (旧条「喜欢下雨天」vs 新条「我喜欢下雨天」; 「小明哦」vs「我的名字是小明」)。
 * 判据刻意保持保守: 拿不准的一律交给 AI 决策 (applyLlmMemoryDecision) 或由用户手动删。
 *
 * ⚠ 不要把"包含"换成"相似度"或"任意子串": 实测「我喜欢猫」/「我喜欢猫毛」= 0.857、
 * 「猫」/「我家养了一只猫」= 包含 —— 用它扫全库会静默删数据 (见 collapseDuplicateMemories 注释)。
 */
export const isSameContent = (a: string, b: string): boolean => {
	const na = normalizeForCompare(a)
	const nb = normalizeForCompare(b)
	if (!na || !nb) return false
	return na === nb || na.includes(nb) || nb.includes(na)
}

/** 内容重叠去重: 归一化后一方包含另一方时只保留先出现的一条 (供规则提取与 LLM 提取共用)。
 *  判据用 isSameContent (原文包含), **不**用软相似 —— 同一条消息里被两条规则命中的候选
 *  若只差一两个字却是不同事情 (如"喜欢猫"/"喜欢猫毛"), 靠相似度合并会丢信息。 */
export const dedupeByContent = (items: MemoryItem[]): MemoryItem[] => {
	const kept: MemoryItem[] = []
	for (const item of items) {
		const dup = kept.some(k => isSameContent(k.content, item.content))
		if (!dup) kept.push(item)
	}
	return kept
}

/**
 * 在旧记忆池里找新记忆的合并目标: 归一化后原文互相包含即为同一件事 (判据见 isSameContent)。
 * 合并与存量收敛共用一个判据 —— 两处各写一份比较逻辑是这类 bug 的高发区。
 * @returns 命中下标; 无命中返回 -1
 */
export const findMergeTarget = (candidates: readonly MemoryItem[], content: string): number =>
	candidates.findIndex(prev => prev.content && isSameContent(prev.content, content))

/**
 * 合并 (抄 Mem0 思路): 新记忆与旧记忆高度重叠时, 不是简单丢弃,
 * 而是把旧记忆"浓缩升级" —— 内容合并 + 重要性取 max + 更新最近时间.
 * 一条旧记忆只允许被合并一次 (用剩余池避免重复 updated 覆盖).
 * @returns {added 新增, updated 被升级的旧记忆 (调用方需持久化)}
 */
export const mergeMemories = (
	newItems: MemoryItem[],
	existing: MemoryItem[],
): {added: MemoryItem[]; updated: MemoryItem[]} => {
	const added: MemoryItem[] = []
	const updated: MemoryItem[] = []
	const pool = [...existing.filter(isActiveMemory)] // 剩余可合并的旧记忆池 (一条只合并一次)
	// 【作废护栏】池里**剔除 invalidAt 的条目**: 否则新事实会被并进一条"已作废"的旧记忆,
	// 而合并只改 content/updatedAt、保留 `...prev` 的 invalidAt ⇒ 新信息写进去却不注入,
	// 等于静默丢数据 (且用户看不出为什么"记住了"没生效)。
	const now = Date.now()
	for (const item of newItems) {
		const idx = findMergeTarget(pool, item.content)
		if (idx < 0) {
			added.push(item)
			continue
		}
		const prev = pool[idx]
		pool.splice(idx, 1) // 消耗掉, 防止多条新记忆合并到同一条
		// 旧内容短于新内容时, 用更完整的新内容升级 (反之保持旧的, 避免退化)
		const mergedContent = prev.content.length < item.content.length ? item.content : prev.content
		// 衰减取"更永久"的一方: 显式"记住X"(decayDays=null) 并进旧条时, 不能被旧条的可衰减
		// 周期覆盖 —— 否则"记住:我喜欢下雨天"并进旧 preference 后, 90 天衰减会把本应
		// 永久的记忆在几个半衰期后悄悄过期掉
		const decayDays = prev.decayDays === null || item.decayDays === null ? null : prev.decayDays
		const mergedImportance = Math.max(prev.importance, item.importance)
		const mergedConfidence = Math.max(prev.confidence, item.confidence)
		const mergedTags = [...new Set([...(prev.tags ?? []), ...(item.tags ?? [])])]
		// 完全相同 (重复说过的话) → 既不改写也不算新增: 否则 applyLlmMemoryDecision 会把
		// 零变化计成 updated, "记住了"气泡在重复发言时反复弹 (冒烟测试第 4 条)
		const noChange = prev.content === mergedContent &&
			prev.importance === mergedImportance &&
			prev.confidence === mergedConfidence &&
			prev.decayDays === decayDays &&
			mergedTags.length === (prev.tags ?? []).length &&
			mergedTags.every(t => (prev.tags ?? []).includes(t))
		if (noChange) continue
		updated.push({
			...prev,
			content: mergedContent,
			importance: mergedImportance,
			confidence: mergedConfidence,
			updatedAt: now,
			tags: mergedTags,
			decayDays,
		})
	}
	return {added, updated}
}

/* ------------------------------------------------------------------ */
/* 1.5 LLM 提取: 主提取通道 (Mem0 风格: 该记/不该记清单 + few-shot)      */
/* ------------------------------------------------------------------ */

/** 明显的寒暄/语气词: 不值得为它花一次 LLM 调用 */
const CHITCHAT_RE = /^(?:在吗|在不在|你好|您好|hi|hello|hey|哈哈+|嘿嘿|呵呵|嗯+|哦+|噢+|好的|好呀|收到|谢谢|多谢|晚安|早安|早上好|晚上好|午安|再见|拜拜|没事|随便|不知道|是吗|真的吗|草|靠|呃+|额+)[\s!！。.~～?？]*$/i

/**
 * 是否跳过 AI 提取 (纯规则通道即可, 省 token):
 * 过短的消息、纯寒暄语气词 → 不可能包含值得长期记住的信息.
 */
export const shouldSkipLlmExtract = (text: string): boolean => {
	const t = text.trim()
	if (t.length < 4) return true
	return CHITCHAT_RE.test(t)
}

const pad2 = (n: number): string => `${n}`.padStart(2, "0")
const localDateStr = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/**
 * 构造 LLM 记忆提取提示词 (Mem0 风格两段式中的第一段).
 * 关键设计 (取自 Mem0 FACT_RETRIEVAL_PROMPT):
 * - 「该记的 7 类」+「不要记的 5 类」明确清单;
 * - few-shot 用中文覆盖: 寒暄→空、纯提问→空、情绪+事实混合只抽事实、一句话拆多条;
 * - 只从"主人(用户)"的消息里提取, 明令不许记 AI 自己的话;
 * - 内容写成主人的第一人称完整短句 (便于与规则结果合并, 注入也更自然);
 * - 注入今天日期, 便于把"下周三/明天"这类相对时间理解清楚;
 * - recentContext 只用于理解指代 (如"那个游戏"), 不作为提取来源.
 */
export const buildLlmExtractPrompt = (
	userText: string,
	recentContext: {role: string; content: string}[] = [],
): string => {
	const ctx = recentContext.length
		? recentContext
			.map(m => `${m.role === "user" ? "主人" : "Nori"}: ${String(m.content ?? "").replace(/\s+/g, " ").slice(0, 100)}`)
			.join("\n")
		: "(无)"
	return [
		"你是「个人信息整理员」, 负责从主人的发言里挑出值得长期记住的信息, 组织成一条条独立、清晰的事实。",
		"",
		"【该记的信息】",
		"1. 个人偏好: 喜欢/不喜欢的人、食物、事物、活动、娱乐;",
		"2. 重要个人信息: 名字、称呼、年龄、生日、家人朋友对象等关系、重要日期;",
		"3. 计划与打算: 近期要做的事、目标、想去的地方、答应过的事;",
		"4. 生活与活动习惯: 作息、爱好、常做的事、固定安排;",
		"5. 健康相关: 身体状况、饮食禁忌、健身与作息习惯;",
		"6. 工作与学习: 职业、专业、在学什么、在做什么项目;",
		"7. 其他杂项: 常看的书影音、常用品牌、宠物、住处等。",
		"",
		"【不要记的信息】",
		"1. 寒暄客套 (在吗/你好/谢谢/晚安);",
		"2. 提问与指使 (帮我查一下/你觉得呢/讲个笑话);",
		"3. 一时的情绪和吐槽 (今天好累/好无聊/这电影真难看);",
		"4. 一次性的琐碎当下动作 (我去吃饭了/刚洗完澡);",
		"5. Nori 自己说过的话 —— 只记主人的信息, 绝不记 AI 的话。",
		"",
		"【输出要求】",
		"- 每条 20 字以内, 用主人的第一人称完整短句, 如\"我叫小明\"\"喜欢下雨天\"\"我在准备考研\"\"下周要交论文\";",
		"- 一句话里有多个信息就拆成多条; 夹在情绪或提问里的事实也要抽出来;",
		"- type 取 fact(身份事实) / preference(偏好) / project(长期在做的事或目标) / event(近期事件) / relationship(关系) / core(主人明确要求记住的) 之一;",
		"- importance 0~1 (越长期越重要越高), confidence 0~1;",
		"- 按主人说话的语言记录;",
		"- 只输出 JSON, 不要任何解释。格式 {\"facts\":[{\"content\":\"...\",\"type\":\"fact\",\"importance\":0.6,\"confidence\":0.9}]}; 没有可记的就输出 {\"facts\":[]}。",
		"",
		"【示例】",
		"主人: 在吗 → {\"facts\":[]}",
		"主人: 哈哈今天天气不错 → {\"facts\":[]}",
		"主人: 你觉得我该学什么 → {\"facts\":[]}",
		"主人: 我叫小明, 是个程序员 → {\"facts\":[{\"content\":\"我叫小明\",\"type\":\"fact\",\"importance\":0.9,\"confidence\":0.95},{\"content\":\"我是程序员\",\"type\":\"fact\",\"importance\":0.75,\"confidence\":0.9}]}",
		"主人: 今天好累啊, 不过下周要交论文了 → {\"facts\":[{\"content\":\"我下周要交论文\",\"type\":\"event\",\"importance\":0.65,\"confidence\":0.9}]}",
		"主人: 我最喜欢的那部电影是星际穿越, 你看过吗 → {\"facts\":[{\"content\":\"我最喜欢的电影是星际穿越\",\"type\":\"preference\",\"importance\":0.6,\"confidence\":0.9}]}",
		"主人: 我最近在准备考研, 我妈让我别熬夜 → {\"facts\":[{\"content\":\"我在准备考研\",\"type\":\"project\",\"importance\":0.75,\"confidence\":0.9},{\"content\":\"我妈让我别熬夜\",\"type\":\"relationship\",\"importance\":0.5,\"confidence\":0.8}]}",
		"",
		`今天日期: ${localDateStr(new Date())} (用于换算\"下周三\"\"明天\"这类相对时间)`,
		"",
		"【最近对话 (只用于理解指代, 不要从 Nori 的话里提取信息)】",
		ctx,
		"",
		"【主人这句话】",
		userText,
	].join("\n")
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5)

/* ---------------- LLM 相关性召回 (语义召回, 关键词兜底) ---------------- */

/**
 * 构造 LLM 相关性判断提示词: 从候选记忆里挑出与当前发言真正相关的.
 * 解决关键词字面匹配抓不到同义/指代的问题 (如 "我昨天说的游戏" → "喜欢玩原神").
 * 输出 JSON 数组: [{id, reason}] / 空数组 []. 候选超限时先按关键词粗筛.
 */
export const buildLlmRelevancePrompt = (
	query: string,
	candidates: {id: string; content: string}[],
): string => [
	"你是记忆检索助手。根据用户当前发言, 从记忆列表里选出**真正相关**的若干条, 只输出 JSON 数组。",
	"判断标准:",
	"1. 记忆能帮助回答/理解当前发言, 或用户明显在指代之前说过的事;",
	"2. 同义表达也算相关 (如用户说'那个游戏' 记忆是'喜欢玩原神' 也算命中);",
	"3. 明显无关的不要选; 没有相关的就输出 []。",
	"格式: [{\"id\":\"记忆id\",\"reason\":\"一句话理由\"}], 不要输出其他任何文字。",
	"---用户发言---",
	query.slice(0, 200),
	"---记忆列表---",
	candidates.map(c => `${c.id}: ${c.content.slice(0, 100)}`).join("\n"),
].join("\n")

/**
 * 解析 LLM 相关性返回 (容错). 返回命中的记忆 id 数组 (按输出顺序).
 */
export const parseLlmRelevance = (raw: string, validIds: Set<string>): string[] => {
	let text = raw.trim()
	const FENCE = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
	if (FENCE) text = FENCE[1].trim()
	const START = text.indexOf("[")
	const END = text.lastIndexOf("]")
	if (START === -1 || END <= START) return []
	try {
		const arr = JSON.parse(text.slice(START, END + 1)) as unknown
		if (!Array.isArray(arr)) return []
		const out: string[] = []
		for (const item of arr) {
			if (!item || typeof item !== "object") continue
			const id = String((item as Record<string, unknown>).id ?? "")
			if (id && validIds.has(id) && !out.includes(id)) out.push(id)
		}
		return out
	} catch {
		return []
	}
}

/**
 * 解析 LLM 返回的记忆 JSON (容错):
 * - 支持代码围栏 / 前后杂文;
 * - 支持 {"facts":[{"content":...}]} (Mem0 风格) 与 {"facts":["字符串事实"]};
 * - 支持纯数组 [{"content":...}] / ["..."] (旧格式);
 * - 内容重叠的条目在最后统一去重.
 */
export const parseLlmMemories = (raw: string): MemoryItem[] => {
	let text = String(raw ?? "").trim()
	const FENCE = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
	if (FENCE) text = FENCE[1].trim()
	// 优先按对象解析 (取出 facts/memories/memory 字段), 再退回纯数组
	let arr: unknown = null
	const oStart = text.indexOf("{")
	const oEnd = text.lastIndexOf("}")
	if (oStart !== -1 && oEnd > oStart) {
		try {
			const obj = JSON.parse(text.slice(oStart, oEnd + 1)) as Record<string, unknown>
			const candidate = obj.facts ?? obj.memories ?? obj.memory
			if (Array.isArray(candidate)) arr = candidate
		} catch { /* 落到数组解析 */ }
	}
	if (!Array.isArray(arr)) {
		const aStart = text.indexOf("[")
		const aEnd = text.lastIndexOf("]")
		if (aStart !== -1 && aEnd > aStart) {
			try {
				const candidate = JSON.parse(text.slice(aStart, aEnd + 1))
				if (Array.isArray(candidate)) arr = candidate
			} catch { /* 忽略 */ }
		}
	}
	if (!Array.isArray(arr)) return []
	const TYPES: MemoryType[] = ["fact", "preference", "project", "event", "relationship", "core"]
	const now = Date.now()
	const items: MemoryItem[] = []
	for (const item of arr) {
		// 兼容字符串形式的事实 ("Name is John")
		const record: Record<string, unknown> | null =
			typeof item === "string" ? {content: item}
				: (item && typeof item === "object" ? item as Record<string, unknown> : null)
		if (!record) continue
		const content = String(record.content ?? record.text ?? "").trim().slice(0, MAX_MEMORY_LEN)
		if (!content) continue
		const type = (TYPES as string[]).includes(String(record.type ?? "")) ? String(record.type) as MemoryType : "fact"
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
			decayDays: defaultDecayDays(type),
		})
	}
	return dedupeByContent(items)
}

/* ------------------------------------------------------------------ */
/* 1.7 LLM 入库决策 (Mem0 第二段): ADD / UPDATE / DELETE / NONE          */
/* ------------------------------------------------------------------ */

export type MemoryDecisionEvent = "ADD" | "UPDATE" | "DELETE" | "NONE"

export interface MemoryDecision {
	/** 目标记忆 id; ADD 时为 "new" */
	id: string
	/** 该件事最终应存的内容 (NONE 可以留空) */
	text: string
	event: MemoryDecisionEvent
}

/**
 * 构造"入库决策"提示词 (Mem0 DEFAULT_UPDATE_MEMORY_PROMPT 的结构):
 * 把新提取的事实与召回到的相似旧记忆一起给 LLM, 由它决定每条旧记忆要不要改写/删除.
 * 这样重复、同义、矛盾(改口)都由语义判断处理, 不再依赖字符串包含.
 */
export const buildLlmMemoryDecisionPrompt = (
	facts: {content: string; type: string}[],
	existing: {id: string; content: string; type: string}[],
): string => [
	"你是记忆库管理员。把「新提取的事实」与「记忆库里已有的相似记忆」逐条对照, 决定怎么处理。",
	"",
	"四种操作:",
	"- ADD: 这是新信息, 库里没有 → 新增;",
	"- UPDATE: 库里已有同一件事, 但新事实信息更全/更准 → 用新事实改写那条旧记忆;",
	"- DELETE: 新事实与库里旧记忆**矛盾/已取代** (如旧\"喜欢下雨天\" vs 新\"不喜欢下雨天\", 旧\"我叫小明\" vs 新\"我叫小刚\") → 把旧记忆作废;",
	"  作废不等于抹掉: 旧记忆会进「历史」并可被还原, 所以**该用就用**, 不要因为舍不得而留着矛盾的两条;",
	"- NONE: 库里已有**同一件事** (新事实与它表述不同但信息相同, 或新事实只是它的一部分) → 不改动;",
	"  这也意味着这条新事实**不需要再单独存一遍** —— 不要因为措辞不同就把同一件事当成新信息;",
	"",
	"规则:",
	"1. 只处理\"同一件事\"; 无关的旧记忆不要出现在输出里;",
	"2. UPDATE/DELETE 必须使用下面「已有记忆」中给出的 id, 不要编造 id;",
	"3. ADD 的 id 统一写 \"new\";",
	"4. text 写这件事最终应存的内容 (20 字内、主人第一人称短句); 同义改写时优先保留信息更全的版本;",
	"5. UPDATE 的 text 请直接采用对应新事实的原措辞 (只做轻微顺句), 不要另起一套说法 —— 否则同一件事会在库里留下两种写法;",
	"6. 只输出 JSON, 不要任何解释文字。格式: {\"memory\":[{\"id\":\"...\",\"text\":\"...\",\"event\":\"ADD\"}]}",
	"7. DELETE 的门槛是**信息矛盾**(两条不能同时成立), 拿不准就选 NONE —— 作废虽可还原,",
	"   但每次误判都要主人自己动手收拾; 尤其**名字/身份/住址**这类高重要记忆, 只有明确改口才 DELETE。",
	"",
	"【新提取的事实】",
	facts.map(f => `- ${f.content} (${f.type})`).join("\n") || "(空)",
	"",
	"【已有记忆 (只能引用这些 id)】",
	existing.length ? existing.map(e => `${e.id} | ${e.content} (${e.type})`).join("\n") : "(无)",
].join("\n")

/** 解析入库决策 (容错: 代码围栏/前后杂文/大小写/缺字段/纯数组) */
export const parseLlmMemoryDecision = (raw: string): MemoryDecision[] => {
	let text = String(raw ?? "").trim()
	const FENCE = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
	if (FENCE) text = FENCE[1].trim()
	let arr: unknown = null
	const oStart = text.indexOf("{")
	const oEnd = text.lastIndexOf("}")
	if (oStart !== -1 && oEnd > oStart) {
		try {
			const obj = JSON.parse(text.slice(oStart, oEnd + 1)) as Record<string, unknown>
			const candidate = obj.memory ?? obj.facts ?? obj.memories ?? obj.decisions
			if (Array.isArray(candidate)) arr = candidate
		} catch { /* 落到数组解析 */ }
	}
	if (!Array.isArray(arr)) {
		const aStart = text.indexOf("[")
		const aEnd = text.lastIndexOf("]")
		if (aStart !== -1 && aEnd > aStart) {
			try {
				const candidate = JSON.parse(text.slice(aStart, aEnd + 1))
				if (Array.isArray(candidate)) arr = candidate
			} catch { /* 忽略 */ }
		}
	}
	if (!Array.isArray(arr)) return []
	const out: MemoryDecision[] = []
	for (const item of arr) {
		if (!item || typeof item !== "object") continue
		const r = item as Record<string, unknown>
		const id = String(r.id ?? "").trim()
		if (!id) continue
		const rawEvent = String(r.event ?? r.operation ?? r.action ?? "").trim().toUpperCase()
		const event: MemoryDecisionEvent =
			rawEvent === "ADD" || rawEvent === "UPDATE" || rawEvent === "DELETE" || rawEvent === "NONE"
				? rawEvent as MemoryDecisionEvent
				: "NONE"
		const content = String(r.text ?? r.content ?? "").trim().slice(0, MAX_MEMORY_LEN)
		out.push({id, text: content, event})
	}
	return out
}

/* ------------------------------------------------------------------ */
/* 1.6 合并分析: 一次 LLM 调用同时选表情 + 提取记忆 (省 token 省延迟)   */
/* ------------------------------------------------------------------ */

export interface LlmAnalyzeResult {
	/** 选中的表情名 (null = 无合适表情) */
	emotion: string | null
	/** 选中的动作名 (null = 无合适动作) */
	motion: string | null
	memories: MemoryItem[]
}

/**
 * 构造合并分析提示词: 从 Nori 回复选表情 + 从用户发言提取记忆
 */
export const buildLlmAnalyzePrompt = (
	userText: string,
	reply: string,
	expressionNames: string[],
	motionNames: string[] = [],
): string => [
	"你是 Nori 的反应助手。根据下面的对话完成三件事，只输出一个 JSON 对象，不要输出其他文字：",
	"1. emotion: 从 Nori 的回复中选择最贴切的情绪表情，只能来自可用表情列表；都不合适输出 null；",
	`可用表情: ${expressionNames.join("、") || "（无）"}`,
	"2. motion: 从可用动作列表中选择一个与情绪/语气最搭的动作；都不合适输出 null；",
	`可用动作: ${motionNames.join("、") || "（无）"}`,
	"3. memories: 从用户的发言中提取值得长期记住的信息（身份/偏好/正在做的事/重要事实/承诺），每条 20 字内、第三人称陈述，类型 fact/preference/project/event/relationship/core，importance 0~1、confidence 0~1；没有输出空数组。",
	'格式: {"emotion":"happy","motion":"jump","memories":[{"content":"...","type":"preference","importance":0.7,"confidence":0.8}]}',
	"---用户发言---",
	userText.slice(0, 300),
	"---Nori回复---",
	reply.slice(0, 500),
].join("\n")

/**
 * 解析合并分析结果 (容错: 代码围栏 / 前后杂文 / 缺字段)
 */
export const parseLlmAnalyze = (raw: string): LlmAnalyzeResult => {
	let text = raw.trim()
	const FENCE = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
	if (FENCE) text = FENCE[1].trim()
	const START = text.indexOf("{")
	const END = text.lastIndexOf("}")
	if (START === -1 || END <= START) return {emotion: null, motion: null, memories: []}
	let obj: unknown
	try {
		obj = JSON.parse(text.slice(START, END + 1))
	} catch {
		return {emotion: null, motion: null, memories: []}
	}
	if (!obj || typeof obj !== "object") return {emotion: null, motion: null, memories: []}
	const record = obj as Record<string, unknown>
	let emotion: string | null = null
	const rawEmotion = String(record.emotion ?? "").trim().toLowerCase()
	if (rawEmotion && rawEmotion !== "null" && rawEmotion !== "none" && rawEmotion !== "无") {
		emotion = rawEmotion
	}
	let motion: string | null = null
	const rawMotion = String(record.motion ?? "").trim().toLowerCase()
	if (rawMotion && rawMotion !== "null" && rawMotion !== "none" && rawMotion !== "无") {
		motion = rawMotion
	}
	const memories = parseLlmMemories(JSON.stringify(record.memories ?? []))
	return {emotion, motion, memories}
}

/* ------------------------------------------------------------------ */
/* 2. 召回: 按相关性打分, 取 Top K                                     */
/* ------------------------------------------------------------------ */

/**
 * 分词: 中文按相邻双字 (bigram) + 连续字母数字词切分.
 * 带缓存: 召回每次对全部记忆逐条分词, 内容字符串不可变 → 同串命中直接复用
 * (记忆库 300 条时省掉每条消息一次的全量重切).
 */
const tokenCache = new Map<string, string[]>()
export const tokenize = (s: string): string[] => {
	const hit = tokenCache.get(s)
	if (hit) return hit
	const lower = s.toLowerCase()
	const words: string[] = []
	// 连续字母/数字 (英文/数字关键词)
	for (const m of lower.matchAll(/[a-z0-9]+/g)) {
		const w = m[0]
		if (w.length >= 2) words.push(w)
	}
	// 中文: 相邻双字 bigram (长度 >= 2 的连续汉字段)
	for (const m of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
		const seg = m[0]
		for (let i = 0; i < seg.length - 1; i++) words.push(seg.slice(i, i + 2))
	}
	// 去重
	const uniq = [...new Set(words)]
	if (tokenCache.size > 800) tokenCache.clear() // 防查询串把缓存撑爆 (内容串数量有限)
	tokenCache.set(s, uniq)
	return uniq
}

/** 半衰期 (毫秒): 30 天前的新鲜度折半 (基础新鲜度) */
const RECENCY_HALF_LIFE = 30 * 24 * 3600 * 1000

/** 记忆的"最近活跃"时间: 被召回 / 合并升级 / 创建 中的最晚者 */
const lastActiveAt = (item: MemoryItem): number =>
	Math.max(item.lastAccessedAt || 0, item.updatedAt || 0, item.createdAt || 0)

const recencyScore = (item: MemoryItem, now: number): number => {
	const t = lastActiveAt(item)
	if (!t) return 0
	return Math.pow(0.5, (now - t) / RECENCY_HALF_LIFE)
}

/**
 * 类型衰减系数 (④ 时间衰减): 记忆按类型有半衰期 (decayDays),
 * 距"最近被提/创建/合并升级"超过半衰期后, 相关性打折 (随久远指数衰减).
 * decayDays = null (显式记住/核心) → 系数恒 1, 永不衰减.
 * 时间基准取 max(lastAccessedAt, updatedAt, createdAt): 合并升级/被召回都算"重新提及".
 * @returns 0~1 的保留系数 (1 = 新鲜/永久, 越小越该遗忘)
 */
export const decayFactor = (item: MemoryItem, now: number): number => {
	const days = item.decayDays
	if (!days || days <= 0) return 1
	const t = lastActiveAt(item)
	if (!t) return 1
	const halfLifeMs = days * 24 * 3600 * 1000
	return Math.pow(0.5, (now - t) / halfLifeMs)
}

/**
 * 词面重叠词元数 (查询与记忆共有的 bigram 个数).
 * 这是**相关性**的唯一判据; 召回是否收录只看它 (见 recallMemories)。
 */
export const overlapCount = (queryTokens: string[], item: MemoryItem): number => {
	const contentTokens = tokenize(item.content)
	return queryTokens.filter(t => contentTokens.includes(t)).length
}

/**
 * 计算一条记忆对当前问题的召回得分 (仅用于在**已判定相关**的记忆之间排序).
 * score = 语义重叠 + importance + confidence + recency + 强化(accessCount), 乘类型衰减
 */
export const scoreMemory = (queryTokens: string[], item: MemoryItem, now: number): number => {
	if (!queryTokens.length) return 0
	const overlap = overlapCount(queryTokens, item)
	const semantic = overlap / Math.sqrt(Math.max(queryTokens.length, 1))
	const base = (
		semantic * 2.0 +
		item.importance * 0.6 +
		item.confidence * 0.2 +
		recencyScore(item, now) * 0.3 +
		Math.min(item.accessCount, 10) / 10 * 0.1
	)
	// 类型衰减: 越久没被提、越是易过期的类型, 得分越低
	return base * decayFactor(item, now)
}

/**
 * 召回: 对全部记忆按当前用户消息打分, 取 Top K.
 * 命中后更新 lastAccessedAt / accessCount (强化), 返回 [命中的记忆, 需要持久化的记忆列表]
 *
 * 相关性是**必要条件**: 词面重叠为 0 的记忆直接不参与, 不看它的 importance/新鲜度。
 * 否则静态分 (importance*0.6 + confidence*0.2 + 新鲜度*0.3 + 强化*0.1) 单靠自身就能过阈值 ——
 * 一条 importance 0.9、当天创建的记忆语义为 0 时分数仍有 ~1.0, 远超 0.35,
 * 于是对**任何**提问都会被召回注入, 既挤占 topK 又白涨 accessCount。
 * 静态分只负责在相关记忆之间排序 (见 scoreMemory)。
 */
export const recallMemories = (
	items: MemoryItem[],
	query: string,
	topK = 8,
): {hits: MemoryItem[]; updated: MemoryItem[]} => {
	const now = Date.now()
	const tokens = tokenize(query)
	if (!tokens.length) return {hits: [], updated: []}
	const scored = items
		.filter(item => isActiveMemory(item))              // ← 作废的 (被改口/纠正取代) 一律不参与召回
		.filter(item => overlapCount(tokens, item) > 0)   // ← 相关性门槛 (必要条件)
		.map(item => ({item, score: scoreMemory(tokens, item, now)}))
		.sort((a, b) => b.score - a.score)
	// 相关记忆里再按得分过滤, 排除"只有一个极常见 bigram 重叠"的弱噪音
	const hits = scored.filter(s => s.score > 0.35).slice(0, topK).map(s => s.item)
	if (!hits.length) return {hits: [], updated: []}
	const hitIds = new Set(hits.map(h => h.id))
	const updated = items.map(item =>
		hitIds.has(item.id)
			? {...item, lastAccessedAt: now, accessCount: item.accessCount + 1}
			: item
	)
	return {hits, updated}
}

/**
 * 把命中的记忆渲染成注入上下文的 system 块
 */
export const buildMemoryBlock = (hits: MemoryItem[], limit = 6): string => {
	if (!hits.length) return ""
	const lines = hits.slice(0, limit).map(item => `- ${item.content}`)
	return `【长期记忆】(按需参考)\n${lines.join("\n")}`
}

/* ------------------------------------------------------------------ */
/* 3. 摘要: 旧对话压缩                                                 */
/* ------------------------------------------------------------------ */

/**
 * 构造摘要用的 system 提示词
 *
 * 2026-09-27 重构 P2: 由"摘要 + 记忆要点"升级为"摘要 + 结构化记忆块"。
 * 为什么要一次调用出两样: 记忆的**生产**从"每句话实时选词"搬到"每次历史总结之后" ——
 * 总结时模型看的是**整段按时间顺序的对话**, 段内的改口(「我想去买冰激凌」→「突然不想买了」)
 * 在提取那一刻就已是最终状态, 于是**根本不会产出被推翻的那条**, 不需要任何改口判据兜底。
 * 用哨兵行 ===MEM=== 分隔两个部分: 摘要永远优先 (解析失败/超时也能只留摘要)。
 *
 * 2026-09-28 加 `known` (去重方案 ④): 把"已经记住的内容"喂给模型。
 * 为什么必须喂: 实测确认提示词里原本**完全没有**库里已有的记忆, 模型是"蒙着眼睛"提取的 ——
 * 它不知道昨天已经记过同一件事, 于是重复条目照写 (实机截图:
 * 「我（小桧）想买鸡蛋」与「我想买鸡蛋」并存)。判重靠事后字符串比较抓不住近义措辞, 所以
 * 从源头让模型自己避开最省事 (零额外调用, 只是提示词长一点)。
 *
 * @param known 已记住的内容 (由调用方截断并限量, 见 index.ts 的 knownMemoryList)
 */
export const buildSummaryPrompt = (
	messages: {role: string; content: string}[],
	withMemoryBlock = true,
	known: readonly string[] = [],
	examples?: {pos?: readonly string[]; neg?: readonly string[]} | null,
): string => {
	const text = messages
		.map(m => `${m.role === "user" ? "用户" : "Nori"}: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`)
		.join("\n")
	// 记忆整理关掉时 (设置里的 memoryLlmExtract): 退回"摘要 + 记忆要点"文本式提示词。
	// 要点由**免费的关键词规则**通道提取 (不再是逐句跑, 而是跟着总结跑), 与旧行为一致:
	// 「关掉 AI 提取 = 只用关键词规则记住东西」这条用户可见的契约不能变。
	// (这条路径不加 known: 保持与旧行为逐字一致, 免得改动面扩大)
	if (!withMemoryBlock) {
		return [
			"你是记忆压缩助手。把下面这段对话历史压缩成一段简短摘要（100~200 字），只保留：",
			"1. 用户的重要身份信息、偏好、正在做的事；",
			"2. 讨论过的重要主题和结论；",
			"3. 承诺过的事情。",
			"不要添加原文没有的信息，不要写成对话形式，直接输出一段连贯的第三人称摘要。",
			"摘要写完后另起一行，输出「记忆要点」：只列出这段对话里值得长期记住的稳定新信息（身份、",
			"偏好、正在做的事、承诺），每行一条、用第一人称短句（如「我叫小明」「我喜欢下雨天」），",
			"最多 5 条；若这段对话没有这样的新信息，就只输出摘要本身，不要写记忆要点。",
			"---对话历史---",
			text,
		].join("\n")
	}
	const lines = [
		"你是记忆整理助手。读完下面这段对话历史, 输出两部分。",
		"【第一部分: 摘要】100~200 字第三人称叙述，只保留：用户的重要身份信息、偏好、正在做的事；",
		"讨论过的重要主题和结论；承诺过的事情。不要添加原文没有的信息，不要写成对话形式。",
		`【第二部分: 记忆块】另起一行写一行 ${MEM_SENTINEL}，紧接着输出一个 JSON 对象：`,
		'{"topic":"<8 字以内的主题>","items":[{"content":"<第一人称短句, 20 字以内>","type":"fact|preference|project|event|relationship|core","importance":0~1}]}',
		"记忆块的规则：",
		"1. 先判断「值不值得长期记住」，标准只有一个：**三个月后它还成立、并且以后主人提到相关的事时我还需要它吗？**",
		"两问都是「是」才写；只是「现在正在发生」的事，一律不写。",
		"2. 该写的就这几类：身份与称呼；稳定偏好（喜欢/不喜欢）；长期在做的事与目标；承诺与约定；重要关系；",
		"健康与禁忌；主人明确要求记住的（type 用 core，importance ≥0.9）。",
		"3. 不该写的（一条都不写）：当下的状态与身体感受（困了/饿了/累了/在忙/在洗澡）；一次性的动作与流水账",
		"（今天吃了什么、今天下雨、加班到十点）；一时的情绪（开心/烦躁）；寒暄、玩笑与提问；这段对话「发生的",
		"过程」本身；以及已经记住的内容换个说法再说一遍。",
		"——判别窍门：**一次性的不写，一贯的才写。** 例：「我今天加班到十点」→不写；「我最近一直在加班」→写。",
		"4. 示例 —— 写：「我叫小桧」「我不喜欢下雨天」「我最近在准备考研」「记住：我的生日是 3 月 2 号」；",
		"不写：「我有点困，准备去睡觉」「今天下雨了」「我还没吃饭」。",
		"5. importance ≥0.5 才输出这条（0.9+ 身份或明确要求；0.7 稳定偏好/长期项目/重要关系；0.5 一般事实）。",
		"**低于 0.5 的直接别写** —— 宁可这条不写，也不要为了凑数写不重要的事。",
		"6. 主人中途改口时，只记最终说法，不要记已被推翻的那个（例：先说「我想去买冰激凌」，",
		"后面说「突然不想买了」→ 只记「我不想买冰激凌了」）；省略宾语的句子要结合上下文补全；",
		"7. **同一件事只写一条**：说法不同但指的是同一件事的，也只写一条（例：「我（小桧）想买鸡蛋」",
		"与「我想买鸡蛋」是同一条，只写后者那种自然说法）；",
		"8. 上面【已经记住的内容】里已有的，若这段对话**没有改变它**，就不要再写一遍；",
		"但若这段对话**改变或补充**了它（改口、纠正、补充细节），**必须**按最终状态写出来 ——",
		"这才是最新的事实，旧说法会被自动作废留档，不要因为「已经记过」就不写；",
		"9. 内容写成自然的第一人称短句，**不要加括号注释、引号或书名号**，每条 20 字以内。",
		'10. 最多 6 条；**宁可 0 条**（输出 {"topic":"","items":[]}），也不要写不值得记的。',
		"不要输出 JSON 以外的解释文字。",
	]
	// 示例集 (整理优化): 从主人自己保留/删掉的记忆里学口味。**只作风格示例**, 不是对话内容。
	if (examples && ((examples.pos?.length ?? 0) > 0 || (examples.neg?.length ?? 0) > 0)) {
		if (examples.pos?.length) {
			lines.push(
				"【主人认可的记法（来自主人自己保留的记忆，照这个颗粒度记）】",
				`该记：${examples.pos.join(" / ")}`,
			)
		}
		if (examples.neg?.length) {
			lines.push(
				"【主人删掉过的（别再记这类）】",
				`不该记：${examples.neg.join(" / ")}`,
			)
		}
		lines.push("※ 以上只是**风格示例**，不是这段对话的内容，不要把它们写进摘要或记忆块。")
	}
	// 已记住的内容 (去重方案 ④): 明确标注"不是本段对话" + 只用于避免重复, 防模型把它当对话内容摘要进去
	if (known.length) {
		lines.push(
			"【已经记住的内容（仅供避免重复，**不是**下面这段对话的一部分，不要写进摘要）】",
			...known.map(k => `- ${k}`),
		)
	}
	lines.push("---对话历史---", text)
	return lines.join("\n")
}

/** 摘要与记忆块的分隔哨兵 (模型按此输出; 解析用 indexOf, 不依赖行首) */
export const MEM_SENTINEL = "===MEM==="
/** 单次记忆块最多接受几条 (与提示词里的上限一致; 模型超发就截断) */
export const MEM_BLOCK_MAX_ITEMS = 6
/** 记忆块主题最大长度 (提示词说 8 字, 这里留一倍余量只做防御) */
export const TOPIC_MAX_CHARS = 16

/** 记忆块解析结果 (尚未入库) */
export interface BlockOutput {
	/** 摘要正文 (注入上下文用) */
	summaryText: string
	/** 模型给的短主题; 空串 = 没给/没解析出来 */
	topic: string
	/** 解析出的条目 (已做类型/长度/重要性防御) */
	items: {content: string; type: MemoryType; importance: number}[]
}

/** 从文本里抠出第一个**配对完整**的 JSON 对象 (模型可能加 ```json 围栏或前后废话) */
const extractJsonObject = (raw: string): string | null => {
	const start = raw.indexOf("{")
	if (start < 0) return null
	let depth = 0
	let inStr = false
	let esc = false
	for (let i = start; i < raw.length; i += 1) {
		const ch = raw[i]
		if (inStr) {
			if (esc) esc = false
			else if (ch === "\\") esc = true
			else if (ch === '"') inStr = false
			continue
		}
		if (ch === '"') inStr = true
		else if (ch === "{") depth += 1
		else if (ch === "}") {
			depth -= 1
			if (depth === 0) return raw.slice(start, i + 1)
		}
	}
	return null
}

/**
 * 解析"摘要 + 记忆块"两段式输出。
 *
 * 容错原则 (**摘要永远优先**, 记忆块是加分项):
 * - 没有哨兵 → 整段当摘要 (等价旧格式, 记忆块为空);
 * - 哨兵后没有合法 JSON → 摘要照用, 记忆块为空 (上层据此降级到旧的"记忆要点"文本通道);
 * - 条目字段非法 → 逐条丢弃而不是整块丢 (内容为空/超长/类型不认识)。
 */
export const parseBlockOutput = (raw: string): BlockOutput => {
	const text = String(raw ?? "").trim()
	if (!text) return {summaryText: "", topic: "", items: []}
	const at = text.indexOf(MEM_SENTINEL)
	if (at < 0) return {summaryText: text, topic: "", items: []}
	const head = text.slice(0, at).trim()
	const tail = text.slice(at + MEM_SENTINEL.length)
	const jsonText = extractJsonObject(tail)
	if (!jsonText) return {summaryText: head || text, topic: "", items: []}
	let parsed: unknown
	try {
		parsed = JSON.parse(jsonText)
	} catch {
		return {summaryText: head || text, topic: "", items: []}
	}
	const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>
	const topic = typeof obj.topic === "string" ? obj.topic.trim().slice(0, TOPIC_MAX_CHARS) : ""
	const seen = new Set<string>()
	const items: BlockOutput["items"] = []
	const rawItems = Array.isArray(obj.items) ? obj.items : []
	for (const it of rawItems) {
		if (items.length >= MEM_BLOCK_MAX_ITEMS) break
		if (!it || typeof it !== "object") continue
		const rec = it as Record<string, unknown>
		const content = String(rec.content ?? "").trim().slice(0, MAX_MEMORY_LEN)
		if (!content) continue
		const key = normalizeForCompare(content)
		if (!key || seen.has(key)) continue
		seen.add(key)
		const t = String(rec.type ?? "").trim()
		items.push({
			content,
			type: (MEMORY_TYPES as readonly string[]).includes(t) ? (t as MemoryType) : "fact",
			importance: clamp01(Number(rec.importance)),
		})
	}
	return {summaryText: head || text, topic, items}
}

/**
 * 由块解析结果构造记忆条目 (P2)。
 * 字段与规则通道/LLM 通道产出的条目**完全一致**, 所以召回/注入/作废/固定/合并等所有既有
 * 路径不需要认识"块"这个概念。`decayDays` 用类型默认值: type=core ⇒ null (永不衰减),
 * 这是"主人明确要求记住"的永久性来源 (与规则通道的 explicit 标签同效)。
 */
export const makeMemoryItem = (input: {
	content: string
	type?: MemoryType
	importance?: number
	confidence?: number
	tags?: string[]
}): MemoryItem => {
	const content = String(input.content ?? "").trim().slice(0, MAX_MEMORY_LEN)
	const type: MemoryType = input.type && (MEMORY_TYPES as readonly string[]).includes(input.type)
		? input.type
		: "fact"
	const now = Date.now()
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
		decayDays: defaultDecayDays(type),
	}
}

/** 摘要最大长度 (防止摘要本身撑爆上下文) */
export const MAX_SUMMARY_CHARS = 600

/**
 * 按"句末边界"软截断。
 * 硬切 (slice + "…") 会在半句话中间截断, 注入后是残句; 这里优先退到最后一个句末标点。
 * 找不到合适边界 (或退得太狠 < 60% 上限) 时才回退硬切。
 */
export const softTruncate = (text: string, max: number): string => {
	if (text.length <= max) return text
	const head = text.slice(0, max)
	// 末尾 60% 范围内找最后一个句末标点
	const from = Math.floor(max * 0.6)
	let cut = -1
	for (let i = head.length - 1; i >= from; i -= 1) {
		const ch = head[i]
		if (ch === "。" || ch === "！" || ch === "？" || ch === "!" || ch === "?" || ch === "\n" || ch === "；" || ch === ";") {
			cut = i + 1
			break
		}
	}
	if (cut > 0) return head.slice(0, cut)
	return `${head}…`
}

/**
 * 摘要区间指纹 (跨实例去重依据)。
 *
 * 必须基于**消息时间戳**, 不能用下标 —— 自动裁剪会从前面删消息, 下标随之重排:
 * 裁剪后下一轮算出的区间又是同一组下标, 于是生成**同一个 id**, 落盘合并按 id 去重
 * 把这条新摘要当成重复丢掉, 摘要器每轮白干 (实测 200 轮只剩 2 条摘要)。
 * 时间戳是消息自带的稳定标识, 裁剪不会改变它, 两个实例对同一批消息也算出同一个 id。
 *
 * @returns 形如 `sum-<首条ts>-<末条ts>`; 消息无 ts 时退回下标 (兼容旧数据/测试)
 */
export const summaryIdFor = (
	batch: readonly {ts?: number}[],
	start: number,
): string => {
	const first = batch[0]?.ts
	const last = batch[batch.length - 1]?.ts
	if (typeof first === "number" && typeof last === "number" && (first || last)) {
		return `sum-${first}-${last}`
	}
	return `sum-${start}-${start + batch.length}`
}

/**
 * 记忆块 id (P2): 与摘要区间指纹**同源** (`blk-` 前缀), 理由与 summaryIdFor 完全一样 ——
 * 双实例(主界面/悬浮窗)对同一段对话并发总结时算出同一个 id, 落盘合并按 id 去重只留一份。
 */
export const blockIdFor = (batch: readonly {ts?: number}[], start: number): string =>
	`blk-${summaryIdFor(batch, start).slice(4)}`

export const makeSummary = (content: string, msgCount: number, id?: string): MemorySummary => ({
	// id 可由调用方传区间指纹 (见 summaryIdFor): 双实例对同一区间并发总结时产出相同 id,
	// 落盘合并按 id 去重只留一份; 不传则退回随机 uid (兼容旧调用)
	id: id ?? uid(),
	content: softTruncate(content, MAX_SUMMARY_CHARS),
	createdAt: Date.now(),
	msgCount,
	tokenCount: Math.max(1, Math.ceil(content.length / 4)),
})

/* ---------------- 摘要重叠去重 (双实例游标错位) ---------------- */

/** 从摘要 id 解析出覆盖的消息时间戳区间; 非区间指纹 (旧版 uid) 返回 null */
export const rangeOfSummary = (id: string): {start: number; end: number} | null => {
	const m = /^sum-(\d+)-(\d+)$/.exec(id)
	if (!m) return null
	const start = Number(m[1])
	const end = Number(m[2])
	if (!(end > start)) return null
	return {start, end}
}

/**
 * 两条摘要是否"覆盖同一段对话"。
 *
 * 为什么需要它: 主界面与悬浮窗的消息列表长度可能差 1 (主界面裁剪后会插一条占位
 * system 消息, 悬浮窗从磁盘读到的没有), 于是 `start = min(游标, total - RAW_WINDOW)`
 * 两边算出来差 1 —— 同一段对话被总结成 `sum-2-26` 与 `sum-3-27` 两条,
 * **id 不同, 按 id 去重抓不住**, 界面上表现为"历史总结重复了两条"。
 *
 * 判据: 重叠长度 ≥ 较短那段的 50% 即视为同一段。
 * 正常的相邻两批**零重叠** (游标接着上次末端, 不回头), 不会被误判。
 */
export const summariesOverlap = (
	a: {start: number; end: number},
	b: {start: number; end: number},
): boolean => {
	const lo = Math.max(a.start, b.start)
	const hi = Math.min(a.end, b.end)
	if (hi < lo) return false
	const overlap = hi - lo + 1
	const shorter = Math.min(a.end - a.start + 1, b.end - b.start + 1)
	if (shorter <= 0) return false
	return overlap * 2 >= shorter
}

/* ---------------- 历史总结注入 (字符预算制) ---------------- */

/** 注入历史总结的默认字符预算 (约 4000 字符 ≈ 2600 token)。
 *  为什么用"预算"而不是固定条数: 固定条数时摘要写得越多越浪费 ——
 *  写 12 条只用 2 条, 其余的写了也永远不注入。改成按预算从新往旧累加,
 *  近期摘要密集时注入 3~4 条, 摘要都短时能注入更多, 用满而不失控。 */
export const SUMMARY_BLOCK_BUDGET = 4000
/** 参与注入的 meta (折叠归档) 条数上限 —— 它们比逐条摘要更远, 留一小撮足够 */
export const META_INJECT_LIMIT = 2

/**
 * 把摘要 (含折叠归档 metas) 渲染成注入上下文的 system 块。
 *
 * 顺序: **先 metas (更久远) 再逐条摘要 (较近)**, 让模型读到时间正序。
 * 逐条摘要按 `budget` 从新往旧累加, 超预算即停 —— 停的是"再往前的整条",
 * 而不是截断内容 (避免注入残句)。
 */
export const buildSummaryBlock = (
	summaries: MemorySummary[],
	opts: {budget?: number; metas?: MemorySummary[]} = {},
): string => {
	const budget = opts.budget ?? SUMMARY_BLOCK_BUDGET
	const metas = opts.metas ?? []
	if (!summaries.length && !metas.length) return ""
	const head = `【历史总结】(较早对话的压缩记忆)\n`
	// 折叠归档 (最久远) 在前, 只留最近几条
	const oldMetas = [...metas].sort((a, b) => a.createdAt - b.createdAt).slice(-META_INJECT_LIMIT)
	// 逐条摘要: 新 → 旧 累加
	const newestFirst = [...summaries].sort((a, b) => b.createdAt - a.createdAt)
	const chosen: MemorySummary[] = []
	let used = head.length
	for (const s of newestFirst) {
		const cost = s.content.length + 1
		if (chosen.length && used + cost > budget) break
		chosen.push(s)
		used += cost
	}
	chosen.reverse()   // 时间正序
	const lines = [...oldMetas.map(m => m.content), ...chosen.map(s => s.content)]
	if (!lines.length) return ""
	return head + lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* 4. 遗忘机制: 上限 + 低频清理 (防止记忆无限膨胀、召回噪音上升)          */
/* ------------------------------------------------------------------ */

/** 记忆条数上限 (超出后丢弃低价值旧记忆) */
export const MAX_MEMORIES = 300
/**
 * 低频收起的**启动门槛**: 库内条数超过它, 才会去挑"低重要度 + 很久没人提"的条目收起。
 *
 * 2026-09-29 由 150 降到 **60**（用户拍板）：150 是**真删时代**的保守值 —— 那时删掉就没了,
 * 所以宁可留着不动; 现在自动路径只"**收起**"(进「已收起」, 可一键「留下」, 再次提到还会自动放回),
 * 代价从"丢数据"变成"多点一下", 于是可以放心让列表长期保持干净。
 */
export const PRUNE_AFTER = 60
/** 多少天未被召回视为"低频" */
const STALE_DAYS = 30

/**
 * 类型化过期 (④ 时间衰减的清理侧): 记忆按 decayDays 半衰期, 若「距最近被提/创建」
 * 已超过 半衰期 × EXPIRE_MULT 且从未或极少被召回 → 视为过期, 删除.
 * decayDays=null (显式记住/核心) 永不删除.
 * @returns 被删除的记忆
 */
export const EXPIRE_MULT = 3 // 超过 3 个半衰期未用 → 过期 (90 天偏好 → 270 天未提删除)

/**
 * **挑出"已过期"的记忆**（纯选择，不删）。
 * 与 `expireMemories`（返回保留列表）配对：现在存储层拿到这份清单后是**收起**而不是删除
 * —— 自动路径永不真删（用户担心"误删之后一点都不记了"）。
 */
export const pickExpiredMemories = (items: MemoryItem[], now = Date.now()): MemoryItem[] =>
	items.filter(it => {
		if (!isActiveMemory(it)) return false      // 作废/已收起的不用再判一次
		const days = it.decayDays
		if (!days || days <= 0) return false       // 永久 (显式记住/固定/目标)
		// 被召回强化过 (accessCount>=2) → 说明用户会再提, 不因久未提而收
		if (it.accessCount >= 2) return false
		const t = Math.max(it.lastAccessedAt, it.updatedAt, it.createdAt)
		if (!t) return false
		const expireMs = days * EXPIRE_MULT * 24 * 3600 * 1000
		return (now - t) > expireMs
	})

export const expireMemories = (items: MemoryItem[]): MemoryItem[] => {
	if (!items.length) return []
	const drop = pickExpiredMemories(items)
	// 没有任何过期记忆 → 原样保留 (绝不能返回 [], 否则会清空所有记忆!)
	if (!drop.length) return items
	const dropIds = new Set(drop.map(d => d.id))
	return items.filter(it => !dropIds.has(it.id))
}

/**
 * 数**生效**条数。PRUNE_AFTER / MAX_MEMORIES 这两道闸只该管生效记忆 ——
 * 已收起 (fadedAt) 与已作废 (invalidAt) 的条目**不参与召回, 只占文件**, 却一直留在
 * `store.memories` 里 (自动路径只标记、不移出) ⇒ 拿总条数去比, 溢出量会被它们抬高:
 * 库越过 MAX_MEMORIES 之后, 每写一条普通记忆下一拍就被判「该收起」, 最终只剩永久记忆活着。
 * 这是 2026-09-30 P3 长期推演查出的真 bug (最小复现 `tmp-memcheck/_dbg-p3-prune.mjs`,
 * 回归用例 `run-tests` T35; 详见 `长期运行推演-P3发现-20260930.md`)。
 */
const liveCount = (list: readonly MemoryItem[]): number => list.filter(isActiveMemory).length

/**
 * 第二轮 ("按价值分淘汰") 的**免死金牌**: 主人明显在意的东西, 不该被"新鲜垃圾"挤出去。
 *
 * 背景 (2026-09-30 P3 推演, 用户拍板方案 a): 库被一次性垃圾顶到 MAX_MEMORIES 之后, 淘汰按
 * 「重要度×0.6 + 新鲜度×0.3 + 被召回×0.1) × 类型衰减」排序, 而"新鲜度×衰减"这一项让
 * **新鲜的一次性垃圾**(衰减系数接近 1) 压过**很久没提的项目/偏好**(衰减后分数低) ⇒
 * 该记的被收起、垃圾留着 (最坏情况实测: 该记的 11 件事被收起, 生效里只剩垃圾)。
 *
 * 判据与已有豁免保持一致 —— 都是"主人明确要留"的信号: 重要度 ≥ 0.7、带
 * explicit / pinned / goal / identity 标签、或 core 类型。永久记忆 (decayDays=null)
 * 更早就被排除了, 不在这里重复。
 *
 * 为什么是 0.7 而不是更高: 0.7 是**提示词自己定的量纲**里的"稳定偏好 / 长期项目 / 重要关系"
 * 那一档 (0.5 = 一般事实, 0.9+ = 身份或明确要求), 而一次性垃圾落在 0.5~0.65 ——
 * 取 0.7 正好把"长期类"与"一次性类"分开, 不多不少。
 *
 * 代价: 免死金牌够多时生效条数会**超过** MAX_MEMORIES —— 这是有意的取舍 (宁可多留,
 * 也不把主人交代过的事丢掉), 与 decayDays=null 的豁免同一个思路。
 */
export const MIN_IMPORTANCE_KEEP = 0.7
const isProtectedFromOverflow = (it: MemoryItem): boolean =>
	it.type === "core" ||
	(it.importance ?? 0) >= MIN_IMPORTANCE_KEEP ||
	(it.tags ?? []).some(t => t === "explicit" || t === "pinned" || t === "goal" || t === "identity")

/**
 * 遗忘策略 (纯逻辑, 由存储层调用):
 * 1. 类型化过期 (expireMemories) 独立调用;
 * 2. **生效**记忆数超过 PRUNE_AFTER 时: 清理 30 天未召回 + 低重要性 (importance<0.6) 的旧记忆;
 * 3. **生效**记忆数仍超过 MAX_MEMORIES: 按「重要性×新鲜度×使用次数」综合得分从低到高丢弃, 直到回到上限.
 * @returns 被删除的记忆
 */
export const pruneMemories = (items: MemoryItem[]): MemoryItem[] => {
	if (liveCount(items) <= PRUNE_AFTER) return []
	let working = items
	const now = Date.now()
	// 第一轮: 清理"低频 + 低重要"的旧记忆
	// 永久记忆 (decayDays=null: 显式记住/固定/目标) 不参与低频清理 —— 用户明确要保留的优先级最高
	const staleMs = STALE_DAYS * 24 * 3600 * 1000
	const stale = working.filter(it =>
		isActiveMemory(it) &&              // 作废/已收起的不用再判一次
		it.decayDays !== null &&
		it.importance < 0.6 &&
		now - Math.max(it.lastAccessedAt, it.createdAt) > staleMs &&
		it.accessCount < 2
	)
	if (stale.length) {
		const staleIds = new Set(stale.map(s => s.id))
		working = working.filter(it => !staleIds.has(it.id))
	}
	// 第二轮: 若仍超上限, 按「价值分」从低到高丢弃 (重要度 + 新鲜度 + 被召回次数, 乘类型衰减)
	// 永久记忆 (decayDays=null) 不参与"按价值丢弃" —— expireMemories 豁免它们, 这里必须同样豁免;
	// 高重要度 / explicit / pinned / goal / identity 也有免死金牌 (见 isProtectedFromOverflow)
	if (liveCount(working) > MAX_MEMORIES) {
		const droppable = working.filter(it => isActiveMemory(it) && it.decayDays !== null && !isProtectedFromOverflow(it))
		const scored = droppable
			.map(it => ({
				it,
				score:
					(it.importance * 0.6 +
					recencyScore(it, now) * 0.3 +
					Math.min(it.accessCount, 10) / 10 * 0.1) * decayFactor(it, now),
			}))
			.sort((a, b) => a.score - b.score)
		const overflow = liveCount(working) - MAX_MEMORIES
		const drop = scored.slice(0, overflow).map(s => s.it)
		const dropIds = new Set(drop.map(d => d.id))
		working = working.filter(it => !dropIds.has(it.id))
	}
	return items.filter(it => !working.some(w => w.id === it.id))
}

/* ------------------------------------------------------------------ */
/* 5. 双实例一致性: 主 App 与悬浮窗各自 WebView 共享同一份 memory.json  */
/* ------------------------------------------------------------------ */

/** 单次载入最多自动收敛的存量重复条数 (剩下的下次载入继续收) */
export const COLLAPSE_MAX_MERGES = 50

/** 同 id 两条记录取较新的一份 (updatedAt 缺失时回退 createdAt) */
const newerOf = <T extends {id: string; createdAt: number; updatedAt?: number}>(x: T, y: T): T =>
	(x.updatedAt ?? x.createdAt) >= (y.updatedAt ?? y.createdAt) ? x : y

/** MemoryItem 冲突判定: 先比内容更新时间, 再比最近召回时间, 最后比召回次数.
 *  recall 强化只刷 lastAccessedAt/accessCount 不刷 updatedAt,
 *  只比 updatedAt 会把另一实例的召回强化计数吞掉.
 *  **作废/收起/还原都是"改动"**: 比的是 max(updatedAt, invalidAt, fadedAt) ——
 *  否则磁盘上那份还没作废的旧副本会凭"updatedAt 平局"赢下这条 id, 标记当场失效
 *  (改口纠正被静默回滚 / 收起被静默撤销)。
 *  平局时**偏袒"已作废 / 已收起"的那份**: 它们进「历史」并且一键可还原, 而错误地复活会把
 *  已被纠正的旧说法重新注入上下文 —— 后者用户几乎不可能察觉 (T29-C 实测到过静默回滚)。 */
const newerMemory = (a: MemoryItem, b: MemoryItem): MemoryItem => {
	const aU = Math.max(a.updatedAt ?? a.createdAt, a.invalidAt ?? 0, a.fadedAt ?? 0)
	const bU = Math.max(b.updatedAt ?? b.createdAt, b.invalidAt ?? 0, b.fadedAt ?? 0)
	if (aU !== bU) return aU > bU ? a : b
	const aOff = !!(a.invalidAt || a.fadedAt)
	const bOff = !!(b.invalidAt || b.fadedAt)
	if (aOff !== bOff) return aOff ? a : b
	if (a.lastAccessedAt !== b.lastAccessedAt) return a.lastAccessedAt > b.lastAccessedAt ? a : b
	return a.accessCount >= b.accessCount ? a : b
}

/**
 * 存量收敛专用判据 (**比写入合并更严**): 只收"同一句话只是多个主语前缀 / 尾语气词"的那一档。
 *
 * ## 为什么不能直接用 isSameContent 扫全库
 * 它的"包含"是双向的, 而全库扫描是每次载入、自动、无预览的 —— 实测
 * `isSameContent("咖啡","每天喝咖啡")` = true, 于是一条短记忆会被库里任何提到它的长记忆
 * 吞掉, 静默丢数据且没有撤销入口。(业界同类经验也一致: 自动合并的相似度门槛应显著高于
 * 人工复核 —— Plauti 的建议是人工 80~85%、自动 90%+; Mem0 本身则完全不做入库期字符串合并,
 * 交给 LLM 的 ADD/UPDATE/DELETE。)
 *
 * ## 放行规则 (先剥白名单主语前缀, 再要求**完全相等**, 不做通用子串判定)
 *   ① 剥掉句尾语气词后完全相同 (「我的名字是小明」/「我的名字是小明哦」);
 *   ② 从长的那条里剥掉一个白名单主语前缀后, 与短的那条**逐字相同**
 *      (「小明」/「我的名字是小明」、「小明」/「我叫小明」、「在准备考研」/「我最近在准备考研」这份不收, 只剥一次)。
 * 白名单**不含「我家」**: 实测语料里「养猫」/「我家养猫」会被它并掉, 而"我家养的猫"与
 * "我养猫"是两条不同信息 (谁家的猫) —— 宁可漏收。「我」保留: 所有负例都挡得住
 * (「咖啡」/「每天喝咖啡」、日语/我在学日语、跑步/我每天早上跑步…), 正例又多靠它。
 * 拿不准的一律不收, 留在库里由 AI 判重 (写入时) 或用户手动删。
 */
const COLLAPSE_SUBJECT_PREFIXES = ["我的名字是", "我的名字叫", "我的名字", "我叫", "我是", "我", "自己", "主人"]

/** 两条**已归一化**的内容是否属"确定无疑的重复" (判据本体: 相等, 或长的那条剥掉一个白名单主语前缀后与短的逐字相同) */
const sameNormalized = (x: string, y: string): boolean => {
	if (!x || !y) return false
	if (x === y) return true
	const [short, long] = x.length <= y.length ? [x, y] : [y, x]
	return COLLAPSE_SUBJECT_PREFIXES.some(p => long.startsWith(p) && long.slice(p.length) === short)
}

/**
 * 存量重复收敛: 把库里**确定无疑的重复**合并成一条 (保留信息更全的那条)。
 * 与摘要的 dropOverlappingSummaries 同一个思路 —— 以前只有摘要有自动收敛。
 *
 * 判据见 sameNormalized (刻意比写入合并更严, 因为它自动、无预览、还会写盘)。
 * 注意它运行在**每次载入**, 所以宁可少收: 误并 = 静默丢信息。
 *
 * @returns {removed 被合并掉的条数, dropped 被合并掉的那些条目 (调用方登记墓碑)}
 */
export const collapseDuplicateMemories = (
	store: MemoryStoreData,
	limit = COLLAPSE_MAX_MERGES,
): {removed: number; dropped: MemoryItem[]} => {
	const list = store.memories
	if (list.length < 2) return {removed: 0, dropped: []}
	const kept: MemoryItem[] = []
	/**
	 * 与 kept 一一对应的**归一化缓存** (2026-09-30 性能改写)。
	 *
	 * 为什么要有: 旧写法每次两两比较都调 collapseSameContent → 内部把两边各归一化一遍,
	 * 同一条被反复归一化 O(n) 次 ⇒ 载入耗时随生效条数**平方**增长 (实测 70 条 5.8ms /
	 * 150 条 20.8ms / 300 条 65~80ms; 手机上还要再慢几倍)。
	 *
	 * ⚠ 唯一的风险点: 合并会把 kept[hit] 的内容换成更长的那条 ⇒ **缓存必须同步更新**,
	 * 否则后续比较会拿着旧内容判重。这一点由 tmp-memcheck/_dbg-collapse-equivalence.mjs
	 * 在边界用例 + 真实语料 + 随机语料上逐字段证明"与旧实现同判"。
	 * 另外: 非字符串内容 (历史脏数据) 旧实现不让它"吸收别人"、但允许它"被别人命中"
	 *   (normalizeContent 会把 123 变成 "123") —— 所以这里照样缓存它的归一化串。
	 */
	const norms: string[] = []
	const gone: MemoryItem[] = []
	let removed = 0
	for (const it of list) {
		const norm = normalizeForCompare(it?.content)
		// 【作废护栏】已作废/已收起的条目只作旁观者: 既不吸收别人 (否则把活记忆并进死条目),
		// 也不被别人收敛掉 (否则自己明明被作废、却把活的那条顶替没了)。
		if (!it || typeof it.content !== "string" || !isActiveMemory(it) || !norm) {
			kept.push(it)
			norms.push(norm)
			continue
		}
		let hit = -1
		for (let i = kept.length - 1; i >= 0; i -= 1) {
			if (!isActiveMemory(kept[i])) continue
			// 判据见 sameNormalized (比写入合并更严: 只放行"少主语/尾语气词"那一档)
			if (sameNormalized(norms[i], norm)) { hit = i; break }
		}
		// 触顶后不再合并 (只按原样保留): 单次载入最多收敛这么多条, 剩下的下次载入继续收 (幂等)
		if (hit < 0 || removed >= limit) { kept.push(it); norms.push(norm); continue }
		removed += 1
		gone.push(it)
		// 合并就是"丢重复": 内容取更完整的一方 (标点/语气词更全的通常更长),
		// importance/confidence 取大, 标签并集, decayDays 取"更永久"的一方 ——
		// 否则「记住我喜欢下雨天」的永久性会被旧的可衰减条目吃掉。
		// 保留 kept[hit].id (库里仍是同一条, 不产生 churn)。
		const a = kept[hit]
		const merged: MemoryItem = {
			...a,
			content: it.content.length > a.content.length ? it.content : a.content,
			importance: Math.max(a.importance, it.importance),
			confidence: Math.max(a.confidence, it.confidence),
			decayDays: a.decayDays === null || it.decayDays === null ? null : a.decayDays,
			tags: [...new Set([...(a.tags ?? []), ...(it.tags ?? [])])],
			updatedAt: Date.now(),
		}
		kept[hit] = merged
		// ★ 内容被换成新那条时, 缓存跟着换 (留着旧的 = 拿已不存在的内容判重)
		norms[hit] = merged.content === a.content ? norms[hit] : norm
	}
	if (!removed) return {removed: 0, dropped: []}
	store.memories = kept
	return {removed, dropped: gone}
}

/**
 * 落盘合并 (数据保全): 每实例内存里各有自己的 cache, 直接全量覆盖会互相
 * 弄丢对方已落盘的内容. 合并规则:
 * - memories / summaries: 按 id 并集, 同一 id 冲突取较新的一份;
 * - summarizedMsgCount: 取 max (游标永不倒退, 避免重复总结已总结的区间).
 * @param a 磁盘上的版本
 * @param b 本地内存版本
 */
export const mergeStores = (a: MemoryStoreData, b: MemoryStoreData): MemoryStoreData => {
	// 墓碑并集: 任一实例删除过的 id, 合并后都不再复活.
	// (墓碑只在本实例内存里 → 悬浮窗一写就把主界面删掉的记忆带回来, 故必须随 store 持久化)
	const tombs = new Map<string, number>()
	for (const t of [...(a.tombstones ?? []), ...(b.tombstones ?? [])]) {
		if (!t || !t.id) continue
		const at = Number(t.at) || 0
		tombs.set(t.id, Math.max(tombs.get(t.id) ?? 0, at))
	}
	const mem = new Map<string, MemoryItem>()
	for (const it of [...a.memories, ...b.memories]) {
		if (tombs.has(it.id)) continue
		const old = mem.get(it.id)
		mem.set(it.id, old ? newerMemory(old, it) : it)
	}
	const sum = new Map<string, MemorySummary>()
	for (const s of [...a.summaries, ...b.summaries]) {
		if (tombs.has(s.id)) continue
		const old = sum.get(s.id)
		sum.set(s.id, old ? newerOf(old, s) : s)
	}
	// 折叠归档同样按 id 并集去重 (meta 的 id 是区间指纹, 双实例并发折叠会产出相同 id)
	const meta = new Map<string, MemorySummary>()
	for (const m of [...(a.meta ?? []), ...(b.meta ?? [])]) {
		if (tombs.has(m.id)) continue
		const old = meta.get(m.id)
		meta.set(m.id, old ? newerOf(old, m) : m)
	}
	// 记忆块并集 (P1): 同一个 id = 双实例总结了同一段对话。
	// 成员**取并集**而不是"取较新一份": 两个实例各自往 memories 里写了自己提取的条目,
	// 合并后这些条目都在库里 —— 块里只留一方的 id, 另一方的条目在块视图里就成孤儿。
	// topic/summary 取较新的那份 (谁说完了算谁的), 区间取并集 (两端扩展)。
	// ⚠ 循环变量别叫 `b`: 参数就叫 b, `for (const b of [...(b.blocks…)])` 会踩 TDZ
	// (循环头绑定在"可迭代表达式"里已生效) ⇒ 落盘合并直接抛 ReferenceError。
	const blk = new Map<string, MemoryBlock>()
	for (const one of [...(a.blocks ?? []), ...(b.blocks ?? [])]) {
		if (!one || typeof one.id !== "string" || !one.id) continue
		if (tombs.has(one.id)) continue
		const old = blk.get(one.id)
		if (!old) {
			blk.set(one.id, {...one, itemIds: [...new Set(one.itemIds ?? [])]})
			continue
		}
		blk.set(one.id, {
			...newerOf(old, one),
			fromTs: Math.min(old.fromTs, one.fromTs),
			toTs: Math.max(old.toTs, one.toTs),
			msgCount: Math.max(old.msgCount ?? 0, one.msgCount ?? 0),
			itemIds: [...new Set([...(old.itemIds ?? []), ...(one.itemIds ?? [])])],
		})
	}
	// 悬空引用必须在这里就地清掉: 成员是**并集**, 而"条目被删/被低频清理"在另一边是
	// "少了一个 id" —— 并集会让已删条目的引用**复活** (实测: 删除后块里那条又回来了)。
	// 判据用合并后的 `mem` (已过墓碑、按 id 去重) —— 解析不到条目的引用一律不留。
	for (const [id, one] of blk) {
		const kept = one.itemIds.filter(x => mem.has(x))
		if (kept.length !== one.itemIds.length) blk.set(id, {...one, itemIds: kept})
	}
	return {
		memories: [...mem.values()],
		summaries: [...sum.values()],
		summarizedMsgCount: Math.max(a.summarizedMsgCount, b.summarizedMsgCount),
		// 两个计数都**只增不减** (已摘要的总条数 / 已被裁掉的总条数) ⇒ 取 max 是对的;
		// 当前数组里的"下一个要摘要的下标"由两者相减得出 (见 trimmedMsgCount 注释)
		trimmedMsgCount: Math.max(a.trimmedMsgCount ?? 0, b.trimmedMsgCount ?? 0),
		tombstones: [...tombs.entries()].map(([id, at]) => ({id, at})),
		// 示例集: 取 builtAt 较新的那份; **平局取本地(b)** —— 本地刚做过的摘除/清除不能被
		// 磁盘上那份还没更新的旧副本顶回去 (T34-M6 实测: 点了「清除示例」又被合并复活)
		exampleSet: (() => {
			const x = a.exampleSet
			const y = b.exampleSet
			if (!x) return y
			if (!y) return x
			return (x.builtAt ?? 0) > (y.builtAt ?? 0) ? x : y
		})(),
		// 回收站: 按 id 并集, 同 id 取 deletedAt 较新的; 超出上限丢最旧的。
		// ⚠ 不按墓碑过滤 —— 回收站里的条目**本来就是被删的**(带墓碑), 过滤掉就没法还原了。
		deletedBin: (() => {
			const bin = new Map<string, MemoryItem>()
			for (const it of [...(a.deletedBin ?? []), ...(b.deletedBin ?? [])]) {
				if (!it || typeof it.id !== "string" || !it.id) continue
				const old = bin.get(it.id)
				if (!old || (it.deletedAt ?? 0) > (old.deletedAt ?? 0)) bin.set(it.id, it)
			}
			return [...bin.values()]
				.sort((x, y) => (y.deletedAt ?? 0) - (x.deletedAt ?? 0))
				.slice(0, MAX_DELETED_BIN)
		})(),
		meta: [...meta.values()],
		// 按区间正序, 让块视图的时间线顺序稳定 (Map 的插入序取决于 a/b 谁先, 不可依赖)
		blocks: [...blk.values()].sort((x, y) => (x.fromTs - y.fromTs) || x.id.localeCompare(y.id)),
		schemaVersion: MEMORY_SCHEMA_VERSION,
	}
}

/**
 * 摘要条数封顶: 超过 max 条时丢弃最旧的 (摘要本质是"近况压缩", 保留最新一段).
 * 与 summarizeIfNeeded 内的裁剪共用同一实现, 供启动时收敛存量超标数据.
 * 注: 这里只负责"选谁留下", 被丢弃的那些由存储层折叠进 meta (见 foldDroppedSummaries)。
 */
export const capSummaries = (summaries: MemorySummary[], max: number): MemorySummary[] => {
	if (summaries.length <= max) return summaries
	return [...summaries].sort((x, y) => y.createdAt - x.createdAt).slice(0, max)
}

/* ---------------- 两级压缩: 把被丢弃的逐条摘要折成归档 meta ---------------- */

/** 单条摘要在归档里保留的摘录长度 (只留开头, 够勾勒脉络) */
export const META_EXCERPT_CHARS = 80
/** 归档 meta 的条数上限 (超出丢最旧的 meta) */
export const MAX_METAS = 6
/** 归档 meta 单条最大长度 */
export const MAX_META_CHARS = 500

const dayOf = (ts: number): string => {
	const d = new Date(ts)
	return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * 把若干条被丢弃的逐条摘要折叠成一条归档 meta。
 *
 * 刻意**不调 LLM**: 折叠是同步、确定性的 —— 避免异步 + 双实例并发折叠互相覆盖,
 * 也避免多一次 LLM 调用与失败路径。质量上够用: 归档只用于"久远脉络", 细节由
 * 逐条摘要与长期记忆承载。
 *
 * @returns 折叠出的 meta; 输入为空时返回 null
 */
export const foldDroppedSummaries = (dropped: MemorySummary[]): MemorySummary | null => {
	if (!dropped.length) return null
	const asc = [...dropped].sort((a, b) => a.createdAt - b.createdAt)
	const from = dayOf(asc[0].createdAt)
	const to = dayOf(asc[asc.length - 1].createdAt)
	const parts: string[] = []
	let used = 0
	for (const s of asc) {
		const one = s.content.replace(/\s+/g, " ").trim().slice(0, META_EXCERPT_CHARS)
		if (!one) continue
		if (used + one.length + 1 > MAX_META_CHARS - 40) break
		parts.push(one)
		used += one.length + 1
	}
	if (!parts.length) return null
	const content = softTruncate(`〔${from}–${to}〕${parts.join("；")}`, MAX_META_CHARS)
	return {
		// 区间指纹: 双实例对同一批被丢弃摘要折叠时产出相同 id → 合并去重只留一份
		id: `meta-${asc[0].createdAt}-${asc[asc.length - 1].createdAt}`,
		content,
		createdAt: asc[0].createdAt,   // 用最早的创建时间: 它在时间轴上位于这些摘要之前
		msgCount: asc.reduce((n, s) => n + (s.msgCount || 0), 0),
		tokenCount: Math.max(1, Math.ceil(content.length / 4)),
	}
}
