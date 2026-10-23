/**
 * 纯逻辑：参数校验 / 日期键 / 限流。
 *
 * 刻意与 Worker 运行时（`cloudflare:workers`）解耦 —— 这样 `node --test` 可以直接
 * 跑这些函数，不需要 wrangler / workerd。
 */

/** 安装 ID：16~64 位字母数字（客户端生成 32 位十六进制，这里放宽以兼容未来改动） */
export const ID_RE = /^[A-Za-z0-9_-]{16,64}$/
export const VERSION_MAX = 32

/** 「在线」窗口：最近 10 分钟发过心跳即算在线（客户端 5 分钟一次心跳） */
export const WINDOW_MS = 10 * 60 * 1000
/** 同一 ID 的写入节流（避免重试风暴把行写配额打满） */
export const IDLE_THROTTLE_MS = 30 * 1000
/** 今日累计表保留天数 */
export const DAY_KEEP_DAYS = 90

export const isValidId = (id) => typeof id === "string" && ID_RE.test(id)

export const isValidVersion = (v) =>
	typeof v === "string" && v.length > 0 && v.length <= VERSION_MAX && !/[\r\n]/.test(v)

/** 「今日」按**北京时间（UTC+8）**切日 —— 和 App 里「今日 N 位同好来过」的语义一致。
 *  （早期用 UTC，会让北京 00:00–08:00 显示成前一天，用户会觉得数字没重置。） */
export const DAY_OFFSET_MS = 8 * 60 * 60 * 1000
export const dayKey = (now = Date.now()) =>
	new Date(now + DAY_OFFSET_MS).toISOString().slice(0, 10)

/** 在线统计的起始时间戳 */
export const onlineCutoff = (now = Date.now()) => now - WINDOW_MS

/** 需要保留的最早日期键（清理用） */
export const dayCutoff = (now = Date.now()) =>
	dayKey(now - DAY_KEEP_DAYS * 24 * 60 * 60 * 1000)

/** 这个 ID 这次要不要写库（同 ID 30s 内重复心跳只返回当前人数） */
export const shouldCount = (lastTs, now = Date.now()) =>
	lastTs == null || now - lastTs >= IDLE_THROTTLE_MS

/** 把任意输入收敛成非负整数（防御脏响应） */
export const normalizeCount = (n) => {
	const v = Number(n)
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/**
 * 按来源 IP 的滑动窗口限流（内存态，不落库、不打日志）。
 * 只用于挡住刷量脚本；正常用户 5 分钟一次心跳，远低于阈值。
 */
export const createRateLimiter = ({limit = 120, windowMs = 60_000} = {}) => {
	const hits = new Map()
	const pruneOne = (key, now) => {
		const arr = (hits.get(key) || []).filter((t) => now - t < windowMs)
		if (arr.length) hits.set(key, arr)
		else hits.delete(key)
		return arr
	}
	return {
		allow(key, now = Date.now()) {
			const arr = pruneOne(key, now)
			if (arr.length >= limit) return false
			arr.push(now)
			hits.set(key, arr)
			return true
		},
		prune(now = Date.now()) {
			for (const key of [...hits.keys()]) pruneOne(key, now)
		},
		size() {
			return hits.size
		},
	}
}
