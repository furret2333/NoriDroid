/**
 * 习惯学习 (v1): 全本地的来访规律档案, 让 Ambient 主动搭话的时机个性化.
 * 采集: 启动/点击/发送 的时间戳 (不含任何内容, 隐私干净)
 * 存储: Download/DeepEr/habit-profile.json, 滚动保留 30 天
 * 模型: 近 14 天 × 48 个半小时桶的活跃计数 → 活跃概率曲线
 * 数据不足 3 天 = 冷启动, 调用方回退固定参数 (零回归风险)
 */
import {readFile, writeFile} from "./chat"

const FILE = "habit-profile.json"
const KEEP_DAYS = 30
const DAY_MS = 24 * 3600 * 1000
const BUCKETS = 48
const TOUCH_THROTTLE = 60_000

interface HabitEntry {
	t: number
	kind: "open" | "touch" | "msg"
}

interface HabitStore {
	days: Record<string, HabitEntry[]>
	updated: number
}

let cache: HabitStore | null = null
let lastTouchRecord = 0

const dayStr = (ts: number): string => {
	const d = new Date(ts)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

const load = (): HabitStore => {
	if (cache) return cache
	try {
		const raw = readFile(FILE)
		if (raw) {
			const p = JSON.parse(raw) as HabitStore
			if (p && typeof p === "object" && p.days && typeof p.days === "object") {
				cache = {days: p.days, updated: Number(p.updated) || Date.now()}
				return cache
			}
		}
	} catch { /* 忽略 */ }
	cache = {days: {}, updated: Date.now()}
	return cache
}

const persist = (): boolean => {
	if (!cache) return false
	try {
		const ok = writeFile(FILE, JSON.stringify(cache))
		if (!ok) console.error("[habit] 写盘失败")
		return ok
	} catch (e) {
		console.error("[habit] persist error", e)
		return false
	}
}

/** 记录一次互动时间 (touch 自动节流 60s, 防高频写盘) */
export const habitRecord = (kind: "open" | "touch" | "msg"): void => {
	try {
		const now = Date.now()
		if (kind === "touch" && now - lastTouchRecord < TOUCH_THROTTLE) return
		lastTouchRecord = now
		const store = load()
		const day = dayStr(now)
		;(store.days[day] ??= []).push({t: now, kind})
		const minDay = dayStr(now - KEEP_DAYS * DAY_MS)
		for (const d of Object.keys(store.days)) if (d < minDay) delete store.days[d]
		store.updated = now
		// 写盘失败 → 丢弃内存缓存: 下次 load 重新从磁盘读, 内存不再代表"已保存"的假象
		// (档案是滚动统计, 丢一次记录无害; 但若继续用脏缓存, 后续写入会以它为基准)
		if (!persist()) cache = null
	} catch { /* 忽略 */ }
}

/** 半小时桶序号 (本地时间, 一天 48 桶) */
export const bucketOf = (ts: number): number => {
	const d = new Date(ts)
	return Math.floor((d.getHours() * 60 + d.getMinutes()) / 30)
}

export interface HabitProfile {
	daysOfData: number
	/** 48 个半小时桶的活跃概率 (0~1, 以最活跃桶归一) */
	prob: number[]
	/** 当前时刻是否处于习惯活跃时段 (概率 >= 0.4) */
	nowActive: boolean
	/** 习惯高峰时段所在小时 (本地时间) */
	peakHour: number
}

/** 构建活跃概率曲线; 有效数据不足 3 天返回 null (冷启动, 调用方走固定参数) */
export const habitProfile = (): HabitProfile | null => {
	const store = load()
	const cutoff = Date.now() - 14 * DAY_MS
	const days = Object.keys(store.days).filter(d => (store.days[d] || []).some(e => e.t >= cutoff))
	if (days.length < 3) return null
	const buckets = new Array<number>(BUCKETS).fill(0)
	for (const d of days) {
		for (const e of store.days[d] || []) {
			if (e.t >= cutoff) buckets[bucketOf(e.t)]++
		}
	}
	const max = Math.max(...buckets)
	if (max <= 0) return null
	const prob = buckets.map(b => b / max)
	// 在**原始计数桶**上取峰值的下标: prob 已归一化到 ≤1, 拿它 indexOf(原始 max) 永远得 -1
	// (除非峰值恰好等于 1), peakHour 会变成负数 → habitLateToday 近乎每天都判"迟到"。
	const peakBucket = buckets.indexOf(max)
	return {
		daysOfData: days.length,
		prob,
		nowActive: prob[bucketOf(Date.now())] >= 0.4,
		peakHour: Math.floor((peakBucket * 30) / 60),
	}
}

/** 当前时刻的习惯概率 (0~1; 无档案返回 -1) —— 已随死代码清理删除：
 *  全仓库零引用（`audit-dead-exports.mjs` ① 类）。习惯系统的其余部分不受影响。 */

/** 今天是否明显"迟到": 习惯高峰已过 90 分钟以上, 且今天还没有任何互动记录 */
export const habitLateToday = (): boolean => {
	const p = habitProfile()
	if (!p) return false
	const store = load()
	const today = dayStr(Date.now())
	const list = store.days[today] || []
	if (!list.length) return false
	// 挂载即记录 "open", 所以用"今天首条记录"判定: 首次互动比习惯高峰晚 90 分钟以上 = 迟到
	const first = new Date(list[0].t)
	const firstMin = first.getHours() * 60 + first.getMinutes()
	const peakMin = p.peakHour * 60
	return firstMin > peakMin + 90
}
