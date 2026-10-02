/**
 * 摸头时的表情反馈：**持续播 shy / smile（二选一随机）**，停手 1 秒后**平滑**收回。
 *
 * ## 规格（用户 2026-09-24 定）
 * 1. 摸头时**持续播放** `_shy` 或 `_smile` —— 两个里**随机**选一个
 * 2. **不做 10 秒锁**：停手后 **1 秒内**没有继续摸头就收回；收回**不能有跳变感**
 * 3. **摸头优先**：聊天回复的表情标记不许盖掉它（见 `petExpressionHoldsLayer`）
 * 4. **只有摸到头才播**（摸身体不播；判定在调用方，传 `petting = stroking && onNoriHead`）
 *
 * ## 为什么"不跳变"是免费的
 * `04_Shy.exp3.json` / `07_Smile.exp3.json` 都自带 **`FadeInTime: 0.5` / `FadeOutTime: 0.5`**
 * —— 进场与收回都是 0.5s 淡变（Cubism 表情权重插值），所以**不需要**自己写过渡。
 * 因此这里只在"**状态真的变了**"时才调库（名字变了/刚开始 → play；展示→不展示 → stop），
 * **绝不每帧重播** —— 每帧重播会把 0.5s 的淡入反复重置，反而变成"一直在淡入"的闪烁。
 *
 * ## 为什么必须过 EXPRESSION_DENY（这个项目栽过）
 * 之前的实现用 `name.includes("smile")` 挑表情，而 Nori 有
 * `Finale_Smile` / `Finale_Sad_Smile` / `Finale_EyeClosed_Smile` 这类**结算动画** ⇒ 会命中它们。
 * 项目历史上就出过"难过 → 演成 `Finale_Sad`"的事故。`EXPRESSION_DENY` 正是当年的修复，
 * 这里复用同一个正则（`markerRules.ts` 导出，避免两处漂移）。
 *
 * ## 与眨眼的共存
 * `07_Smile` 会把 `ParamEyeLOpen/ROpen` 各 −1（闭眼笑），而眨眼也在写这两个参数 ——
 * 但眨眼是**乘性闭合**（读回当前值再按比例减），眼睛已经被表情闭上时它天然什么都不做 ⇒ 不打架。
 */

import {EXPRESSION_DENY} from "./markerRules"

/** 被摸时播放的表情关键词（子串、大小写不敏感匹配真实表情名） */
export const PET_EXPRESSION_KEYS = ["shy", "smile"] as const

/** 停手后多久收回（用户定：1 秒）。收回本身还有表情自带的 0.5s 淡出 */
export const PET_EXPRESSION_GRACE_MS = 1000

/**
 * 从模型可用表情里挑一个"被摸"的表情（shy / smile **二选一随机**）。
 * 两个都没有（或都被 DENY 挡掉）→ `null`（不硬编名字，换模型也安全）。
 * `rand` 可注入 ⇒ 门禁能精确断言"两个都能被选中"与"越界/NaN 不崩"。
 */
export const pickPetExpression = (available: readonly string[], rand: () => number = Math.random): string | null => {
	if (!Array.isArray(available) || !available.length) return null
	const pool = available.filter((n) => !EXPRESSION_DENY.test(n))
	const hits = pool.filter((n) => PET_EXPRESSION_KEYS.some((k) => n.toLowerCase().includes(k)))
	if (!hits.length) return null
	const r = rand()
	const i = Number.isFinite(r) ? Math.min(hits.length - 1, Math.max(0, Math.floor(r * hits.length))) : 0
	return hits[i]
}

export interface PetExpressionState {
	/** 当前正在展示的表情名（未展示为 null） */
	name: string | null
	/** 是否正在展示 */
	showing: boolean
	/** 最近一次"确实在摸头"的时刻 (ms) */
	lastPetMs: number
}

export const newPetExpressionState = (): PetExpressionState => ({name: null, showing: false, lastPetMs: 0})

/**
 * 推进一步 —— **纯函数**（不改入参）。
 *
 * 语义：
 * - `petting = true`：刷新 `lastPetMs`；名字还在可用列表里就**保持不变**（同一次抚摸不换脸），
 *   否则重挑一个 ⇒ 表现是"整个抚摸过程只播一种表情"
 * - `petting = false`：还在 `PET_EXPRESSION_GRACE_MS` 内就**继续展示同一个**；
 *   超过才收回并把名字清空 ⇒ **下一次抚摸会重新随机**（这就是"不要 10s 锁"的含义）
 */
export const petExpressionStep = (
	st: PetExpressionState,
	now: number,
	petting: boolean,
	available: readonly string[],
	rand: () => number = Math.random,
): {state: PetExpressionState; show: boolean; name: string | null} => {
	if (!Number.isFinite(now)) return {state: st, show: st.showing, name: st.name}
	if (petting) {
		const keep = st.name !== null && Array.isArray(available) && available.includes(st.name)
		const name = keep ? st.name : pickPetExpression(available, rand)
		return {state: {name, showing: name !== null, lastPetMs: now}, show: name !== null, name}
	}
	if (!st.showing) return {state: st, show: false, name: null}
	if (now - st.lastPetMs < PET_EXPRESSION_GRACE_MS) return {state: st, show: true, name: st.name}
	return {state: {name: null, showing: false, lastPetMs: st.lastPetMs}, show: false, name: null}
}

/* ---------------- IO 侧（由 App 的 rAF 循环每帧调用） ---------------- */

export interface PetExpressionHooks {
	play?: (name: string) => void
	stop?: () => void
}

let state: PetExpressionState = newPetExpressionState()

/** 当前展示的表情名（调试/E2E 用） */
export const petExpressionName = (): string | null => state.name
/** 是否正在展示（调试/E2E 用） */
export const petExpressionShowing = (): boolean => state.showing
/**
 * **摸头表情是否正占着"表情层"** —— 聊天回复的表情要让位（用户定的优先级 3）。
 * 调用方（标记/关键词/回中性）在看到它为 true 时应跳过自己的表情操作。
 */
export const petExpressionHoldsLayer = (): boolean => state.showing

/**
 * 每帧调用：推进状态，并**只在状态变化时**才 play/stop（避免反复重置 0.5s 淡入）。
 * @returns 本帧是否仍在展示（App 据此决定要不要继续 rAF）
 */
export const applyPetExpression = (
	now: number,
	petting: boolean,
	available: readonly string[],
	hooks: PetExpressionHooks = {},
	rand: () => number = Math.random,
): boolean => {
	const prev = state
	const step = petExpressionStep(prev, now, petting, available, rand)
	state = step.state
	if (step.show && step.name) {
		// "刚开始" 或 "名字变了" 才播 —— 同一张脸持续期间一个字都不调
		if (!prev.showing || prev.name !== step.name) {
			try { hooks.play?.(step.name) } catch { /* 忽略 */ }
		}
	} else if (prev.showing) {
		try { hooks.stop?.() } catch { /* 忽略 */ }
	}
	return step.show
}

/** **仅供门禁**：重置状态 */
export const __resetPetExpressionForTest = (): void => { state = newPetExpressionState() }
