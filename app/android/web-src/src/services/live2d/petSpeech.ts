/**
 * 摸头台词 —— 摸到头时**用 TTS 说一句**（用户给的 10 句语料），**10 秒内只说一次**。
 *
 * ## 规格（用户定，逐条对应）
 * 1. 摸到头 → 从给定的 10 句里**任意说一段**（随机）
 * 2. **从第一次摸头后 10s 内只触发一次输出** —— 实现成"以**上一次真的说了话**为锚的 10s 冷却"：
 *    第一次摸头必定说，之后每满 10s 才可能再说（一直摸着 ≈ 每 10s 一句）
 * 3. 台词来自用户文档，**只做一处"省略号归一"**：第 6 句的 `....`（4 个英文句点）→ `…`
 *    （与第 10 句同一写法）。其余 9 句一字不改。归一的原因：TTS 对连续英文句点的停顿**不可控**
 *    （有的念成"点点点点"，有的干脆不顿），而 `…` 是明确的停顿标记。
 * 4. **只有摸到头**才说（判定在调用方：`stroking && onNoriHead`）
 *
 * ## 为什么台词表放这里而不是塞进 App.vue
 * 这张表要能被 **Node 门禁逐字对拍**（`tmp-memcheck/run-pet-speech-tests.mjs`）——
 * 手抄中文台词必错标点，`?`/`？`、`...`/`…` 肉眼几乎不可分。放纯模块里才能自动核对。
 *
 * ## 为什么用"洗牌袋"而不是每次独立随机
 * 10 句独立随机时，连着两次摸头说出同一句的概率是 1/10，实际体感就是"怎么老是这句"。
 * 洗牌袋保证 **10 句全部说完之前不会重复**，且重装袋子时**不与刚说的那句相连**。
 *
 * ## 本模块**不做**的事（都在 App.vue 的 IO/策略层）
 * - TTS 是否就绪（`isTtsReady`）→ 不就绪时**不说，且不消耗窗口**（配好 Key 后第一次摸头就能听到）
 * - 正在朗读/正在生成回复时**跳过、不打断**（同样**不消耗**窗口）
 * - 气泡呈现（复用 `.ai-bubble`，开口出现、说完即收）
 */

/** 台词表 —— 取自用户给的文档（10 条，顺序照抄）。
 *  ⚠ 唯一一处偏离原文：第 6 句的 `....`（4 个英文句点）已按用户要求**归一为 `…`**
 *  （与第 10 句同一写法）；其余 9 句逐字未改。
 *  ⚠ 改动这里必须同步跑 `node tmp-memcheck/run-pet-speech-tests.mjs`：
 *  门禁里写死了**文档原文**与**本表**两份期望值，逐条对拍，不一致会直接 FAIL。 */
export const PET_LINES: readonly string[] = [
	"头发都被你揉乱啦。",
	"再摸就要收费啦。",
	"Nori不是小狗啦。",
	"为什么摸我的头呀。",
	"你摸Nori，Nori也不会掉毛的。",
	"好乖…啊，说反了，是你在摸我。",
	"只有Nori有摸头待遇吗？",
	"嘿嘿，摸摸头很舒服，感觉芯片都要开心得发热了。",
	"这算是表扬吗？那我记下来了。",
	"被摸头…有点想睡了。",
]

/** 两句之间的最小间隔（ms）—— "从第一次摸头后 10s 内只触发一次输出" */
export const PET_SPEECH_WINDOW_MS = 10_000

/** 台词状态（纯数据，便于单测） */
export interface PetSpeechState {
	/** 上一次**真的说了话**的时刻；从未说过是 `-Infinity`（首次摸头必定触发） */
	lastSpokeAt: number
	/** 洗牌袋里**还没用过**的台词下标 */
	bag: number[]
	/** 上一次说出去的下标（`-1` = 还没说过）—— 用来保证不紧接着重复 */
	lastIdx: number
}

export const newPetSpeechState = (): PetSpeechState => ({
	lastSpokeAt: Number.NEGATIVE_INFINITY,
	bag: [],
	lastIdx: -1,
})

/** Fisher-Yates 洗牌；`rand` 注入以便门禁确定性地测两条分支。
 *  `rand()` 返回非有限值时按 0 处理（与 `petExpression.pickPetExpression` 同一套容错口径）。 */
const shuffle = (n: number, rand: () => number): number[] => {
	const idx = Array.from({length: n}, (_, i) => i)
	for (let i = n - 1; i > 0; i--) {
		const r = rand()
		const j = Number.isFinite(r) ? Math.min(i, Math.max(0, Math.floor(r * (i + 1)))) : 0
		const t = idx[i]
		idx[i] = idx[j]
		idx[j] = t
	}
	return idx
}

/** 从袋里取一条：袋空则重装；重装后若第一条恰是"刚说过的那句"，与下一条对调。 */
const drawLine = (st: PetSpeechState, rand: () => number): {idx: number; bag: number[]} => {
	const bag = st.bag.length ? st.bag.slice() : shuffle(PET_LINES.length, rand)
	let idx = bag.shift() ?? 0
	// 不紧接着重复: 把撞上的那句挪到袋尾, 本次用下一条 (袋里每个下标仍恰好一份)
	if (idx === st.lastIdx && bag.length > 0) {
		const alt = bag.shift() as number
		bag.push(idx)
		idx = alt
	}
	return {idx, bag}
}

/**
 * **纯决策**：这一刻该不该说、说哪一句。
 *
 * - 窗口**没到** → `line: null` 且**状态原样返回**（调用方可以放心地当"没发生"）
 * - 窗口到了 → 推进 `lastSpokeAt = now` 并抽一句
 * - `now` 非有限（NaN/Infinity）→ `line: null` 且不动状态（时间坏了不该乱说话）
 */
export const petSpeechDraw = (
	st: PetSpeechState,
	now: number,
	rand: () => number = Math.random,
): {state: PetSpeechState; line: string | null} => {
	if (!Number.isFinite(now) || PET_LINES.length === 0) return {state: st, line: null}
	// 首次 (lastSpokeAt = -Infinity) 必定通过; lastSpokeAt 若是 NaN 也按"没说过"处理
	if (Number.isFinite(st.lastSpokeAt) && now - st.lastSpokeAt < PET_SPEECH_WINDOW_MS) {
		return {state: st, line: null}
	}
	const {idx, bag} = drawLine(st, rand)
	return {state: {lastSpokeAt: now, bag, lastIdx: idx}, line: PET_LINES[idx] ?? null}
}

/* ---------------- 有状态入口 + 调试探针 ---------------- */

let state = newPetSpeechState()
let count = 0
let lastLine: string | null = null

/**
 * 摸头时调用（App.vue 的两处"确认摸到头"边沿）。
 * @returns 要朗读的台词；本次不说则 null
 */
export const maybePetSpeechLine = (now: number, rand: () => number = Math.random): string | null => {
	const step = petSpeechDraw(state, now, rand)
	state = step.state
	if (step.line === null) return null
	count += 1
	lastLine = step.line
	return step.line
}

/** 调试/实测探针：实际说出去了几句 */
export const petSpeechCount = (): number => count
/** 调试/实测探针：最后说出的一句 */
export const petSpeechLastLine = (): string | null => lastLine
/** 调试/实测探针：距离"可以再说"还差多少 ms（0 = 现在就可以说） */
export const petSpeechWaitMs = (now: number): number => {
	if (!Number.isFinite(now) || !Number.isFinite(state.lastSpokeAt)) return 0
	return Math.max(0, PET_SPEECH_WINDOW_MS - (now - state.lastSpokeAt))
}

/** 只给门禁/E2E 用：清空状态（含计数） */
export const __resetPetSpeechForTest = (): void => {
	state = newPetSpeechState()
	count = 0
	lastLine = null
}
