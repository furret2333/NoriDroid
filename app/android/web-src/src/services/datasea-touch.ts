/**
 * 数据海背景的**触摸响应** —— 纯逻辑（无 DOM / 无 rAF / 无副作用），便于门禁单测。
 *
 * 由 `datasea-bg.ts` 每帧调用；指针事件由 `App.vue` 的三个阶段驱动：
 *   pointerdown → `dataseaTouchStart` ／ pointermove → `dataseaTouchMove` ／ pointerup(=cancel) → `dataseaTouchEnd`
 *
 * ## 用户定的三条（2026-09-25）
 * 1. **跟得更慢**：趋近率 `0.4 → 0.18 /s`（时间常数 2.5s → **5.6s**，像"水被慢慢搅动"而不是被拽过去）
 * 2. **不要一碰到就动**：强度 `0 → 1` **渐入 350ms**（smoothstep）；粒子在头 100ms 里的位移实测不到 0.5px
 * 3. **取消"立即变亮"**：旧实现里 `boost = (1 - d/r) * 0.35` 直接加在 alpha 上（当帧就亮）—— **已删除**。
 *    现在粒子只被吸引、亮度只由它自己的基础亮度与闪烁决定。
 * 另外：**吸引点本身对指尖做低通**（≈125ms），手指抖动/瞬移不会让整片粒子抽动。
 *
 * ## ⚠ 一个必须守住的坑：渐入**不能**按"最近一次移动"计时
 * 旧代码把每次 `pointermove` 的时刻写进 `touch.at`，而效果存活判定用的是它。
 * 如果渐入也按这个字段算，那么**手指一直在动时"已过 350ms"永远不成立** ⇒ 强度永远回落到 0
 * ⇒ 症状是"摸起来跟没反应一样"，而且极难查。
 * 所以这里用两个**只在边沿写**的时刻：`startAt`（按下）与 `releasedAt`（抬手）——
 * `dataseaTouchMove` 只改 `rawX/rawY`，**绝不碰这两个字段**。门禁里有一条专门守它。
 */

/** 影响半径 (px) —— 与旧实现同值（170） */
export const DATASEA_TOUCH_RADIUS = 170
/** 粒子朝吸引点的趋近率 (1/s)。旧值 0.4（太快、像被拽）；用户要求"更慢一点" */
export const DATASEA_TOUCH_PULL_RATE = 0.18
/** 强度渐入时长 (ms)：按下后多久到满强度 */
export const DATASEA_TOUCH_RAMP_MS = 350
/** 强度渐出时长 (ms)：抬手后多久归零（旧实现是"到点突然停住"） */
export const DATASEA_TOUCH_RELEASE_MS = 400
/** 吸引点对指尖的低通速率 (1/s) ≈ 125ms 时间常数（手指抖动的缓冲） */
export const DATASEA_TOUCH_GLIDE_RATE = 8

export interface DataseaTouchState {
	/** 手指是否按着（由 down/up 边沿驱动） */
	down: boolean
	/** 本次按下时刻 (ms) —— **渐入基准**，只在 `dataseaTouchStart` 写 */
	startAt: number
	/** 按下那一刻已有的强度（从它往 1 涨，避免"释放中再次按下"时跳变） */
	pressFrom: number
	/** 抬手时刻 (ms) —— **渐出基准**，只在 `dataseaTouchEnd` 写 */
	releasedAt: number
	/** 抬手那一刻的强度（渐出从这里往下走，避免中途抬手时跳变） */
	releaseFrom: number
	/** 指尖最新位置（move 直接写） */
	rawX: number
	rawY: number
	/** **缓冲后的吸引点**（低通跟随 rawX/rawY） */
	x: number
	y: number
	/** 当前强度 0~1 */
	strength: number
}

export const newDataseaTouchState = (): DataseaTouchState => ({
	down: false, startAt: 0, pressFrom: 0, releasedAt: 0, releaseFrom: 0,
	rawX: 0, rawY: 0, x: 0, y: 0, strength: 0,
})

/** smoothstep：0→0、1→1，中间平滑（两端斜率 0 ⇒ 起手与收尾都没有"顿一下"） */
const smoothstep = (t: number): number => {
	if (!Number.isFinite(t) || t <= 0) return 0
	if (t >= 1) return 1
	return t * t * (3 - 2 * t)
}

const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback)

/**
 * 按下：开始一次触摸。**吸引点直接贴合指尖**（粒子此刻还没被"拉"，
 * 因为强度从 `pressFrom` 慢慢涨起来；若让吸引点从旧位置滑过来，粒子会先被拉向旧点）。
 */
export const dataseaTouchStart = (st: DataseaTouchState, x: number, y: number, now: number): DataseaTouchState => {
	const nx = finite(x)
	const ny = finite(y)
	return {
		...st,
		down: true,
		startAt: finite(now),
		/** 从**当前**强度接着往 1 涨：释放过程中再次按下时不会先跳回 0 */
		pressFrom: Math.min(1, Math.max(0, finite(st.strength))),
		rawX: nx, rawY: ny, x: nx, y: ny,
	}
}

/** 移动：只更新指尖位置与目标（**绝不改 startAt/releasedAt**，见文件头那个坑） */
export const dataseaTouchMove = (st: DataseaTouchState, x: number, y: number): DataseaTouchState => {
	if (!st.down) return st                      // 没按下就不是"触摸"（悬停/面板拖动不该搅动背景）
	return {...st, rawX: finite(x), rawY: finite(y)}
}

/** 抬手：记下渐出基准（强度从这里往下走，不会跳变） */
export const dataseaTouchEnd = (st: DataseaTouchState, now: number): DataseaTouchState => {
	if (!st.down) return st
	return {...st, down: false, releasedAt: finite(now), releaseFrom: st.strength}
}

/**
 * 推进一帧（纯函数，不改入参）：
 * - 强度：按下时从 `pressFrom` 涨到 1（350ms）；抬手后从 `releaseFrom` 落到 0（400ms）
 * - 吸引点：以 `DATASEA_TOUCH_GLIDE_RATE` 低通跟随指尖（帧率无关：`1 - e^(-r·dt)`）
 * @param dt 帧间真实时长 (秒)
 */
export const dataseaTouchStep = (
	st: DataseaTouchState,
	now: number,
	dt: number,
): {state: DataseaTouchState; strength: number; x: number; y: number; active: boolean} => {
	const d = Number.isFinite(dt) && dt > 0 ? dt : 0
	/* 吸引点低通：指数形式 ⇒ 60fps 与 30fps 下"走过的比例"一致 */
	const k = d > 0 ? 1 - Math.exp(-DATASEA_TOUCH_GLIDE_RATE * d) : 0
	const x = st.x + (st.rawX - st.x) * k
	const y = st.y + (st.rawY - st.y) * k

	let strength: number
	if (st.down) {
		const from = Math.min(1, Math.max(0, finite(st.pressFrom)))
		strength = from + (1 - from) * smoothstep((finite(now) - st.startAt) / DATASEA_TOUCH_RAMP_MS)
	} else {
		const from = Math.min(1, Math.max(0, finite(st.releaseFrom)))
		strength = from * (1 - smoothstep((finite(now) - st.releasedAt) / DATASEA_TOUCH_RELEASE_MS))
	}
	if (!Number.isFinite(strength) || strength < 0) strength = 0
	if (strength > 1) strength = 1
	// 已经松手且衰减完了 ⇒ 彻底停掉（调用方据此整段跳过触摸逻辑）
	const active = st.down || strength > 0
	return {state: {...st, x, y, strength}, strength, x, y, active}
}

/**
 * 单个粒子这一帧该朝吸引点走的比例 (0~1)。
 * 与旧实现同一形状 `min(1, rate·dt) · (1 - d/R)`，另乘**强度包络**（这就是"缓冲"）。
 * 任何非法输入一律返回 0（不许把 NaN 渗进粒子坐标 —— 那会让粒子**永久**坏掉）。
 */
export const dataseaTouchPull = (dt: number, dist: number, strength: number): number => {
	if (!Number.isFinite(dt) || dt <= 0) return 0
	if (!Number.isFinite(dist) || dist <= 1 || dist >= DATASEA_TOUCH_RADIUS) return 0
	if (!Number.isFinite(strength) || strength <= 0) return 0
	const s = Math.min(1, strength)
	return Math.min(1, DATASEA_TOUCH_PULL_RATE * dt) * (1 - dist / DATASEA_TOUCH_RADIUS) * s
}
