import {computed, onBeforeUnmount, onMounted, reactive, ref, type Ref, type UnwrapNestedRefs} from "vue"
import {sendChat, writeFile, type ChatMsg} from "../services/chat"
import {listDiary} from "../services/nori-diary"
import {
	listAll, listInvalidMemories, listFadedMemories, listDeletedMemories,
	listBlocks, listUnblockedMemories, organizeProgress, listGoals,
	hasMemoryBackup, restoreMemoryBackup, backupMemoryNow,
	restoreFadedMemory, fadeMemoryManually, restoreDeletedMemory, deleteMemoryForever,
	restoreMemory, deleteMemory, pinMemory, addGoal, removeGoal,
	getMemoryExamples, rebuildMemoryExamples, clearMemoryExamples, shouldRebuildMemoryExamples,
	diagCount, injectCount, memoryHealth, buildInjectJsonl, buildDiagJsonl,
	setDiagEnabled, clearDiag, clearInjects, summarizeIfNeeded,
	clearMemory, pruneStalePreview, pruneStaleMemories, flushMemoryPersist, reloadMemory,
	type MemoryItem, type MemorySummary, type MemoryBlockView, type MemoryType,
	type MemoryBlock, type MemoryHealth,
} from "../services/memory"

export interface MemoryPanelConfig {
	baseUrl: string
	apiKey: string
	model: string
	memoryLlmExtract: boolean
	memoryAutoTuneExamples: boolean
	memoryDiagnostics: boolean
}
export interface MemoryPanelOptions {
	cfg: MemoryPanelConfig
	messages: Ref<ChatMsg[]>
	persistSettings: () => string
	notify: (message: string, ms?: number) => void
}

export const useMemoryPanel = (options: MemoryPanelOptions) => {
	const {cfg, messages, persistSettings, notify: triggerBubble} = options
	const memView = reactive<{memories: MemoryItem[]; summaries: MemorySummary[]}>(listAll())

	/**
	 * 记忆块视图数据 (P4): 块 + 解析出的条目。**浏览态**按块排时间线, 块内再按类型分小节。
	 * 刷新与 memView 同步 (见 refreshMemView)。
	 */
	const memBlocks = ref<MemoryBlockView[]>([])
	/** 没挂进任何块的条目 (实时通道写的 / 存量去重后被合并掉的 / 早期数据) */
	const memUnblocked = ref<MemoryItem[]>([])
	/** 「待整理 N 条」: {pending, threshold}; pending 攒到 threshold 会自动整理 */
	const memPending = ref(organizeProgress([]))

	const TYPE_LABELS: Record<string, string> = {
		fact: "事实",
		preference: "偏好",
		project: "项目",
		event: "事件",
		relationship: "关系",
		core: "核心",
	}

	const typeLabel = (t: string): string => TYPE_LABELS[t] ?? t

	const summaryLabel = (s: MemorySummary): string =>
		`${new Date(s.createdAt).toLocaleString()} · 覆盖 ${s.msgCount} 条消息`

	const refreshMemView = () => {
		const data = listAll()
		memView.memories = data.memories
		memView.summaries = data.summaries
		invalidMems.value = listInvalidMemories()
		fadedMems.value = listFadedMemories()
		deletedMems.value = listDeletedMemories()
		tuneSet.value = getMemoryExamples()
		goals.value = listGoals()
		hasBackup.value = hasMemoryBackup()
		memBlocks.value = listBlocks()
		memUnblocked.value = listUnblockedMemories()
		memPending.value = organizeProgress(messages.value)
		diagN.value = diagCount()
		// A3: 注入记录条数 + 记忆健康快照 (健康计数不依赖诊断开关, 所以一直都刷新)
		injectN.value = injectCount()
		health.value = memoryHealth()
	}

	/* ---------------- 记忆管理 (固定/删除) + 撤销清理 + 目标陪伴 + 导出 (A2/A3/C3/C4) ---------------- */
	const goals = ref<MemoryItem[]>(listGoals())
	const goalDraft = ref("")
	const hasBackup = ref(hasMemoryBackup())

	/**
	 * 已作废的记忆 (被改口/纠正取代的那些, B1): 默认折叠在「已作废」里 —— 不注入、不参与召回,
	 * 但留在库里, 用户点「还原」就能救回来 (误判的代价从"永久丢"降到"点一下")。
	 */
	const invalidMems = ref<MemoryItem[]>(listInvalidMemories())

	/** 已收起 (2026-09-28): 到期/太久没提被自动收起的条目; 与「作废」的区别是**没有被推翻** */
	const fadedMems = ref<MemoryItem[]>(listFadedMemories())
	/** 已删除 (2026-09-28, 回收站): 手删的条目(带内容), 可还原; 最多留 20 条 */
	const deletedMems = ref<MemoryItem[]>(listDeletedMemories())

	/** 记忆诊断日志 (P1): 内存里已经攒了多少次整理的证据 (开关关着时恒为 0) */
	const diagN = ref<number>(diagCount())

	/* ---------------- A3 (2026-10-08): 注入可见性 + 记忆健康 ---------------- */

	/** 已记录多少次**注入**（与整理记录分开记；开关关着时恒为 0） */
	const injectN = ref<number>(injectCount())
	/** 记忆健康快照：生效/已收起/已作废、上次成功整理、本次运行最后一次整理的结果、上轮注入明细 */
	const health = ref<MemoryHealth>(memoryHealth())
	const onMemoryPersist = (): void => { health.value = memoryHealth() }
	onMounted(() => window.addEventListener("nori-memory-persist", onMemoryPersist))
	onBeforeUnmount(() => window.removeEventListener("nori-memory-persist", onMemoryPersist))

	/** 时刻→人话 (诊断区共用; 没有记录时给一个明确的占位而不是空白) */
	const fmtWhen = (t: number | null | undefined): string =>
		t ? new Date(t).toLocaleString() : "—"

	/** 「上一轮注入」的一行摘要：来源 + 条数 + 时间 */
	const injectSummary = computed(() => {
		const r = health.value.lastInject
		if (!r) return injectN.value ? "（已记录，但最近一次已滚出环形缓冲）" : "还没有注入记录"
		const src: Record<string, string> = {
			"keyword": "关键词",
			"keyword-kw": "关键词·别名兜底",
			"smart-llm": "AI 语义召回",
			"smart-fallback": "AI 失败 → 关键词降级",
			"opening": "开场注入",
		}
		return `${src[r.source] ?? r.source} · 注入 ${r.hits.length}/${r.limit} 条 · 库里生效 ${r.considered} 条 · 过门槛 ${r.matched} 条 · ${new Date(r.ts).toLocaleTimeString()}`
	})

	/** 导出注入记录 (与整理诊断分开一个文件: mem-inject-*.jsonl) */
	const doExportInject = () => {
		if (!injectN.value) { triggerBubble("还没有注入记录 —— 先打开上面的开关，再聊一句"); return }
		const text = buildInjectJsonl({model: cfg.model, app: "NoriDroid"})
		const d = new Date()
		const p2 = (n: number) => String(n).padStart(2, "0")
		const name = `mem-inject-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.jsonl`
		try {
			const ok = writeFile(name, text)
			triggerBubble(ok ? `已导出 ${name}（${injectN.value} 条）` : "导出失败")
		} catch {
			triggerBubble("导出失败")
		}
	}

	/** 收起原因的人话 (只在这一处拼, 免得散落) */
	const fadeReasonLabel = (m: MemoryItem): string => {
		if (m.fadedReason === "lowvalue") return "太久没提、不太重要"
		if (m.fadedReason === "manual") return "你手动收起的"
		return "到期了（很久没提）"
	}

	/** 把一条被收起的记忆放回生效 */
	const doRestoreFaded = (m: MemoryItem) => {
		if (!restoreFadedMemory(m.id)) { triggerBubble("这条已经放回去了"); return }
		refreshMemView()
		triggerBubble("已经放回生效啦")
	}

	/** 从回收站还原一条被删的记忆 */
	const doRestoreDeleted = (m: MemoryItem) => {
		if (!restoreDeletedMemory(m.id)) { triggerBubble("这条已经不在回收站里了"); return }
		refreshMemView()
		triggerBubble(m.invalidAt ? "已还原到已作废，需另行还原才会生效" : m.fadedAt ? "已还原到已收起，点留下才会生效" : "已还原到生效列表")
	}

	/** 记忆优化 (整理优化) 的界面状态: 当前示例集 + 是否展开查看 */
	const tuneShow = ref(false)
	const tuneSet = ref<{builtAt: number; basedOn: number; pos: string[]; neg: string[]} | null>(null)
	const tuneHas = computed(() => !!tuneSet.value && (tuneSet.value.pos.length > 0 || tuneSet.value.neg.length > 0))
	const tunePos = computed(() => tuneSet.value?.pos ?? [])
	const tuneNeg = computed(() => tuneSet.value?.neg ?? [])
	const tuneInfo = computed(() => {
		const e = tuneSet.value
		if (!e || (!e.pos.length && !e.neg.length)) return "还没有示例。例子来自生效中的记忆；删除和收起不会自动当反例。点「立即优化」生成"
		return `上次优化：${fmtTs(e.builtAt)} · 正例 ${e.pos.length} 条 / 反例 ${e.neg.length} 条（基于当时 ${e.basedOn} 条记忆）`
	})

	/** 「立即优化」: 首次给一次提醒 —— 例子是从"你留下的记忆"里学的, 没用的先删掉 */
	const doRebuildExamples = () => {
		if (!tuneHas.value) {
			const ok = window.confirm(
				"例子是从你**留下的**记忆里学的，没用的先删掉更好 ——\n" +
				"删除可能是重复、过时或隐私原因，不会自动当反例；先检查生效记忆是否准确。\n\n" +
				"确定现在就生成示例吗？（先取消，去把没用的记忆删掉也行）",
			)
			if (!ok) { triggerBubble("那我等你整理好啦"); return }
		}
		const built = rebuildMemoryExamples()
		refreshMemView()
		triggerBubble(built ? "示例已更新，我照你的口味来记" : "记忆还太少，先不生成示例")
	}

	const doClearExamples = () => {
		clearMemoryExamples()
		refreshMemView()
		triggerBubble("示例已清除，回到默认规则")
	}

	/** 自动优化: 每次整理成功后检查一次 (新增 ≥20 条才重建, 零额外调用) */
	const maybeAutoTuneExamples = () => {
		if (!cfg.memoryAutoTuneExamples) return
		if (!shouldRebuildMemoryExamples()) return
		if (rebuildMemoryExamples()) refreshMemView()
	}

	/* ---------------- 记忆诊断日志 (P1, 2026-09-30) ---------------- */

	/** 开关: 立刻同步给记忆模块 (关掉后不再记录, 已记录的不清 —— 用户可能正要导出) */
	const onDiagToggle = () => {
		setDiagEnabled(!!cfg.memoryDiagnostics)
		persistSettings()   // 立刻落盘: 否则重启 App 会回到关闭, 悬浮窗也读不到这个开关
		diagN.value = diagCount()
		injectN.value = injectCount()
		health.value = memoryHealth()
		triggerBubble(cfg.memoryDiagnostics ? "开始记录整理与注入过程，导出在同一次里做哦" : "已停止记录（已有的记录还在，可以导出）")
	}

	/** 导出: 走与「导出」同一条 writeFile 通道 (落到 Download/NoriDroid/) */
	const doExportDiag = () => {
		if (!diagN.value) { triggerBubble("还没有记录 —— 先打开上面的开关"); return }
		const text = buildDiagJsonl({model: cfg.model, app: "NoriDroid"})
		const d = new Date()
		const name = `mem-diag-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}.jsonl`
		try {
			const ok = writeFile(name, text)
			triggerBubble(ok ? `已导出 ${name}（${diagN.value} 条记录）` : "导出失败")
		} catch {
			triggerBubble("导出失败")
		}
	}

	const doClearDiag = () => {
		clearDiag()
		// A3: 注入记录也在同一个开关下攒着, 一并清掉 (否则"清空记录"看起来没生效)
		clearInjects()
		diagN.value = diagCount()
		injectN.value = injectCount()
		health.value = memoryHealth()
		triggerBubble("整理与注入记录都已清空")
	}

	/** 永久删除 (从回收站抹掉): 这是**唯一不可逆**的操作, 所以要二次确认 */const doDeleteForever = (m: MemoryItem) => {
		if (!window.confirm(`永久删除这条记忆？删了就找不回来了。\n「${m.content}」`)) return
		deleteMemoryForever(m.id)
		refreshMemView()
		triggerBubble("已永久删除")
	}

	/** 还原一条被作废的记忆 (B1) */
	const doRestoreInvalid = (m: MemoryItem) => {
		if (!restoreMemory(m.id)) { triggerBubble("这条已经还原过了"); return }
		refreshMemView()
		triggerBubble("已还原，我又记起来啦")
	}

	/** 长期记忆展示列表: 排除目标条目 (目标有专门的"陪着你的事"小节, 避免两处重复) */
	const nonGoalMemories = computed(() =>
		memView.memories.filter(m => !(m.tags ?? []).includes("goal"))
	)

	/** 记忆库页 (独立页): 搜索 + 类型筛选 */
	const memSearch = ref("")
	const memFilter = ref("") // "" | 类型 | goal | pinned
	const filteredMems = computed(() => {
		// 目标条默认**不在长期记忆里重复出现** —— 它们上面已有「陪着你的事」小节,
		// 两处都列一遍正是用户说的"混在一起"。但显式筛选「目标」或在搜索时照常参与,
		// 否则搜不到目标内容 (搜"雅思"必须能找到「考雅思 7 分」)。
		const q0 = memSearch.value.trim().toLowerCase()
		let list = (memFilter.value === "goal" || q0) ? memView.memories : nonGoalMemories.value
		if (memFilter.value === "goal") list = list.filter(m => (m.tags ?? []).includes("goal"))
		else if (memFilter.value === "pinned") list = list.filter(m => (m.tags ?? []).includes("pinned"))
		else if (memFilter.value) list = list.filter(m => m.type === memFilter.value)
		if (q0) list = list.filter(m => m.content.toLowerCase().includes(q0))
		return list
	})

	/** 来源标注说明处理方式；旧记录来源不完整，不能直接称为用户声明。 */
	const isInferred = (m: MemoryItem): boolean => m.sourceKind === "llm" || (m.tags ?? []).includes("llm")
	const memProvenance = (m: MemoryItem): string => (isInferred(m) ? "AI 整理" : m.sourceKind === "rule" ? "原话提取" : "旧记录/手动")
	const PROV_TIP = "原话提取 = 规则命中；AI 整理 = 模型从对话筛出，需要核对；旧记录的来源可能不完整"

	/** 类型在记忆库里的展示顺序 (分组小节的先后; 目标单独一节, 不在此列) */
	const TYPE_ORDER: MemoryType[] = ["core", "fact", "preference", "project", "event", "relationship"]

	/**
	 * 按类型分组的长期记忆 (用户 2026-09-27 要求: "同类型标签分类到一块, 现在都混在一起")。
	 * 组内保持传入顺序 (重要度优先 → 新旧), 组间按 TYPE_ORDER, 空组不显示。
	 * P4 起抽成函数: 块视图的每一块内部也用它 (块内按类型分小节)。
	 */
	const groupByType = (items: MemoryItem[]): {type: string; label: string; items: MemoryItem[]}[] => {
		const buckets = new Map<string, MemoryItem[]>()
		for (const m of items) {
			const list = buckets.get(m.type)
			if (list) list.push(m)
			else buckets.set(m.type, [m])
		}
		const out: {type: string; label: string; items: MemoryItem[]}[] = []
		for (const t of [...TYPE_ORDER, ...[...buckets.keys()].filter(k => !TYPE_ORDER.includes(k as MemoryType))]) {
			const items = buckets.get(t)
			if (items?.length) out.push({type: t, label: typeLabel(t), items})
		}
		return out
	}

	/** 搜索/筛选态的平铺分组 (找东西的场景: 不按时间线, 直接按类型列出来) */
	const groupedMems = computed(() => groupByType(filteredMems.value))

	/** 块视图可展示的条目: 生效中 且 不是目标 (目标有自己那一节) */
	const blockVisible = (m: MemoryItem): boolean =>
		!m.invalidAt && !m.fadedAt && !(m.tags ?? []).includes("goal")

	/** 块标题: 「主题 · 时间段 · N 条」; 迁移块 (早期记忆) 没有主题与区间时只显示主题 */
	const blockTitle = (b: MemoryBlock): string => {
		const topic = b.topic || "未命名"
		if (!b.msgCount) return topic   // 迁移块: 没有"覆盖了多少条消息"这回事
		const from = fmtTs(b.fromTs)
		const to = fmtTs(b.toTs)
		// 同一分钟内只写一个时间: 25 条消息可能只跨几十秒, 否则会显示成「22:25 ~ 22:25」(实测截图里就是这样)
		const range = from === to ? from : `${from} ~ ${to}`
		return `${topic} · ${range} · ${b.msgCount} 条对话`
	}

	/**
	 * 记忆库的**渲染计划** (P4): 一处算完, 模板只做两层循环, 不必为块/平铺/未归类各写一遍行标记。
	 * - 浏览态: 每个记忆块一节 (块内按类型分小节) + 「未归类」一节;
	 * - 搜索/筛选态: 退回"按类型平铺" (找东西时时间线反而是干扰)。
	 */
	const memSections = computed<{key: string; title: string; subs: {key: string; label: string; items: MemoryItem[]}[]}[]>(() => {
		const toSubs = (items: MemoryItem[]) =>
			groupByType(items).map(g => ({key: g.type, label: g.label, items: g.items}))
		if (memSearch.value || memFilter.value) {
			const subs = toSubs(filteredMems.value)
			return subs.length ? [{key: "flat", title: "", subs}] : []
		}
		const out: {key: string; title: string; subs: {key: string; label: string; items: MemoryItem[]}[]}[] = []
		for (const v of memBlocks.value) {
			const subs = toSubs(v.items.filter(blockVisible))
			if (subs.length) out.push({key: v.block.id, title: blockTitle(v.block), subs})
		}
		const unblocked = toSubs(memUnblocked.value.filter(blockVisible))
		if (unblocked.length) out.push({key: "unblocked", title: "未归类", subs: unblocked})
		return out
	})

	/** 「立即整理」: 不等攒够阈值, 现在就把待整理的消息总结成摘要 + 记忆块 (同一条链路) */
	const memOrganizing = ref(false)
	/**
	 * 「立即整理」的反馈 (A: 就地反馈)。
	 * 为什么不复用下面那个 `memPruneMsg`: 那个提示渲染在面板**最底部**(与清理/撤销按钮同一行),
	 * 而"立即整理"按钮在面板上部 —— 用户点完视线不往下走, 实测体感就是"点了没反应"
	 * (探针 probe-organize-button.mjs 量到反馈在 776/808 ≈ 96% 处)。所以这里单独一份状态, 就地显示。
	 */
	const memOrgMsg = ref("")
	const memOrgMsgOk = ref(false)
	/** 有没有东西可整理 (B: 没有就把按钮置灰, 别让它"可点但无事发生") */
	const canOrganize = computed(() => memPending.value.pending > 0)
	const doOrganizeNow = async () => {
		if (memOrganizing.value || !canOrganize.value) return
		memOrganizing.value = true
		memOrgMsg.value = ""
		try {
			const summarized = await summarizeIfNeeded(messages.value, async (prompt) => {
				const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
					{role: "system", content: prompt} as ChatMsg,
				])
				return r.ok ? (r.content ?? "") : ""
			}, !!cfg.memoryLlmExtract, true)
			maybeAutoTuneExamples()   // 自动优化 (开关打开时): 新增够 20 条就顺手刷新示例
			refreshMemView()
			const left = memPending.value.pending
			if (summarized) {
				memOrgMsg.value = left > 0
					? `已整理一批，还剩 ${left} 条待整理（再点一次可继续）`
					: "已经整理完啦，刚才聊的我都记住了"
				memOrgMsgOk.value = true
			} else {
				// 走到这里有两种: 模型没回内容 (有可整理的东西但失败了) / 整理期间待整理被清空
				memOrgMsg.value = left > 0
					? "这次没能整理出来（模型没回内容），稍后再试"
					: "没有待整理的内容 —— 最近的话都还在我眼前，不用整理"
				memOrgMsgOk.value = false
			}
		} catch (e) {
			console.error("[mem] 立即整理失败:", e)
			memOrgMsg.value = "整理失败，稍后再试"
			memOrgMsgOk.value = false
		} finally {
			memOrganizing.value = false
		}
	}

	const isPinnedId = (id: string): boolean => {
		const m = memView.memories.find(x => x.id === id)
		return !!(m && (m.tags ?? []).includes("pinned"))
	}

	const doTogglePin = (m: MemoryItem) => {
		pinMemory(m.id, !isPinnedId(m.id))
		refreshMemView()
		triggerBubble(isPinnedId(m.id) ? "已固定，这条不会淡忘" : "已取消固定")
	}

	/**
	 * 「收起」一条记忆 (2026-09-29 用户要求: 条目行原来只有删除)。
	 * 意图 = "这条现在不重要，但别删" ⇒ 进「已收起」，点「留下」放回。
	 */
	const doFadeMemory = (m: MemoryItem) => {
		if (!fadeMemoryManually(m.id)) { triggerBubble("这条已经收起来了"); return }
		refreshMemView()
		triggerBubble("已收起，随时能在「已收起」里点「留下」放回来")
	}

	const doDeleteMemory = (m: MemoryItem) => {
		if (!window.confirm(`删除这条记忆？\n「${m.content}」\n（会先进「已删除」，能还原；想不删只是暂时不重要，可以用「收起」）`)) return
		deleteMemory(m.id)
		refreshMemView()
		triggerBubble("已删除，可在「已删除」里还原")
	}

	/** 撤销上次清空/清理 (用 before-clear 快照整体还原) */
	const doRestoreMemory = () => {
		if (!hasMemoryBackup()) { triggerBubble("没有可恢复的备份"); return }
		if (!window.confirm("用最近一次清理前的记忆覆盖当前内容？")) return
		restoreMemoryBackup()
		refreshMemView()
		triggerBubble("已恢复清理前的记忆")
	}

	const doAddGoal = () => {
		const t = goalDraft.value.trim()
		if (!t) return
		addGoal(t)
		goalDraft.value = ""
		refreshMemView()
		triggerBubble("好，我会陪你盯着这件事的")
	}

	const doRemoveGoal = (id: string) => {
		removeGoal(id)
		refreshMemView()
	}

	/* ---------------- 导出 (C4): 记忆+总结+日记 → Markdown 文件 ---------------- */
	const pad2 = (n: number): string => `${n}`.padStart(2, "0")
	const localDay = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
	const fmtTs = (ts: number): string => {
		const d = new Date(ts)
		return `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
	}

	const buildExportMd = (withDiary: boolean): string => {
		const lines: string[] = []
		lines.push("# DeepEr 数据导出", `导出时间：${new Date().toLocaleString()}`, "")
		const data = listAll()
		// 目标单独一段 (它们不在"长期记忆"里重复出现, 见记忆库的分节逻辑)
		const goalList = listGoals()
		if (goalList.length) {
			lines.push(`## 陪着你的事（目标，${goalList.length} 条）`)
			for (const g of goalList) lines.push(`- ${g.content} · ${fmtTs(g.createdAt)}`)
			lines.push("")
		}
		lines.push(`## 长期记忆（${data.memories.length} 条）`)
		for (const m of data.memories) {
			const pin = (m.tags ?? []).includes("pinned") ? "（已固定）" : ""
			lines.push(`- [${typeLabel(m.type)}·${memProvenance(m)}] ${m.content}${pin} · ${fmtTs(m.createdAt)} · 重要性 ${m.importance}`)
		}
		// 记忆块时间线 (2026-09-29 补): 让人能看出"哪段时间聊了什么", 也是块的成员关系凭证
		const blocks = listBlocks()
		if (blocks.length) {
			lines.push("", `## 记忆块时间线（${blocks.length} 段）`)
			for (const b of blocks) {
				const range = b.block.msgCount
					? `${fmtTs(b.block.fromTs)} ~ ${fmtTs(b.block.toTs)} · ${b.block.msgCount} 条对话`
					: "早期记忆（迁移前的存量）"
				lines.push(`- ${b.block.topic || "未命名"} · ${range} · ${b.items.filter(i => !i.invalidAt && !i.fadedAt).length} 条生效`)
			}
		}
		// 未归类 (没挂进任何块的条目)
		const unblocked = listUnblockedMemories()
		if (unblocked.length) {
			lines.push("", `## 未归类（${unblocked.length} 条 · 没挂进任何记忆块）`)
			for (const m of unblocked) lines.push(`- [${typeLabel(m.type)}] ${m.content} · ${fmtTs(m.createdAt)}`)
		}
		// 已作废的记忆 (B1): 导出要带上"历史" —— 用户可能靠它复盘 she 是什么时候改口的
		const invalid = listInvalidMemories()
		if (invalid.length) {
			lines.push("", `## 已作废的记忆（${invalid.length} 条 · 已被后来说的话取代，Nori 不再使用）`)
			for (const m of invalid) {
				lines.push(`- [${typeLabel(m.type)}·${memProvenance(m)}] ${m.content} · 记于 ${fmtTs(m.createdAt)} · 作废于 ${fmtTs(m.invalidAt ?? 0)}`)
			}
		}
		// 已收起 / 回收站 (2026-09-29 补): 导出要能当"全量备份"用 —— 从新包退回旧包前,
		// 这两块在旧包里是看不见的 (旧代码不认 fadedAt/deletedBin), 导出是唯一的取回渠道
		const faded = listFadedMemories()
		if (faded.length) {
			lines.push("", `## 已收起的记忆（${faded.length} 条 · 太久没提或到期自动收起，可在记忆库点「留下」放回）`)
			for (const m of faded) {
				lines.push(`- [${typeLabel(m.type)}] ${m.content} · ${fadeReasonLabel(m)} · 收起于 ${fmtTs(m.fadedAt ?? 0)}`)
			}
		}
		const deleted = listDeletedMemories()
		if (deleted.length) {
			lines.push("", `## 已删除（回收站，${deleted.length} 条 · 可在记忆库点「还原」取回；「永久删除」后不再出现）`)
			for (const m of deleted) {
				lines.push(`- [${typeLabel(m.type)}] ${m.content} · 删除于 ${fmtTs(m.deletedAt ?? 0)}`)
			}
		}
		// 记忆优化示例集 (整理优化): 导出带上, 换机/排查时能看出"她现在照什么口味记"
		const ex = getMemoryExamples()
		if (ex && (ex.pos.length || ex.neg.length)) {
			lines.push("", `## 记忆优化示例（生成于 ${fmtTs(ex.builtAt)} · 基于当时 ${ex.basedOn} 条记忆）`)
			if (ex.pos.length) lines.push(`- 该记：${ex.pos.join(" / ")}`)
			if (ex.neg.length) lines.push(`- 不该记：${ex.neg.join(" / ")}`)
		}
		lines.push("", `## 历史总结（${data.summaries.length} 条）`)
		for (const s of data.summaries) {
			lines.push(`- ${fmtTs(s.createdAt)}：${s.content}`)
		}
		if (withDiary) {
			const diary = listDiary()
			lines.push("", `## Nori 的日记（${diary.length} 篇）`)
			for (const e of diary) {
				lines.push(`### ${e.date} · ${e.mood}`, e.content, "")
			}
		}
		return lines.join("\n")
	}

	const exportFileName = (): string =>
		`deeper-export-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.md`

	const doExportAll = () => {
		try {
			const name = exportFileName()
			const ok = writeFile(name, buildExportMd(true))
			triggerBubble(ok ? `已导出 ${name}` : "导出失败")
		} catch {
			triggerBubble("导出失败")
		}
	}

	const doClearMemory = () => {
		if (!window.confirm("确定清空全部长期记忆和历史摘要吗？")) return
		// 清空前自动备份 → 可"撤销上次清理"一键还原
		backupMemoryNow()
		clearMemory()
		refreshMemView()
		triggerBubble("已清空记忆")
	}

	const memPruneMsg = ref("")
	const memPruneMsgOk = ref(false)

	const doPruneMemories = () => {
		// 只在该次清理真会删东西时才备份 —— 无效清理若覆盖备份,
		// 会把"清空前"的撤销点弄丢 (上次清空的备份被空操作顶掉)
		if (pruneStalePreview() > 0) backupMemoryNow()
		const removed = pruneStaleMemories()
		if (removed > 0) {
			refreshMemView()
			memPruneMsg.value = `已收起 ${removed} 条低频记忆，可在「已收起」里点「留下」放回`
			memPruneMsgOk.value = true
		} else {
			memPruneMsg.value = "没有需要清理的低频记忆（都很新鲜或有价值）"
			memPruneMsgOk.value = false
		}
	}

	const refreshMemFromDisk = () => {
		void flushMemoryPersist().then(() => {
			reloadMemory()
			refreshMemView()
		})
	}
	return {
		cfg, TYPE_LABELS,
		memView, memPending, summaryLabel, refreshMemView, goals,
		goalDraft, hasBackup, invalidMems, fadedMems, deletedMems,
		diagN, injectN, health, fmtWhen, injectSummary,
		doExportInject, fadeReasonLabel, doRestoreFaded, doRestoreDeleted, tuneShow,
		tuneHas, tunePos, tuneNeg, tuneInfo, doRebuildExamples,
		doClearExamples, maybeAutoTuneExamples, onDiagToggle, doExportDiag, doClearDiag, doDeleteForever,
		doRestoreInvalid, nonGoalMemories, memSearch, memFilter, filteredMems,
		isInferred, memProvenance, PROV_TIP, memSections, memOrganizing,
		memOrgMsg, memOrgMsgOk, canOrganize, doOrganizeNow, isPinnedId,
		doTogglePin, doFadeMemory, doDeleteMemory, doRestoreMemory, doAddGoal,
		doRemoveGoal, fmtTs, doExportAll, doClearMemory, memPruneMsg,
		memPruneMsgOk, doPruneMemories, refreshMemFromDisk,
	}
}

export type MemoryPanelState = ReturnType<typeof useMemoryPanel>
export type MemoryPanelModel = UnwrapNestedRefs<MemoryPanelState>
