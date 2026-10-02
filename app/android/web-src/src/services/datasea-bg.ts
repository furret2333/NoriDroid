/**
 * 数据海动态背景 (纯程序渲染, 零素材零下载):
 * 星云光斑漂移 + 星尘粒子 (随手指**缓慢**聚拢) + 透视网格地面.
 * rAF 循环**跟随设置里的「渲染帧率上限」**（`setDataseaFps`，与 Live2D 同一个旋钮、
 * 同一个门限算法 `frameGate`）; document.hidden 由 rAF 天然暂停.
 * 预算: 全屏 canvas 2D, 粒子 ~130 + 大光斑 6 + 星云光斑 4; 底色渐变走 CSS, 画布只画动的东西.
 *
 * ## 触摸响应（2026-09-25 按用户要求改过；纯逻辑在 `datasea-touch.ts`，有门禁）
 * 1. **跟得更慢**：趋近率 0.4 → **0.18 /s**（时间常数 2.5s → 5.6s）
 * 2. **不要一碰到就动**：强度 0→1 **渐入 350ms**；抬手后 400ms 渐出（旧实现是"到点突然停住"）
 * 3. **取消"立即变亮"**：旧代码那句 `boost = (1 - d/R) * 0.35` 直接加 alpha、当帧就亮 —— **已删**
 * 4. 吸引点本身对指尖做 ≈125ms 低通（手指抖动的缓冲）
 * 驱动方式也随之明确成"**按下 = 一次触摸**"：pointerdown → Start、pointermove → Move、
 * pointerup/cancel → End（旧实现只有 move + 1.2s 存活期，按住不动反而会失效）。
 */

import {frameGate, frameDtCapMs, frameThreshold} from "./live2d/frameCap"
import {
	DATASEA_TOUCH_RADIUS,
	newDataseaTouchState,
	dataseaTouchStep,
	dataseaTouchPull,
	dataseaTouchStart as touchStart,
	dataseaTouchMove as touchMove,
	dataseaTouchEnd as touchEnd,
} from "./datasea-touch"

const BLOB_COUNT = 4
const PARTICLE_COUNT = 130
const BOKEH_COUNT = 6

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let raf = 0
let W = 0
let H = 0
let t0 = 0
let enabled = false
/** 门限 (ms, 0 = 不限制) —— 由 setDataseaFps 写入, 与 Live2D 同源 */
let minInterval = 0
/** 上一次**真正画**的时刻 (被跳过的帧不更新它) */
let lastDraw = 0

interface Particle {
	x: number
	y: number
	r: number
	vx: number
	vy: number
	base: number // 基础亮度 0~1
	tw: number // 闪烁频率
	tp: number // 闪烁相位
	bokeh: boolean
}

let particles: Particle[] = []
let glow: HTMLCanvasElement | null = null // 通用光晕 sprite (离屏缓存, 避免每帧建渐变)
/** 触摸响应状态 (按下/移动/抬手的边沿由 App.vue 驱动; 每帧由 dataseaTouchStep 推进) */
let touchState = newDataseaTouchState()
let lastFrame = 0 // 帧间真实时长: 粒子按 dt 移动, 高刷新率屏不再等比加速

const makeGlow = (): HTMLCanvasElement => {
	const c = document.createElement("canvas")
	c.width = 64
	c.height = 64
	const g = c.getContext("2d")!
	const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
	grad.addColorStop(0, "rgba(255,255,255,1)")
	grad.addColorStop(0.35, "rgba(190,235,255,0.55)")
	grad.addColorStop(1, "rgba(190,235,255,0)")
	g.fillStyle = grad
	g.fillRect(0, 0, 64, 64)
	return c
}

const seed = (): void => {
	particles = []
	for (let i = 0; i < PARTICLE_COUNT; i++) {
		const bokeh = i < BOKEH_COUNT
		particles.push({
			x: Math.random() * W,
			y: Math.random() * H * (bokeh ? 0.75 : 1),
			r: bokeh ? 7 + Math.random() * 14 : 0.6 + Math.random() * 1.8,
			vx: (Math.random() - 0.5) * (bokeh ? 4 : 7),
			vy: (Math.random() - 0.5) * (bokeh ? 3 : 5),
			base: bokeh ? 0.10 + Math.random() * 0.10 : 0.25 + Math.random() * 0.6,
			tw: 0.4 + Math.random() * 1.6,
			tp: Math.random() * Math.PI * 2,
			bokeh,
		})
	}
}

const resize = (): void => {
	if (!canvas) return
	const dpr = Math.min(window.devicePixelRatio || 1, 2)
	W = window.innerWidth
	H = window.innerHeight
	canvas.width = Math.round(W * dpr)
	canvas.height = Math.round(H * dpr)
	ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
	seed()
}

const frame = (now: number): void => {
	if (!ctx || !glow) return
	/* 时钟异常就别画了 —— 这个循环要拿 now 算 `t` 与 dt，NaN 会渗进 sin()/坐标，
	   把**所有粒子**变成 NaN 且再也回不来（比"少画一帧"严重得多）。
	   （frameGate 对 NaN 是"画"=fail-open，那是给不需要拿 now 做算术的调用方的语义；
	     这里必须自己先挡，所以这道守卫不是多余的。） */
	if (!Number.isFinite(now)) {
		raf = requestAnimationFrame(frame)
		return
	}
	/* 帧率门控: 与 Live2D 同一个旋钮、同一个 frameGate。
	   不够格就**不画**，但仍然 rAF 排队 —— 保留 rAF 才能与 vsync 整数分频（120→60 无余数），
	   用 setTimeout 会出现一顿一顿的节奏。 */
	const gate = frameGate(now, lastDraw || undefined, minInterval)
	lastDraw = gate.last
	if (!gate.draw) {
		raf = requestAnimationFrame(frame)
		return
	}
	const t = (now - t0) / 1000
	// 粒子按真实帧间时长移动 (帧率无关): 旧实现按"每帧固定步长", 120Hz 屏会比
	// 60Hz 快一倍, 主观漂移感被放大。
	// 注意 dt 的封顶要**跟着门限走**: 限到 15fps 时帧间隔 66.7ms, 若仍夹在 50ms
	// 每帧都被夹掉, 粒子只剩 75% 速度（见 frameCap.frameDtCapMs）。
	const dt = lastFrame ? Math.min((now - lastFrame) / 1000, frameDtCapMs(minInterval) / 1000) : 0.016
	lastFrame = now
	ctx.clearRect(0, 0, W, H)

	// 星云光斑漂移 (screen 叠加, 低透明度大半径; 光晕 sprite 为白色通用款)
	ctx.globalCompositeOperation = "lighter"
	for (let i = 0; i < BLOB_COUNT; i++) {
		const bx = W * (0.5 + 0.34 * Math.sin(t * 0.045 + i * 1.9))
		const by = H * (0.42 + 0.26 * Math.cos(t * 0.038 + i * 1.3))
		const br = Math.max(W, H) * (0.34 + 0.08 * Math.sin(t * 0.05 + i))
		ctx.globalAlpha = 0.10 + 0.03 * Math.sin(t * 0.09 + i * 2.1)
		ctx.drawImage(glow, bx - br, by - br, br * 2, br * 2)
	}

	// 星尘粒子
	/* 触摸响应: 强度/吸引点都由 datasea-touch 推进一步（渐入、低通、渐出都在那边，有门禁）。
	   注意用的是 rAF 的 `now`（与 performance.now() 同一时基），别再调一次 performance.now()。 */
	const tt = dataseaTouchStep(touchState, now, dt)
	touchState = tt.state
	for (const p of particles) {
		p.x += p.vx * dt
		p.y += p.vy * dt
		if (p.x < -20) p.x = W + 20
		if (p.x > W + 20) p.x = -20
		if (p.y < -20) p.y = H + 20
		if (p.y > H + 20) p.y = -20
		// 触摸响应: 靠近手指的粒子**缓慢**聚拢。
		// 旧实现每帧 2% 收敛太快（高刷屏上"嗖"地挤过去），且**一碰到就按满强度**、
		// 还顺手把 alpha 加亮 —— 现在三样都改了：慢趋近 + 350ms 渐入 + 不再变亮。
		if (tt.active) {
			const dx = tt.x - p.x
			const dy = tt.y - p.y
			const k = dataseaTouchPull(dt, Math.hypot(dx, dy), tt.strength)
			if (k > 0) {
				p.x += dx * k
				p.y += dy * k
			}
		}
		const a = Math.max(0, p.base * (0.65 + 0.35 * Math.sin(t * p.tw + p.tp)))
		ctx.globalAlpha = Math.min(1, a)
		const rr = p.r * (p.bokeh ? 1 : 1 + 0.4 * Math.sin(t * p.tw + p.tp) ** 2)
		ctx.drawImage(glow, p.x - rr, p.y - rr, rr * 2, rr * 2)
	}
	ctx.globalAlpha = 1
	ctx.globalCompositeOperation = "source-over"

	// 透视网格地面 (底部 26%, 横线向观者滚动)
	const gy = H * 0.74
	const gh = H - gy
	ctx.strokeStyle = "rgba(56,189,248,0.10)"
	ctx.lineWidth = 1
	const rows = 8
	const scroll = (t * 0.35) % 1
	for (let i = 0; i <= rows; i++) {
		const k = (i + scroll) / rows
		const y = gy + gh * k * k
		ctx.globalAlpha = 0.05 + 0.10 * k
		ctx.beginPath()
		ctx.moveTo(0, y)
		ctx.lineTo(W, y)
		ctx.stroke()
	}
	const cols = 14
	ctx.globalAlpha = 0.07
	for (let i = 0; i <= cols; i++) {
		const x = (W / cols) * i
		ctx.beginPath()
		ctx.moveTo(W / 2 + (x - W / 2) * 0.45, gy)
		ctx.lineTo(x, H)
		ctx.stroke()
	}
	ctx.globalAlpha = 1

	raf = requestAnimationFrame(frame)
}

const startLoop = (): void => {
	if (!raf && enabled) {
		t0 = performance.now() - 1000
		lastFrame = 0
		lastDraw = 0
		raf = requestAnimationFrame(frame)
	}
}

/**
 * 设置背景帧率上限（跟随设置里的「渲染帧率上限」旋钮；0 = 不限制）。
 * 复位计时基准 ⇒ 新档位**下一帧就生效**，不用等一个旧门限周期。
 * 顺带把门限挂到 window 上（与补丁的 `__noriL2dMinInterval` 对称）—— E2E 靠它断言"背景真的同步了"。
 */
export const setDataseaFps = (fps: number): void => {
	minInterval = frameThreshold(fps)
	lastDraw = 0
	;(globalThis as unknown as {__noriDataseaMinInterval?: number}).__noriDataseaMinInterval = minInterval
}

export const initDataseaBg = (canvasEl: HTMLCanvasElement): void => {
	canvas = canvasEl
	ctx = canvasEl.getContext("2d")
	glow = makeGlow()
	resize()
	enabled = true
	startLoop()
}

export const setDataseaBgEnabled = (on: boolean): void => {
	enabled = on
	if (on) {
		if (!ctx && canvas) initDataseaBg(canvas)
		else startLoop()
	} else if (raf) {
		cancelAnimationFrame(raf)
		raf = 0
		ctx?.clearRect(0, 0, W, H)
	}
}

export const resizeDataseaBg = (): void => {
	if (enabled) resize()
}

/** 手指按下 = 开始一次触摸（由 stage 的 pointerdown 驱动）。
 *  ⚠ 必须与 move/up 成对调用：状态机靠 `down` 判定"是不是在触摸"，
 *  漏了 End 会一直保持在满强度（pointercancel 也已接上，见 App.vue 的监听表）。 */
export const dataseaTouchStart = (x: number, y: number): void => {
	touchState = touchStart(touchState, x, y, performance.now())
}

/** 通知指尖位置（只在**已按下**时有意义；悬停/未按下时是空操作） */
export const dataseaTouchMove = (x: number, y: number): void => {
	touchState = touchMove(touchState, x, y)
}

/** 抬手 / 取消：强度在 400ms 内渐出到 0（不是突然停住） */
export const dataseaTouchEnd = (): void => {
	touchState = touchEnd(touchState, performance.now())
}

/**
 * E2E / 实机调试探针（纯读）：触摸状态 + 全部粒子坐标。
 * 为什么要把粒子坐标也给出来：单看 `strength` 只能证明"状态机在跑"，
 * 要看"粒子到底动没动、动了多少"就得有坐标 —— E2E 靠它断言
 * "刚按下 100ms 内几乎没有位移" 与 "按住 1 秒后确实在聚拢"。
 */
;(globalThis as unknown as {__noriDataseaDebug?: () => unknown}).__noriDataseaDebug = () => ({
	down: touchState.down,
	strength: touchState.strength,
	rawX: touchState.rawX,
	rawY: touchState.rawY,
	x: touchState.x,
	y: touchState.y,
	radius: DATASEA_TOUCH_RADIUS,
	px: particles.map((p) => [p.x, p.y]),
})

export const stopDataseaBg = (): void => {
	enabled = false
	if (raf) {
		cancelAnimationFrame(raf)
		raf = 0
	}
}
