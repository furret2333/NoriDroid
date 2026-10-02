/**
 * 抚摸时的轻量级特效：**柔和的白/冰蓝微光粒子**（贴合数据海背景的视觉语言）。
 *
 * ## 为什么是"微光粒子"而不是爱心
 *
 * 第一版做的是粉色 ♥ 字形，实机反馈**太违和**：字形有硬边、粉色和数据海的冷色背景冲突。
 * 数据海（`services/datasea-bg.ts`）自己的语言是：
 *   粒子 sprite = 径向渐变 `白 → rgba(190,235,255,0.55) → 透明`，星尘半径 0.6~2.4px、
 *   光斑半径 7~21px 且透明度只 0.10~0.20，整体冷色、低对比。
 * 所以这里照同一套配色与"柔"的程度来做：**无字形、边缘全透明、低透明度、慢速上浮**。
 *
 * ## 其它设计取舍（2026-09-23/24）
 *
 * - **不用 canvas 粒子，不占 rAF**：DOM + Web Animations API，动画只碰 transform / opacity，
 *   由合成器驱动，**不额外占用 JS 帧**（live2d 那边本来就有帧率节流，这里不该再抢）。
 * - **零素材**：只用 CSS 径向渐变，不引入图片或音频。
 * - **绝不挡触摸**：整层 `pointer-events: none`。摸头、头部跟随、触摸区命中全靠 canvas 上的
 *   pointer 事件 —— 特效层一旦可点，就会把摸头打断。
 * - **有上限**：同时存活的粒子数封顶（`MAX_LIVE`），生成频率由调用方节流；
 *   动画结束（或被打断）自动移除元素，不泄漏 DOM。
 * - **层级**：z-index 3 —— 在 canvas(1) 与触摸调试层(2) 之上，所有 UI(≥4) 之下。
 *
 * 主 App 与悬浮窗共用本模块，避免两边各写一套。
 */

const LAYER_ID = "nori-pet-fx"
/** 同时存活的粒子上限 —— 超了就跳过本次生成（宁少不卡）。
 *  从 10 提到 28：Phase 2 加了"完成爆发"（3 圈涟漪 + 8 波火花），
 *  上限太小会把奖励特效裁掉一半。DOM + WAAPI 的 28 个元素仍然很便宜。 */
const MAX_LIVE = 28
const Z_INDEX = "3"

/** 与数据海同源的柔光: 白心 → 冰蓝 → 全透明 (没有硬边, 所以不像贴图) */
const MOTE_GLOW = "radial-gradient(circle, rgba(255,255,255,0.92) 0%, rgba(190,235,255,0.48) 42%, rgba(190,235,255,0) 100%)"
/** 直径范围 (px)。取数据海光斑的下半段: 星尘 1~5px 太小看不见, 光斑 14~42px 又太抢 */
const MOTE_SIZE_MIN = 10
const MOTE_SIZE_MAX = 20

let layer: HTMLDivElement | null = null
let live = 0
/** 累计生成计数 (按类型) —— 给 E2E 做**确定性**证据用:
 *  DOM 抽查受采样时机影响(粒子寿命只有 0.x 秒), 数"生成了几颗"才不受延迟影响。 */
const spawned = {mote: 0, star: 0, ripple: 0}

/** 累计生成数 (供 E2E/诊断; 返回副本, 调用方改不到内部状态) */
export const petFxSpawned = (): {mote: number; star: number; ripple: number} => ({...spawned})

/** 动画结束（或被打断）→ 计数减一 + 移除元素。绝不泄漏 DOM */
const release = (anim: Animation, el: HTMLElement): void => {
	let released = false
	const done = () => {
		if (released) return
		released = true
		live = Math.max(0, live - 1)
		el.remove()
	}
	anim.addEventListener("finish", done)
	anim.addEventListener("cancel", done)
}

const ensureLayer = (): HTMLDivElement | null => {
	if (typeof document === "undefined" || !document.body) return null
	if (layer && layer.isConnected) return layer
	layer = document.createElement("div")
	layer.id = LAYER_ID
	layer.setAttribute("aria-hidden", "true")
	layer.style.cssText = `position:fixed;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:${Z_INDEX}`
	document.body.appendChild(layer)
	return layer
}

export interface PetFxOptions {
	/** 本次生成几个（会被上限裁剪） */
	count?: number
	/** 水平散布半径 px */
	spread?: number
	/** 上升高度 px */
	rise?: number
}

/** 在屏幕坐标 (x, y) 处冒一小簇柔光粒子（手指位置 / 模型头部） */
export const spawnPetMotes = (x: number, y: number, opts: PetFxOptions = {}): void => {
	const host = ensureLayer()
	if (!host) return
	const room = MAX_LIVE - live
	if (room <= 0) return
	const count = Math.max(1, Math.min(opts.count ?? 1, room))
	const spread = opts.spread ?? 24
	const rise = opts.rise ?? 52
	for (let i = 0; i < count; i += 1) {
		const el = document.createElement("span")
		el.className = "nori-pet-mote"
		el.dataset.kind = "mote"
		const size = MOTE_SIZE_MIN + Math.random() * (MOTE_SIZE_MAX - MOTE_SIZE_MIN)
		el.style.cssText = [
			"position:absolute",
			`left:${(x + (Math.random() - 0.5) * spread).toFixed(1)}px`,
			`top:${(y + (Math.random() - 0.5) * spread * 0.5).toFixed(1)}px`,
			`width:${size.toFixed(1)}px`,
			`height:${size.toFixed(1)}px`,
			"border-radius:50%",
			`background:${MOTE_GLOW}`,
			"will-change:transform,opacity",
			"user-select:none",
			"-webkit-user-select:none",
		].join(";")
		host.appendChild(el)
		live += 1
		spawned.mote += 1
		// 峰值透明度刻意压低 (0.42~0.66): 数据海的光斑才 0.10~0.20, 这里要"看得见但不突兀"
		const peak = 0.42 + Math.random() * 0.24
		const dx = (Math.random() - 0.5) * 22
		const dy = -(rise + Math.random() * 22)
		const anim = el.animate(
			[
				{transform: "translate(-50%,-50%) scale(0.82)", opacity: 0},
				{transform: `translate(calc(-50% + ${(dx * 0.45).toFixed(1)}px), calc(-50% + ${(dy * 0.45).toFixed(1)}px)) scale(1)`, opacity: peak, offset: 0.3},
				{transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(0.92)`, opacity: 0},
			],
			// 慢一点 (1.2~1.7s) 才"柔和"; 快闪会显突兀
			{duration: 1200 + Math.random() * 500, easing: "cubic-bezier(0.25,0.46,0.45,0.94)", fill: "forwards"},
		)
		release(anim, el)
	}
}

/** 清掉整个特效层（离开页面 / 重建挂载时调用） */
export const clearPetFx = (): void => {
	generation += 1                       // 让所有"延迟批次"失效
	for (const id of timers) window.clearTimeout(id)
	timers.clear()
	live = 0
	if (layer) {
		layer.remove()
		layer = null
	}
}

/** 当前存活的粒子数（供 E2E 断言与诊断） */
export const petFxCount = (): number => (layer ? layer.childElementCount : 0)

/** 特效层 id（供 E2E 断言） */
export const petFxLayerId = (): string => LAYER_ID

/** 柔光渐变本身（供 E2E 断言"是软边而不是字形/实心块"） */
export const petMoteGlow = (): string => MOTE_GLOW

/* ================= Phase 2: 三层特效的另外两层 =================
 *
 * 移植自网页版 headPat 的 `h8e`(碰到头) 与 `p8e`(完成一次)。**照抄的是**:
 *   数量(3 颗 / 8 波)、角度(均布 360° / 一律向上 π/2 ± 抖动)、时序(110ms / 130,280ms / 每 70ms 一波)、
 *   以及配色 —— 网页版三个色值 `Lu{0.42,0.86,1}` `zf{0.78,0.94,1}` `s8e{0.62,0.98,0.87}`。
 * 尺寸/透明度按 **2D DOM 像素重新取值**（网页版那套数是在它自己的 3D 粒子引擎世界单位里,
 * 直接搬没有意义）: 只保留它与"头宽"的比例关系, 用 `PET_FX_UNIT_PX` 换算。
 *
 * **有意不抄的两点**:
 * 1. 网页版的 "star" 是粒子引擎里的星形 sprite。这里**不做字形/硬边图形** ——
 *    第一版粉色 ♥ 字形实机反馈"太违和"。star 改用"更小、更亮、核心更紧"的圆点代替。
 * 2. 网页版"抚摸中"是每 80ms 一颗小火花(12.5/s)。这里保留现有 260ms 一颗柔光粒子
 *    （那套密度已被认可为"不突兀"），不三倍加密度。想试 80ms 只改 `PET_FX_INTERVAL_MS`。 */

/** 换算基准: 网页版单位 → px。取 60 让"完成"的三圈涟漪落在 72/120/174px 这个肉眼合适的区间 */
export const PET_FX_UNIT_PX = 60
/** 网页版色板 (alpha 由各效果自己定): Lu / zf / s8e */
export const PET_FX_COLORS = {
	lu: "rgba(107,219,255,",
	zf: "rgba(199,240,255,",
	mint: "rgba(158,250,222,",
}
/** star 用的"更紧更亮"的渐变 (与柔光粒子的 MOTE_GLOW 区分开) */
const STAR_GLOW = (color: string): string =>
	`radial-gradient(circle, rgba(255,255,255,0.98) 0%, ${color}0.55) 30%, ${color}0) 72%)`

let generation = 0
const timers = new Set<number>()

/** 延迟批次: 记 generation, clearPetFx 之后不再往已销毁的层里塞东西 */
const later = (ms: number, fn: () => void): void => {
	const g = generation
	const id = window.setTimeout(() => {
		timers.delete(id)
		if (g !== generation) return
		fn()
	}, ms)
	timers.add(id)
}

const rand = (a: number, b: number): number => a + (b - a) * Math.random()

/** 一颗火花 (网页版 sparkle): 沿 angle 方向飞 speed×lifespan 的距离后消失 */
const spawnSpark = (x: number, y: number, s: {kind: string; color: string; angle: number; speed: number; size: number; lifespan: number}): void => {
	const host = ensureLayer()
	if (!host || live >= MAX_LIVE) return
	const el = document.createElement("span")
	el.className = s.kind === "star" ? "nori-pet-star" : "nori-pet-mote"
	el.dataset.kind = s.kind
	const size = Math.max(3, s.size * PET_FX_UNIT_PX)
	const dist = Math.max(4, s.speed * s.lifespan * PET_FX_UNIT_PX)
	const dx = Math.cos(s.angle) * dist
	const dy = -Math.sin(s.angle) * dist       // 屏幕 y 向下, 所以取负
	el.style.cssText = [
		"position:absolute",
		`left:${x.toFixed(1)}px`,
		`top:${y.toFixed(1)}px`,
		`width:${size.toFixed(1)}px`,
		`height:${size.toFixed(1)}px`,
		"border-radius:50%",
		`background:${s.kind === "star" ? STAR_GLOW(s.color) : MOTE_GLOW}`,
		"will-change:transform,opacity",
		"user-select:none",
		"-webkit-user-select:none",
	].join(";")
	host.appendChild(el)
	live += 1
	if (s.kind === "star") spawned.star += 1
	else spawned.mote += 1
	const peak = s.kind === "star" ? 0.85 : 0.6
	const anim = el.animate(
		[
			{transform: "translate(-50%,-50%) scale(0.5)", opacity: 0},
			{transform: `translate(calc(-50% + ${(dx * 0.5).toFixed(1)}px), calc(-50% + ${(dy * 0.5).toFixed(1)}px)) scale(1)`, opacity: peak, offset: 0.25},
			{transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(0.6)`, opacity: 0},
		],
		{duration: Math.max(120, s.lifespan * 1000), easing: "cubic-bezier(0.25,0.46,0.45,0.94)", fill: "forwards"},
	)
	release(anim, el)
}

/** 一圈涟漪 (网页版 ripple): 由小放大 + 淡出, flash>0 时开头有一记亮闪 */
const spawnRipple = (x: number, y: number, r: {color: string; radius: number; lifespan: number; flash: number; intensity: number; width: number}): void => {
	const host = ensureLayer()
	if (!host || live >= MAX_LIVE) return
	const el = document.createElement("span")
	el.className = "nori-pet-ripple"
	el.dataset.kind = "ripple"
	const size = Math.max(12, r.radius * PET_FX_UNIT_PX * 2)
	const bw = Math.max(1, r.width * PET_FX_UNIT_PX)
	const flash = r.flash > 0 ? Math.min(1, r.flash * 2.4) : 0
	el.style.cssText = [
		"position:absolute",
		`left:${x.toFixed(1)}px`,
		`top:${y.toFixed(1)}px`,
		`width:${size.toFixed(1)}px`,
		`height:${size.toFixed(1)}px`,
		"border-radius:50%",
		"background:transparent",
		`border:${bw.toFixed(1)}px solid ${r.color}0.85)`,
		`box-shadow:0 0 ${(bw * 2).toFixed(1)}px ${r.color}0.3)`,
		"will-change:transform,opacity",
		"user-select:none",
		"-webkit-user-select:none",
	].join(";")
	host.appendChild(el)
	live += 1
	spawned.ripple += 1
	const anim = el.animate(
		[
			{transform: "translate(-50%,-50%) scale(0.12)", opacity: flash},
			{transform: "translate(-50%,-50%) scale(0.62)", opacity: Math.min(1, r.intensity), offset: 0.22},
			{transform: "translate(-50%,-50%) scale(1)", opacity: 0},
		],
		{duration: Math.max(160, r.lifespan * 1000), easing: "cubic-bezier(0.16,0.62,0.36,1)", fill: "forwards"},
	)
	release(anim, el)
}

/**
 * **碰到头**的一记 (网页版 `h8e`): 3 颗火花均布 360° + 一圈涟漪 + 延迟 110ms 的第二圈。
 * 只在进入抚摸的那一刻放一次 —— 所以可以比"抚摸中"的粒子显眼一点。
 */
export const spawnPetTouchBurst = (x: number, y: number): void => {
	const lu = PET_FX_COLORS.lu
	const zf = PET_FX_COLORS.zf
	for (let i = 0; i < 3; i += 1) {
		spawnSpark(x, y, {
			kind: "star",
			color: Math.random() < 0.5 ? lu : zf,
			angle: (i / 3) * Math.PI * 2 + rand(-0.4, 0.4),
			speed: rand(0.35, 0.7),
			size: rand(0.08, 0.12),
			lifespan: rand(0.35, 0.55),
		})
	}
	spawnRipple(x, y, {color: lu, radius: 0.34, lifespan: 0.55, flash: 0.22, intensity: 0.48, width: 0.06})
	later(110, () => spawnRipple(x, y, {color: zf, radius: 0.52, lifespan: 0.65, flash: 0, intensity: 0.24, width: 0.05}))
}

/**
 * **完成一次**的奖励爆发 (网页版 `p8e`): 三圈逐级放大的涟漪(0/130/280ms) + 8 波向上飞散的火花(每 70ms)。
 * 每摸满 `requiredMs`(默认 1s) 触发一次 —— 这是"完成"的视觉兑现, 用网页版的时序逐条对齐。
 */
export const spawnPetComplete = (x: number, y: number): void => {
	const lu = PET_FX_COLORS.lu
	const zf = PET_FX_COLORS.zf
	const mint = PET_FX_COLORS.mint
	spawnRipple(x, y, {color: lu, radius: 0.6, lifespan: 0.65 + 0.6 * 0.35, flash: 0.28, intensity: 0.5, width: 0.065})
	later(130, () => spawnRipple(x, y, {color: zf, radius: 1, lifespan: 0.65 + 1 * 0.35, flash: 0, intensity: 0.36, width: 0.055}))
	later(280, () => spawnRipple(x, y, {color: zf, radius: 1.45, lifespan: 0.65 + 1.45 * 0.35, flash: 0, intensity: 0.24, width: 0.048}))
	for (let i = 0; i < 8; i += 1) {
		later(i * 70, () => {
			const star = i % 3 === 0
			spawnSpark(x, y, {
				kind: star ? "star" : "mote",
				color: star ? zf : (Math.random() < 0.5 ? lu : mint),
				angle: Math.PI / 2 + rand(-0.16, 0.16),   // 一律向上
				speed: rand(0.55, 0.85),
				size: star ? rand(0.09, 0.13) : rand(0.055, 0.09),
				lifespan: rand(0.75, 1.1),
			})
		})
	}
}

/* ---------------- 抚摸幅度曲线 ----------------
 * 放在本模块是为了**能被门禁单测** —— App.vue 里的 rAF 循环没法在 Node 里跑,
 * 而"幅度渐强"这条行为必须可验证。
 *
 * 只让**幅度**随时长渐强, **频率恒定**: 旧版固定 10px/0.86Hz 被评价"像马达在震",
 * 问题出在频率, 不是幅度。 */

/** 起手幅度 (px) */
export const PET_SWAY_AMP_MIN = 5
/** 摸久了的最大幅度 (px) */
export const PET_SWAY_AMP_MAX = 9
/** 从起手涨到最大需要的连续抚摸时长 (ms) */
export const PET_SWAY_RAMP_MS = 2500

/** 抚摸 elapsedMs 毫秒后的摆动幅度 (线性渐强, 到顶封住) */
export const petSwayAmp = (elapsedMs: number): number => {
	const p = Math.max(0, Math.min(1, (Number.isFinite(elapsedMs) ? elapsedMs : 0) / PET_SWAY_RAMP_MS))
	return PET_SWAY_AMP_MIN + (PET_SWAY_AMP_MAX - PET_SWAY_AMP_MIN) * p
}
