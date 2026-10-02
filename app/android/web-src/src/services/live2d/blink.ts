/**
 * 眨眼（自己做，走"顶点计算之前"的钩子）。
 *
 * ## 为什么自己做 —— 库其实**内置**了眨眼，只是被空名单废掉了
 * 库里完整移植了 Cubism 的 `CubismEyeBlink`（实测源码：间隔 4s、闭合 0.1s、全闭 0.05s、睁开 0.15s），
 * 它按 **model3.json** 里 `Groups` 中 `Name === "EyeBlink"` 那一项的 `Ids` 列表来驱动参数。
 *
 * 而这份 `ARGNori.model3.json` 里那一项是：
 *
 * ```json
 * {"Target":"Parameter","Name":"EyeBlink","Ids":[]}
 * ```
 *
 * **空数组** ⇒ 库拿到的"要驱动几个参数"是 **0** ⇒ 眨眼对象没有任何参数可写 ⇒ **永远不眨**。
 * （模型本身是有 `ParamEyeLOpen` / `ParamEyeROpen` 的：cdi3.json 里两个都在。
 *  原项目多半是导出 model3.json 时漏勾了眨眼组。）
 *
 * 两条修法：
 *   - **A. 补 model3.json 的 Ids** —— 但那是**模型文件**：真机上模型是下载来的
 *     （`/data/data/<pkg>/files/models/...`），改本地副本对真机无效，改真机文件一重下就丢；
 *     要在产品里生效还得拦 fetch/XHR 改响应 ⇒ 侵入大、没法用门禁守住。
 *   - **B. 自己做（本文件）** —— 不动模型、不新增补丁 token、走已有的钩子。
 * 选了 **B**。
 *
 * ## 为什么闭合是"乘性"的
 * 每帧**读回当前值** `c`，再相加 `-c × k`（k = 本次眨眼的闭合量 0→1→0）。这样：
 *   - 表情把眼睛设成 2（睁大）时按比例闭、设成 0（本来闭着，如 `Sleep`）时天然无动作；
 *   - 若用固定幅度相加，表情把值改大时会"闭不干净"；若用 `__noriSetParam`（覆盖）会把表情压掉。
 * 库每帧从保存值重建参数 ⇒ 每帧加一次正好、**不累积**；不眨眼时一个字都不写。
 */

import {registerBeforeUpdate} from "./beforeUpdate"

export interface BlinkTuning {
	/** 两次眨眼之间的随机间隔下界 (ms) */
	minGapMs: number
	/** 上界 (ms) */
	maxGapMs: number
	/** 闭合用时 */
	closeMs: number
	/** 保持全闭用时 */
	closedMs: number
	/** 睁开用时 */
	openMs: number
	/** 眨完立刻再眨一次（"双眨"）的概率 */
	doubleChance: number
	/** 双眨的间隔 */
	doubleGapMs: number
}

/** 默认参数：整体节奏接近库内置的 CubismEyeBlink（间隔 4s / 闭 0.1 / 全闭 0.05 / 睁 0.15），
 *  但间隔做成随机的 2.4~6.2s —— 固定 4 秒会看出机械感 */
export const DEFAULT_BLINK_TUNING: BlinkTuning = {
	minGapMs: 2400,
	maxGapMs: 6200,
	closeMs: 90,
	closedMs: 40,
	openMs: 130,
	doubleChance: 0.12,
	doubleGapMs: 130,
}

/** 一次眨眼的完整时长 */
export const blinkTotalMs = (t: BlinkTuning = DEFAULT_BLINK_TUNING): number => t.closeMs + t.closedMs + t.openMs

/** 两次眨眼之间的随机间隔（**只调一次 rand**，否则"可注入随机源"的测试会数不清调用次数） */
export const nextBlinkGap = (rand: () => number, t: BlinkTuning = DEFAULT_BLINK_TUNING): number => {
	const v = rand()
	const r = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
	return t.minGapMs + r * (t.maxGapMs - t.minGapMs)
}

/**
 * 一次眨眼的**闭合量** k ∈ [0,1]（0 = 完全睁开，1 = 完全闭合）。
 * 形状：线性闭合 → 保持全闭 → 线性睁开。时间轴异常（NaN/负数）一律当 0，不毒化。
 */
export const blinkClosure = (elapsedMs: number, t: BlinkTuning = DEFAULT_BLINK_TUNING): number => {
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
	if (elapsedMs < t.closeMs) return elapsedMs / t.closeMs
	if (elapsedMs < t.closeMs + t.closedMs) return 1
	const o = elapsedMs - t.closeMs - t.closedMs
	if (o < t.openMs) return t.openMs <= 0 ? 0 : 1 - o / t.openMs
	return 0
}

export interface BlinkState {
	/** 开关。**当前产品侧没有任何地方关它**（设置里没有眨眼开关，用户决定不加）；
	 *  保留这个字段是因为它是纯状态机的一部分、且"关掉要立刻停止闭合"这条已被门禁覆盖 ——
	 *  将来真要加开关，接上 `setBlinkOn` 即可（现在**不导出**半成品的 setter）。 */
	on: boolean
	/** 是否正在眨 */
	blinking: boolean
	/** 本次眨眼开始时刻 */
	startMs: number
	/** 下一次该眨的时刻 */
	nextAtMs: number
	/** 刚才那次是"双眨"的第一下（用于禁止连三下） */
	doublePending: boolean
	/** 累计眨眼次数（给 E2E 做确定性证据） */
	count: number
}

export const newBlinkState = (now: number, rand: () => number = Math.random, t: BlinkTuning = DEFAULT_BLINK_TUNING): BlinkState => ({
	on: true,
	blinking: false,
	startMs: 0,
	nextAtMs: now + nextBlinkGap(rand, t),
	doublePending: false,
	count: 0,
})

/**
 * 推进一帧 —— **纯函数**（不修改入参），返回新状态与该帧要施加的闭合量。
 * 抽成纯函数是为了门禁能在 Node 里精确单测时间表（时钟与随机源都可注入）。
 */
export const blinkStep = (
	st: BlinkState,
	now: number,
	rand: () => number = Math.random,
	t: BlinkTuning = DEFAULT_BLINK_TUNING,
): {state: BlinkState; closure: number} => {
	if (!Number.isFinite(now)) return {state: st, closure: 0}
	if (!st.on) {
		return st.blinking
			? {state: {...st, blinking: false, startMs: 0, doublePending: false, nextAtMs: now + nextBlinkGap(rand, t)}, closure: 0}
			: {state: st, closure: 0}
	}
	if (!st.blinking) {
		if (now < st.nextAtMs) return {state: st, closure: 0}
		return {state: {...st, blinking: true, startMs: now, count: st.count + 1}, closure: blinkClosure(0, t)}
	}
	const elapsed = now - st.startMs
	const total = blinkTotalMs(t)
	/* 时钟跳变/长时间挂起后不要卡在"闭着眼" */
	if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > total * 4) {
		return {state: {...st, blinking: false, startMs: 0, doublePending: false, nextAtMs: now + nextBlinkGap(rand, t)}, closure: 0}
	}
	if (elapsed >= total) {
		// 眨完了：可能接一次"双眨"，否则排下一次
		if (!st.doublePending && rand() < t.doubleChance) {
			return {state: {...st, blinking: false, startMs: 0, doublePending: true, nextAtMs: now + t.doubleGapMs}, closure: 0}
		}
		return {state: {...st, blinking: false, startMs: 0, doublePending: false, nextAtMs: now + nextBlinkGap(rand, t)}, closure: 0}
	}
	return {state: st, closure: blinkClosure(elapsed, t)}
}

/* ---------------- IO 侧（真正写参数） ---------------- */

/** 模型里驱动眼睛开合的两个参数（cdi3.json 实测都在） */
export const BLINK_PARAMS = ["ParamEyeLOpen", "ParamEyeROpen"] as const

interface BlinkHooks {
	get?: (id: string) => number | null
	add?: (id: string, v: number) => boolean
}

const defaultHooks = (): BlinkHooks => {
	if (typeof window === "undefined") return {}
	const w = window as unknown as {__noriGetParam?: BlinkHooks["get"]; __noriAddParam?: BlinkHooks["add"]}
	return {get: w.__noriGetParam, add: w.__noriAddParam}
}

const nowMs = (): number => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now())

let state: BlinkState = newBlinkState(0)
let lastClosure = 0

/** 累计眨眼次数（E2E / 实机调试用） */
export const blinkCount = (): number => state.count
/** 上一帧实际施加的闭合量（调试用；0=睁 1=全闭） */
export const blinkClosureNow = (): number => lastClosure

/**
 * 每帧调用（由 `beforeUpdate` 调度器在库 `update()` **之前**调用）。
 * 闭合量为 0 时**一个字都不写** —— 不眨眼时零开销、也绝不干扰表情。
 */
export const applyBlink = (now: number = nowMs(), hooks: BlinkHooks = defaultHooks()): number => {
	const step = blinkStep(state, now)
	state = step.state
	lastClosure = step.closure
	const k = step.closure
	if (k <= 0) return 0
	const {get, add} = hooks
	if (typeof get !== "function" || typeof add !== "function") return 0
	let written = 0
	for (const id of BLINK_PARAMS) {
		const c = get(id)
		if (typeof c !== "number" || !Number.isFinite(c) || c === 0) continue
		add(id, -c * k)      // 乘性闭合：按"当前睁开的比例"闭，不吃掉表情
		written += 1
	}
	return written
}

/** 装上（App 启动时调一次）。与其他消费者共用一个钩子槽位，见 beforeUpdate.ts */
export const installBlink = (): void => { registerBeforeUpdate(() => { applyBlink() }) }

/** 仅供测试：重置状态与时钟 */
export const __resetBlinkForTest = (now = 0, rand: () => number = () => 0.5): void => {
	state = newBlinkState(now, rand)
	lastClosure = 0
}
