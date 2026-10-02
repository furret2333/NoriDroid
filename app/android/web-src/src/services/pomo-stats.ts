/**
 * 番茄钟专注统计的**纯逻辑**层 (无 window / DOM 依赖, 可直接单测).
 *
 * 为什么单独抽出来: 这里是"算数字 + 造热力图网格 + 决定提不提"的部分, 是本功能里
 * 唯一能脱离 App.vue 验证的 (项目里 App.vue 的组件逻辑无法用 Node 测试覆盖)。
 *
 * 数据: pomo.json = {v, days:{"YYYY-MM-DD": PomoDayStat}, total, best, celebrated}
 * 保留策略: **永久保留** (不再按 30 天滚动删除); 另有 total/best 汇总做兜底。
 */

/** 每日专注记录 (与 pomo.json 的 days[k] 同构) */
export interface PomoDayStat {
	/** 净专注分钟数 (含中断前已专注的部分) */
	focusMin: number
	/** 完整跑完的番茄数 */
	done: number
	/** 放弃次数 */
	abort: number
	/** 正向计时分钟数 */
	countUpMin: number
}

/** 终身累计 (永不随天滚动, 即使某天明细被裁也保留) */
export interface PomoTotal {
	focusMin: number
	done: number
	countUpMin: number
}

/** 最佳记录 */
export interface PomoBest {
	/** 单日最高分钟 */
	dayMin: number
	/** 最长的"连续有专注"天数 */
	streak: number
}

/** pomo.json 结构 */
export interface PomoStatsFile {
	v: number
	days: Record<string, PomoDayStat>
	/** 已庆祝过的里程碑 (只庆祝一次); 可选 → 兼容旧数据 */
	celebrated?: Record<string, number>
	/** 终身累计; 可选 → 旧数据首次加载时自动累积出来 */
	total?: PomoTotal
	/** 最佳记录; 可选 → 旧数据首次加载时自动算出 */
	best?: PomoBest
}

/** 保留上限: 10 年。这是**防御性**上限而非业务保留期 ——
 *  用户要的是永久保留, 这条只是防止文件被异常写坏后无限膨胀。 */
export const KEEP_DAYS = 3650

/** 本地日期键 YYYY-MM-DD */
export const dayKey = (d: Date = new Date()): string =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

/** 某天的总专注分钟 (净专注 + 正向计时) */
export const dayMinutes = (d?: PomoDayStat): number => (d?.focusMin || 0) + (d?.countUpMin || 0)

/** 某天是否"有专注" (用于连续天数; 只完成不专注也算有) */
export const isActiveDay = (d?: PomoDayStat): boolean => !!d && (dayMinutes(d) > 0 || (d.done || 0) > 0)

/**
 * 把一次记录的**增量**累加进终身累计, 并刷新最佳记录。
 *
 * 注意参数是 delta 而不是"某天的全量": 同一天可能多次记录 (完成一个番茄 / 放弃一次 /
 * 结束一段正向计时), 传全量会重复累加 (实测: 100+20 之后再传 330 会得到 450)。
 * 调用方在每次记录后传本次新增的量。
 */
export const addToStore = (stats: PomoStatsFile, delta: Partial<PomoTotal>): void => {
	stats.total = {
		focusMin: (stats.total?.focusMin || 0) + (delta.focusMin || 0),
		done: (stats.total?.done || 0) + (delta.done || 0),
		countUpMin: (stats.total?.countUpMin || 0) + (delta.countUpMin || 0),
	}
	let dayMin = stats.best?.dayMin || 0
	for (const k of Object.keys(stats.days)) dayMin = Math.max(dayMin, dayMinutes(stats.days[k]))
	stats.best = {dayMin, streak: bestStreak(stats.days)}
}

/**
 * 迁移/自愈: 补上 total / best 字段 (旧 pomo.json 没有), 并按 KEEP_DAYS 裁掉过老明细。
 * @returns 是否有改动 (有则调用方需要落盘)
 */
export const migrateStats = (stats: PomoStatsFile, now: Date = new Date()): boolean => {
	let changed = false
	// ① 补终身累计: 用现存 days 求和 (旧数据只有 days, 这是唯一的还原途径)
	if (!stats.total) {
		const t: PomoTotal = {focusMin: 0, done: 0, countUpMin: 0}
		for (const k of Object.keys(stats.days)) {
			t.focusMin += stats.days[k]?.focusMin || 0
			t.done += stats.days[k]?.done || 0
			t.countUpMin += stats.days[k]?.countUpMin || 0
		}
		stats.total = t
		changed = true
	}
	// ② 补最佳记录
	if (!stats.best) {
		let dayMin = 0
		for (const k of Object.keys(stats.days)) dayMin = Math.max(dayMin, dayMinutes(stats.days[k]))
		stats.best = {dayMin, streak: bestStreak(stats.days)}
		changed = true
	}
	// ③ 防御性裁剪 (永久保留 = 只删 10 年以前的)
	const cutoff = dayKey(new Date(now.getTime() - KEEP_DAYS * 86400000))
	for (const k of Object.keys(stats.days)) {
		if (k < cutoff) { delete stats.days[k]; changed = true }
	}
	return changed
}

/* ---------------- 汇总 (面板展示用) ---------------- */

export interface PomoSummary {
	/** 今日总分钟 */
	todayMin: number
	/** 今日完成番茄数 */
	todayDone: number
	/** 今日放弃次数 */
	todayAbort: number
	/** 今日完成率 0~1 (无完成也无放弃时返回 -1 表示"无数据") */
	todayRate: number
	/** 今日平均每段专注分钟 (无完成时返回 -1) */
	todayAvgMin: number
	/** 近 N 天总分钟 */
	rangeMin: number
	/** 近 N 天最佳单日分钟 */
	rangeBest: number
	/** 近 N 天完成番茄总数 */
	rangeDone: number
	/** 连续有专注记录的天数 */
	streak: number
}

/**
 * 汇总近 `rangeDays` 天 (含今天) 的专注数据。
 */
export const summarize = (
	days: Record<string, PomoDayStat>,
	rangeDays = 7,
	now: Date = new Date(),
): PomoSummary => {
	const today = days[dayKey(now)]
	const doneToday = today?.done || 0
	const abortToday = today?.abort || 0
	const attempts = doneToday + abortToday

	let rangeMin = 0
	let rangeBest = 0
	let rangeDone = 0
	for (let i = 0; i < rangeDays; i++) {
		const k = dayKey(new Date(now.getTime() - i * 86400000))
		const d = days[k]
		const min = dayMinutes(d)
		rangeMin += min
		if (min > rangeBest) rangeBest = min
		rangeDone += d?.done || 0
	}

	return {
		todayMin: dayMinutes(today),
		todayDone: doneToday,
		todayAbort: abortToday,
		// 没有任何完成/放弃时不显示 0% (那是"没数据", 不是"全失败")
		todayRate: attempts > 0 ? doneToday / attempts : -1,
		todayAvgMin: doneToday > 0 ? Math.round((today?.focusMin || 0) / doneToday) : -1,
		rangeMin,
		rangeBest,
		rangeDone,
		streak: computeStreak(days, now),
	}
}

/**
 * 当前连续天数: 从今天往前数"有记录的天"。
 * 今天尚无记录时从昨天起算 (否则每天 0 点一过 streak 就归零, 体验很怪)。
 */
export const computeStreak = (
	days: Record<string, PomoDayStat>,
	now: Date = new Date(),
): number => {
	let offset = isActiveDay(days[dayKey(now)]) ? 0 : 1
	let n = 0
	for (let i = offset; i < 4000; i++) {
		if (!isActiveDay(days[dayKey(new Date(now.getTime() - i * 86400000))])) break
		n += 1
	}
	return n
}

/**
 * 历史最长连续天数 (全量扫描, 按日期升序找最长连续段)。
 * 与 computeStreak 不同: 后者算"当前", 这里算"历史最佳"。
 */
export const bestStreak = (days: Record<string, PomoDayStat>): number => {
	const keys = Object.keys(days).filter(k => isActiveDay(days[k])).sort()
	let best = 0
	let run = 0
	let prev: Date | null = null
	for (const k of keys) {
		const cur = new Date(`${k}T12:00:00`)
		if (prev && Math.round((cur.getTime() - prev.getTime()) / 86400000) === 1) run += 1
		else run = 1
		if (run > best) best = run
		prev = cur
	}
	return best
}

/** 月度汇总 (详细页用): 按月聚合, 新→旧 */
export const monthlyRollup = (
	days: Record<string, PomoDayStat>,
	months = 12,
	now: Date = new Date(),
): {month: string; min: number; done: number}[] => {
	const map = new Map<string, {min: number; done: number}>()
	for (const [k, d] of Object.entries(days)) {
		const m = k.slice(0, 7)   // YYYY-MM
		const cur = map.get(m) ?? {min: 0, done: 0}
		cur.min += dayMinutes(d)
		cur.done += d?.done || 0
		map.set(m, cur)
	}
	const out: {month: string; min: number; done: number}[] = []
	for (let i = 0; i < months; i++) {
		const dt = new Date(now.getFullYear(), now.getMonth() - i, 1)
		const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`
		const v = map.get(key)
		out.push({month: key, min: v?.min || 0, done: v?.done || 0})
	}
	return out
}

/* ---------------- 热力图网格 ---------------- */

export interface HeatCell {
	/** YYYY-MM-DD */
	date: string
	/** 当天总分钟 */
	min: number
	/** 0~4 强度档 (0 = 无记录, 供着色) */
	level: number
}

export interface Heatmap {
	/** 总列数 (= 周数, 含首尾补白) */
	weeks: number
	/** 长度 = weeks * 7, 行优先 (行 = 周内第几天, 0=周日) */
	cells: (HeatCell | null)[]
	/** 每条柱顶的月份标签 (仅月份变化处有值) */
	monthLabels: {col: number; text: string}[]
}

/** 分钟 → 强度档 (0~4)。0 分钟 = 0 档; 其余按阈值分档 */
export const heatLevel = (min: number): number => {
	if (!min) return 0
	if (min < 25) return 1
	if (min < 50) return 2
	if (min < 100) return 3
	return 4
}

/**
 * 构造热力图网格 (GitHub contribution 风格)。
 *
 * 关键: 起点必须**周对齐**到 `weeks*7 - (今天在周内的偏移 + 1)` 天前, 否则单元格
 * 与星期行会错位 (格子对不上"周几")。
 * @param weeks 列数 (默认 52 周 ≈ 一年)
 * @param now 注入当前时间以便测试
 */
export const buildHeatmap = (
	days: Record<string, PomoDayStat>,
	weeks = 52,
	now: Date = new Date(),
): Heatmap => {
	const doy = now.getDay()               // 0=周日
	// 网格共 weeks 列: 最后一列是本周, 第一列起点 = 今天 - (weeks-1) 周 - 本周已过天数
	const start = new Date(now.getTime() - ((weeks - 1) * 7 + doy) * 86400000)
	const cells: (HeatCell | null)[] = []
	const monthLabels: {col: number; text: string}[] = []
	let lastMonth = -1
	for (let w = 0; w < weeks; w++) {
		for (let row = 0; row < 7; row++) {
			const d = new Date(start.getTime() + (w * 7 + row) * 86400000)
			if (d.getTime() > now.getTime()) { cells.push(null); continue }
			const date = dayKey(d)
			const min = dayMinutes(days[date])
			cells.push({date, min, level: heatLevel(min)})
			if (row === 0) {
				const m = d.getMonth()
				if (m !== lastMonth) {
					monthLabels.push({col: w, text: `${m + 1}月`})
					lastMonth = m
				}
			}
		}
	}
	return {weeks, cells, monthLabels}
}

/* ---------------- 给 Nori 的注入 (克制: 一次只说一件事) ---------------- */

/** 里程碑: 连续天数 (只庆祝一次, 记在 celebrated 里) */
export const MILESTONES: {key: string; need: (s: PomoSummary) => boolean; text: string}[] = [
	{key: "streak7", need: (s) => s.streak >= 7, text: "主人已经连续一周每天都专注了"},
	{key: "streak3", need: (s) => s.streak >= 3, text: "主人已经连着好几天都专注了"},
]

/** 话题相关闸门: 只有聊到这些事才提专注数据, 否则答非所问 */
const TOPIC_RE = /(工作|上班|加班|学习|复习|考试|论文|项目|写代码|编程|赶工|赶进度|专注|摸鱼|效率|图书馆|自习|作业|ddl)/i

export const topicRelated = (text: string): boolean => TOPIC_RE.test(String(text ?? ""))

/**
 * 生成注入给 Nori 的一行提示; 不值得提时返回 ""。
 * 三个闸门: ① 话题相关 ② 有值得说的内容 ③ 由调用方负责"每天只提一次"。
 * 优先级: 里程碑 > 连续天数 > 今日时长。
 *
 * 输出的提示词**自带克制约束** —— persona 已反复强调"2~3 句、最多 4 句",
 * 所以这里明确要求"最多提这一件事、不要罗列、不搭就不提", 而不是去放宽长度规则。
 */
export const buildFocusHint = (
	s: PomoSummary,
	userText: string,
	celebrated: Record<string, number> = {},
): {hint: string; milestoneKey?: string} => {
	if (!topicRelated(userText)) return {hint: ""}

	for (const m of MILESTONES) {
		if (m.need(s) && !celebrated[m.key]) {
			return {
				hint:
					`【自然地提一句】${m.text}。可以高兴一点地夸他一句，最多提这一件事，` +
					`不要罗列其它数据，不要报数字堆砌。`,
				milestoneKey: m.key,
			}
		}
	}
	if (s.streak >= 3) {
		return {
			hint:
				`【自然地提一句】主人已经连续 ${s.streak} 天有专注了。最多提这一件事，` +
				`不要罗列其它数据；若和当前话题不搭就不要提。`,
		}
	}
	if (s.todayMin >= 25) {
		return {
			hint:
				`【自然地提一句】主人今天已经专注 ${s.todayMin} 分钟了。最多提这一件事，` +
				`不要罗列其它数据；若和当前话题不搭就不要提。`,
		}
	}
	return {hint: ""}
}
