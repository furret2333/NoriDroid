/**
 * 抚摸采样器 —— 从 NoriOS 网页版的 headPat 移植过来。**纯函数, 无 DOM / 无副作用 / 可单测**。
 *
 * ## 出处（可复查）
 * 网页版离线归档 `os.inori.ai/assets/NormalApp-Co7fh3WA.js`:
 *   - 采样器 `r8e(getTuning)`（偏移 @2423800 起）
 *   - 调参对象 `w4`（@2423947, 常量名 `DEFAULT_NORI_PAT_TUNING`）
 * 安卓端原来只有"按住 260ms 就进入抚摸"（`STROKE_DELAY`），**没有"摸了多少 / 摸完一次"的概念**。
 *
 * ## 语义（与网页版逐条对齐）
 * - 只有**横向为主**（`|dx| >= horizontalDominance * |dy|`）且**速度够快**（`|vx| >= minSpeedX`）
 *   的采样才"合格"；且采样间隔必须 `<= maxSampleGapMs`（默认 250ms），否则该次作废。
 * - 合格采样把**采样间隔时长**累加进进度；不合格的**不累加、也不清零** —— 网页版就是这样。
 *   ⇒ 中途停顿后再摸，之前的进度仍然保留。这是原版行为，不是 bug（有断言钉住）。
 * - 进度累计到 `requiredMs`（默认 1000ms）算**完成一次**；一次抚摸（按下→抬起）
 *   最多完成一次 —— 用 latch 锁住，直到 `end()` 或下一次 `start()`。
 *
 * ## 单位
 * x/y 的单位由调用方决定。网页版传的是**头宽**（head-widths，其 Debug 面板标签为
 * `Stroke velocity: x.xx head-widths/s`），所以 `minSpeedX=0.05` 与速度饱和值 3 都是头宽量纲。
 * 安卓端传归一化坐标（除以头宽或模型框宽）即可沿用同一组阈值。
 *
 * ## 为什么单独一个文件
 * 这类逻辑原来只会写在 rAF / pointermove 回调里 —— Node 门禁测不到，等于没验证。
 * 抽成纯函数后由 `tmp-memcheck/run-marker-tests.mjs` 第 13 节守。
 * （先例：`petSwayAmp()` 也是这么从 rAF 里抽出来的。）
 */

export interface PetStrokeTuning {
	/** 累计多少"合格移动时长"算完成一次（ms） */
	requiredMs: number
	/** 横向分量至少是纵向的几倍，才算"横向为主" */
	horizontalDominance: number
	/** 横向速度下限（单位/秒） */
	minSpeedX: number
	/** 两次采样间隔超过这个值就作废（ms）—— 防止"慢慢挪一下"被当作连续抚摸 */
	maxSampleGapMs: number
}

/** 与网页版 `w4` / `DEFAULT_NORI_PAT_TUNING` 同值（只取采样器需要的四项） */
export const DEFAULT_PET_STROKE_TUNING: PetStrokeTuning = {
	requiredMs: 1000,
	horizontalDominance: 1,
	minSpeedX: 0.05,
	maxSampleGapMs: 250,
}

export interface PetStrokeSample {
	/** 本次采样是否让进度达到 requiredMs —— 一次抚摸里只会 true 一次 */
	completed: boolean
	/** 当前累计进度（ms，封顶 requiredMs） */
	progressMs: number
	/** 本次采样是否合格（横向为主 **且** 速度够） */
	qualifying: boolean
	/** 本次采样的横向速度（单位/秒；不合格时为 0） */
	velocityX: number
}

/** 未激活 / 未开始时 move 的返回值（冻结，避免调用方误改共享对象） */
export const PET_STROKE_IDLE: PetStrokeSample = Object.freeze({
	completed: false,
	progressMs: 0,
	qualifying: false,
	velocityX: 0,
})

export interface PetStrokeDetector {
	readonly active: boolean
	readonly progressMs: number
	/** 开始一次抚摸（按下）—— 同时清零进度与 latch */
	start(nowMs: number, x: number, y: number): void
	/** 喂一个采样点（pointermove）；返回本次判定结果 */
	move(nowMs: number, x: number, y: number): PetStrokeSample
	/** 结束抚摸（抬起 / 命中丢失）—— 复位，下次 start 重新计数 */
	end(): void
}

export const createPetStrokeDetector = (
	getTuning: () => PetStrokeTuning = () => DEFAULT_PET_STROKE_TUNING,
): PetStrokeDetector => {
	let active = false
	let latched = false
	let progress = 0
	let lastT = 0
	let lastX = 0
	let lastY = 0

	/** 不合格但进度仍有效的返回（进度原样带出，方便调试面板显示） */
	const rejected = (): PetStrokeSample => ({completed: false, progressMs: progress, qualifying: false, velocityX: 0})

	return {
		get active() {
			return active
		},
		get progressMs() {
			return progress
		},
		start(nowMs: number, x: number, y: number) {
			active = true
			latched = false
			progress = 0
			lastT = nowMs
			lastX = x
			lastY = y
		},
		move(nowMs: number, x: number, y: number) {
			if (!active) return PET_STROKE_IDLE
			const t = getTuning()
			// 非有限输入先挡掉, 且**不更新基准点** —— 网页版是先赋值再判定的, 一旦收到 NaN
			// 基准点会被污染, 之后每次 dt 都是 NaN, 整个采样器就废了(要等下一次 start 才好)。
			// 这里提前返回即"丢帧", 下一个正常采样照常工作。
			if (!Number.isFinite(nowMs) || !Number.isFinite(x) || !Number.isFinite(y)) return rejected()

			const dt = nowMs - lastT
			const dx = x - lastX
			const dy = y - lastY
			// 再更新基准点（网页版也是先更新再判定）—— 不合格的采样同样会推进基准,
			// 否则慢速滑动会不断累积 dx 从而"突然"变合格。
			lastT = nowMs
			lastX = x
			lastY = y

			// 间隔非法: dt<=0 会算出 Infinity 速度, 超过 maxSampleGapMs 说明中间断档
			if (dt <= 0 || dt > t.maxSampleGapMs) return rejected()

			const vx = dx / (dt / 1000)
			const horizontal = Math.abs(dx) >= t.horizontalDominance * Math.abs(dy)
			const fastEnough = Math.abs(vx) >= t.minSpeedX
			if (!horizontal || !fastEnough) return rejected()

			progress = Math.min(t.requiredMs, progress + dt)
			const completed = !latched && progress >= t.requiredMs
			if (completed) latched = true
			return {completed, progressMs: progress, qualifying: true, velocityX: vx}
		},
		end() {
			active = false
			latched = false
			progress = 0
		},
	}
}
