/**
 * Android 记忆服务: 存储走 NoriChat 文件桥 (memory.json, 与 chat.json 同在公共下载目录)
 */
import {readFile, writeFile} from "../chat"
import {DIAG_PROMPT_MAX, DIAG_RAW_MAX, recordOrganize} from "./diag"
// 记忆诊断日志 (P1): 供界面读写（开关/条数/清空/导出）
export {
	buildDiagJsonl,
	clearDiag,
	diagCount,
	diagEnabled,
	lastDiagRecord,
	MAX_DIAG_RECORDS,
	recordOrganize,
	setDiagEnabled,
	type MemDiagRecord,
} from "./diag"
import {
	blockIdFor,
	buildLlmExtractPrompt,
	buildLlmMemoryDecisionPrompt,
	buildLlmRelevancePrompt,
	buildMemoryBlock,
	buildSummaryBlock,
	buildSummaryPrompt,
	capSummaries,
	collapseDuplicateMemories,
	contentSimilarity,
	defaultDecayDays,
	EMPTY_MEMORY_STORE,
	extractMemories,
	foldDroppedSummaries,
	isActiveMemory,
	isSameContent,
	isWorthRemembering,
	makeMemoryItem,
	makeSummary,
	MAX_DELETED_BIN,
	MEMORY_SCHEMA_VERSION,
	mergeMemories,
	mergeStores,
	MAX_METAS,
	NEAR_DUP_DICE,
	normalizeContent,
	normalizeForCompare,
	overlapCount,
	parseBlockOutput,
	parseLlmMemories,
	parseLlmMemoryDecision,
	parseLlmRelevance,
	pickExpiredMemories,
	pruneMemories,
	rangeOfSummary,
	recallMemories,
	scoreMemory,
	shouldSkipLlmExtract,
	summariesOverlap,
	summaryIdFor,
	tokenize,
	type MemoryBlock,
	type MemoryDecision,
	type MemoryItem,
	type MemoryStoreData,
	type MemorySummary,
} from "./core"

// 合并分析工具 (表情+记忆一次调用) 供 App.vue 使用
export {buildLlmAnalyzePrompt, parseLlmAnalyze} from "./core"
// 记忆提取工具 (LLM 版, 供 analyzeAfterReply 使用)
export {buildLlmExtractPrompt, parseLlmMemories} from "./core"
// Mem0 两段式第二段: 入库决策 (提示词/解析/跳过判断), 供调用方与测试使用
export {buildLlmMemoryDecisionPrompt, parseLlmMemoryDecision, shouldSkipLlmExtract} from "./core"
// LLM 相关性召回 (供 recallForQuerySmart 使用)
export {buildLlmRelevancePrompt, parseLlmRelevance} from "./core"
// 规则提取 (诊断/外部直接调用)
export {extractMemories} from "./core"

const FILE = "memory.json"
const FILE_BAK = "memory.json.bak"
/**
 * 迁移前的 v1 快照 (P1)。只在**首次**迁移时写一次 (已存在就不覆盖, 免得把最早的
 * 那份 v1 快照换成"迁移后又被改过"的半成品)。出问题可整体换回 memory.json。
 */
const FILE_V1 = "memory.v1-backup.json"

/** 近端原始消息保留条数 (之前的历史交给摘要) */
const RAW_WINDOW = 20
/** 触发摘要的历史条数阈值 (未摘要消息数达到该值就压缩) */
const SUMMARIZE_THRESHOLD = 25
/** 单次摘要最多处理的消息条数 (防止提示词无限膨胀) */
const MAX_SUMMARIZE_BATCH = 25
/** 历史总结条数上限 (每条≤600 字; 超出后丢最旧的并折进 meta 归档, 防止文件/上下文无限膨胀)。
 *  12 → 24: 12 条只覆盖约 300 条消息 (每天用几天就满), 24 条覆盖约 600 条;
 *  注入侧已改为**字符预算制**, 所以提高归档深度不会增加常态 token 成本。 */
const MAX_SUMMARIES = 24
/**
 * 单次注入上下文的最大记忆条数 (唯一来源)。
 * 召回取数与渲染条数都必须用它 —— 曾出现"取 8 条只渲染 6 条", 多出的两条
 * 从未进过上下文却被强化, 导致价值评分与免过期判定基于虚假数据。
 */
const MEMORY_BLOCK_LIMIT = 6

/**
 * 记忆块条数上限 (P2)。块的 summary 与 summaries[] 同源 (摘要另有 24 条上限 + meta 归档),
 * 所以丢掉的只是"这段条目属于哪个时间段"这一层**组织信息**: 条目本身与叙事脉络都不受影响
 * (条目会落到记忆库的「未归类」桶里, 不会消失)。上限存在的意义是防 memory.json 无界增长
 * (它每次改动都全量重写)。200 块 ≈ 5000 条消息, 正常使用远到不了。
 */
const MAX_BLOCKS = 200

let cache: MemoryStoreData | null = null

/* ---------------- 双实例一致性状态 (主 App / 悬浮窗共享同一 memory.json) ---------------- */
/** 本实例最近一次成功写盘的原文: 落盘时若磁盘内容 ≠ 它, 说明被别的实例改过 */
let lastWrittenRaw: string | null = null
/** 本会话删除过的 id (墓碑): 落盘合并时不再把它们从磁盘旧副本"复活" */
const deletedIds = new Set<string>()
/** 墓碑上限: 超出按时间丢最旧的 (磁盘上早被清掉的 id 不再需要记) */
const MAX_TOMBSTONES = 800

/**
 * 登记删除墓碑 (两层):
 * - 会话级 Set: 本实例落盘合并时排除 (快);
 * - store.tombstones: 随 memory.json 持久化 → 另一实例 (悬浮窗/主界面) 合并时同样尊重,
 *   否则"主界面删掉的记忆会被悬浮窗的下一次全量写带回来".
 */
const markDeleted = (items: readonly {id: string}[]): void => {
	if (!items.length) return
	for (const it of items) deletedIds.add(it.id)
	const store = cache
	if (!store) return
	const at = Date.now()
	const list = store.tombstones ?? (store.tombstones = [])
	const seen = new Set(list.map(t => t.id))
	for (const it of items) {
		if (seen.has(it.id)) continue
		seen.add(it.id)
		list.push({id: it.id, at})
	}
	if (list.length > MAX_TOMBSTONES) {
		list.sort((x, y) => y.at - x.at) // 新的在前
		store.tombstones = list.slice(0, MAX_TOMBSTONES)
	}
}
/**
 * 撤销一条墓碑（2026-09-28，配合「撤销删除」）。
 * 墓碑 = "这个 id 被用户删过, 落盘合并时别再带回来"。但用户点「还原」是**显式反悔**,
 * 墓碑必须一起撤掉 —— 否则还原后的条目会在下一次落盘合并时被自己的墓碑过滤掉,
 * 表现为"还原了但一重启又没了"。
 *
 * ⚠ 光删本地墓碑还不够: 磁盘上那份**还没更新**的副本里墓碑还在, 落盘合并（adoptFromDisk）
 * 取并集时会把它带回来, 于是刚还原的条目又被过滤掉（T32-F 实测踩到, 与当年"作废标记被
 * 合并吃掉"同一类坑）。所以还原过的 id 记进 `restoredIds`, 合并前先从磁盘墓碑里剔掉。
 */
const removeTombstone = (id: string): void => {
	deletedIds.delete(id)
	restoredIds.add(id)
	const store = cache
	if (!store?.tombstones?.length) return
	store.tombstones = store.tombstones.filter(t => t.id !== id)
}
/** 本会话"用户显式还原过"的 id: 落盘合并时压过磁盘上那份过期墓碑 */
const restoredIds = new Set<string>()
/** 本会话"用户永久删除过"的 id: 落盘合并时不许磁盘旧副本把它带回回收站 */
const purgedIds = new Set<string>()
/** 本会话"用户清除了记忆示例": 落盘合并时不许磁盘上那份旧的示例集被带回来 */
let examplesCleared = false
/** 是否跳过落盘前合并 (clearMemory 清空用: 别把要清的东西并回来) */
let skipDiskMerge = false

/** 磁盘版本合并进本地 cache (先剔除本会话已删的墓碑, 再 id 并集 + 游标取 max) */
const adoptFromDisk = (disk: MemoryStoreData): void => {
	if (!cache) return
	if (deletedIds.size) {
		disk = {
			...disk,
			memories: disk.memories.filter(m => !deletedIds.has(m.id)),
			summaries: disk.summaries.filter(s => !deletedIds.has(s.id)),
		}
	}
	// 本会话显式还原 / 永久删除过的 id: 磁盘上那份**还没更新**的副本不能赢 ——
	// 否则还原后又被过期墓碑过滤掉、永久删除后又被过期回收站带回来 (T32-F/G 实测)
	if (restoredIds.size || purgedIds.size || examplesCleared) {
		disk = {
			...disk,
			tombstones: (disk.tombstones ?? []).filter(t => !restoredIds.has(t.id)),
			deletedBin: (disk.deletedBin ?? []).filter(m => !restoredIds.has(m.id) && !purgedIds.has(m.id)),
			exampleSet: examplesCleared ? undefined : disk.exampleSet,
		}
	}
	// 原地合并 (保持 cache 对象身份不变): 召回强化/摘要/入库决策等异步流程常跨 await
	// 持有 store 引用 —— 整体重赋值 cache 会让唤醒后的写入落在"孤儿对象"上,
	// 改动静默丢失; 游标推进丢失还会引发对同一区间的重复摘要
	const merged = mergeStores(disk, cache)
	cache.memories = merged.memories
	cache.summaries = merged.summaries
	cache.summarizedMsgCount = merged.summarizedMsgCount
	cache.trimmedMsgCount = merged.trimmedMsgCount
	cache.tombstones = merged.tombstones
	// meta 必须一起收: 原来漏了这一行 ⇒ 磁盘上另一实例折叠出的归档 meta 被本地 cache 覆盖掉,
	// 表现为"更久远的脉络偶尔整段消失"(谁最后落盘谁说了算)。blocks 同理 (P1 新增)。
	cache.meta = merged.meta
	cache.blocks = merged.blocks
	cache.deletedBin = merged.deletedBin
	cache.exampleSet = merged.exampleSet
	cache.schemaVersion = merged.schemaVersion
}

/**
 * 整表清理"同段重复"摘要 (历史遗留数据): 按区间重叠两两判定, 保留**较新**的那条。
 * 载入/裁剪时调用, 让用户已有的重复摘要自动收敛 (无需手工清理)。
 *
 * "较新"用**数组顺序**判定, 不用 createdAt: 双实例在同一毫秒内各写一条时
 * createdAt 完全相同, 排序会退化并可能保留较旧的那条 (实测踩到过)。
 * 摘要是按时间追加的, 且落盘合并 (mergeStores) 保持该顺序, 所以"靠后的即较新"。
 * @returns 是否发生了合并
 */
const dropOverlappingSummaries = (store: MemoryStoreData): boolean => {
	const list = store.summaries
	if (list.length < 2) return false
	const keptRev: MemorySummary[] = []
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const s = list[i]
		const r = rangeOfSummary(s.id)
		if (r && keptRev.some(k => {
			const kr = rangeOfSummary(k.id)
			return !!kr && summariesOverlap(kr, r)
		})) continue
		keptRev.push(s)
	}
	if (keptRev.length === list.length) return false
	store.summaries = keptRev.reverse()   // 恢复时间正序
	console.log(`[mem] 同段重复摘要已收敛: ${list.length} → ${keptRev.length} 条`)
	return true
}

/**
 * 清掉与新区间重叠的旧摘要 (双实例游标错位导致的"同一段被总结两遍")。
 *
 * 只在 overlaps 判定命中时动手; 正常的相邻批次零重叠, 不会被误删。
 * 被替换掉的旧摘要**不登记墓碑** —— 它是被同段的新摘要取代, 不是用户删除;
 * 登记墓碑反而会让另一实例的副本被无谓挡掉。
 */
const replaceOverlappingSummary = (store: MemoryStoreData, newId: string): void => {
	const next = rangeOfSummary(newId)
	if (!next) return
	// 顺便清掉历史遗留的同段重复 (用户已有的数据也一并收敛)
	const merged = dropOverlappingSummaries(store)
	const kept = store.summaries.filter(s => {
		const r = rangeOfSummary(s.id)
		return !r || !summariesOverlap(r, next)
	})
	const removed = store.summaries.length - kept.length
	store.summaries = kept
	if (removed) {
		console.log(`[mem] 同段摘要已被新摘要替换: 合并掉 ${removed} 条${merged ? " (含历史重复)" : ""}`)
	}
}

/**
 * 摘要封顶 (返回被裁掉的条数); 被裁的**折叠进 meta 归档**并登记墓碑, 防落盘合并时复活。
 *  注意: 被裁的摘要不是直接丢弃 —— 折成一条归档 meta (区间指纹 id), 让久远脉络保留下来。 */
const trimSummariesToMax = (): number => {
	if (!cache) return 0
	// 先清掉历史遗留的"同段重复" (旧版本双实例错位产生的), 再谈封顶
	const mergedDup = dropOverlappingSummaries(cache)
	if (cache.summaries.length <= MAX_SUMMARIES) return mergedDup ? 1 : 0
	const kept = capSummaries(cache.summaries, MAX_SUMMARIES)
	const dropped = cache.summaries.filter(s => !kept.some(k => k.id === s.id))
	markDeleted(dropped)
	// 折叠归档 (同步、确定性, 不调 LLM): 失败/空则不产出, 不影响裁剪本身
	try {
		const meta = foldDroppedSummaries(dropped)
		if (meta) {
			const metas = cache.meta ?? (cache.meta = [])
			if (!metas.some(m => m.id === meta.id)) metas.push(meta)
			if (metas.length > MAX_METAS) {
				metas.sort((x, y) => y.createdAt - x.createdAt)   // 新的在前
				const evicted = metas.slice(MAX_METAS)
				markDeleted(evicted)   // 归档也登记墓碑, 防另一实例旧副本带回来
				cache.meta = metas.slice(0, MAX_METAS)
			}
		}
	} catch (e) {
		console.error("[mem] fold summaries failed", e)
	}
	cache.summaries = kept
	return dropped.length
}

/**
 * 记忆块封顶 (P2): 超出 MAX_BLOCKS 时丢**最旧**的块记录 (块按区间正序, 前面即最旧)。
 * 只丢块记录 —— 条目与摘要一个字不动 (见 MAX_BLOCKS 注释)。
 */
const trimBlocksToMax = (): number => {
	if (!cache) return 0
	const list = cache.blocks
	if (!list || list.length <= MAX_BLOCKS) return 0
	const dropped = list.length - MAX_BLOCKS
	cache.blocks = list.slice(dropped)
	console.log(`[mem] 记忆块超出上限 ${MAX_BLOCKS}: 丢弃最旧 ${dropped} 个块 (条目与摘要不受影响)`)
	return dropped
}

/** 解析存储 JSON; 结构非法返回 null */
const tryParse = (raw: string): MemoryStoreData | null => {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as Partial<MemoryStoreData>
		if (!Array.isArray(parsed.memories) && !Array.isArray(parsed.summaries)) return null
		// 删除墓碑 (旧数据没有该字段 → 空数组)
		const tombstones = Array.isArray(parsed.tombstones)
			? parsed.tombstones.filter(t => t && typeof t.id === "string" && t.id)
				.map(t => ({id: String(t.id), at: Number(t.at) || 0}))
			: []
		return {
			// 坏元素防御: 单个 null/缺 content 的元素曾让 tokenize 在召回时整表抛错
			memories: Array.isArray(parsed.memories)
				? parsed.memories.filter(m => !!m && typeof m === "object" && typeof m.content === "string")
				: [],
			summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
			summarizedMsgCount: typeof parsed.summarizedMsgCount === "number" ? parsed.summarizedMsgCount : 0,
			trimmedMsgCount: typeof parsed.trimmedMsgCount === "number" ? parsed.trimmedMsgCount : 0,
			tombstones,
			// 折叠归档: 旧数据没有该字段 → 空数组; 同样做形状校验 (坏元素会污染注入块)
			meta: Array.isArray(parsed.meta)
				? parsed.meta.filter(m => !!m && typeof m === "object"
					&& typeof m.id === "string" && m.id
					&& typeof m.content === "string" && m.content)
				: [],
			// 记忆块 (P1): 旧数据没有该字段 → 空数组; 坏元素必须过滤, 否则块视图/注入会抛错
			blocks: Array.isArray(parsed.blocks)
				? parsed.blocks.filter(b => !!b && typeof b === "object"
					&& typeof b.id === "string" && b.id)
					.map(b => ({
						id: String(b.id),
						fromTs: Number(b.fromTs) || 0,
						toTs: Number(b.toTs) || 0,
						msgCount: Number(b.msgCount) || 0,
						topic: typeof b.topic === "string" ? b.topic : "",
						summary: typeof b.summary === "string" ? b.summary : "",
						createdAt: Number(b.createdAt) || 0,
						itemIds: Array.isArray(b.itemIds)
							? b.itemIds.filter(x => typeof x === "string" && x)
							: [],
					}))
				: [],
			// 回收站 (2026-09-28): 手删的条目连内容一起留着, 才能还原。旧数据没有该字段 → 空数组
			deletedBin: Array.isArray(parsed.deletedBin)
				? parsed.deletedBin.filter(m => !!m && typeof m === "object" && typeof m.content === "string")
				: [],
			// 示例集 (整理优化): 形状不对就当没有
			exampleSet: (() => {
				const e = parsed.exampleSet as MemoryExamples | undefined
				if (!e || typeof e !== "object" || typeof e.builtAt !== "number") return undefined
				return {
					builtAt: e.builtAt,
					basedOn: Number(e.basedOn) || 0,
					pos: Array.isArray(e.pos) ? e.pos.filter(x => typeof x === "string" && x) : [],
					neg: Array.isArray(e.neg) ? e.neg.filter(x => typeof x === "string" && x) : [],
				}
			})(),
			schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
		}
	} catch {
		return null
	}
}

/** 载入后按"本会话删除过的 id"过滤: 删除走 400ms 防抖落盘, 删除后立即重载会读到
 *  磁盘旧副本 —— 不过滤的话刚删的记忆会复活, 且此后 diskRaw === lastWrittenRaw
 *  使落盘合并被跳过, 删除被静默回滚 */
const applySessionTombstones = (store: MemoryStoreData): MemoryStoreData => {
	if (!deletedIds.size) return store
	return {
		...store,
		memories: store.memories.filter(m => !deletedIds.has(m.id)),
		summaries: store.summaries.filter(s => !deletedIds.has(s.id)),
	}
}

/**
 * 存量重复长期记忆收敛 (历史遗留数据): 把**归一化后完全相同**的条目合并成一条。
 *
 * 存在的理由: 摘要有 dropOverlappingSummaries 自动收敛, 长期记忆一直没有 —— 早期版本
 * (判重只靠字符串包含 + AI 判重被成本闸挡住) 写下的重复会一直躺在记忆页里。
 *
 * 判据刻意比写入合并更严 (只认完全相同, 不做包含判定) —— 它在每次载入自动、无预览地跑,
 * 而"包含"会把短记忆并进任何提到它的长记忆 (实测 `isSameContent("猫","我家养了一只猫")=true`)。
 * 详见 core.ts 里 collapseDuplicateMemories 的注释。
 *
 * 与摘要收敛同样**只删不复活**: 被合并掉的 id 登记墓碑, 否则另一实例 (悬浮窗) 的旧
 * cache 落盘时会把它们带回来。返回是否发生了变化 (调用方据此作废"跳写"标记并落盘)。
 */
const collapseMemories = (store: MemoryStoreData): boolean => {
	const {removed, dropped} = collapseDuplicateMemories(store)
	if (!removed) return false
	markDeleted(dropped)
	console.log(`[mem] 存量重复记忆已收敛: 合并掉 ${removed} 条`)
	return true
}

/**
 * 载入时的**存量改口收敛** (2026-09-27 加): 库里已经同时躺着"说法"和"反过来的说法"时,
 * 把**更早的那条作废** (可还原), 让历史存量也自动清干净 —— 否则新判据只对"新写入"生效,
 * 用户库里那条「我想养猫」+「我不想养猫了」会永远并列 (实机反馈就是这个状态)。
 *
 * 为什么敢在载入时自动跑: 判据本身很紧 (方向相反 + 宾语**完全相等** + 宾语 ≥2 字),
 * 而且作废是**可还原**的、在「已作废」里看得见 —— 代价远小于"两条矛盾记忆永久并列"。
 */
const collapseReversals = (store: MemoryStoreData): number => {
	const active = store.memories.filter(isActiveMemory)
	if (active.length < 2) return 0
	// 按创建时间排: 同一件事上"更早的说法"被"更晚的说法"取代
	const ordered = [...active].sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id))
	const hit = new Set<string>()
	for (let i = 0; i < ordered.length; i += 1) {
		for (let j = i + 1; j < ordered.length; j += 1) {
			if (hit.has(ordered[i].id)) break
			// 同一毫秒的并列: **判不出谁先谁后就不动** (载入时自动改数据, 宁可不收)
			if (ordered[i].createdAt === ordered[j].createdAt) continue
			if (isReversal(ordered[i].content, ordered[j].content)) hit.add(ordered[i].id)
		}
	}
	if (!hit.size) return 0
	const now = Date.now()
	store.memories = store.memories.map(m =>
		hit.has(m.id)
			? {...m, invalidAt: now, updatedAt: Math.max(now, (m.updatedAt ?? m.createdAt ?? 0) + 1)}
			: m
	)
	console.log(`[mem] 存量改口收敛: 作废旧说法 ${hit.size} 条 (可还原)`)
	return hit.size
}

/* ---------------- 记忆块 (P1): 迁移与悬空引用清理 ---------------- */

/**
 * 清掉块里已经不存在的条目引用 (条目被用户删除、或被"存量去重"合并掉了)。
 * 只清引用, **不删块本身** —— 块的 topic/summary 仍有价值 (时间线上"那段时间聊过什么"
 * 不该因为某条被删就消失)。块视图对悬空引用也会再兜一层过滤 (双保险)。
 */
export const pruneBlockRefs = (store: MemoryStoreData): boolean => {
	const blocks = store.blocks
	if (!blocks?.length) return false
	const alive = new Set(store.memories.map(m => m.id))
	let changed = false
	for (const b of blocks) {
		const kept = b.itemIds.filter(id => alive.has(id))
		if (kept.length !== b.itemIds.length) {
			b.itemIds = kept
			changed = true
		}
	}
	return changed
}

/**
 * v1 → v2 迁移 (P1, **行为不变**): 给没有 blocks 的旧库补一个「早期记忆」块, 把现有条目
 * 原样挂进去 (内容/类型/时间/重要度**一个字不改**), 并写 schemaVersion=2。
 *
 * - 幂等: 磁盘上已有 schemaVersion ≥ 2 就直接返回 false, 不重复迁移;
 * - 迁移前把 memory.json 原文另外存一份 `memory.v1-backup.json` (**只写一次**:
 *   已存在就不覆盖, 免得把最早的 v1 快照换成迁移后被改过的半成品);
 * - 空库也照样标版本, 否则每次载入都重试迁移。
 * @param rawMain 迁移前磁盘上的 memory.json 原文 (用于 v1 快照)
 * @returns 是否发生了迁移 (调用方据此立即落盘 + 作废"零变化跳写"依据)
 */
const migrateToBlocks = (store: MemoryStoreData, rawMain: string): boolean => {
	if ((store.schemaVersion ?? 0) >= MEMORY_SCHEMA_VERSION) {
		// 版本已是 v2: 只兜底补数组 (坏数据/半截写入), 不算迁移
		if (!Array.isArray(store.blocks)) store.blocks = []
		return false
	}
	if (rawMain && !readFile(FILE_V1)) writeFile(FILE_V1, rawMain)
	if (!Array.isArray(store.blocks)) store.blocks = []
	if (!store.blocks.length && store.memories.length) {
		const times = store.memories.map(m => m.createdAt || 0).filter(t => t > 0)
		store.blocks.push({
			id: "blk-legacy",
			fromTs: times.length ? Math.min(...times) : 0,
			toTs: times.length ? Math.max(...times) : 0,
			msgCount: 0,          // 0 = 不是由某段对话总结出来的 (迁移块)
			topic: "早期记忆",
			summary: "",
			createdAt: Date.now(),
			// 含已作废条目: 它仍属于这段历史 (记忆库的「已作废」区照旧单独展示、可还原)
			itemIds: store.memories.map(m => m.id),
		})
	}
	store.schemaVersion = MEMORY_SCHEMA_VERSION
	console.log(`[mem] 记忆结构已迁移到 v${MEMORY_SCHEMA_VERSION}: 挂起 ${store.memories.length} 条旧记忆`)
	return true
}

/**
 * 载入路径的落盘约定: lastWrittenRaw 表示"本实例最近一次**成功写盘**的内容"。
 * applySessionTombstones / backfillDecay / collapseMemories / trimSummariesToMax 都会改动
 * cache 但**不写盘**, 因此必须作废这个标记 —— 否则随后的 flushPersist 会命中"零变化跳写"
 * (json === diskRaw) 而跳过落盘, 表现为"只在内存生效、重启后复原"。摘要裁剪与归档折叠实测踩到过。
 */
const load = (): MemoryStoreData => {
	if (cache) return cache
	const rawMain = readFile(FILE)
	lastWrittenRaw = rawMain || null
	let store = tryParse(rawMain)
	if (store) {
		cache = applySessionTombstones(store)
		backfillDecay(cache)
		const collapsed = collapseMemories(cache)
		// 存量改口收敛 (「我想养猫」+「我不想养猫了」并存时把更早的作废): 与重复收敛同一档,
		// 属"载入时自动改数据", 所以判据必须紧 + 可还原 (见 collapseReversals 注释)
		const reversalFixed = collapseReversals(cache) > 0
		// 记忆块迁移 (P1): 只在 v1 库上跑一次, 幂等; 顺带清掉块里的悬空引用
		const migrated = migrateToBlocks(cache, rawMain)
		const pruned = pruneBlockRefs(cache)
		const trimmed = trimSummariesToMax() > 0
		// 上面几步都可能改动了 cache 而未写盘 → 作废跳写依据
		if (cache !== store || trimmed || collapsed || reversalFixed || migrated || pruned) lastWrittenRaw = null
		// 必须**立即**落盘, 不能用 persist() 的 400ms 防抖: 那会在载入时排一个延迟写,
		// 把这 400ms 内别处 (另一实例 / 调用方刚写入) 的新内容用"载入时的陈旧快照"盖掉。
		if (trimmed || collapsed || reversalFixed || migrated || pruned) flushPersist()
		return cache
	}
	// 主文件缺失/损坏: 尝试从备份恢复 (自愈)
	store = tryParse(readFile(FILE_BAK))
	if (store) {
		cache = applySessionTombstones(store)
		backfillDecay(cache)
		collapseMemories(cache)
		collapseReversals(cache)
		migrateToBlocks(cache, readFile(FILE_BAK))
		pruneBlockRefs(cache)
		trimSummariesToMax()
		// 用恢复的数据(已补字段)回写主文件; 损坏的旧内容留档备查
		const json = JSON.stringify(cache)
		if (writeFile(FILE, json)) lastWrittenRaw = json
		if (rawMain) writeFile(`${FILE}.corrupt-${Date.now()}`, rawMain)
		return cache
	}
	// 备份也没有: 清空, 损坏内容留档
	if (rawMain) writeFile(`${FILE}.corrupt-${Date.now()}`, rawMain)
	cache = {
		...EMPTY_MEMORY_STORE,
		memories: [],
		summaries: [],
		summarizedMsgCount: 0,
		trimmedMsgCount: 0,
		tombstones: [], // 新数组: 别与 EMPTY_MEMORY_STORE 共享引用, 否则 markDeleted 会污染常量
		blocks: [],     // 同理: 共享引用会让 push 污染常量
		deletedBin: [],
	}
	return cache
}

/**
 * 旧数据兼容: 早期 memory.json 的记忆没有 decayDays 字段,
 * 按 type 补默认衰减周期 (core=null 永久, fact 365 天…), 并回写一次.
 */
const backfillDecay = (store: MemoryStoreData): void => {
	let changed = false
	store.memories = store.memories.map(m => {
		// 只补"缺字段"的旧数据; null = 永不衰减 (显式记住/固定/目标), 不能当缺字段覆写 ——
		// 否则每次重启都会把永久记忆改回可衰减, 几个月后 expireMemories 会把它们清掉
		if (m && m.decayDays !== undefined) return m
		changed = true
		return {...m, decayDays: m ? defaultDecayDays(m.type) : null}
	})
	if (changed) {
		lastWrittenRaw = null   // 内存已改但未写盘 → 作废跳写依据 (见 load 的落盘约定)
		persist()
	}
}

/* ---------------- 持久化 (防抖 + 串行, 根治并发写覆盖) ---------------- */
/** 防抖窗口: 多次修改合并成一次写盘 */
const PERSIST_DEBOUNCE_MS = 400
let persistTimer: ReturnType<typeof setTimeout> | null = null
/** 串行写队列: 一次只写一个文件快照, 杜绝交错覆盖 */
let writeQueue: Promise<unknown> = Promise.resolve()

/**
 * 持久化 (防抖): 300ms 内的多次改动合并成一次写盘.
 * 写盘走串行队列, 每次写"当时的 cache 快照", 防止并发交错.
 */
const persist = (): void => {
	if (!cache) return
	if (persistTimer) clearTimeout(persistTimer)
	persistTimer = setTimeout(() => {
		persistTimer = null
		flushPersist()
	}, PERSIST_DEBOUNCE_MS)
}

/**
 * 立即落盘 (串行队列): 写当前 cache 的快照.
 * 双实例防线 (主 App / 悬浮窗各持一份 cache): 磁盘内容若不是"本实例上次写的"
 * (说明被另一实例改过), 先把它并进 cache 再写 —— id 并集 + 游标取 max,
 * 避免任何一方的陈旧 cache 全量覆盖弄丢对方已落盘的记忆/总结.
 * 本会话删除过的 id 有墓碑, 不会被磁盘旧副本复活; 合并后顺带封顶摘要条数.
 */
const flushPersist = (): void => {
	if (!cache) return
	writeQueue = writeQueue.then(async () => {
		try {
			let diskRaw: string | null = null
			if (!skipDiskMerge) {
				diskRaw = readFile(FILE)
				const disk = tryParse(diskRaw)
				if (disk && diskRaw !== lastWrittenRaw) {
					adoptFromDisk(disk)
					trimSummariesToMax()
					// 两个实例的墓碑并集可能超上限 → 落盘前收一次 (按时间留最新的)
					const tombs = cache?.tombstones
					if (tombs && tombs.length > MAX_TOMBSTONES) {
						tombs.sort((x, y) => y.at - x.at)
						if (cache) cache.tombstones = tombs.slice(0, MAX_TOMBSTONES)
					}
				}
			} else {
				skipDiskMerge = false
			}
			const json = JSON.stringify(cache)
			// 零变化跳写: 内容与磁盘完全一致时不落盘 (否则无待办分支每轮对话都全量双写,
			// 白磨 flash 且拉大双实例竞态窗口)
			if (diskRaw !== null && json === diskRaw) {
				lastWrittenRaw = json
				return
			}
			// 主文件 + 备份双写: 任一损坏都能从另一份恢复
			const ok1 = writeFile(FILE, json)
			const ok2 = writeFile(FILE_BAK, json)
			if (ok1) lastWrittenRaw = json
			if (!ok1 || !ok2) {
				console.error("[mem] persist write failed", {ok1, ok2, file: FILE})
			}
		} catch (e) {
			console.error("[mem] persist error", e)
		}
	})
}

/** 立即落盘并等队列清空 (App 退后台/关闭前调用, 防丢) */
export const flushMemoryPersist = async (): Promise<void> => {
	if (persistTimer) {
		clearTimeout(persistTimer)
		persistTimer = null
		flushPersist()
	}
	await writeQueue
}

export const memoryStats = (): {memoryCount: number; summaryCount: number; fadedCount: number; deletedCount: number} => {
	const store = load()
	return {
		// memoryCount 保持旧语义 (库里条目总数, 含作废/已收起), 免得改动既有调用方的预期
		memoryCount: store.memories.length,
		summaryCount: store.summaries.length,
		fadedCount: store.memories.filter(m => !!m.fadedAt && !m.invalidAt).length,
		deletedCount: (store.deletedBin ?? []).length,
	}
}

/** 展示用数据: 完整记忆列表 (重要性优先) + 历史总结列表 (新→旧) */
export interface MemoryViewData {
	memories: MemoryItem[]
	summaries: MemorySummary[]
}

/** 已作废记忆 (被新信息取代的那些) —— 供记忆库的"历史"折叠展示与还原 */
export const listInvalidMemories = (): MemoryItem[] => {
	const store = load()
	return store.memories
		.filter(m => !!m.invalidAt)
		.sort((a, b) => (b.invalidAt ?? 0) - (a.invalidAt ?? 0))
}

/** 记忆库"块视图"数据 (P4 UI 与 P5 近况注入共用): 块 + 按 id 解析出的条目 */
export interface MemoryBlockView {
	block: MemoryBlock
	/** 解析出的条目 (**含已作废的**: 调用方自己按 isActiveMemory 决定怎么展示) */
	items: MemoryItem[]
}

/**
 * 块视图: 按区间正序返回全部块, 并把 `itemIds` 解析成条目。
 * 解析时过滤悬空引用 (条目已被删/被合并) —— 兜住 pruneBlockRefs 没跑到的那一刻。
 * **块的顺序即时间线顺序**, 与存储顺序一致 (mergeStores 已按 fromTs 排序)。
 */
export const listBlocks = (): MemoryBlockView[] => {
	const store = load()
	const byId = new Map(store.memories.map(m => [m.id, m]))
	return (store.blocks ?? []).map(block => ({
		block,
		items: block.itemIds
			.map(id => byId.get(id))
			.filter((m): m is MemoryItem => !!m),
	}))
}

/**
 * **还挂在任何块之外的条目** (块视图的「未归类」桶)。
 *
 * 会出现这种条目的正常来源: ① 实时通道还开着时写下的条目 (P3 默认关, 但开关打开时会有);
 * ② 存量去重把两条并成一条后, 被合并掉的 id 从块里清掉, 而留下的那条不在块里;
 * ③ 早期迁移前的极端数据。UI 必须有个地方放它们, 否则"记忆在库里但界面看不到"。
 */
export const listUnblockedMemories = (includeInvalid = false): MemoryItem[] => {
	const store = load()
	const used = new Set<string>()
	for (const b of store.blocks ?? []) for (const id of b.itemIds) used.add(id)
	return store.memories
		.filter(m => !used.has(m.id) && (includeInvalid || isActiveMemory(m)))
		.sort((a, b) => (b.importance - a.importance) || (b.createdAt - a.createdAt))
}

/**
 * 展示列表。**默认只返回仍然有效的记忆** —— 作废的（被改口/纠正取代的）不参与展示与注入，
 * 但可以通过 `includeInvalid` 拿到（记忆库的"查看历史"用），也可以 `restoreMemory` 还原。
 */
export const listAll = (includeInvalid = false): MemoryViewData => {
	const store = load()
	const mems = includeInvalid ? [...store.memories] : store.memories.filter(isActiveMemory)
	return {
		memories: mems.sort((a, b) => (b.importance - a.importance) || (b.createdAt - a.createdAt)),
		summaries: [...store.summaries].sort((a, b) => b.createdAt - a.createdAt),
	}
}

/**
 * **作废**一条记忆 (改口/纠正): 不打墓碑、不删, 只写 `invalidAt`。
 * 之后的召回/注入/展示都会跳过它, 但用户可以一键还原 (见 restoreMemory)。
 *
 * 与 `deleteMemory` 的区别: 删除登记墓碑 (双实例落盘合并时不会被旧副本复活, 也不可还原);
 * 作废只是标记, 合并时按"较新的一份"取 (谁后写谁赢, 与其它字段同一套规则)。
 */
export const invalidateMemory = (id: string): boolean => {
	const store = load()
	const m = store.memories.find(x => x.id === id)
	if (!m || m.invalidAt) return false
	// 同时刷 updatedAt, 并且**严格大于**原值:
	// 双实例落盘合并按"最后改动时间"取胜, 而 Date.now() 与旧 updatedAt 可能是**同一毫秒**
	// (实测: 刚写入的记忆马上被改口纠正) —— 平局时旧副本会按 accessCount 规则反吃回来,
	// 作废标记当场丢失 (T29-C 实测踩到: 内存里 invalidAt 有, 落盘合并后没了)。
	const now = Math.max(Date.now(), (m.updatedAt ?? m.createdAt ?? 0) + 1)
	store.memories = store.memories.map(x => (x.id === id ? {...x, invalidAt: now, updatedAt: now} : x))
	persist()
	return true
}

/** 还原一条被作废的记忆 (用户点"还原")。返回是否真的改了。 */
export const restoreMemory = (id: string): boolean => {
	const store = load()
	const m = store.memories.find(x => x.id === id)
	if (!m || !m.invalidAt) return false
	store.memories = store.memories.map(x => {
		if (x.id !== id) return x
		const {invalidAt: _drop, ...rest} = x
		// **必须严格大于"作废那一版"的 updatedAt** —— 不只是 invalidAt:
		// 作废时把 updatedAt 设成了 max(now, 旧值+1), 所以它可能正好是 invalidAt+1;
		// 只按 invalidAt+1 还原会与磁盘上那份**平局**, 而 core.newerMemory 平局时偏袒"已作废"
		// ⇒ 还原被静默吃掉 (T29-B 实测踩到, 见 tmp-memcheck/probe-restore-rollback.mjs)
		const base = Math.max(x.updatedAt ?? 0, x.invalidAt ?? 0)
		return {...rest, updatedAt: Math.max(Date.now(), base + 1)}
	})
	persist()
	return true
}

/**
 * 已收起的记忆 (2026-09-28): 自动路径（到期 / 低频）的处置结果。
 * 与「已作废」的区别: 作废=被新说法取代(有替代者); 收起=不再重要/太久没提(无替代者)。
 * 两者都不注入、不召回, 但都在库里、都能一键还原。
 */
export const listFadedMemories = (): MemoryItem[] => {
	const store = load()
	return store.memories
		.filter(m => !!m.fadedAt && !m.invalidAt)
		.sort((a, b) => (b.fadedAt ?? 0) - (a.fadedAt ?? 0))
}

/** 「留下」一条被收起的记忆: 放回生效列表 (与作废还原同一套"严格递增 updatedAt"防平局逻辑) */
export const restoreFadedMemory = (id: string): boolean => {
	const store = load()
	const m = store.memories.find(x => x.id === id)
	if (!m || !m.fadedAt) return false
	store.memories = store.memories.map(x => {
		if (x.id !== id) return x
		const {fadedAt: _f, fadedReason: _r, ...rest} = x
		const base = Math.max(x.updatedAt ?? 0, x.fadedAt ?? 0)
		return {...rest, updatedAt: Math.max(Date.now(), base + 1)}
	})
	persist()
	return true
}

/**
 * 把某条内容从**示例集**里摘掉（2026-09-29）。
 *
 * 规则（"例子跟着你的取舍走"）：
 * - **手动收起 / 删除** → 从**正例**摘掉（它不再是你"保留着的"东西）；
 * - **永久删除** → 正例与**反例**都摘掉（你都说"永久删"了，就别再把它当例子发给模型）；
 * - **自动收起不动示例集**：那是例行整理、不是你的取舍，动它会把例子慢慢磨没。
 * - 两边都空了 ⇒ 整个 `exampleSet` 清掉（回到提示词默认规则）。
 *
 * 注意示例是**截断过的**（≤24 字 + 省略号），所以比对用"前缀匹配"而不是全等。
 */
const stripFromExamples = (store: MemoryStoreData, content: string, alsoNeg: boolean): void => {
	const e = store.exampleSet
	if (!e || !content) return
	const norm = normalizeForCompare(content)
	if (!norm) return
	const hit = (t: string): boolean => {
		const x = normalizeForCompare(t.replace(/…$/, ""))
		return !!x && (x === norm || norm.startsWith(x))
	}
	e.pos = e.pos.filter(t => !hit(t))
	if (alsoNeg) e.neg = e.neg.filter(t => !hit(t))
	if (!e.pos.length && !e.neg.length) store.exampleSet = undefined
	// 本地刚改过 ⇒ 把 builtAt 顶到最新, 这样落盘合并时它一定赢过磁盘上那份旧副本
	else e.builtAt = Math.max((e.builtAt ?? 0) + 1, Date.now())
}

/** 手工收起一条 (条目行「收起」按钮): 与自动收起同语义, 可一键「留下」 */
export const fadeMemoryManually = (id: string): boolean => {
	const store = load()
	const m = store.memories.find(x => x.id === id)
	if (!m || !isActiveMemory(m)) return false
	fadeItems(store, [m], "manual")
	// 你亲手说"这条不重要" ⇒ 别再拿它当"该记"的例子
	stripFromExamples(store, m.content, false)
	persist()
	return true
}

/** 回收站里的条目 (用户手删的, 可还原; 按删除时间新→旧) */
export const listDeletedMemories = (): MemoryItem[] => {
	const store = load()
	return [...(store.deletedBin ?? [])].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
}

/**
 * 撤销删除: 从回收站放回生效列表。
 * ⚠ 必须**同时清掉墓碑** —— 墓碑的作用是"别让磁盘旧副本把它带回来", 但还原是用户的显式意图,
 * 留着墓碑会让它在下次落盘合并时又被过滤掉 (表现为"还原了但重启又没了")。
 */
export const restoreDeletedMemory = (id: string): boolean => {
	const store = load()
	const bin = store.deletedBin ?? (store.deletedBin = [])
	const idx = bin.findIndex(m => m.id === id)
	if (idx < 0) return false
	const {deletedAt: _d, ...item} = bin[idx]
	bin.splice(idx, 1)
	removeTombstone(id)
	store.memories = [
		...store.memories,
		{...item, updatedAt: Math.max(Date.now(), (item.updatedAt ?? item.createdAt ?? 0) + 1)},
	]
	persist()
	return true
}

/** 永久删除: 从回收站里也抹掉 (墓碑保留, 免得磁盘旧副本带回来); 同时把它从示例集里摘干净 */
export const deleteMemoryForever = (id: string): boolean => {
	const store = load()
	const bin = store.deletedBin ?? []
	const item = bin.find(m => m.id === id)
	const before = bin.length
	store.deletedBin = bin.filter(m => m.id !== id)
	if (store.deletedBin.length === before) return false
	purgedIds.add(id)     // 磁盘上那份还没更新的回收站副本不许把它带回来 (见 adoptFromDisk)
	markDeleted([{id}])   // 已经在墓碑里也无妨 (markDeleted 会去重)
	// 你都点"永久删除"了: 正例/反例里都不该再留着它的文字 (用户 2026-09-29 明确要求)
	if (item?.content) stripFromExamples(store, item.content, true)
	persist()
	return true
}

/**
 * 从用户消息提取记忆并入库存 (规则法 + 记忆合并). 返回本次"净新增"条数.
 * 合并: 与旧记忆高度重叠时升级旧记忆 (重要性取 max、时间刷新), 不重复堆叠.
 */
export const addMemoriesFromText = (text: string): number => {
	const store = load()
	const before = store.memories.length
	const res = applyMerge(store, extractMemories(text))
	if (res.changed) persist()
	// 净新增 ≈ 长度差 (prune 可能删旧记忆, 仅作展示近似)
	return Math.max(0, store.memories.length - before)
}

/**
 * 偏好"方向词"表: 词 → 方向 (true = 喜欢侧, false = 不喜欢侧)。
 * 这些词只表达态度、不携带宾语语义, 比较时整体剥掉, 剩下的就是"同一个东西"。
 * 必须覆盖 EXTRACT_RULES 归一后的全部形态, 否则用户换个说法提同一件事会被当成
 * 两条不同记忆并存 (旧方向残留)。匹配按长度降序, 保证 "不喜欢" 不被 "喜欢" 抢先。
 */
const PREF_DIR_WORDS: Array<[string, boolean]> = [
	// 不喜欢侧 (长词优先)
	["不喜欢", false], ["不爱吃", false], ["不爱喝", false], ["不爱", false],
	["讨厌", false], ["反感", false], ["受不了", false], ["接受不了", false], ["无感", false],
	// 喜欢侧
	["喜欢", true], ["最爱", true], ["超爱", true], ["热爱", true], ["好爱", true], ["很爱", true], ["爱", true],
]

/** 方向词前面可能出现的"主语 + 时间/程度副词": 反复剥掉, 直到露出方向词 */
const PREF_PREFIXES = ["我", "自己", "最近", "现在", "一直", "平时", "超", "挺", "蛮", "很", "特别", "最", "好", "又", "还是", "真的", "已经", "本来", "其实"]

/**
 * **意愿/计划**的"否定"与"情态"词 (2026-09-27 加): 拆成两张表分别剥, 而不是把
 * 「不想/不打算/不去/不养」全部枚举 —— 枚举永远漏 (实测第一版就漏了「我不去北京了」:
 * 「不去」不在任何表里)。拆开后的判据:
 *
 *   方向 = 有没有否定词 (`WILL_NEG_WORDS`); 宾语 = 剥掉"否定 + 情态"后剩下的动词短语。
 *
 * 于是这些都能对上同一件事: 我想养猫 / 我不想养猫了 / 我不打算养猫了 / 我不养猫了
 *   → 方向 true,false,false,false; 宾语 养猫 ×4。
 *
 * 只放「不再/不」, **刻意不放「没/没有」**: 「我没去北京」是在说**过去没发生**,
 * 不构成对「我想去北京」的否定 —— 放进来会误作废计划类记忆 (实测反例见 probe ④)。
 * 也刻意不含「别」(更像对 Nori 说话, 不该拿来作废主人的计划)。
 */
const WILL_NEG_WORDS = ["不再", "不"]
/** 情态动词 (正面意愿): 长词优先, 「要」放最后 (否则「想要」会被「要」拆错) */
const WILL_MODAL_WORDS = ["想要", "想", "打算", "准备", "计划", "决定", "要"]
/**
 * 宾语以这些字开头时**不算意愿** —— 它们是"状态/身份"而不是"要做的事":
 * 「我不在家」+「我要在家」、「我没有猫」+「我要有猫」这类会被误当改口。
 * 判不出就先不做 (宁可漏收, 因为这条判据会自动作废用户数据)。
 */
const WILL_OBJ_BLOCK = /^(?:在|有|是|叫|姓)/

/**
 * 解析"意愿 + 宾语": 剥掉 主语 → 否定词 → 情态词, 剩下的是动词短语 (宾语)。
 * 既没有否定词也没有情态词 (普通事实/偏好) → null, 调用方据此跳过。
 */
const parseWill = (content: string): {obj: string; dir: boolean} | null => {
	let rest = stripSubjectPrefix(content)
	let neg = false
	for (const w of WILL_NEG_WORDS) {
		if (rest.startsWith(w)) { rest = rest.slice(w.length); neg = true; break }
	}
	let modal = false
	for (const w of WILL_MODAL_WORDS) {
		if (rest.startsWith(w)) { rest = rest.slice(w.length); modal = true; break }
	}
	if (!neg && !modal) return null
	rest = stripTail(rest)
	if (!rest || WILL_OBJ_BLOCK.test(rest)) return null
	return {obj: rest, dir: !neg}
}

/** 剥掉主语/时间副词前缀 (最多 3 层: "我最近特别想…") */
const stripSubjectPrefix = (content: string): string => {
	let rest = content.replace(/^[\s，,。.、]+/, "")
	for (let guard = 0; guard < 3; guard++) {
		const before = rest
		for (const p of PREF_PREFIXES) {
			if (rest.startsWith(p)) { rest = rest.slice(p.length); break }
		}
		if (rest === before) break
	}
	return rest
}

/** 剥掉尾部标点与语气词 (反复剥: "…了呀") */
const stripTail = (content: string): string => {
	let rest = content.replace(/[。！？!?，,、\s]+$/g, "")
	for (let guard = 0; guard < 4; guard += 1) {
		const before = rest
		rest = rest.replace(/(?:了|啊|呢|吧|嘛|哈|哟|哦|啦)+$/g, "")
		if (rest === before) break
	}
	return rest
}

/**
 * 解析"方向 + 宾语": 按给定词表剥掉方向词, 剩下的是宾语。
 * 找不到方向词 (普通事实/项目记忆) → null, 调用方据此跳过消解。
 */
const parseDirection = (content: string, table: Array<[string, boolean]>): {obj: string; dir: boolean} | null => {
	const rest0 = stripSubjectPrefix(content)
	let dir: boolean | null = null
	let rest = rest0
	for (const [w, d] of table) {
		if (rest.startsWith(w)) { rest = rest.slice(w.length); dir = d; break }
	}
	if (dir === null) return null
	rest = stripTail(rest)
	if (!rest) return null
	return {obj: rest, dir}
}

/**
 * 两条偏好是否"同一件事但方向相反" (= 用户改口)。
 * 「最喜欢下雨天」「我不喜欢下雨天了」→ 宾语均为 "下雨天", 方向相反 ⇒ true。
 * 同方向 (「喜欢下雨天」vs「我喜欢下雨天」) 一律 false —— 那是同义重复, 交给 merge 合并升级。
 * 宾语判据沿用原来的"相等或包含"(T27 有守卫: 「咖啡」/「每天喝咖啡」不会互相吞)。
 */
const isPrefReversal = (oldContent: string, newContent: string): boolean => {
	const a = parseDirection(oldContent, PREF_DIR_WORDS)
	const b = parseDirection(newContent, PREF_DIR_WORDS)
	if (!a || !b) return false
	if (a.dir === b.dir) return false
	return a.obj === b.obj || a.obj.includes(b.obj) || b.obj.includes(a.obj)
}

/**
 * 两条**意愿/计划**是否"同一件事但方向相反" (= 改口), 例如
 * 「我想养猫」↔「我不想养猫了」、「我要去北京」↔「我不去北京了」。
 *
 * 与 `isPrefReversal` 的两点不同 (都是为了**降误判**, 因为它现在跨类型生效):
 * ① 宾语判据只认**完全相等** —— 包含关系会误伤「我想买手机」vs「我不想买手机壳了」(两件东西);
 * ② 宾语至少 2 个字, 否则「我要」/「不要」这种半截话会命中。
 */
const isWillReversal = (oldContent: string, newContent: string): boolean => {
	const a = parseWill(oldContent)
	const b = parseWill(newContent)
	if (!a || !b) return false
	if (a.dir === b.dir) return false
	const na = normalizeForCompare(a.obj)
	const nb = normalizeForCompare(b.obj)
	return !!na && na.length >= 2 && na === nb
}

/** 不看模型也能判的"改口"总入口 (偏好族 ∪ 意愿族) */
const isReversal = (oldContent: string, newContent: string): boolean =>
	isPrefReversal(oldContent, newContent) || isWillReversal(oldContent, newContent)

/**
 * **确定性反向消解**: 新事实与库内旧记忆构成改口 (方向相反 + 同一件事) → 把旧条**作废**
 * (不是删除: 留在文件里、进「已作废」、可一键还原)。
 *
 * 为什么要有它 (实机反馈 2026-09-27): 作废原本 100% 依赖模型输出 DELETE,
 * 而实测「我想养猫」→「我不想养猫了」时模型只答 ADD ⇒ 两条并存、没有任何历史。
 * 这条判据**跨类型**生效 (旧条是 project、新条是 preference 也能对上) —— 类型是模型标的,
 * 本来就不可靠 (同一次实测里同一件事被标成两种类型)。
 *
 * @returns 本次新作废的条数
 */
const invalidateReversals = (store: MemoryStoreData, fresh: MemoryItem[]): number => {
	const now = Date.now()
	const hit = new Set<string>()
	for (const it of fresh) {
		// 已作废的新条不参与: 它本就是"被推翻的那一条", 不该再去作废别人
		// (段内改口先把同批里被推翻的标掉, 见 invalidateIntraBatchReversals)
		if (!it.content || !isActiveMemory(it)) continue
		for (const old of store.memories) {
			if (!isActiveMemory(old) || !old.content) continue   // 作废条不参与 (别重复计数)
			if (hit.has(old.id)) continue
			// 同方向/无关的一律不动 (交给 merge 合并升级) —— 这条注释守着 T27 的反向守卫
			if (isReversal(old.content, it.content)) hit.add(old.id)
		}
	}
	if (!hit.size) return 0
	store.memories = store.memories.map(m =>
		hit.has(m.id)
			? {...m, invalidAt: now, updatedAt: Math.max(now, (m.updatedAt ?? m.createdAt ?? 0) + 1)}
			: m
	)
	console.log(`[mem] 改口消解: 作废旧说法 ${hit.size} 条 (可还原)`)
	return hit.size
}

/**
 * **段内自相矛盾**消解 (P2): 同一次总结产出的条目里出现互为改口的两条时, 按**数组顺序**
 * 保留靠后的那条 (提示词要求模型只输出最终状态; 这里防的是模型没听话)。
 *
 * 为什么按数组顺序: 这是唯一可用的先后依据 —— 同一批条目的 createdAt 会落在同一毫秒,
 * 现有 collapseReversals 对"同毫秒并列"刻意不动手 (判不出先后就不改数据), 所以必须在
 * 写入前定序。作废而不是删除: 与全库一致的语义 (留在「已作废」可还原)。
 *
 * @returns 被作废的条数
 */
const invalidateIntraBatchReversals = (fresh: MemoryItem[]): number => {
	if (fresh.length < 2) return 0
	const now = Date.now()
	const hit = new Set<string>()
	for (let i = 0; i < fresh.length; i += 1) {
		for (let j = i + 1; j < fresh.length; j += 1) {
			if (hit.has(fresh[i].id)) break
			if (!fresh[i].content || !fresh[j].content) continue
			if (isReversal(fresh[i].content, fresh[j].content)) hit.add(fresh[i].id)
		}
	}
	if (!hit.size) return 0
	for (const it of fresh) {
		if (!hit.has(it.id)) continue
		it.invalidAt = now
		it.updatedAt = Math.max(now, (it.updatedAt ?? it.createdAt ?? 0) + 1)
	}
	console.log(`[mem] 段内改口: 作废同批内被推翻的 ${hit.size} 条 (可还原)`)
	return hit.size
}

/** 内部: 应用合并结果到 store (升级旧记忆 + 追加新增 + 类型化过期 + 遗忘清理).
 *  返回 {added 净新增条数, updated 被升级旧条数, changed 是否发生变化} —— 计数用于
 *  "记住了"气泡门控: 走 merge 兜底升级(如新说法更完整)也算 updated, 不然真升级不弹泡. */
const applyMerge = (store: MemoryStoreData, fresh: MemoryItem[]): {added: number; updated: number; changed: boolean; invalidated: number; expired: number; lowvalue: number; revived: number; addedItems: MemoryItem[]; updatedItems: MemoryItem[]} => {
	// ① 改口消解 (先于 mergeMemories): 同一件事 + 方向相反 → 把**旧条作废**, 让最新方向落库.
	// 必须在 merge 之前做: mergeMemories 的"取长保留"策略会把更长的旧方向当更完整,
	// 导致用户改口("我不喜欢下雨天了"→"我喜欢下雨天")时方向反而保留旧的.
	//
	// 2026-09-27 两点变更:
	//   - 由"真删(墓碑)"改为**作废**(可还原) —— 与 AI 决策 DELETE 的语义统一, 误判代价从"永久丢"降到"点一下";
	//   - 判据从"偏好族 + 要求新旧都是 preference"放宽为 `isReversal`(偏好族 ∪ 意愿族, **跨类型**),
	//     因为实机「我想养猫」(project) →「我不想养猫了」(preference) 被类型不一致整条漏掉 (见 isWillReversal 注释)。
	const invalidated = invalidateReversals(store, fresh)
	// ⓪ **再次被提到 = 复活**（2026-09-28）: 之前被"收起"的条目若又被说到, 先把它放回生效状态,
	// 这样它就能正常参与下面的合并（用户担心的"误收起之后一点都不记了"由这条兜住）。
	const revived = reviveFaded(store, fresh)
	const {added, updated} = mergeMemories(fresh, store.memories)
	if (updated.length) {
		const upd = new Map(updated.map(u => [u.id, u]))
		store.memories = store.memories.map(m => upd.get(m.id) ?? m)
	}
	if (added.length) {
		store.memories = [...store.memories, ...added]
	}
	// 类型化到期 (④): 每次写库惰性处理过期的随口偏好/一次性事件 (显式记住永不参与)。
	// **2026-09-28 改语义: 到期 = 收起(fadedAt), 不再真删** —— 用户明确担心误删之后彻底不记;
	// 收起后仍在库里可见、「留下」一键可还原, 且叙事层面还有历史总结兜底。
	// (墓碑只用于"用户手删"; 自动路径不该产生不可逆的结果)
	const expired = pickExpiredMemories(store.memories)
	if (expired.length) fadeItems(store, expired, "expired")
	// 遗忘机制: 超限(内部判断)后清理低频旧记忆 —— 同样是**收起**而不是删除
	const dropped = pruneMemories(store.memories)
	if (dropped.length) fadeItems(store, dropped, "lowvalue")
	return {
		added: added.length,
		updated: updated.length,
		invalidated,
		// 诊断日志用 (P1): 本批触发的"收起"与"复活"各有几条 —— 此前只打 console, 设备上看不见
		expired: expired.length,
		lowvalue: dropped.length,
		revived,
		changed: added.length > 0 || updated.length > 0 || invalidated > 0 ||
			expired.length > 0 || dropped.length > 0 || revived > 0,
		// 供块归属用 (P2): 本段**真正进库**的条目 (新增 + 被升级), 不是"请求写入的"
		addedItems: added,
		updatedItems: updated,
	}
}

/**
 * **收起**一批记忆（2026-09-28）：自动路径（到期 / 低频）唯一的处置方式。
 *
 * 为什么不是删除：用户明确担心「误删掉之后模型一点都不记了」。收起后
 * ①仍在文件里（记忆库「已收起」折叠区可见、可一键「留下」）；
 * ②叙事层不受影响（历史总结照旧注入上下文）；
 * ③与 `invalidAt` 分工清楚：作废=被新说法取代，收起=不再重要/太久没提。
 *
 * `updatedAt` 必须**严格大于**原值：双实例落盘合并按"最后改动时间"取胜，
 * 同一毫秒会平局，而平局规则偏向"已收起"那一份（见 newerMemory）—— 但仍要严格递增，
 * 否则另一实例上"还没收起"的副本可能凭 lastAccessedAt 反超（作废当年踩过同样的坑）。
 */
const fadeItems = (store: MemoryStoreData, items: readonly MemoryItem[], reason: "expired" | "lowvalue" | "manual"): number => {
	if (!items.length) return 0
	const now = Date.now()
	const ids = new Set(items.map(it => it.id))
	store.memories = store.memories.map(m =>
		ids.has(m.id) && isActiveMemory(m)
			? {...m, fadedAt: now, fadedReason: reason, updatedAt: Math.max(now, (m.updatedAt ?? m.createdAt ?? 0) + 1)}
			: m
	)
	console.log(`[mem] 已收起 ${ids.size} 条 (原因: ${reason}; 可一键「留下」)`)
	return ids.size
}

/**
 * **再次被提到 = 复活**：把库里"已收起"的条目与这批新条目做同一件事比对，命中就放回生效状态。
 * 这样"误收起"不会变成"彻底忘掉" —— 用户再说一次它就回来了（并且会被 merge 正常升级）。
 * 只认"同一件事"（`isSameContent`，与写入合并同一把尺子）；作废条**不复活**（那是被推翻的旧说法）。
 * @returns 复活条数
 */
const reviveFaded = (store: MemoryStoreData, fresh: readonly MemoryItem[]): number => {
	if (!fresh.length) return 0
	const faded = store.memories.filter(m => !!m.fadedAt && !m.invalidAt)
	if (!faded.length) return 0
	const now = Date.now()
	const hits = new Set<string>()
	for (const f of faded) {
		if (!f.content) continue
		for (const it of fresh) {
			if (!it.content) continue
			if (isSameContent(f.content, it.content)) { hits.add(f.id); break }
		}
	}
	if (!hits.size) return 0
	store.memories = store.memories.map(m =>
		hits.has(m.id)
			? {...m, fadedAt: undefined, fadedReason: undefined, updatedAt: Math.max(now, (m.updatedAt ?? m.createdAt ?? 0) + 1)}
			: m
	)
	console.log(`[mem] 之前收起的 ${hits.size} 条又被提到, 已放回生效`)
	return hits.size
}

/**
 * 写入一个记忆块 (P2): 把这段对话筛出的条目并进库, 并让块挂着它们。
 *
 * 归属规则 (关键设计, 决定记忆库块视图长什么样):
 * - 挂 = 本段**新增**的条目 + 本段**升级**但还没有归属的条目 (**避免孤儿**: 被升级的旧条
 *   若本来不在任何块里, 不挂就会在块视图里无处显示);
 * - 已经在别的块里的条目**不重复挂** —— 一条记忆只属于它最初出现的那个时间段,
 *   后面对它的提及只体现在"新块的 topic/summary"里, 记忆库不会同一条显示两遍。
 *
 * 逐句判重在这里被"块级合并"取代: 段内改口在提取时就被模型看成一件事的最终状态,
 * 跨块矛盾则由 applyMerge 里的确定性判据打 invalidAt (可还原)。
 */
const writeBlock = (
	store: MemoryStoreData,
	block: MemoryBlock,
	fresh: MemoryItem[],
): {added: number; updated: number; invalidated: number; expired: number; lowvalue: number; revived: number} => {
	const res = applyMerge(store, fresh)
	const alive = new Set(store.memories.map(m => m.id))
	const inAnyBlock = new Set<string>()
	for (const b of store.blocks ?? []) for (const id of b.itemIds) inAnyBlock.add(id)
	block.itemIds = [...new Set([...res.addedItems, ...res.updatedItems].map(m => m.id))]
		.filter(id => alive.has(id) && !inAnyBlock.has(id))
	const list = store.blocks ?? (store.blocks = [])
	const exist = list.find(b => b.id === block.id)
	if (exist) {
		// 双实例并发总结了同一区间 (区间指纹撞上): 合并成员而不是并存两个块
		exist.itemIds = [...new Set([...exist.itemIds, ...block.itemIds])]
		exist.topic = block.topic || exist.topic
		exist.summary = block.summary
		exist.createdAt = Math.max(exist.createdAt, block.createdAt)
	} else {
		list.push(block)
		// 按区间正序: 块视图的时间线顺序 (push 的顺序在双实例合并后不保证)
		list.sort((a, b) => (a.fromTs - b.fromTs) || a.id.localeCompare(b.id))
	}
	trimBlocksToMax()
	return {
		added: res.added,
		updated: res.updated,
		invalidated: res.invalidated,
		expired: res.expired,
		lowvalue: res.lowvalue,
		revived: res.revived,
	}
}

/** LLM 语义召回超时 (ms): 超过即放弃, 走关键词降级.
 *  设在 3s: 语义召回是"锦上添花", 不值得让每次对话都等太久 */
const LLM_TIMEOUT_MS = 3000

/** 给 Promise 加超时 (超时 reject) */
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), ms)
		p.then(
			(v) => { clearTimeout(t); resolve(v) },
			(e) => { clearTimeout(t); reject(e) },
		)
	})

/**
 * 混合提取: 规则法 + LLM 法 (捕捉委婉表达). LLM 失败不影响规则结果.
 * @param text 用户消息
 * @param llmCall (prompt) => Promise<string> 调用聊天 LLM 返回提取 JSON
 * @returns 本次净新增条数 (展示用近似)
 */
export const addMemoriesWithLlm = async (
	text: string,
	llmCall: (prompt: string) => Promise<string>,
): Promise<number> => {
	const store = load()
	const before = store.memories.length
	let changed = applyMerge(store, extractMemories(text)).changed
	// LLM 提取 (可选增强, 失败/超时静默)
	try {
		changed = applyMerge(store, parseLlmMemories(await llmCall(buildLlmExtractPrompt(text)))).changed || changed
	} catch {
		// 忽略
	}
	if (changed) persist()
	return Math.max(0, store.memories.length - before)
}

/**
 * 把 LLM 分析返回的记忆去重合并后并入库存 (规则提取由调用方另行处理).
 * @returns 本次净新增条数 (展示用近似)
 */
export const mergeLlmMemories = (items: MemoryItem[]): number => {
	if (!items.length) return 0
	const store = load()
	const before = store.memories.length
	if (applyMerge(store, items).changed) persist()
	return Math.max(0, store.memories.length - before)
}

/* ------------------------------------------------------------------ */
/* Mem0 风格两段式: ① LLM 提取事实  ② LLM 决策入库 (ADD/UPDATE/DELETE)   */
/* ------------------------------------------------------------------ */

/** 入库决策调用超时 (ms): 超时/失败 → 退回"直接合并"兜底, 不影响入库 */
const DECISION_TIMEOUT_MS = 4000
/** 决策时最多给 LLM 看几条相似旧记忆 (控制提示词长度) */
const DECISION_CANDIDATES = 10

export interface MemoryWriteResult {
	/** 本次净新增条数 (近似) */
	added: number
	/** 被改写的旧记忆条数 (决策 UPDATE) */
	updated: number
	/** 被**显式删除**的矛盾旧记忆条数 (登记墓碑, 不可还原) */
	deleted: number
	/**
	 * 被**作废**的旧记忆条数 (2026-09-27 起, 决策 DELETE 走这条路)。
	 * 与 `deleted` 分开: 作废只是打 `invalidAt`、不再注入, 但留在文件里、用户可一键还原。
	 */
	invalidated: number
	/** 是否真的用上了 LLM 决策 (false = 走的直接合并兜底) */
	usedLlm: boolean
}

/**
 * 把 AI 提取的事实写入记忆库 (Mem0 第二段: 更新决策).
 * 1. 用关键词召回与新事实相似的旧记忆作为候选; 没有候选 → 全是新信息, 直接合并 (省一次调用);
 * 2. 一次 LLM 调用做 ADD/UPDATE/DELETE/NONE 决策 (超时或解析失败 → 直接合并兜底);
 * 3. 先执行 UPDATE(改写旧条, 保留 id)/DELETE(矛盾旧条走墓碑), 再把新事实合并入库
 *    (与库内重叠的会自动合并升级, 不会重复堆叠).
 * 好处: 判重与冲突由语义决定, 不再依赖"字符串包含", 也解决了改口/同义改写问题.
 */
export const applyLlmMemoryDecision = async (
	facts: MemoryItem[],
	llmCall: (prompt: string) => Promise<string>,
): Promise<MemoryWriteResult> => {
	if (!facts.length) return {added: 0, updated: 0, deleted: 0, invalidated: 0, usedLlm: false}
	const store = load()
	/**
	 * 参与判重/候选/归属的旧记忆池 —— **只含仍然有效的**。
	 * 作废条 (invalidAt) 必须整体退出这条流水线, 否则三种事故都会发生:
	 * ① 被 AI 判成 UPDATE/NONE 吸收新事实 → 事实写进一条不注入的死条目 (静默丢信息);
	 * ② 成为 factOwner → 3b 处直接把新事实吸收掉 (同样丢信息);
	 * ③ 白白占掉候选名额, 把真正该判的活条目挤出去。
	 */
	/**
	 * 0) **确定性改口消解先跑** (不看模型)。
	 * 必须在 pool/候选之前: 被作废的旧条立刻退出候选, 否则模型可能对一条已经作废的条目
	 * 回 UPDATE (把新事实吸收进死条目 ⇒ 新信息丢失, 就是上面 ①② 那个坑)。
	 * 实测依据: 「我想养猫」→「我不想养猫了」时模型只答 ADD ⇒ 没有这一步就永远不作废
	 * (tmp-memcheck/probe-cross-type-reversal.mjs)。
	 */
	const reversalInvalidated = invalidateReversals(store, facts)
	const pool = store.memories.filter(isActiveMemory)
	// 1) 选候选旧记忆: 关键词命中 + 最近更新 + 高重要 三路混合
	//    (只看关键词会漏掉"衰减严重的老记忆", 只看新旧又会漏掉相关的; 与语义召回同思路)
	//    同时记录"哪条新事实召回到了哪些旧记忆" —— UPDATE 吸收该事实时要用它判断
	const candidates = new Map<string, MemoryItem>()
	const factCands: Set<string>[] = facts.map(() => new Set<string>())
	/** 新事实 → 与它"近重复"的旧记忆 id (similarity ≥ NEAR_DUP_DICE): 必须进候选, 见下 */
	const nearCands: Set<string>[] = facts.map(() => new Set<string>())
	let keywordHit = false
	for (let i = 0; i < facts.length; i += 1) {
		const factTokens = new Set(tokenize(facts[i].content))
		for (const hit of recallMemories(store.memories, facts[i].content, 5).hits) {
			candidates.set(hit.id, hit)
			factCands[i].add(hit.id)
			// 注意: recallMemories 的阈值里含 importance/新鲜度等非语义项,
			// 一条"很新但完全不相关"的记忆也会过阈值 —— 这里必须真看词面重叠,
			// 否则"是否值得调 LLM"的成本控制会失效 (几乎每次都调).
			// 重叠强度闸: 单个常见 bigram ("我的/是一个") 太弱, 会退化成每条消息都调;
			// 要求 ≥2 个词元重叠, 或 1 个词元重叠且事实本身很短 (≤2 词元).
			// 【曾经的 bug】这里的 overlap 原先在"单条候选"内 early-break 计数, 最多数到 2 ——
			// 实测 (probe-mem-ab.mjs, 旧源码 A/B): 旧「我在准备考研考试」+ 新「我准备考研」
			// 只在「考研考试」这一个 bigram 上重叠, 数不到 2 ⇒ keywordHit 判为不命中 ⇒
			// 直接走 merge 兜底 (只认原文包含) ⇒ 库里两条并存 (llm 调用数=0)。
			// 另外它同时兼作"候选来源"的开关 (不命中时只保留词面召回候选), 所以判不中还会让
			// 同类型候选一并进不来 —— 两个后果叠在一起。
			if (hit.content) {
				let overlap = 0
				for (const tk of tokenize(hit.content)) {
					if (factTokens.has(tk)) overlap += 1
				}
				if (overlap >= 2 || (overlap >= 1 && factTokens.size <= 2)) keywordHit = true
			}
		}
		if (candidates.size >= DECISION_CANDIDATES) break
	}
	// 近重复补候选: "同一件事换说法"时词面 bigram 常只重叠 1 个, 既过不了上面的成本闸、
	// 也进不了 recallMemories 的结果 —— AI 判重根本看不到它们, 于是重复越攒越多。
	// 这里把 similarity ≥ NEAR_DUP_DICE 的旧记忆直接塞进候选并记为命中 (判重仍由 AI 做)。
	if (pool.length) {
		// 候选已满时不必再扫 (成本: O(事实数 × 库大小) 的纯字符串计算, 无 LLM 调用)
		const cap = DECISION_CANDIDATES * 2
		for (let i = 0; i < facts.length && candidates.size < cap; i += 1) {
			for (const m of pool) {
				if (candidates.size >= cap) break
				if (!m.content) continue
				if (contentSimilarity(m.content, facts[i].content) < NEAR_DUP_DICE) continue
				candidates.set(m.id, m)
				nearCands[i].add(m.id)
				keywordHit = true
			}
		}
	}
	/**
	 * 同类兜底触发 ("我叫小明" vs "我的名字是小明" 这种**零字面重叠**的同义改写):
	 * 前两条候选路都建立在"有字面重叠"上 —— 零重叠的同义句词面怎么算都不够格, AI 永远看不到它们。
	 *
	 * 【曾经的 bug】这里原先的前置条件是 `!keywordHit`: 只要任一事实被词面召回到过候选
	 * (哪怕重叠只有 1 个 bigram、"是否值得调 LLM"的成本闸判为不值得), 同类兜底就整个不跑 ——
	 * 而那种"召回到了但闸没开"的候选本身又不足以触发决策 ⇒ 判重被静默跳过, 同义改写照样并存两条。
	 * 现在按**成本闸**判断: 闸没打开 (keywordHit=false) 时就把同类型旧记忆补进候选。
	 *
	 * 成本: 新建一个类型的事实会多一次决策调用 (AI 很快判 ADD/NONE 即结束);
	 * 换来的是"同义改写不再重复入库"。类型只有 6 个枚举, 比"全库都问一遍"划算得多。
	 */
	let typeFallbackHit = false
	if (pool.length && !keywordHit) {
		for (const m of pool) {
			for (let i = 0; i < facts.length; i += 1) {
				if (m.type !== facts[i].type) continue
				candidates.set(m.id, m)
				// 也记进 nearCands: 决策 (UPDATE/NONE) 判"同一件事"时要能吸收掉这条事实,
				// 只进候选不记归属的话, AI 说"已有同一件事"也照样入库并存两条
				nearCands[i].add(m.id)
				typeFallbackHit = true
			}
		}
	}
	const existing = [...candidates.values()].slice(0, DECISION_CANDIDATES)
	// 决策前的"原文包含"归属 (兜底去重用, 见 3b): 记下"能 100% 确定新事实是旧条同一件事"
	// 的那条旧记忆 id。必须在这里定下来 —— 决策的 UPDATE 会改写旧条文本, 事后现算会
	// 把被改写的旧条认成"包含该事实", 于是新事实全被吸收、真正的新信息反而丢了。
	const factOwner: (string | null)[] = facts.map(f => {
		let hit: string | null = null
		for (const m of pool) {
			if (!m.content || !isSameContent(m.content, f.content)) continue
			if (hit) return null   // 多条旧条都包含 → 判不准, 交给 merge/用户
			hit = m.id
		}
		return hit
	})
	// 成本控制: 只有**候选真有可能与事实是同一件事**时才花这次决策调用 ——
	// 字面重叠够强 (keywordHit) 或近重复/同类型兜底命中 (typeFallbackHit)。
	// 刻意不再"用最近/高重要记忆凑候选": 那种候选与事实多半无关, 决策基本全是 NONE,
	// 白白多一次调用; 需要它们的时候 (同类型) 已被上面的兜底覆盖。
	if (!existing.length || !(keywordHit || typeFallbackHit)) {
		const mres = applyMerge(store, facts)
		if (mres.changed || reversalInvalidated) persist()   // 提前返回也要落盘: 改口消解可能已经作废了旧条
		return {
			added: mres.added, updated: 0, deleted: 0,
			invalidated: mres.invalidated + reversalInvalidated, usedLlm: false,
		}
	}
	// 2) 决策 (容错: 失败就当没决策, 走合并兜底)
	let decisions: MemoryDecision[] = []
	try {
		const raw = await withTimeout(
			llmCall(buildLlmMemoryDecisionPrompt(
				facts.map(f => ({content: f.content, type: f.type})),
				existing.map(m => ({id: m.id, content: m.content, type: m.type})),
			)),
			DECISION_TIMEOUT_MS,
		)
		decisions = parseLlmMemoryDecision(raw)
	} catch {
		decisions = []
	}
	// 3a) 执行 UPDATE / DELETE (只认库内真实 id; "new" 与编造的 id 一律忽略)
	let updated = 0
	let deleted = 0
	/** 被作废 (被新信息取代) 的条数 —— 与 deleted 分开计数: 作废可还原, 删除不可。
	 *  初值 = 上面那趟**确定性改口消解**已经作废掉的条数 (它不看模型, 先扣掉) */
	let invalidated = reversalInvalidated
	const absorbed = new Set<number>() // 已被 UPDATE/NONE 吸收的新事实下标 (不再单独入库, 防两份措辞并存)
	if (decisions.length) {
		const byId = new Map(pool.map(m => [m.id, m]))
		const now = Date.now()
		const delIds = new Set<string>()   // 用户/调用方显式删除 (登记墓碑) —— 当前决策路径不再产生
		const invIds = new Set<string>()   // 被新信息取代 → 作废 (可还原)
		const patch = new Map<string, string>()
		/** 决策要求"这条新事实不必再存"的旧记忆 id: UPDATE (已吸收) 或 NONE (判定同一件事) */
		const resolvedIds = new Set<string>()
		for (const d of decisions) {
			const old = byId.get(d.id)
			if (!old) continue
			if (d.event === "DELETE") {
				/* DELETE = "旧说法已不成立" → **作废**而不是抹掉 (2026-09-27, 借鉴 Zep 的 edge invalidation)。
				 *
				 * 为什么要改: 原实现在这里有一道保护闸 —— 显式/固定/importance ≥ 0.85 的记忆
				 * 不许被 AI 删除。而**名字、身份**这类最需要纠正的记忆, 规则给的 importance 恰恰是
				 * 0.9 ⇒ 实测「我叫小明」改成「我叫小刚」时会新旧并存, **恰恰纠不了**
				 * (证据: tmp-memcheck/probe-mem-correction.mjs 的第 ④⑤ 组)。
				 * 作废是可一键还原的, 那句判错的代价从"永久丢数据"降到"点一下还原",
				 * 所以那道保护闸**不再需要** —— 死结自然解开。
				 *
				 * 仍然保留的底线: 只认库里真实存在的 id (byId 查过), 编造 id 直接跳过;
				 * 作废条留在文件里, 用户可在记忆库「历史」里看到并还原。 */
				invIds.add(d.id)
				continue
			}
			// NONE = "库里已有同一件事, 新事实不必再存一遍" → 吸收, 否则同一件事换说法后
			// 会按 merge 兜底 (只认原文包含) 又新增一条 (实测: 近重复场景 added=1)
			if (d.event === "NONE") { resolvedIds.add(d.id); continue }
			if (d.event !== "UPDATE" || !d.text) continue
			// UPDATE 只在"新信息不比旧条少"时改写, 避免把更完整的旧记忆改写成更简的版本;
			// 更简的改写请求不是"没判重", 而是"AI 认为这两条本来是一件事" ——
			// 所以旧条不动 (它更全), 但**新事实也不算新增** (否则同一件事又并存两条)。
			if (d.text.length >= old.content.length) patch.set(d.id, d.text)
			resolvedIds.add(d.id)
		}
		// 被判定"同一件事"的旧条 → 对应新事实不再单独入库。
		// 候选来源两路都要看: 词面召回 (factCands) 与近重复召回 (nearCands)。
		// UPDATE/NONE 只要命中**任一**候选即吸收, 不要求那个候选与事实'原文包含' ——
		// 否则近重复 (词面只重叠 1 个 bigram) 这条路上判重成功了却照样入库并存。
		if (resolvedIds.size) {
			facts.forEach((_, i) => {
				for (const id of [...factCands[i], ...nearCands[i]]) {
					if (resolvedIds.has(id)) { absorbed.add(i); break }
				}
			})
		}
		if (patch.size) {
			store.memories = store.memories.map(m =>
				patch.has(m.id) ? {...m, content: patch.get(m.id) as string, updatedAt: now} : m
			)
			updated = patch.size
		}
		if (invIds.size) {
			// 作废: 只标 invalidAt, 不删、不打墓碑 —— 用户可在记忆库「历史」里还原。
			// updatedAt 一并**严格增大**: 双实例合并按最后改动时间取胜, 而 Date.now() 与旧
			// updatedAt 可能同毫秒 → 平局会让磁盘上"还没作废"的副本反吃回来 (实测丢失过)
			const nowInv = Date.now()
			store.memories = store.memories.map(m =>
				invIds.has(m.id) && !m.invalidAt
					? {...m, invalidAt: nowInv, updatedAt: Math.max(nowInv, (m.updatedAt ?? m.createdAt ?? 0) + 1)}
					: m
			)
			invalidated += invIds.size
		}
		if (delIds.size) {
			const removed = store.memories.filter(m => delIds.has(m.id))
			markDeleted(removed) // 墓碑: 防止被磁盘旧副本复活
			store.memories = store.memories.filter(m => !delIds.has(m.id))
			deleted = removed.length
		}
	}
	// 3b) 未被 UPDATE 吸收的新事实入库 (与库内重叠的自动合并升级, 不会重复堆叠)
	//
	// 兜底去重: 决策漏判 (或压根没调决策) 时, 只要库里的旧条**原文包含**新事实
	// (归一化后包含 = 100% 同一件事, 不需要语义判断), 就只强化旧条, 不算新增 ——
	// 否则"重复说同一句话"又攒出一条一模一样的记忆。
	// 判据在决策**改动库之前**就固定下来 (factOwner): UPDATE 会把旧条文本改写成新事实,
	// 事后现算的话每个事实都能"找到"刚刚被改写出来的自己, 变成全部吸收。
	for (let i = 0; i < facts.length; i += 1) {
		if (absorbed.has(i)) continue
		const owner = factOwner[i]
		if (!owner) continue
		absorbed.add(i)
		store.memories = store.memories.map(m => m.id === owner ? {...m, updatedAt: Date.now()} : m)
	}
	const toWrite = absorbed.size ? facts.filter((_, i) => !absorbed.has(i)) : facts
	const mres = toWrite.length ? applyMerge(store, toWrite) : {added: 0, updated: 0, changed: false, invalidated: 0}
	if (mres.changed) persist()
	// updated = 决策改写 + merge 升级 (新说法更完整时走 merge, 也该算"改写"供气泡门控)
	return {
		added: mres.added, updated: updated + mres.updated, deleted,
		invalidated: invalidated + mres.invalidated, usedLlm: decisions.length > 0,
	}
}

export interface SmartExtractResult extends MemoryWriteResult {
	/** 气泡提示内容 (优先 AI 提取结果, 否则规则结果) */
	tips: string[]
}

/**
 * 一站式记忆写入 (主界面/悬浮窗共用):
 * 规则提取免费先跑 (立即兜底, 也让 AI 决策能看到它), 然后 AI 提取 + 决策修正.
 * @param llmCall null = 只用规则 (AI 开关关闭 / 未配置 API)
 * @param recentContext 最近对话 (仅供 AI 理解指代, 不作为提取来源)
 */
export const extractMemoriesSmart = async (
	userText: string,
	llmCall: ((prompt: string) => Promise<string>) | null,
	recentContext: {role: string; content: string}[] = [],
): Promise<SmartExtractResult> => {
	const result: SmartExtractResult = {added: 0, updated: 0, deleted: 0, invalidated: 0, usedLlm: false, tips: []}
	// 1) 规则通道 (免费, 永远跑)
	try {
		const ruleItems = extractMemories(userText)
		result.added = addMemoriesFromText(userText)
		if (result.added > 0) result.tips = ruleItems.slice(0, 2).map(i => i.content)
	} catch (e) {
		console.error("[mem] rule extract failed:", e)
	}
	// 2) AI 通道 (可选; 寒暄/过短消息跳过, 省 token)
	if (!llmCall || shouldSkipLlmExtract(userText)) return result
	try {
		const raw = await llmCall(buildLlmExtractPrompt(userText, recentContext))
		const facts = parseLlmMemories(raw)
		if (!facts.length) return result
		const write = await applyLlmMemoryDecision(facts, llmCall)
		result.added += write.added
		result.updated += write.updated
		result.deleted += write.deleted
		result.invalidated += write.invalidated
		result.usedLlm = write.usedLlm
		// 零新增/零改写 (重复说过的话) 不弹"记住了", 与规则通道的 added>0 门控一致
		if (write.added > 0 || write.updated > 0) {
			result.tips = facts.slice(0, 2).map(f => f.content) // AI 结果更准, 覆盖提示
		}
	} catch (e) {
		console.error("[mem] llm extract failed:", e)
	}
	return result
}

/** 低频记忆筛选 (预览与执行共用同一判定, 避免 UI 先判后删不一致) */
const staleDrop = (store: MemoryStoreData, staleDays: number, minImportance: number): MemoryItem[] => {
	if (!store.memories.length) return []
	const now = Date.now()
	const staleMs = staleDays * 24 * 3600 * 1000
	return store.memories.filter(it =>
		it.importance < minImportance &&
		now - Math.max(it.lastAccessedAt, it.createdAt) > staleMs &&
		it.accessCount < 2
	)
}

/**
 * 预览: 这次"清理低频记忆"会删几条 (不删).
 * 供 UI 决定是否值得先备份 —— 无效清理不该覆盖"清空前"的备份 (上次清空的撤销点).
 */
export const pruneStalePreview = (staleDays = 30, minImportance = 0.6): number =>
	staleDrop(load(), staleDays, minImportance).length

/**
 * 手动清理低频记忆: 删除超过 staleDays 未召回、且重要性低、使用次数少的记忆.
 * @returns 本次删除条数
 */
export const pruneStaleMemories = (staleDays = 30, minImportance = 0.6): number => {
	const store = load()
	const drop = staleDrop(store, staleDays, minImportance)
	if (!drop.length) return 0
	markDeleted(drop)
	const dropIds = new Set(drop.map(d => d.id))
	store.memories = store.memories.filter(it => !dropIds.has(it.id))
	pruneBlockRefs(store)   // 低频清理也要清块里的悬空引用 (被清掉的条目不该还挂在块上)
	persist()
	return drop.length
}

/**
 * 按当前用户消息召回相关记忆.
 * 命中会更新强化信息 (lastAccessedAt/accessCount) 并持久化.
 * @returns 注入上下文的 system 块文本 (空串 = 无相关记忆)
 */
export const recallForQuery = (query: string): string => {
	const store = load()
	if (!store.memories.length) return ""
	// 取数与渲染数必须一致: recallMemories 默认取 8 条, 而 buildMemoryBlock 只渲染 6 条,
	// 多出来的第 7、8 名从未进过上下文却照样 accessCount+1 —— 而 accessCount 既参与
	// pruneMemories 的价值评分, 又是 expireMemories 的免死条件 (>=2 则不过期),
	// 等于给"没被用过的记忆"发免死金牌, 真正被用过的反而更容易被裁掉。
	const {hits, updated} = recallMemories(store.memories, query, MEMORY_BLOCK_LIMIT)
	if (!hits.length) return ""
	store.memories = updated
	persist()
	return buildMemoryBlock(hits, MEMORY_BLOCK_LIMIT)
}

/**
 * LLM 语义召回 (①): 用 LLM 判断真正相关的记忆, 解决关键词字面匹配抓不到
 * 同义/指代的问题. 带降级: LLM 不可用/失败/超时 → 回落关键词召回, 不影响使用.
 *
 * 由于是异步, 由调用方在「发送前」await (主 App / 悬浮窗各有一处);
 * 可加开关, 关闭时直接走 recallForQuery.
 *
 * @param query 当前用户消息
 * @param llmCall (prompt) => Promise<string> 返回 LLM 文本 (通常是 JSON)
 * @param topK 最多注入几条 (LLM 命中 + 关键词兜底合并后取前 topK)
 * @returns 注入上下文的 system 块 (空串 = 无)
 */
export const recallForQuerySmart = async (
	query: string,
	llmCall: (prompt: string) => Promise<string>,
	topK = MEMORY_BLOCK_LIMIT,
): Promise<string> => {
	const store = load()
	if (!store.memories.length) return ""
	// 只拿**有效**记忆当候选: 作废条从这里漏出去就会又被注入 (它连"高重要/最新"两路
	// 粗筛都能进, 与 openingMemoryBlock 同一个坑)
	const all = store.memories.filter(isActiveMemory)
	if (!all.length) return ""
	let picked: MemoryItem[] = []
	let llmOk = false // LLM 成功返回 (即使无命中)
	// 1) LLM 判断 (候选过多时先按关键词粗筛到 Top 20, 控制 prompt 长度)
	//    带超时: LLM 慢/挂起时 8s 后放弃 → 走关键词降级, 避免对话卡死
	try {
		// 候选筛选: 全量 ≤20 时全给 LLM; 超量时混合取 (关键词 Top + 最新 + 高重要),
		// 避免只按关键词粗筛导致"指代性提问"把真相关记忆筛掉
		let pre: MemoryItem[]
		if (all.length <= 20) {
			pre = all
		} else {
			const kw = recallMemories(all, query, 15).hits
			const byNew = [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6)
			const byImp = [...all].sort((a, b) => b.importance - a.importance).slice(0, 6)
			const seen = new Set<string>()
			pre = []
			for (const m of [...kw, ...byNew, ...byImp]) {
				if (!seen.has(m.id)) { seen.add(m.id); pre.push(m) }
				if (pre.length >= 20) break
			}
		}
		if (pre.length) {
			const raw = await withTimeout(llmCall(buildLlmRelevancePrompt(query, pre.map(m => ({id: m.id, content: m.content})))), LLM_TIMEOUT_MS)
			llmOk = true
			const valid = new Set(pre.map(m => m.id))
			const llmIds = parseLlmRelevance(raw, valid)
			// 保持 LLM 输出顺序, 只取有效的
			picked = llmIds.map(id => all.find(m => m.id === id)).filter((m): m is MemoryItem => !!m)
		}
	} catch { /* LLM 失败/超时 → llmOk=false → 走关键词兜底 */ }
	// 2) 降级/补漏:
	//    - LLM 失败/超时 → 用关键词完整兜底 (保底可用);
	//    - LLM 成功但空结果 → 只补"字面强命中"的 ≤2 条 (关键词分很高才算强, 防弱噪音,
	//      也避免 LLM 误判把铁相关的记忆丢掉)
	if (!llmOk && picked.length < 3) {
		const kw = recallMemories(all, query, topK).hits
		for (const m of kw) {
			if (!picked.some(p => p.id === m.id)) picked.push(m)
			if (picked.length >= topK) break
		}
	} else if (llmOk && picked.length === 0) {
		// 关键词强命中: 分数 > 1.5 (明显字面重叠 + 较高重要度) 才补, 最多 2 条。
		// 与 recallMemories 同一道相关性门槛: 先把词面重叠为 0 的记忆排除,
		// 否则"高重要 + 新鲜"的无关记忆也可能靠静态分进入注入上下文。
		const qt = tokenize(query)
		const scored = all
			.filter(m => overlapCount(qt, m) > 0)
			.map(m => ({m, score: scoreMemory(qt, m, Date.now())}))
			.filter(s => s.score > 1.5)
			.sort((a, b) => b.score - a.score)
		for (const {m} of scored.slice(0, 2)) {
			if (!picked.some(p => p.id === m.id)) picked.push(m)
		}
	}
	// 统一收敛到"实际会渲染的条数": 调用方若传了比渲染上限更大的 topK,
	// 多出来的条目会只被强化却进不了上下文 (与 recallForQuery 曾经的 8/6 不一致同源)
	picked = picked.slice(0, Math.min(topK, MEMORY_BLOCK_LIMIT))
	if (!picked.length) return ""
	// 3) 更新强化信息 (lastAccessedAt/accessCount) 并持久化.
	//    从"当前 store.memories"出发而不是 await 前捕获的 all: LLM 调用期间
	//    adoptFromDisk 可能已把另一实例的写入合并进来, 按旧 all 全量回写会把它们抹掉
	const hitIds = new Set(picked.map(p => p.id))
	store.memories = store.memories.map(m =>
		hitIds.has(m.id) ? {...m, lastAccessedAt: Date.now(), accessCount: m.accessCount + 1} : m
	)
	persist()
	return buildMemoryBlock(picked, MEMORY_BLOCK_LIMIT)
}

/** 开场注入的条数上限（**语音会话开始**这类"没有当前提问"的场合用） */
const OPENING_LIMIT = 8

/**
 * **开场记忆块**：给"没有当前提问"的场合用（语音会话开始、悬浮窗开场…）。
 *
 * ## 为什么不能直接 `recallForQuery("")`
 * 关键词召回把**词面重叠当作必要条件**（`recallMemories` 里 tokens 为空直接返回空），
 * 所以空查询**必然**召回不到任何东西 ⇒ 语音里她连"主人叫什么"都不知道。
 * 实机（2026-09-26 报告）更直接：`toolCalls: 0` —— 连 `recall_memory` 都没被调用过，
 * 等于语音全程**零记忆**（而她照样一本正经地回答）。
 *
 * ## 选谁
 * ① 有当前话题（最近一句话）⇒ 先按它召回（**不强化**，见下）；
 * ② 再补"身份/核心"记忆（`tags` 含 identity/explicit，或 `type=core`，或 importance ≥ 0.8）——
 *    称呼、名字、喜好这类"开场就该知道"的东西。
 *
 * ## 为什么不更新 `accessCount`
 * 开场注入每次会话都会发生；如果算强化，同一批高分记忆会被反复加分、永远霸榜（价值评分灌水），
 * 真正"这次被问到"的记忆反而挤不进来。⇒ 开场块**只读**，强化留给真正的按需召回。
 */
export const openingMemoryBlock = (query = "", limit = OPENING_LIMIT): string => {
	const store = load()
	if (!store.memories.length) return ""
	const picked: MemoryItem[] = []
	const seen = new Set<string>()
	const push = (it?: MemoryItem): void => {
		if (it && it.content && !seen.has(it.id)) { seen.add(it.id); picked.push(it) }
	}
	const q = (query ?? "").trim()
	if (q) for (const it of recallMemories(store.memories, q, limit).hits) push(it)
	// 只从**有效**记忆里挑: 作废条 (被改口纠正取代) 若不滤掉, 会在这里被当成
	// "importance ≥ 0.8 的身份记忆" 注入语音开场 —— 名字/身份恰恰最容易走到作废那条路
	const byValue = store.memories.filter(isActiveMemory)
		.sort((a, b) => (b.importance - a.importance) || (b.createdAt - a.createdAt))
	for (const it of byValue) {
		if (picked.length >= limit) break
		const t = it.tags ?? []
		const identity = t.includes("identity") || t.includes("explicit")
		if (it.type === "core" || identity || it.importance >= 0.8) push(it)
	}
	return buildMemoryBlock(picked, limit)
}

/**
 * 读取当前可注入的历史总结块 (空串 = 无)
 */
export const summaryBlock = (): string => {
	const store = load()
	return buildSummaryBlock(store.summaries, {metas: store.meta ?? []})
}

/**
 * 剥离 LLM 摘要末尾的「记忆要点」段 (⑩ 回流用).
 * LLM 不按格式输出/无要点段时安全降级: 整段当摘要, 要点为空.
 */
const splitSummaryKeys = (text: string): {summaryText: string; keyFacts: string[]} => {
	const m = text.match(/\n\s*\**【?记忆要点】?\**[:：]?\s*/)
	if (!m || m.index === undefined) return {summaryText: text, keyFacts: []}
	const summaryText = text.slice(0, m.index).trim()
	const keysText = text.slice(m.index + m[0].length)
	const facts: string[] = []
	for (const part of keysText.split(/\n+|；|;/)) {
		const f = part.replace(/^[\s\-*·•\d.、]+/, "").replace(/[。！？!?…]+$/, "").trim()
		if (!f || f.length > 80) continue
		// "无/没有" 等占位: 整段剥离, 不回流
		if (/^(无|没有|暂无|略|空|none|n\/a|无新增|没有新增)/i.test(f)) {
			return {summaryText: summaryText || text, keyFacts: []}
		}
		facts.push(f)
		if (facts.length >= 5) break
	}
	if (!facts.length) return {summaryText: summaryText || text, keyFacts: []}
	return {summaryText: summaryText || text, keyFacts: facts}
}

/**
 * 回流护栏 (⑩ 摘要要点回流专用): 这条要点是不是"已被作废的旧说法"?
 *
 * 为什么需要: 作废 (invalidAt) 只让旧条**不再注入**, 条目本身还留在库里。而摘要要点是从
 * **旧对话**里再提取一遍的 —— 那段旧对话里往往还留着被纠正掉的旧说法 (「我叫小明」),
 * 回流时会重新造出一条**活的**记忆, 把刚纠正完的事实又顶回去 (实测复现见
 * tmp-memcheck/run-tests.mjs T29 组)。判据用原文包含 (isSameContent), 与写入合并同一把尺子。
 *
 * 只挡自动回流, **不挡用户当场再说一遍** —— 用户主动改回来是合法意图 (那条路径走正常写入,
 * 另有「还原」按钮可用)。
 */
const matchesInvalidated = (store: MemoryStoreData, content: string): boolean =>
	store.memories.some(m => !isActiveMemory(m) && isSameContent(m.content, content))

/**
 * 喂给摘要提示词的「已经记住的内容」(去重方案 ④, 2026-09-28)。
 *
 * 为什么要做: 实测确认摘要提示词里**完全没有**库里已有的记忆 ⇒ 模型是蒙着眼睛提取的,
 * 同一件事换个说法就会被再记一遍 (实机: 「我（小桧）想买鸡蛋」与「我想买鸡蛋」并存)。
 * 事后判重靠字符串比较抓不住近义措辞, 所以从源头让模型自己避开最省事 (零额外调用)。
 *
 * 有界: 条数 ≤40、单条 ≤24 字、总共 ≤900 字 (重要度优先) —— 提示词不能因此无限膨胀。
 * 只喂**生效中**的条目 (作废说法不该被"避免重复", 它本来就要被新说法取代)。
 */
const KNOWN_MEMORY_LIMIT = 40
const KNOWN_MEMORY_ITEM_CHARS = 24
const KNOWN_MEMORY_TOTAL_CHARS = 900
const knownMemoryList = (store: MemoryStoreData): string[] => {
	const items = store.memories
		.filter(isActiveMemory)
		.filter(m => !!m.content)
		.sort((a, b) => (b.importance - a.importance) || (b.createdAt - a.createdAt))
		.slice(0, KNOWN_MEMORY_LIMIT)
	const out: string[] = []
	let total = 0
	for (const m of items) {
		const t = m.content.length > KNOWN_MEMORY_ITEM_CHARS
			? `${m.content.slice(0, KNOWN_MEMORY_ITEM_CHARS)}…`
			: m.content
		if (total + t.length > KNOWN_MEMORY_TOTAL_CHARS) break
		total += t.length
		out.push(t)
	}
	return out
}

/* ---------------- 整理优化: 记忆口味自学习 (2026-09-28) ----------------
 * 用户的想法: 记忆库给一个「整理优化」按钮 + 「自动优化」开关（默认关），
 * 每隔若干条入库就把库里已有记忆提炼成**示例**，写进整理提示词当 few-shot。
 *
 * 为什么这样有效: 例子来自**主人自己保留的**（正例）与**主人删掉的**（反例，来自回收站）
 * —— 这是最强的口味信号，比任何写死的规则都准；而且**零额外调用**（例子就是记忆原文）。
 * 为什么默认关: 早期库里若还堆着垃圾，例子会把垃圾风味固化 ⇒ 首次使用要提示主人先自己过一遍。
 */
/** 生效记忆少于这个数不生成示例 (样本太小, 学出来的口味没意义) */
const EXAMPLE_COLD_START = 12
/** 生效条数比上次生成时多这么多条 → 值得重建 (自动模式) */
const EXAMPLE_REBUILD_AFTER = 20
/** 示例条数与体积上限 (提示词不能因此膨胀) */
const EXAMPLE_POS_MAX = 8
const EXAMPLE_NEG_MAX = 4
const EXAMPLE_ITEM_CHARS = 24
const EXAMPLE_TOTAL_CHARS = 400

export interface MemoryExamples {
	builtAt: number
	basedOn: number
	pos: string[]
	neg: string[]
}

const clipExample = (s: string): string => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim()
	return t.length > EXAMPLE_ITEM_CHARS ? `${t.slice(0, EXAMPLE_ITEM_CHARS)}…` : t
}

/** 正例候选: 生效中、非目标、event 只要够重要；按重要度 + 被召回次数排序 */
const pickExamplePos = (store: MemoryStoreData): string[] => {
	const items = store.memories
		.filter(isActiveMemory)
		.filter(m => !!m.content && !(m.tags ?? []).includes("goal"))
		.filter(m => m.type !== "event" || m.importance >= 0.7)
		.sort((a, b) => (b.importance - a.importance) || (b.accessCount - a.accessCount) || (b.createdAt - a.createdAt))
	const out: string[] = []
	const seen = new Set<string>()
	for (const m of items) {
		if (out.length >= EXAMPLE_POS_MAX) break
		const t = clipExample(m.content)
		const key = normalizeForCompare(t)
		if (!t || !key || seen.has(key)) continue
		seen.add(key)
		out.push(t)
	}
	return out
}

/** 反例候选: 回收站里"主人删掉的"内容 (最近删的优先) */
const pickExampleNeg = (store: MemoryStoreData): string[] => {
	const bin = [...(store.deletedBin ?? [])].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
	const out: string[] = []
	const seen = new Set<string>()
	for (const m of bin) {
		if (out.length >= EXAMPLE_NEG_MAX) break
		const t = clipExample(m.content)
		const key = normalizeForCompare(t)
		if (!t || !key || seen.has(key)) continue
		seen.add(key)
		out.push(t)
	}
	return out
}

/** 当前示例集 (没生成过返回 null) */
export const getMemoryExamples = (): MemoryExamples | null => {
	const e = load().exampleSet
	return e && (e.pos?.length || e.neg?.length) ? e : null
}

/**
 * 重建示例集 (「立即优化」按钮 / 自动模式触发)。
 * 冷启动保护: 生效记忆 < `EXAMPLE_COLD_START` 条 → 不生成 (返回 false)。
 * 反例来自回收站; 回收站空着就只有正例 (照样有用)。
 */
export const rebuildMemoryExamples = (): boolean => {
	const store = load()
	const active = store.memories.filter(isActiveMemory)
	if (active.length < EXAMPLE_COLD_START) {
		console.log(`[mem] 记忆太少 (${active.length} < ${EXAMPLE_COLD_START}), 先不生成示例`)
		return false
	}
	const pos = pickExamplePos(store)
	const neg = pickExampleNeg(store)
	// 总字数上限: 先保正例, 再按剩余预算放反例
	let used = pos.reduce((n, s) => n + s.length, 0)
	const negFit = neg.filter(s => {
		if (used + s.length > EXAMPLE_TOTAL_CHARS) return false
		used += s.length
		return true
	})
	store.exampleSet = {builtAt: Date.now(), basedOn: active.length, pos, neg: negFit}
	persist()
	console.log(`[mem] 示例已重建: 正例 ${pos.length} 条 / 反例 ${negFit.length} 条`)
	return true
}

/** 该不该自动重建 (生效条数比上次生成时多了 ≥20 条) */
export const shouldRebuildMemoryExamples = (): boolean => {
	const store = load()
	const active = store.memories.filter(isActiveMemory).length
	if (active < EXAMPLE_COLD_START) return false
	const e = store.exampleSet
	if (!e) return true
	return active - (e.basedOn ?? 0) >= EXAMPLE_REBUILD_AFTER
}

/** 清除示例 (回到"只用提示词默认规则") */
export const clearMemoryExamples = (): void => {
	const store = load()
	if (!store.exampleSet) return
	store.exampleSet = undefined
	// 清除也是"本地的显式决定": 磁盘上那份还没更新的示例集不许在落盘合并时把它带回来 (T34-M6 实测踩到)
	examplesCleared = true
	persist()
}

/** 写库结果为 0 的常量 (诊断日志用; 单独定义避免每次拼一个新对象) */
const NO_WRITE = {added: 0, updated: 0, invalidated: 0, intra: 0, expired: 0, lowvalue: 0, revived: 0}

/** 诊断日志 (P1): 库状态快照 —— 「距 MAX_MEMORIES 上限还有多远」看这里的 total/active */
const diagLibSnapshot = (store: MemoryStoreData): {active: number; faded: number; invalid: number; total: number; blocks: number} => ({
	active: store.memories.filter(isActiveMemory).length,
	faded: store.memories.filter(m => !!m.fadedAt && !m.invalidAt).length,
	invalid: store.memories.filter(m => !!m.invalidAt).length,
	total: store.memories.length,
	blocks: (store.blocks ?? []).length,
})

/**
 * 检查是否需要生成摘要: 当未摘要消息数超过阈值时, 用传入的 LLM 回调压缩旧对话.
 *
 * 只摘要「上次摘要之后新增的区间」, 且单次最多 MAX_SUMMARIZE_BATCH 条,
 * 避免提示词随历史无限膨胀 / 重复压缩旧内容.
 *
 * 附带三件事:
 * - ⑩ 一次调用产出**摘要 + 记忆块** (P2 起为记忆的主生产通道): 摘要只存纯叙述, 记忆块
 *   (===MEM=== 后的 JSON) 转成条目入库并挂进一个块; JSON 解析失败则降级走原有
 *   「记忆要点」文本通道 (规则提取), 两条通道都空时把要点附在摘要尾部;
 * - ⑧ 历史总结超过 MAX_SUMMARIES 条时丢弃最旧的;
 * - ⑪ 历史被裁剪后游标自愈 (否则下次摘要可能永久不触发).
 *
 * @param messages 全部历史消息 (最新在最后)
 * @param summarizeCall (prompt) => Promise<string> 摘要文本
 * @returns 是否本次生成了摘要
 */
export const summarizeIfNeeded = async (
	messages: {role: string; content: string; ts?: number}[],
	summarizeCall: (prompt: string) => Promise<string>,
	/**
	 * 是否在同一次调用里产出**记忆块** (默认 true)。
	 * 传 false = 设置里关掉了「用 AI 提取与整理记忆」: 提示词退回文本式「记忆要点」,
	 * 条目只由免费的关键词规则通道提取 (与重构前"关掉 AI 仍靠规则记住"的契约一致)。
	 */
	withMemoryBlock = true,
	/**
	 * true = 手动「立即整理」(记忆库按钮): **不等**攒够 SUMMARIZE_THRESHOLD 条, 有多少整理多少。
	 * 自动整理仍按阈值走 (省调用); 手动入口是给"想马上固化"的用户用的。
	 */
	force = false,
): Promise<boolean> => {
	const store = load()
	const total = messages.length
	// 尚未摘要的起点 (累计已摘要 - 累计已裁剪, 并跳过开头的占位 system 条; 见 resumeIndex)
	const start = resumeIndex(store, messages)
	const pending = total - RAW_WINDOW - start
	if (pending <= 0) {
		// 无待压缩区间, 直接返回。
		// 【曾经的 bug】这里曾把游标"收回上限" `= min(游标, total - RAW_WINDOW)`。
		// 但裁剪是从**前面**删消息, 保留的都是**已摘要**的 —— 裁剪后 total 变小,
		// 这个上限也跟着变小, 于是把游标**往回缩**, 制造出"这些已摘要消息还没总结"
		// 的假象: 下一轮从极小值重新总结近端消息, 生成同一个区间 id 被去重, 游标
		// 每次只前进固定一点, 摘要器卡在同 20 条上无限打转, 新消息永不入库。
		// 正解是裁剪处主动调用 notifyHistoryTrimmed() 重算游标, 这里不再擅自改动。
		return false
	}
	if (!force && pending < SUMMARIZE_THRESHOLD) return false
	// 双实例游标同步 (即将总结前才读盘, 平时零开销): 若磁盘上另一实例的游标已
	// 前进到我们之后, 说明对方已总结过这些消息 → 合并后重新判定, 避免从旧位置
	// 重复总结同一区间、或游标倒退覆盖对方的进度.
	const diskRaw = readFile(FILE)
	const disk = tryParse(diskRaw)
	if (disk && disk.summarizedMsgCount > store.summarizedMsgCount) {
		adoptFromDisk(disk)
		return summarizeIfNeeded(messages, summarizeCall)
	}
	// 只取新增区间里最旧的 MAX_SUMMARIZE_BATCH 条 (按时间正序)
	const batch = Math.min(pending, MAX_SUMMARIZE_BATCH)
	const newer = messages.slice(start, start + batch)
	const prompt = buildSummaryPrompt(
		newer,
		withMemoryBlock,
		withMemoryBlock ? knownMemoryList(store) : [],
		withMemoryBlock ? store.exampleSet : null,
	)
	const content = (await summarizeCall(prompt)).trim()
	/* 诊断日志 (P1) 的公共字段: 提示词与原始输出 —— 开关关着时 recordOrganize 直接返回, 零开销 */
	const diagBase = {
		msgs: batch,
		startIndex: start,
		promptChars: prompt.length,
		prompt: prompt.slice(0, DIAG_PROMPT_MAX),
		rawChars: content.length,
		raw: content.slice(0, DIAG_RAW_MAX),
	}
	if (!content) {
		recordOrganize({...diagBase, topic: "", items: [], gated: [], deadLink: [], write: {...NO_WRITE},
			summaryChars: 0, blockId: null, lib: diagLibSnapshot(store), note: "模型返回空"})
		return false
	}
	// ⑩ 摘要/记忆块两段式解析 (P2): 摘要本体只存纯叙述 (注入上下文干净), 记忆块进结构化记忆
	const parsedBlock = parseBlockOutput(content)
	// 摘要优先: 哨兵后什么都没有也必须有摘要文本 (模型只答了一半时不能把摘要丢了)
	const {summaryText, keyFacts} = splitSummaryKeys(parsedBlock.summaryText || content)
	let storedText = summaryText
	// 条目来源: ① 记忆块 JSON (主通道) → ② 「记忆要点」文本 (降级通道, 兼容旧格式/模型不听话)
	const blockItems = parsedBlock.items
	// **写入门槛 (S2)**: 提示词之外的确定性兜底 —— 一次性事件/低重要度的"垃圾"不进长期记忆。
	// 它们不会被丢弃: 那段对话的摘要照旧写进历史总结 (叙事不丢), 只是不占长期记忆的位置。
	const worth = blockItems.filter(it => isWorthRemembering({type: it.type, importance: it.importance}))
	const gatedItems = blockItems.filter(it => !isWorthRemembering({type: it.type, importance: it.importance}))
	const gatedOut = gatedItems.length
	if (gatedOut > 0) console.log(`[mem] 写入门槛挡下 ${gatedOut} 条不重要内容 (只留在摘要里)`)
	const fresh: MemoryItem[] = []
	/** 被作废护栏挡下的内容 (诊断日志用: 模型又把被推翻的旧说法写回来了) */
	const deadLink: string[] = []
	if (worth.length) {
		for (const it of worth) {
			// 已作废的旧说法不再从旧对话里回流成活记忆 (见 matchesInvalidated)
			if (matchesInvalidated(store, it.content)) { deadLink.push(it.content); continue }
			// 显式要求记住的给 core 类型 ⇒ decayDays=null (永不衰减), 与规则通道的 explicit 同效
			fresh.push(makeMemoryItem({content: it.content, type: it.type, importance: it.importance}))
		}
	} else if (!blockItems.length && keyFacts.length) {
		for (const fact of keyFacts) {
			for (const it of extractMemories(fact)) {
				if (matchesInvalidated(store, it.content)) { deadLink.push(it.content); continue }
				fresh.push(it)
			}
		}
	}
	/* 诊断日志 (P1): 本次写入结果与"走了哪条通道" */
	let write = {...NO_WRITE}
	let diagBlockId: string | null = null
	let diagNote = ""
	if (!blockItems.length) diagNote = keyFacts.length ? "记忆块 JSON 未解析出来 → 记忆要点文本通道" : "记忆块 JSON 未解析出来且无要点"
	if (worth.length) {
		// 段内自相矛盾先按数组顺序定序作废 (模型没听话时的兜底, 见 invalidateIntraBatchReversals)
		const intra = invalidateIntraBatchReversals(fresh)
		// 主通道: 条目 + 块一起写 (块是本段对话的"组织方式", 条目仍是唯一事实来源)
		const block: MemoryBlock = {
			id: blockIdFor(newer, start),
			fromTs: newer[0]?.ts ?? 0,
			toTs: newer[newer.length - 1]?.ts ?? 0,
			msgCount: batch,
			topic: parsedBlock.topic,
			summary: storedText,
			createdAt: Date.now(),
			itemIds: [],
		}
		const wres = writeBlock(store, block, fresh)
		write = {added: wres.added, updated: wres.updated, invalidated: wres.invalidated, intra,
			expired: wres.expired, lowvalue: wres.lowvalue, revived: wres.revived}
		diagBlockId = block.id
		if (!fresh.length) {
			// 全被**作废护栏**挡下 (注意: 被写入门槛挡下的不算 —— 那些本就是"不值得记"的,
			// 不该再塞回摘要里添噪): 摘要尾部附上原要点, 信息不丢 (与文本通道同一兜底)
			storedText = `${summaryText}\n${worth.map(i => i.content).join("；")}`
			block.summary = storedText
			diagNote = "候选全被作废护栏挡下 → 要点附回摘要"
		} else {
			console.log(`[mem] 记忆块已写入 ${block.id}: ${worth.length} 条候选 → 新增 ${wres.added} / 升级 ${wres.updated} / 作废 ${wres.invalidated + intra}`)
		}
	} else if (fresh.length) {
		const mres = applyMerge(store, fresh)
		write = {added: mres.added, updated: mres.updated, invalidated: mres.invalidated, intra: 0,
			expired: mres.expired, lowvalue: mres.lowvalue, revived: mres.revived}
	} else if (keyFacts.length) {
		// 规则没接住任何要点 (或被作废护栏全挡下): 原文附在摘要尾部, 信息不丢
		storedText = `${summaryText}\n${keyFacts.join("；")}`
	}
	// 摘要 id 用**消息时间戳**区间指纹: 双实例对同一区间并发总结时产出相同 id,
	// 落盘合并按 id 去重只留一份。注意不能用下标 —— 自动裁剪会重排下标, 导致
	// 每轮算出同一个 id 而被去重丢掉 (见 summaryIdFor 注释)
	const newId = summaryIdFor(newer, start)
	// 区间重叠去重: 主界面与悬浮窗的消息列表可能差 1 (主界面裁剪后会插占位 system),
	// 于是同一段对话被算成 sum-2-26 与 sum-3-27 两条, id 不同去重不掉。
	// 这里按区间重叠判定, 命中就**用新的替换旧的**, 而不是并存两份。
	replaceOverlappingSummary(store, newId)
	store.summaries.push(makeSummary(storedText, batch, newId))
	// ⑧ 条数上限: 超出丢最旧的 (被裁的登记墓碑, 防落盘合并时复活)
	trimSummariesToMax()
	// 取 max: await 摘要期间另一实例的游标可能已随磁盘合并进来, 别倒退覆盖。
	// 累计口径 = 已裁剪条数 + 数组内下标 + 本批条数 (裁剪过的历史不在数组里, 必须加回来)
	store.summarizedMsgCount = Math.max(store.summarizedMsgCount, (store.trimmedMsgCount ?? 0) + start + batch)
	/* 诊断日志 (P1): 一条记录 = 一次整理的完整证据 (提示词/原始输出/解析/门槛挡了什么/写库结果/库状态) */
	recordOrganize({
		...diagBase,
		topic: parsedBlock.topic,
		items: blockItems.map(it => ({c: it.content, t: it.type, i: it.importance})),
		gated: gatedItems.map(it => ({c: it.content, t: it.type, i: it.importance})),
		deadLink,
		write,
		summaryChars: storedText.length,
		blockId: diagBlockId,
		lib: diagLibSnapshot(store),
		note: diagNote,
	})
	persist()
	return true
}
/**
 * 当前聊天数组里「下一个要摘要的消息」下标 (P5)。
 *
 * = 累计已摘要条数 - 累计已裁剪条数, 再夹到 `[0, total - RAW_WINDOW]`。
 * 裁剪会把已摘要的旧消息从数组里删掉, 所以"已摘要条数"必须减去"被删掉的条数"才是数组下标。
 * (旧实现是裁剪时把游标重置成保留条数, 等于把**没总结过的近端 20 条**标成已摘要 ⇒ 永久跳过。)
 *
 * 再跳过数组开头的**占位 system 条** (裁剪时插的"更早的对话已压缩"): 它不是真消息 ——
 * 让它占一个批次名额, 每批就会少总结一条真消息; 它还会成为区间指纹的一端, 使块的
 * fromTs 变成它的 ts (时间线显示成错乱的区间)。
 */
const resumeIndex = (store: MemoryStoreData, messages: readonly {role?: string}[]): number => {
	let i = Math.min(
		Math.max(0, (store.summarizedMsgCount ?? 0) - (store.trimmedMsgCount ?? 0)),
		Math.max(0, messages.length - RAW_WINDOW),
	)
	while (i < messages.length && messages[i]?.role === "system") i += 1
	return i
}

/**
 * 这次自动裁剪**最多**能安全删掉多少条 (P5)。
 *
 * 只允许删"已经进过摘要的那段前缀" —— 没被总结的消息一旦删掉就永远丢了 (实时通道默认关之后
 * 没有第二条路把它写进记忆)。返回 0 = 这次不该裁 (摘要失败/还没攒够可裁的内容)。
 */
export const safeTrimDrop = (total: number): number => {
	const store = load()
	const prefix = Math.max(0, (store.summarizedMsgCount ?? 0) - (store.trimmedMsgCount ?? 0))
	return Math.max(0, Math.min(prefix, Math.max(0, total - RAW_WINDOW)))
}

/**
 * 「待整理 N 条」进度 (P4, 记忆库顶部提示用)。
 *
 * 用户看到的语义: **还有多少句话没进长期记忆**。口径 = 已滑出近端原文窗口、但还没被总结的
 * 消息数 (pending); 它攒到 `threshold` 时会自动整理一次。近端窗口内的消息不算"待整理" ——
 * 那些话 nori 直接看得见 (在上下文里), 不需要先变成记忆。
 */
export const organizeProgress = (messages: readonly {role?: string}[]): {pending: number; threshold: number} => {
	const store = load()
	const start = resumeIndex(store, messages)
	return {pending: Math.max(0, messages.length - RAW_WINDOW - start), threshold: SUMMARIZE_THRESHOLD}
}

/**
 * 上下文里的**原文窗口** (P5, 空窗清零)。
 *
 * 旧行为是固定发"最后 20 条" (`slice(-20)`)。问题: 一条消息**掉出近端 20 条之后、被总结之前**
 * 既不在上下文里、也还没进记忆 —— 最长有 `SUMMARIZE_THRESHOLD-1 = 24` 条消息的空窗, 这期间
 * 指代类提问 ("那个游戏") 与情感连贯都会断, 而实时通道默认关之后没有别的东西兜它。
 *
 * 新行为: 发**最多 `RAW_WINDOW + MAX_SUMMARIZE_BATCH = 45` 条** —— 刚好覆盖"近端 20 条 +
 * 一整个待总结批次", 于是空窗归零 (滑出近端的都还在窗口里)。45 也是硬上限: 摘要连续失败时
 * 数组会一直涨, 有这个上限就不会让上下文无界膨胀。
 */
export const CONTEXT_RAW_MAX = RAW_WINDOW + MAX_SUMMARIZE_BATCH

/** 取本次要发进上下文的原文历史 (两个 WebView 入口共用同一规则) */
export const contextHistory = <T extends {role: string; content: string; error?: boolean}>(messages: T[]): T[] =>
	messages.filter(m => !m.error).slice(-CONTEXT_RAW_MAX)

/**
 * 「最近聊过」的块话题 (P5, 近况注入): 最近 1~2 个记忆块的主题, 一行。
 *
 * 为什么**只给主题、不给摘要**: 摘要已经由 summaryBlock() 按字符预算注入了 (最新的几条一定
 * 在里面), 再注入一遍是纯重复; 而"主题"是块结构独有的抓手 —— 指代类提问 (「那个游戏」)
 * 与情感连贯靠它接得上, 成本只有十几个字。
 */
export const recentTopicsBlock = (limit = 2): string => {
	const store = load()
	const topics = (store.blocks ?? [])
		.slice(-limit)
		.map(b => String(b.topic ?? "").trim())
		.filter(Boolean)
	if (!topics.length) return ""
	// 新的在前 (块按时间正序存, slice 拿到的是最新的几个)
	return `【最近聊过】${topics.reverse().join(" · ")}`
}

/**
 * 清空全部记忆与摘要
 */
export const clearMemory = (): void => {
	const old = cache
	if (old) {
		markDeleted(old.memories)
		markDeleted(old.summaries)
		// 块也登记墓碑: 否则另一实例的旧 cache 落盘时会把已清空的块带回来 (块视图"清空后还在")
		markDeleted(old.blocks ?? [])
	}
	// 清空时跳过落盘合并: 否则磁盘旧内容会被并回来, 等于没清
	skipDiskMerge = true
	cache = {
		...EMPTY_MEMORY_STORE,
		memories: [],
		summaries: [],
		summarizedMsgCount: 0,
		trimmedMsgCount: 0,
		// 墓碑保留: 被清掉的 id 不被另一实例的旧 cache 带回来
		tombstones: old?.tombstones ?? [],
		blocks: [],   // 新数组: 别与常量共享引用 (push 会污染 EMPTY_MEMORY_STORE)
		deletedBin: [],
	}
	persist()
}

/* ---------------- 记忆管理 (单条删除/固定) ---------------- */
const TAG_PIN = "pinned"

const isPinned = (m: MemoryItem): boolean => (m.tags ?? []).includes(TAG_PIN)

/**
 * 这条记忆是否"用户明确要求永久保留": 显式记住 / 核心。
 * 取消固定时必须保住它们的永久性 —— explicit 标签在 expireMemories 里并不被豁免
 * (那里只看 decayDays), 所以一旦 decayDays 被改回数字, 标签就救不回来了。
 */
const hasPermanentTag = (m: MemoryItem): boolean =>
	(m.tags ?? []).some(t => t === "explicit" || t === "core")

/**
 * 删除单条记忆（2026-09-28 改：**进回收站而不是直接消失**）。
 *
 * 之前只登记墓碑（id + 时间），内容当场就没了、**无法还原** —— 用户明确担心
 * 「误删掉之后模型一点都不记了」。现在条目带着 `deletedAt` 进 `deletedBin`：
 * 记忆库「已删除」区里可一键还原，确认不要了再「永久删除」。
 * 墓碑照旧登记（防止磁盘上的旧副本在落盘合并时把它带回生效列表）。
 */
export const deleteMemory = (id: string): boolean => {
	const store = load()
	const idx = store.memories.findIndex(m => m.id === id)
	if (idx < 0) return false
	const [item] = store.memories.splice(idx, 1)
	markDeleted([item])
	const bin = store.deletedBin ?? (store.deletedBin = [])
	bin.unshift({...item, deletedAt: Date.now()})
	// 上限: 超出丢最旧的 (那些才是真正"永久删除"掉的)
	if (bin.length > MAX_DELETED_BIN) {
		bin.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
		store.deletedBin = bin.slice(0, MAX_DELETED_BIN)
	}
	pruneBlockRefs(store)   // 顺带清掉块里的悬空引用 (不等下次载入)
	// 你把它删了 ⇒ 别再拿它当"该记"的例子 (示例集跟着你的取舍走, 见 stripFromExamples)
	stripFromExamples(store, item.content, false)
	persist()
	return true
}

/**
 * 固定/取消固定一条记忆: 固定 = 打 pinned 标签 + 永不衰减 (decayDays=null);
 * 取消固定 = 恢复该类型的默认衰减 —— 但**带 explicit/core 标签的除外**: 那是用户
 * 明确要求记住的内容, 取消"固定"只是取消置顶, 不该把它从永久降级为会过期。
 * 刷新 updatedAt 保证双实例落盘合并取最新。
 */
export const pinMemory = (id: string, pin: boolean): boolean => {
	const store = load()
	const m = store.memories.find(x => x.id === id)
	if (!m) return false
	store.memories = store.memories.map(x => {
		if (x.id !== id) return x
		const tags = new Set(x.tags ?? [])
		if (pin) tags.add(TAG_PIN)
		else tags.delete(TAG_PIN)
		// 取消固定: explicit/core 保持永久, 其余恢复类型默认衰减
		const decayDays = pin ? null : (hasPermanentTag(x) ? null : defaultDecayDays(x.type))
		return {
			...x,
			tags: [...tags],
			decayDays,
			updatedAt: Date.now(),
		}
	})
	persist()
	return true
}

/** 是否已固定 (供 UI 显示) */
export const isMemoryPinned = (id: string): boolean => {
	const store = load()
	const m = store.memories.find(x => x.id === id)
	return !!m && isPinned(m)
}

/* ---------------- 清空/清理前自动备份 + 撤销 (A2) ---------------- */
const BACKUP_FILE = "memory.before-clear.json"

/** 清空/清理前调用: 把当前库快照存到固定备份文件 (覆盖最近一次), 供"撤销"恢复 */
export const backupMemoryNow = (): boolean => {
	try {
		const store = load()
		if (!store.memories.length && !store.summaries.length) return false
		return writeFile(BACKUP_FILE, JSON.stringify(store))
	} catch {
		return false
	}
}

/** 是否有一份可恢复的备份 (供 UI 决定按钮态) */
export const hasMemoryBackup = (): boolean => {
	try {
		return !!tryParse(readFile(BACKUP_FILE))
	} catch {
		return false
	}
}

/** 撤销上一次清空/清理: 用固定备份整体替换当前库 */
export const restoreMemoryBackup = (): boolean => {
	try {
		const backup = tryParse(readFile(BACKUP_FILE))
		if (!backup) return false
		// 整体替换: 跳过落盘合并 (别把要恢复的旧内容又并掉), 清墓碑 (恢复即显式认可这些 id)
		skipDiskMerge = true
		deletedIds.clear()
		cache = backup
		// 备份可能是重构前存的 (没有 blocks 字段): 就地补结构, 让内存里的库与载入路径一致。
		// 传空 rawMain ⇒ 不写 v1 快照 (那份快照只对应 memory.json 的迁移, 不该被备份文件顶替)。
		migrateToBlocks(cache, "")
		pruneBlockRefs(cache)
		persist()
		return true
	} catch {
		return false
	}
}

/* ---------------- C3 目标陪伴 (陪着你的事, 隔几天自然问进展) ---------------- */
const TAG_GOAL = "goal"
/** 两次关心的最小间隔: 3 天 (设目标当天不打扰) */
const GOAL_CARE_INTERVAL_MS = 3 * 24 * 3600 * 1000
/** "目标收尾判定"的 LLM 超时 (ms): 超时就当没判出来 —— 宁可不删, 也不阻塞回复 */
const GOAL_DONE_TIMEOUT_MS = 4000

/** 全部目标 (新→旧)。作废的（已收尾/被纠正的）不再算目标。 */
export const listGoals = (): MemoryItem[] => {
	const store = load()
	return store.memories
		.filter(m => (m.tags ?? []).includes(TAG_GOAL) && isActiveMemory(m))
		.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
}

/** 记下一个目标 (type=project + goal 标签, 长期不衰减; 与已有项目记忆重叠时并入升级) */
export const addGoal = (text: string): boolean => {
	const content = text.trim().slice(0, 120)
	if (!content) return false
	const store = load()
	const item: MemoryItem = {
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
		decayDays: null,
	}
	applyMerge(store, [item])
	// 目标应当长期: 统一把 goal 条目设为永不衰减
	// (合并升级旧项目记忆时可能保留原 project 的 60 天衰减, 会把它又悄悄过期掉)
	// 注意: 目标与已有记忆重叠时, applyMerge 会并入旧条且保留旧 tags (不含 goal) ——
	// 按内容重叠把被吞的目标条找回来补打标签, 否则它从目标列表里悄悄消失
	const mergedAway = !store.memories.some(m => m.id === item.id)
	const goalNorm = normalizeContent(content)
	store.memories = store.memories.map(m => {
		const wasGoal = (m.tags ?? []).includes(TAG_GOAL)
		const mn = normalizeContent(m.content)
		const absorbed = !wasGoal && mergedAway && !!mn && !!goalNorm &&
			(mn === goalNorm || mn.includes(goalNorm) || goalNorm.includes(mn))
		if (!wasGoal && !absorbed) return m
		return {
			...m,
			tags: wasGoal ? m.tags : [...new Set([...(m.tags ?? []), TAG_GOAL])],
			decayDays: null,
			updatedAt: Date.now(), // 刷新: 双实例合并按 updatedAt 取新, 防旧副本把标签盖回去
		}
	})
	persist()
	return true
}

/** 删除一个目标 (同单条删除) */
export const removeGoal = (id: string): boolean => deleteMemory(id)

/**
 * 到点了吗: 存在超过 GOAL_CARE_INTERVAL_MS 没被关心的目标时返回一段"自然关心"注入文本,
 * 并刷新该记忆的 updatedAt (双实例合并按 updatedAt 取新 → 不会两边重复触发).
 * 未到期/无目标返回 "" (不打扰、不加 token).
 */
export const goalCarePrompt = (): string => {
	const store = load()
	const now = Date.now()
	const goals = store.memories.filter(m => (m.tags ?? []).includes(TAG_GOAL) && isActiveMemory(m))
	if (!goals.length) return ""
	// 挑最久没被关心的目标 (updatedAt/createdAt 最早)
	let oldest: MemoryItem | null = null
	let oldestT = Infinity
	for (const g of goals) {
		const t = Math.max(g.updatedAt ?? 0, g.createdAt ?? 0)
		if (t < oldestT) { oldestT = t; oldest = g }
	}
	if (!oldest || now - oldestT < GOAL_CARE_INTERVAL_MS) return ""
	// 标记已关心 (下次要再隔一个间隔)
	store.memories = store.memories.map(m =>
		m.id === oldest.id ? {...m, updatedAt: now} : m
	)
	persist()
	const days = Math.max(1, Math.round((now - oldestT) / 86400000))
	return `【自然地关心】主人有个目标「${oldest.content}」，已经 ${days} 天没问过进展了。可以在回复里自然地带一句问问进展，别说教，别每次都问。`
}

/* ---------------- 目标是否已完成 (LLM 判定, "陪着你的事"的收尾) ----------------
 *
 * 背景 (2026-09-27 用户要求): 目标只会被每 3 天问一次进展, 却**没有收尾** —— 做完了也没人摘掉,
 * 会一直被问下去。这里让 LLM 在回复后判断: 主人是否明确表示某个目标已完成/已放弃。
 *
 * 三条硬约束 (因为这个动作会**删用户数据**, 必须保守):
 *   ① 只在明确表达"做完了/不做了/没在弄了"时才删; 只是提到、或说"还在弄" → 一律不删;
 *   ② 必须给出上面列表里**真实存在的 id**, 编造 id 会被忽略 (解析层过滤);
 *   ③ 调用方只在"确实有目标"且 AI 开关可用时才调; 失败/超时/解析不出 → 什么都不删。
 */

/** 构造"目标收尾判定"提示词: 给出目标清单 + 最近对话, 要求只输出 JSON */
export const buildLlmGoalDonePrompt = (
	goals: {id: string; content: string}[],
	userText: string,
	recent: {role: string; content: string}[] = [],
): string => {
	const ctx = recent.length
		? recent.map(m => `${m.role === "user" ? "主人" : "Nori"}: ${String(m.content ?? "").replace(/\s+/g, " ").slice(0, 100)}`).join("\n")
		: "(无)"
	return [
		"你在维护「陪着你的事」这份目标清单。判断主人**刚刚这句话**是否表示某个目标已经收尾。",
		"",
		"【什么算收尾】(只有这两种)",
		"- 已完成: 明确说做完了/考完了/结束了/搞定了/达成等;",
		"- 已放弃: 明确说不做了/放弃了/不打算了/没必要了/算了不弄了等。",
		"",
		"【什么不算 **一律不要删**】",
		"- 只是提到、聊到、问进度 (如\"还在弄\"/\"快了\"/\"最近有点忙\");",
		"- 只是抱怨、情绪、玩笑、反问;",
		"- 含糊不清、你不确定 —— 不确定就**不要删**。",
		"",
		"【输出要求】",
		"- 只输出 JSON, 不要解释。格式: {\"done\":[{\"id\":\"目标id\",\"reason\":\"一句话依据\"}]};",
		"- 没有收尾的目标就输出 {\"done\":[]};",
		"- id 只能用下面清单里给出的, **不要编造**。",
		"",
		"【目标清单 (只能引用这些 id)】",
		goals.length ? goals.map(g => `${g.id} | ${g.content}`).join("\n") : "(无)",
		"",
		"【最近对话 (只用于理解指代)】",
		ctx,
		"",
		"【主人刚刚说】",
		userText,
	].join("\n")
}

/**
 * 解析"目标收尾"返回 (容错: 代码围栏/前后杂文/纯数组/字段名不同)。
 * 只保留 `validIds` 里真实存在的 id, 并去重 —— 防 LLM 编造 id 误删无关目标。
 */
export const parseLlmGoalDone = (raw: string, validIds: Set<string>): {id: string; reason: string}[] => {
	let text = String(raw ?? "").trim()
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
	if (fence) text = fence[1].trim()
	let arr: unknown = null
	const oStart = text.indexOf("{")
	const oEnd = text.lastIndexOf("}")
	if (oStart !== -1 && oEnd > oStart) {
		try {
			const obj = JSON.parse(text.slice(oStart, oEnd + 1)) as Record<string, unknown>
			const candidate = obj.done ?? obj.finished ?? obj.completed ?? obj.goals
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
	const out: {id: string; reason: string}[] = []
	const seen = new Set<string>()
	for (const item of arr) {
		// 允许元素是纯 id 字符串, 也允许 {id, reason}
		const id = typeof item === "string"
			? item.trim()
			: String((item as Record<string, unknown>)?.id ?? "").trim()
		if (!id || !validIds.has(id) || seen.has(id)) continue
		seen.add(id)
		const reason = typeof item === "string" ? "" : String((item as Record<string, unknown>)?.reason ?? "").slice(0, 60)
		out.push({id, reason})
	}
	return out
}

/**
 * 回复后判定"目标是否已收尾"并按需删除 (用户 2026-09-27 要求: 让 LLM 自己判断何时删掉目标)。
 *
 * 保守设计 (会删用户数据, 所以宁可漏判):
 *   - 没有目标 / 没给 llmCall → 直接返回, **零调用**;
 *   - LLM 失败、超时(4s)、输出解析不出 → 什么都不删;
 *   - 只删"提示词清单里真实存在的 id"(编造的 id 在 parseLlmGoalDone 里已被过滤);
 *   - 删除走 `removeGoal`(即 deleteMemory) → 会登记墓碑, 不会被双实例落盘合并复活。
 *
 * @param userText 主人刚才这句
 * @param llmCall  (prompt) => Promise<string>; null = 不判定
 * @param recent   最近对话 (仅供 LLM 理解指代)
 * @returns 被删掉的目标内容 (供气泡提示; 空数组 = 没删)
 */
export const pruneDoneGoals = async (
	userText: string,
	llmCall: ((prompt: string) => Promise<string>) | null,
	recent: {role: string; content: string}[] = [],
): Promise<string[]> => {
	if (!llmCall) return []
	const goals = listGoals()
	if (!goals.length) return []
	let raw = ""
	try {
		raw = await withTimeout(
			llmCall(buildLlmGoalDonePrompt(goals.map(g => ({id: g.id, content: g.content})), userText, recent)),
			GOAL_DONE_TIMEOUT_MS,
		)
	} catch {
		return []   // 超时/失败: 不删
	}
	const valid = new Set(goals.map(g => g.id))
	const hits = parseLlmGoalDone(raw, valid)
	if (!hits.length) return []
	const removed: string[] = []
	for (const h of hits) {
		const g = goals.find(x => x.id === h.id)
		if (!g) continue
		if (removeGoal(h.id)) removed.push(g.content)
	}
	return removed
}

/**
 * 裁剪历史后**登记被裁掉的条数**。每次自动裁剪后必须调用一次 (P5 改语义, 见下)。
 *
 * 旧语义是"把游标重置成保留条数", 注释里写"保留的每条都已经摘要过" —— **这句是错的**:
 * 裁剪保留的正是**最近的 20 条原文**, 它们是数组里最没被总结过的一批。重置之后
 * `summarizedMsgCount` 把它们标成已摘要, 下一次总结就从第 21 条往后取, 那 20 条被永久跳过,
 * 最终被下一次裁剪无声删掉。实测复现: `tmp-memcheck/probe-trim-skip.mjs`
 * (覆盖区间 0~24 → 45~69, 中间的 25~44 一条都没进摘要)。
 *
 * 新语义: 两个计数都**只增不减**, 游标在数组里的实际下标由两者相减得出
 * (见 summaryStartIndex / trimmedMsgCount 注释)。这样双实例落盘合并取 max 依旧安全,
 * 裁剪也不会再让任何消息被跳过。
 *
 * @param droppedCount 本次裁剪**删掉**的消息条数 (含被删掉的占位 system 消息)
 */
export const notifyHistoryTrimmed = (droppedCount: number): void => {
	const store = load()
	const n = Math.max(0, Math.floor(droppedCount) || 0)
	if (!n) return
	store.trimmedMsgCount = (store.trimmedMsgCount ?? 0) + n
	persist()
}

/**
 * 仅供测试: 暴露"改口"判据本体 (偏好族 ∪ 意愿族)。
 * 为什么要暴露: 这条判据会**自动作废**用户数据, 必须能用一张大表把**正例与反例**都钉住
 * (反例比正例更重要 —— 误作废 = 用户看到记忆莫名进了历史)。见 run-tests 的 T30。
 */
export const __isReversalForTest = (oldContent: string, newContent: string): boolean =>
	isReversal(oldContent, newContent)

/** 直接读写摘要游标 (仅供测试: 用于模拟双实例游标错位) */export const __getSummaryCursorForTest = (): number => load().summarizedMsgCount
export const __setSummaryCursorForTest = (n: number): void => {
	load().summarizedMsgCount = Math.max(0, Math.floor(n) || 0)
}

/**
 * 重新从磁盘加载记忆库: 悬浮窗等另一实例可能已写入新记忆, 而本实例的 cache
 * 是启动时加载的旧快照. 打开记忆页面/设置前调用, 让另一窗口记的内容可见.
 */
export const reloadMemory = (): void => {
	cache = null
	load()
}

export type {MemoryItem, MemorySummary, MemoryBlock} from "./core"
export type {MemoryType} from "./core"
