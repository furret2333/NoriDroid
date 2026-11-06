import {ref, type Ref} from "vue"
import type {createLive2D} from "../services/live2d"
import {normalizeRenderScale} from "../services/live2d/renderScale"
import {canvasPointFromClient} from "../services/live2d/stage"
import type {createBackgroundController} from "../services/background-controller"
import {ambientTouch} from "../services/ambient"
import {habitRecord} from "../services/habit"
import {cancelReturnToNeutral} from "../services/live2d/motionReturn"
import {spawnPetMotes, spawnPetTouchBurst, spawnPetComplete, clearPetFx, petSwayAmp, petFxSpawned} from "../services/live2d/petEffect"
import {createPetStrokeDetector, DEFAULT_PET_STROKE_TUNING} from "../services/live2d/petStroke"
import {petAudioPrime, petAudioTouch, petAudioStroke, petAudioComplete, petAudioRelease, petAudioState} from "../services/live2d/petAudio"
import {pickHeadBox, inHeadZoneHysteresis, headZoneLine, type PetPartBox} from "../services/live2d/petHeadZone"
import {applyPetExpression, petExpressionName, petExpressionShowing} from "../services/live2d/petExpression"
import {petSpeechCount, petSpeechLastLine, petSpeechWaitMs} from "../services/live2d/petSpeech"
import {blinkCount, blinkClosureNow} from "../services/live2d/blink"
import type {AppSettings} from "./useAppSettings"
import type {useTouchEditor} from "./useTouchEditor"

type TouchEditor = Pick<ReturnType<typeof useTouchEditor>,
	"touchDrawing" | "touchAdjusting" | "touchTesting" | "touchEnabled" |
	"detector" | "modelSize" | "onDrawDown" | "onDrawMove" | "onDrawUp">
type StageBackground = Pick<ReturnType<typeof createBackgroundController>, "touchStart" | "touchMove" | "touchEnd">

export interface StageInteractionOptions {
	l2d: ReturnType<typeof createLive2D>
	settings: () => Readonly<Pick<AppSettings,
		"petTouchEnabled" | "petTouchEffects" | "petTouchSound" | "petTouchSpeech" |
		"lookFlipX" | "lookFlipY" | "lookSens" | "renderScale">>
	ready: Readonly<Ref<boolean>>
	expressions: Readonly<Ref<string[]>>
	panel: Readonly<Ref<string>>
	scale: Readonly<Ref<number>>
	offsetX: Readonly<Ref<number>>
	offsetY: Readonly<Ref<number>>
	touchEditor: () => TouchEditor
	background: () => StageBackground
	persistSettings: () => string
	notify: (text: string, durationMs?: number) => void
	replyBusy: () => boolean
	maybeSpeakPetLine: () => void
	clearTransformTouches: () => void
}

/** Stage gestures and pet feedback. App keeps listener wiring and lifecycle order explicit. */
export const useStageInteraction = ({
	l2d, settings, ready, expressions, panel, scale, offsetX, offsetY,
	touchEditor, background, persistSettings, notify, replyBusy, maybeSpeakPetLine, clearTransformTouches,
}: StageInteractionOptions) => {
	const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
	const onPetTouchSetting = () => {
		persistSettings()
		if (!settings().petTouchSound) petAudioRelease()
		if (!settings().petTouchEffects) clearPetFx()
	}

	let stagePointers = 0
	const activeStagePointers = new Set<number>()
	let petOwnsGesture = false
	const petFeedbackEnabled = () => settings().petTouchEnabled || settings().petTouchEffects || settings().petTouchSound || settings().petTouchSpeech
	const claimPetGesture = () => { if (petFeedbackEnabled()) { petOwnsGesture = true; touchEditor().detector.cancel() } }

	/* ---------------- 手指触摸追踪 (半透明小白点) ---------------- */
	const touchDotHost = ref<HTMLElement | null>(null)
	/** 每个活动手指的 dot 元素 */
	const touchDots = new Map<number, HTMLElement>()

	/** 手指按下: 在对应位置生成白点 (内联样式, 避免 scoped CSS 不作用于动态元素) */
	const spawnTouchDot = (pointerId: number, x: number, y: number) => {
		if (!touchDotHost.value) return
		let dot = touchDots.get(pointerId)
		if (!dot) {
			dot = document.createElement("div")
			// 内联全部样式: 动态创建的 div 不在 Vue 模板中, scoped CSS 不生效
			Object.assign(dot.style, {
				position: "absolute",
				width: "22px",
				height: "22px",
				borderRadius: "50%",
				background: "radial-gradient(circle at 35% 30%, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.4) 55%, rgba(255,255,255,0.1) 100%)",
				border: "1px solid rgba(255,255,255,0.55)",
				boxShadow: "0 0 12px rgba(255,255,255,0.35), inset 0 0 6px rgba(255,255,255,0.3)",
				opacity: "1",
				willChange: "transform",
				transition: "opacity 0.28s ease-out",
				pointerEvents: "none",
				zIndex: "50",
				left: "0",
				top: "0",
			})
			touchDotHost.value.appendChild(dot)
			touchDots.set(pointerId, dot)
		}
		dot.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
		dot.style.opacity = "1"
	}

	/** 手指移动: 更新 dot 位置 */
	const moveTouchDot = (pointerId: number, x: number, y: number) => {
		const dot = touchDots.get(pointerId)
		if (!dot) return
		dot.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
	}

	/** 手指抬起: 让 dot 淡出后移除 */
	const removeTouchDot = (pointerId: number) => {
		const dot = touchDots.get(pointerId)
		if (!dot) return
		touchDots.delete(pointerId)
		dot.style.opacity = "0"
		// 等淡出动画结束再移除 DOM
		setTimeout(() => dot.remove(), 300)
	}

	/* ---------------- 头部跟随 + 抚摸反馈 ---------------- */
	let headFollowActive = false
	let headBase = {x: 0, y: 0}
	let stroking = false
	let strokeTimer: ReturnType<typeof setTimeout> | null = null
	let swayRaf = 0
	let swayPhase = 0
	/** 本次抚摸开始时刻 (算幅度渐强) 与上次冒爱心的时刻 (节流) */
	let strokeStartAt = 0
	let lastPetFxAt = 0

	/** 按住多久进入抚摸反馈 (表情 + 轻蹭) */
	const STROKE_DELAY = 260
	/** 头部轻蹭幅度起手值/上限/渐强时长 与曲线函数都在 petEffect.ts (便于门禁单测)。
	 *  只让幅度随抚摸时长渐强, 摆动**频率不变** —— 旧版固定 10px/0.86Hz 被评价"像马达在震",
	 *  问题出在频率而不是幅度。 */
	/** 轻蹭摆动速度 (rad/帧): 慢速漂移感 (刻意不随抚摸变快) */
	const SWAY_SPEED = 0.045
	/** 冒柔光粒子的节流间隔 (ms) —— 与 petEffect 的存活上限一起把开销压住。
	 *  刻意比第一版(220ms)更慢、且每次只 1 颗: 密度低才"柔和", 不会突兀。 */
	const PET_FX_INTERVAL_MS = 260

	/** 摸头表情的驱动循环 —— **只在"正在展示"期间跑**，收回后自动停（不常驻 rAF）。
	 *
	 *  规格（用户定）: 只在**摸到头**时播 shy/smile 二选一；停手 1 秒内没继续摸就收回；
	 *  收回靠表情自带的 0.5s 淡出 ⇒ 不会有跳变感；状态变化时才调库 ⇒ 不会每帧重置淡入。
	 *  名字的挑选/宽限期/`EXPRESSION_DENY` 过滤都在 `services/live2d/petExpression.ts`（有门禁单测）。 */
	let petExprRaf = 0
	const startPetExpressionLoop = (): void => {
		if (petExprRaf) return
		const loop = () => {
			const petting = settings().petTouchEnabled && stroking && onNoriHead          // 规格 4: 只有摸到头才播
			const showing = applyPetExpression(performance.now(), petting, expressions.value, {
				play: (n) => {
					// 规格 3(摸头优先): 顺手取消"5 秒回中性"，否则它到点会 stopExpression 把这张脸清掉
					cancelReturnToNeutral()
					try { l2d.playExpression(n) } catch { /* 忽略 */ }
				},
				stop: () => { try { l2d.stopExpression() } catch { /* 忽略 */ } },
			})
			petExprRaf = showing ? requestAnimationFrame(loop) : 0
		}
		petExprRaf = requestAnimationFrame(loop)
	}

	/* ---------------- 头部拖拽跟随 (库原生 setDragging; 方向/灵敏度可在设置里现场调) ---------------- */
	let lookCur = {x: 0, y: 0}
	let lookTarget = {x: 0, y: 0}
	let lookRaf = 0
	/** 注视起点只初始化一次, 跨触摸延续, 无跳变 */
	let lookInit = false

	const canvasCenter = (): {x: number; y: number} => {
		const el = l2d.canvas()
		if (!el) return {x: window.innerWidth / 2, y: window.innerHeight / 2}
		return {x: el.clientWidth / 2, y: el.clientHeight / 2}
	}

	/** 当前 Live2D 未经过 CSS 缩放的模型框，所有视线目标都在这个坐标系里计算。 */
	const modelFrame = (): {x: number; y: number; w: number; h: number} | null => {
		const el = l2d.canvas()
		if (!el) return null
		const w = el.clientWidth || window.innerWidth
		const h = el.clientHeight || window.innerHeight
		if (w <= 0 || h <= 0) return null
		const ms = touchEditor().modelSize()
		if (!ms?.w || !ms.h) return {x: 0, y: 0, w, h}
		const s = Math.min(w / ms.w, h / ms.h)
		return {x: (w - ms.w * s) / 2, y: (h - ms.h * s) / 2, w: ms.w * s, h: ms.h * s}
	}

	/**
	 * 中立点 = 模型渲染框中心 (由 modelLayout 按当前缩放/偏移实时计算),
	 * 比画布中心更贴近模型实际位置, 左右输入以它为轴绝对对称.
	 */
	const lookNeutral = (): {x: number; y: number} => {
		const L = modelFrame()
		if (L && L.w > 0 && L.h > 0) return {x: L.x + L.w / 2, y: L.y + L.h / 2}
		return canvasCenter()
	}

	/**
	 * 拖拽范围半径: 按"模型实际渲染框"计算 (框短边 × 0.4), 与缩放无关.
	 * 库的拖拽映射是模型空间——半径若按画布算, 模型小(默认缩放)时同样距离映射成巨大模型偏移, 导致定位不准.
	 */
	const lookRangeRadius = (): number => {
		const el = l2d.canvas()
		const L = modelFrame()
		if (L && L.w > 0 && L.h > 0) return Math.min(L.w, L.h) * 0.4
		if (!el) return 200
		return Math.min(el.clientWidth, el.clientHeight) * 0.35
	}

	/** 方向翻转: 直接翻转归一化偏移的符号 (原点在画布中心, 见 toLookTarget) */

	/**
	 * 手指 → 注视目标: 输入归一化以"模型渲染框中心"为对称轴 (缩放/平移无关,
	 * 左右绝对对称), 但**绝对坐标以画布中心为原点** —— 库的角度零位锚定在
	 * device 中心 (deviceToScreen 以它为 view 原点), 若用模型框中心当零点会留下
	 * 恒定偏角: 松手回正停在"略偏的姿态"上, 0.5s 后被 resetLook 拉回真零位,
	 * 肉眼可见地跳一下 (定位二段跳)。零位必须与库一致。
	 */
	const toLookTarget = (x: number, y: number): {x: number; y: number} => {
		const el = l2d.canvas()
		if (!el) return {x, y}
		const L = modelFrame()
		const n = lookNeutral()
		const halfW = (L && L.w > 0 ? L.w : el.clientWidth) / 2
		const halfH = (L && L.h > 0 ? L.h : el.clientHeight) / 2
		const p = canvasPointFromClient(x, y, canvasView())
		let dx = clamp((p.x - n.x) / halfW, -1, 1)
		let dy = clamp((p.y - n.y) / halfH, -1, 1)
		// 方向翻转: 翻转偏移符号 (原点在画布中心, 翻转即绕零位镜像)
		if (settings().lookFlipX) dx = -dx
		if (settings().lookFlipY) dy = -dy
		const R = lookRangeRadius()
		const c = canvasCenter()
		return {x: c.x + dx * R, y: c.y + dy * R}
	}

	/**
	 * 轻拨感弹簧 (帧率无关, 半隐式欧拉积分; 替代旧的指数插值):
	 * - follow (手指按住): 软跟随 —— 灵敏度设置映射为刚度 (阻尼比恒 0.75),
	 *   头部追手带一点滞后与轻微过冲, 像被轻轻拨动的物体, 不黏手;
	 * - return (松手): 固定低速弹簧, 无论何时/从何处松手都约 1.2s 缓缓漂回中立点,
	 *   带一丝回弹, 不受灵敏度设置影响 (旧实现回正速度跟着灵敏度走, 摸完收得太急).
	 * 手感微调只动这两组数: k 越小越绵软, c 越小回弹越明显
	 */
	const SPRING_RETURN = {k: 7, c: 4.4}
	let lookVel = {x: 0, y: 0}
	let lookLastTs = 0

	const lookLoop = (ts?: number) => {
		const now = ts ?? performance.now()
		const dt = lookLastTs ? Math.min((now - lookLastTs) / 1000, 0.05) : 0.016
		lookLastTs = now
		let spring: {k: number; c: number}
		if (headFollowActive) {
			const k = 500 * (Number(settings().lookSens) || 0.2) + 40
			spring = {k, c: 1.5 * Math.sqrt(k)}
		} else {
			spring = SPRING_RETURN
		}
		lookVel.x += ((lookTarget.x - lookCur.x) * spring.k - lookVel.x * spring.c) * dt
		lookVel.y += ((lookTarget.y - lookCur.y) * spring.k - lookVel.y * spring.c) * dt
		lookCur.x += lookVel.x * dt
		lookCur.y += lookVel.y * dt
		// 注视点限幅: 弹簧带惯性, 但 lookCur 不允许冲出映射范围 (目标在半径圈内,
		// 位置允许 15% 过冲余量, 径向外推速度清零) —— 否则快速摸头会把头甩过界.
		// 限幅圆心 = 画布中心 (与 toLookTarget 的零位原点一致)
		{
			const n = canvasCenter()
			const R = lookRangeRadius() * 1.15
			const dx = lookCur.x - n.x
			const dy = lookCur.y - n.y
			const d = Math.hypot(dx, dy)
			if (d > R && d > 0) {
				const f = R / d
				lookCur.x = n.x + dx * f
				lookCur.y = n.y + dy * f
				const vr = (lookVel.x * dx + lookVel.y * dy) / d
				if (vr > 0) {
					lookVel.x -= (vr * dx) / d
					lookVel.y -= (vr * dy) / d
				}
			}
		}
		// 库的拖拽映射按画布 attribute 尺寸 (宽×renderScale) 归一化, 但输入按 ×DPR;
		// 乘以 renderScale/DPR 使比例恒为 1, 任何渲染分辨率下跟手都一致。
		// 系数与命中钩子/resizeCanvas 同源: 优先读库实际生效的 __noriRenderScale
		const rs = normalizeRenderScale(window.__noriRenderScale, normalizeRenderScale(settings().renderScale, 1))
		const dpr = window.devicePixelRatio || 1
		const K = rs / dpr
		const distT = Math.hypot(lookTarget.x - lookCur.x, lookTarget.y - lookCur.y)
		// 收尾混合 (修"半秒后突然归位"): 慢弹簧的长尾会让 resetLook 迟到一秒以上,
		// 库零位与映射零位的细微差被拖成肉眼可见的跳变 —— 距目标很近时切快速
		// 插值精准落点, 头部视觉归中后立即 resetLook, 不留长尾窗口
		if (!headFollowActive && distT < 14) {
			lookCur.x += (lookTarget.x - lookCur.x) * 0.22
			lookCur.y += (lookTarget.y - lookCur.y) * 0.22
			lookVel.x *= 0.6
			lookVel.y *= 0.6
		}
		try { l2d.lookAt(lookCur.x * K, lookCur.y * K) } catch { /* 忽略 */ }
		const speed = Math.hypot(lookVel.x, lookVel.y)
		const done = !headFollowActive && distT < 0.6 && speed < 4
		if (done) {
			lookRaf = 0
			lookVel = {x: 0, y: 0}
			lookLastTs = 0
			try { l2d.resetLook() } catch { /* 忽略 */ }
			return
		}
		lookRaf = requestAnimationFrame(lookLoop)
	}

	const startLookLoop = () => { if (!lookRaf) lookRaf = requestAnimationFrame(lookLoop) }

	const startHeadFollow = (x: number, y: number) => {
		if (!ready.value) return
		headFollowActive = true
		headBase = {x, y}
		if (!lookInit) {
			lookInit = true
			lookCur = canvasCenter()
		}
		lookTarget = toLookTarget(x, y)
		startLookLoop()
		// 眼珠由库的 drag 源驱动 (与头部同一 feed, 见下方"视线跟随"说明), 无需单独驱动
		// 按住一段时间不松开 → 进入抚摸反馈
		if (strokeTimer) clearTimeout(strokeTimer)
		strokeTimer = setTimeout(() => {
			strokeTimer = null
			if (!headFollowActive) return
			stroking = true
			if (onNoriHead) claimPetGesture()
			// 摸头表情: 交给专用循环（它自己判"是不是摸到头"、宽限期与收回）
			if (settings().petTouchEnabled) startPetExpressionLoop()
			// "刚摸到"的一记 (移植自网页版 w8e + h8e): 只在**摸到头**时响/冒
			if (onNoriHead) {
				if (settings().petTouchSound) petAudioTouch()
				if (settings().petTouchEffects) spawnPetTouchBurst(headBase.x, headBase.y - 10)
				// 摸头台词: 与"摸到了"的音效**同源**（同一处边沿）⇒ 语义天然一致, 以后不会漂移。
				// 窗口/随机/去重都在 petSpeech.ts; 这里只管"该不该开口"与呈现（见 maybeSpeakPetLine）。
				if (settings().petTouchSpeech) maybeSpeakPetLine()
			}
			startSway()
		}, STROKE_DELAY)
	}

	const updateHeadLook = (x: number, y: number) => {
		if (!headFollowActive) return
		headBase = {x, y}
		if (stroking) return // 抚摸中由 sway 控制, 避免和目标抢
		lookTarget = toLookTarget(x, y)
	}

	/** 抚摸期间头部轻微摆动 (模拟"被摸得舒服、轻轻蹭" ) + 冒爱心
	 *  幅度随连续抚摸时长渐强 (曲线在 petEffect.ts, 有单测); 频率恒定。 */
	const startSway = () => {
		stopSway()
		swayPhase = 0
		strokeStartAt = Date.now()
		lastPetFxAt = 0
		const loop = () => {
			if (!headFollowActive || !stroking) return
			const now = Date.now()
			const amp = settings().petTouchEnabled ? petSwayAmp(now - strokeStartAt) : 0
			swayPhase += SWAY_SPEED
			const dx = Math.sin(swayPhase) * amp
			const dy = Math.cos(swayPhase * 1.3) * amp * 0.7
			/* 摸头时**保留视线追踪**: 注视目标仍然跟着手指(headBase), 只是叠一点"幅度渐强"的轻微摆动。
			   （摸头"低头"已按用户决定**删除** —— 它要么与库每帧写的注视通道抢参数、要么按下即满产生
			     "头部角度跳变"；现在摸头的反馈是**表情 + 台词**，见 petExpression.ts 与 petSpeech.ts。
			     实际数据留档在 docs/低头参数探针.md 与 backups\低头重做与参数归属护栏-20260924-232222\。） */
			lookTarget = toLookTarget(headBase.x + dx, headBase.y + dy)
			// 轻量特效: 从手指位置往上冒**柔光白粒子** (节流 + petEffect 内部有存活上限, 不会堆积)。
			// 只在**摸到头**时才冒 —— onNoriHead = 命中实体 且 落在头带内(部件几何算出来的)。
			// 否则摸手/摸脚/在 Nori 旁边的空白处按住都会冒粒子。
			// 每次只 1 颗、峰值透明度只有 0.42~0.66 —— 目标是"看得见但不突兀"。
			if (settings().petTouchEffects && onNoriHead && now - lastPetFxAt >= PET_FX_INTERVAL_MS) {
				lastPetFxAt = now
				spawnPetMotes(headBase.x, headBase.y - 10, {count: 1})
			}
			swayRaf = requestAnimationFrame(loop)
		}
		swayRaf = requestAnimationFrame(loop)
	}

	const stopSway = () => {
		if (swayRaf) { cancelAnimationFrame(swayRaf); swayRaf = 0 }
	}

	/* ---------------- 视线跟随 (眼珠) ----------------
	 * 设计说明: 库的每帧更新本身就会把 drag 值叠加进 ParamAngleX/Y 与 ParamEyeBallX/Y
	 * (live2dEasyControl update: addParameterValueById(EyeBallX, dragX)),
	 * 即眼珠天然跟随 lookAt 的喂点. 此前我们另起一套 gazeLoop 直接 setParam 写眼珠,
	 * 与库的叠加写入双重驱动 —— 方向翻转设置只作用于头部 feed, 眼珠不跟随翻转,
	 * 且松手后库的 dragX 随头部慢回正持续叠加, 造成"头已回正、眼还看向一侧,
	 * 半秒后又突然归位"的错位观感. 现在删掉独立眼珠驱动, 眼/头同源同向:
	 * 同一个 toLookTarget 喂点 (含方向翻转/模型框参考系), 天然同步回正. */

	const endHeadFollow = () => {
		const wasActive = headFollowActive
		headFollowActive = false
		stroking = false
		onNoriHead = false
		if (strokeTimer) { clearTimeout(strokeTimer); strokeTimer = null }
		stopSway()
		// 抚摸会话结束: 复位采样器 + 让合成音归零 (对应网页版的 AK)。
		// 放在这里而不是 pointerup, 是因为"漏掉抬起事件"也要能收尾。
		petStroke.end()
		petAudioRelease()
		if (hitDebug.value) petDebugText.value = petStrokeDebug()
		// 头部回正: 回到"画布中心" —— 库的角度零位锚定在 device 中心, 归位即真零位,
		// resetLook 只是确认性的归零, 不会再出现"先停在某姿态、半秒后跳回正中"的二段跳
		if (wasActive) {
			lookTarget = canvasCenter()
			startLookLoop()
		}
	}

	const onStagePointerDown = (e: PointerEvent) => {
		const onUI = (elm: EventTarget | null): boolean =>
			!!(elm as HTMLElement)?.closest?.("button, input, textarea, select, a, summary, [role=button], .sheet, .dock, .topbar, .pet-fab, .chat-panel, .touch-editor, .touch-top, .pomo-widget, .side-rail, .side-rail-mask, .intro-mask, .gate-mask")
		if (onUI(e.target) || e.button !== 0) return
		if (panel.value !== "" && !(panel.value === "touch" && (touchEditor().touchDrawing.value || touchEditor().touchAdjusting.value || touchEditor().touchTesting.value))) return
		activeStagePointers.add(e.pointerId)
		stagePointers = activeStagePointers.size
		if (stagePointers === 1) petOwnsGesture = false
		try { document.querySelector<HTMLElement>(".stage-root")?.setPointerCapture(e.pointerId) } catch { /* 旧 WebView 可能不支持 */ }
		ambientTouch()
		habitRecord("touch")
		if (stagePointers > 1) { touchEditor().detector.cancel(); endHeadFollow(); touchEditor().onDrawUp(true); return }

		if (touchEditor().touchDrawing.value || touchEditor().touchAdjusting.value) {
			if (onUI(e.target)) return
			touchEditor().onDrawDown(e)
			return
		}
		if (touchEditor().touchTesting.value && panel.value === "touch") {
			if (onUI(e.target)) return
			if (stagePointers > 1) { touchEditor().detector.cancel(); return }
			if (!touchEditor().detector.hitTest(e.clientX, e.clientY)) notify("未命中自定义区域")
			touchEditor().detector.onPointerDown(e)
			return
		}

		if (panel.value !== "") { if (stagePointers > 1) { endHeadFollow(); touchEditor().detector.cancel() }; return }
		if (stagePointers > 1) { endHeadFollow(); touchEditor().detector.cancel(); return }

		if (onUI(e.target)) return
		// 留白/实体命中分流: 只有点在模型实体 (任意可见部件) 上才触发摸头判定;
		// 空白区域 = 只保留白点/粒子/视线跟随 (她在看你的手指, 但不算摸她)
		const hit = noriHitTest(e.clientX, e.clientY)
		strokeOnModel = !!hit && hit.hit
		if (hitDebug.value) hitZoneText.value = zoneText(hit)
		spawnTouchDot(e.pointerId, e.clientX, e.clientY)
		// 背景触摸响应从按下开始，并缓慢渐入。
		// 放在 `onUI` 闸门之后：点面板按钮不该搅动背景（与白点同规矩）。
		background().touchStart(e.clientX, e.clientY)
		// "摸到头" = 命中实体 **且** 落在头区内 —— 这一刻先算一次, 之后由 pointermove 实时更新
		// (原来只在这里算一次, 导致"按上就一直算头上 / 按在别处就怎么移都不算")。
		refreshHeadBox()
		if (strokeOnModel && touchEditor().touchEnabled.value && !replyBusy()) touchEditor().detector.onPointerDown(e)
		// AudioContext 必须在**真实用户手势**里解锁: 抚摸音是在指针移动 / setTimeout 里触发的,
		// 那两处不算手势 —— 那时才 new AudioContext() 会一直停在 suspended。
		// 摸到模型就预热(不必等到摸到头), 这样之后手指滑到头区时声音立刻就有。
		if (strokeOnModel && settings().petTouchSound) petAudioPrime()
		updateNoriHead(e.clientX, e.clientY, true)
		startHeadFollow(e.clientX, e.clientY)
	}

	const onStagePointerMove = (e: PointerEvent) => {
		if (stagePointers > 0 && !activeStagePointers.has(e.pointerId)) return
		// 只在"已按下"时有效（悬停/鼠标移动不算触摸；未按下时是空操作）
		background().touchMove(e.clientX, e.clientY)
		if (touchEditor().touchDrawing.value || touchEditor().touchAdjusting.value) { if (stagePointers === 1 && activeStagePointers.has(e.pointerId)) touchEditor().onDrawMove(e); return }
		if (touchEditor().touchTesting.value && panel.value === "touch") {
			if (stagePointers > 1) touchEditor().detector.cancel()
			else if (stagePointers > 0) touchEditor().detector.onPointerMove(e)
			return
		}
		if (hitDebug.value) {
			const now = performance.now()
			if (now - lastHitDebugT > 150) {
				lastHitDebugT = now
				hitZoneText.value = zoneText(noriHitTest(e.clientX, e.clientY))
				petDebugText.value = petStrokeDebug()
			}
		}
		if (panel.value !== "" || stagePointers > 1) { if (stagePointers > 1) touchEditor().detector.cancel(); return }
		moveTouchDot(e.pointerId, e.clientX, e.clientY)
		// 实时重判是否摸到头 (节流 100ms) —— 手指可以随时滑进/滑出头区
		updateNoriHead(e.clientX, e.clientY)
		if (strokeOnModel) touchEditor().detector.onPointerMove(e)
		// **必须先真的按着**: `pointermove` 在鼠标悬停时也会派发 (buttons=0), 而抚摸的采样/音效/
		// 特效原先只判 `onNoriHead` —— 于是"鼠标指针划过 Nori 头顶"就会冒粒子、响音 (实机/浏览器实测:
		// 悬停 1.44s 冒了 5 颗粒子 + 3 火花 + 3 涟漪)。用户要求: 只有真正按下才触发。
		const pressed = stagePointers > 0
		if (pressed && onNoriHead) {
			// 抚摸采样: 合格的移动 → 摩擦音随速度变响变亮; 累计满 requiredMs → 完成一次
			const p = petStrokePoint(e.clientX, e.clientY)
			const s = petStroke.move(performance.now(), p.x, p.y)
			if (s.qualifying) { claimPetGesture(); petLastVx = s.velocityX; if (settings().petTouchSound) petAudioStroke(s.velocityX) }
			// 累计满 requiredMs = 完成一次: 奖励爆发 (网页版 p8e) + 双段音效 (网页版 S8e)
			if (s.completed) {
				petCompletions += 1
				if (settings().petTouchSound) petAudioComplete()
				if (settings().petTouchEffects) spawnPetComplete(e.clientX, e.clientY)
			}
		}
		updateHeadLook(e.clientX, e.clientY)
	}

	const onStagePointerUp = (e: PointerEvent) => {
		if (!activeStagePointers.delete(e.pointerId)) return
		const wasCancelled = e.type === "pointercancel" || e.type === "lostpointercapture"
		const petWasActive = petOwnsGesture
		stagePointers = activeStagePointers.size
		removeTouchDot(e.pointerId)
		// 抬手/取消都要收尾（pointercancel 也接到这里）—— 否则状态机会一直停在"按着"
		background().touchEnd()
		strokeOnModel = false
		// **收尾必须在面板判断之前**: 原先 `panel !== ""` 直接 return, 于是"摸头途中面板被打开、
		// 抬手事件正好被这一条吞掉"时, stroking/headFollowActive 会永远停在 true ——
		// 之后鼠标**悬停**划过头部就会把"刚摸到"的那一记(触到音 + 火花涟漪)反复重放。
		// endHeadFollow 本身只是复位状态 + 让注视回正, 与面板是否可见无关, 放在这里不会误伤面板逻辑。
		endHeadFollow()
		if (touchEditor().touchDrawing.value || touchEditor().touchAdjusting.value) { touchEditor().onDrawUp(wasCancelled); return }
		if (touchEditor().touchTesting.value && panel.value === "touch") {
			if (wasCancelled) touchEditor().detector.cancel()
			else touchEditor().detector.onPointerUp(e)
			return
		}
		if (panel.value !== "") return
		if (wasCancelled) { touchEditor().detector.cancel(); return }
		if (petWasActive) {
			touchEditor().detector.cancel()
			return
		}
		touchEditor().detector.onPointerUp(e)
	}

	const cancelStageInteraction = () => {
		for (const id of activeStagePointers) removeTouchDot(id)
		activeStagePointers.clear()
		stagePointers = 0
		petOwnsGesture = false
		strokeOnModel = false
		endHeadFollow()
		touchEditor().detector.cancel()
		touchEditor().onDrawUp(true)
		background().touchEnd()
		clearTransformTouches()
	}

	const hitDebug = ref(false)
	const hitZoneText = ref("")
	/** 调试显示的抚摸状态 (进度/完成次数/速度), 与 hitZoneText 同一处节流刷新 */
	const petDebugText = ref("")
	let strokeOnModel = false
	let lastHitDebugT = 0

	/* ---------------- 抚摸采样与音效 (移植自网页版 headPat) ----------------
	 * 网页版把"摸头"定义成: 横向为主 + 速度够快的移动, **累计满 1000ms 算完成一次**,
	 * 每完成一次给一记"完成音"(之前安卓端只有"按住 260ms 就进入抚摸", 没有完成的概念)。
	 * 单位说明: 网页版用**头宽**当单位, 头包围盒要等 Phase 3a 的探测钩子才有;
	 * 这里先用**屏幕短边**当单位, 所以 minSpeedX 按"头宽≈短边的 1/3"换算(0.05→0.02)。 */
	const petStrokeTuning = {...DEFAULT_PET_STROKE_TUNING, minSpeedX: 0.02}
	const petStroke = createPetStrokeDetector(() => petStrokeTuning)
	/** 本次会话累计完成次数 (只用于调试显示) */
	let petCompletions = 0
	/** 最近一次合格采样的横向速度 (单位: 短边/秒; 只用于调试显示) */
	let petLastVx = 0
	/** 最近一次算出的头部盒 (model 坐标; 供调试显示与探针断言) */
	let petHeadBox: PetPartBox | null = null
	/** 最近一次算出的**全模型盒** (model 坐标) —— 头区兜底比例靠它算 */
	let petModelBox: PetPartBox | null = null
	/** 最近一次按下的模型坐标 y (调试显示用) */
	let petLastModelY = NaN
	/** 几何是否可用 (钩子缺失/抛错时为 false → 判定兜底为"按实体") */
	let petGeomOk = false
	/** 本次按下是否落在**头部带**内 (实体命中 **且** 在头带里)。
	 *  注意与 `strokeOnModel` 分开: 后者是"命中实体", 还要继续供**用户配置的触摸区**做判定 ——
	 *  把触摸区也限制成"只有头"会误伤手/肚皮等其它区域。 */
	let onNoriHead = false
	/** 最近一次按下的头部判定结果 (onNoriHead 会在 endHeadFollow 里清掉, 这个留着供调试/探针看) */
	let lastOnHead = false
	const petStrokeUnit = (): number => Math.max(120, Math.min(window.innerWidth || 0, window.innerHeight || 0))
	/** 屏幕坐标 → 采样器坐标 (除以短边 ⇒ 阈值与分辨率/机型无关) */
	const petStrokePoint = (x: number, y: number): {x: number; y: number} => {
		const u = petStrokeUnit()
		return {x: x / u, y: y / u}
	}
	/** 取模型几何 → 算头盒。几何来自补丁钩子 __noriPartProbe (部件盒 + 全模型盒, 与命中点同坐标系)。
	 *  每次按下算一次 —— 实测开销是 248 个 drawable 的顶点遍历(毫秒级), 只在 pointerdown 走一次。 */
	const refreshHeadBox = (): void => {
		const probe = (window as unknown as {__noriPartProbe?: () => {ok?: boolean; parts?: {box: PetPartBox}[]; allBox?: PetPartBox} | null}).__noriPartProbe
		if (typeof probe !== "function") { petHeadBox = null; petModelBox = null; petGeomOk = false; return }
		try {
			const g = probe()
			if (!g?.ok || !Array.isArray(g.parts)) { petHeadBox = null; petModelBox = null; petGeomOk = false; return }
			petModelBox = g.allBox ?? null
			petHeadBox = pickHeadBox(g.parts.map((p) => p.box), petModelBox)
			petGeomOk = !!petModelBox
		} catch {
			petHeadBox = null
			petModelBox = null
			petGeomOk = false
		}
	}
	/** 当前 canvas 的 CSS 变换视图 (与 relayout 写进 canvas.style 的一致) */
	const canvasView = (): {w: number; h: number; scale: number; offsetX: number; offsetY: number} => ({
		w: window.innerWidth || 0,
		h: window.innerHeight || 0,
		scale: scale.value,
		offsetX: offsetX.value,
		offsetY: offsetY.value,
	})

	/** 屏幕点 → 模型坐标 (补丁钩子), 拿不到返回 null */
	const noriModelPoint = (x: number, y: number): {x: number; y: number} | null => {
		const fn = (window as unknown as {__noriModelPoint?: (x: number, y: number) => {x?: number; y?: number} | null}).__noriModelPoint
		if (typeof fn !== "function") return null
		try {
			// 关键: 命中钩子走库的 transformView, 它不知道 canvas 上的 CSS 变换(scale/offset),
			// 所以必须先把 client 坐标逆变换回未变换的画布坐标系, 否则缩放/平移后判定与渲染错位。
			const p0 = canvasPointFromClient(x, y, canvasView())
			const p = fn(p0.x, p0.y)
			return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? {x: p.x as number, y: p.y as number} : null
		} catch {
			return null
		}
	}
	/** 实时重判"是否摸到头"的节流间隔 (ms)。
	 *  实体命中要遍历全部 drawable, 每帧(120Hz)跑不划算; 10Hz 对"移进去/移出来"完全够用, 手感无差。 */
	const PET_HEAD_CHECK_MS = 100
	let lastHeadCheckAt = 0

	/**
	 * 实时重判"是否摸到头"(含 6% 迟滞), 并处理**进入/离开的边沿动作**。
	 *
	 * ## 为什么必须实时
	 * 原来只在 `pointerdown` 算一次 ⇒ 按下时在头上就**整段按压都算头上**(移开也不停),
	 * 按下时不在头上就**怎么移都不算** —— 你反馈的两个现象是同一个原因。
	 * 网页版 `T2()` 是每个事件都重算的: `r = hitTestParts(...)` 与 `s = Ly(...)` 都在 move 里算,
	 * 且"已经在摸"之后改用外扩的 leash 框判是否还在摸。
	 *
	 * 边沿动作:
	 *  - 进入 → 采样从这一刻开始 + 一记"摸到了"的反馈(触到音 + 接触爆发; 只在已经进入抚摸状态时)
	 *  - 离开 → 采样复位 + 摩擦音归零(保留完成音的第二段尾巴)
	 */
	const updateNoriHead = (x: number, y: number, force = false): void => {
		const now = performance.now()
		if (!force && now - lastHeadCheckAt < PET_HEAD_CHECK_MS) return
		lastHeadCheckAt = now
		const mp = noriModelPoint(x, y)
		petLastModelY = mp ? mp.y : NaN
		let inHead = false
		if (!petGeomOk) {
			// 几何拿不到: 兜底为"按实体"(调试行显示「无几何→按实体」), 否则表现为怎么摸都没反应
			const hit = noriHitTest(x, y)
			inHead = !!hit && !!hit.hit
		} else if (mp) {
			const zone = inHeadZoneHysteresis(petHeadBox, petModelBox, mp.x, mp.y, onNoriHead)
			if (zone) {
				// **进入**才要求命中实体; **已经在摸**时只要求还在(有界 leash 盒内的)头区 —— 与网页版一致:
				// 它"已经在摸"的阶段只用外扩盒子 E8e 判, 不再查 drawable。
				// 少了这一条会怎样: 在头顶那种很窄的地方左右摸, 手指稍一滑出轮廓就判"头外"→
				// 采样被 end() 复位 → 进度永远攒不到 1s(实测踩过)。
				inHead = onNoriHead ? true : !!(noriHitTest(x, y)?.hit)
			}
		}
		if (inHead === onNoriHead) return
		onNoriHead = inHead
		lastOnHead = inHead
		if (inHead) {
			const p = petStrokePoint(x, y)
			petStroke.start(performance.now(), p.x, p.y)
			// 滑进头区也要把表情循环拉起来（用户可能从身体开始摸、再滑到头）
			if (settings().petTouchEnabled) startPetExpressionLoop()
			// 已经进入抚摸状态 + **指针真的按着**才补反馈: pointerdown 那一刻由上方的 stroking 定时器负责。
			// `stagePointers > 0` 这道闸是 2026-09-26 加的 —— `pointermove` 在鼠标悬停时也会派发(buttons=0),
			// 而"进入头区"这个边沿原先只看 stroking ⇒ 悬停划过就能冒粒子/响音(浏览器实测)。
			if (stroking && stagePointers > 0) {
				claimPetGesture()
				if (settings().petTouchSound) petAudioTouch()
				if (settings().petTouchEffects) spawnPetTouchBurst(x, y - 10)
				// 与上面同源的第二处"确认摸到头"边沿（从身体滑进头区, 或按下后第一次判到头）
				if (settings().petTouchSpeech) maybeSpeakPetLine()
			}
		} else {
			petStroke.end()
			petAudioRelease(true)
		}
	}

	/** 读回一个模型参数 (补丁钩子 __noriGetParam); 钩子缺失/出错返回 null */
	const readParam = (id: string): number | null => {
		const fn = (window as unknown as {__noriGetParam?: (id: string) => number | null}).__noriGetParam
		if (typeof fn !== "function") return null
		try {
			const v = fn(id)
			return typeof v === "number" && Number.isFinite(v) ? v : null
		} catch {
			return null
		}
	}

	const petStrokeDebug = (): string => {	const line = headZoneLine(petHeadBox, petModelBox)
		const zone = !petGeomOk ? "无几何→按实体" : onNoriHead ? "头上" : "头外"
		const yTxt = Number.isFinite(petLastModelY) ? petLastModelY.toFixed(2) : "?"
		const lineTxt = line === null ? "?" : line.toFixed(2)
		return `抚摸 ${(petStroke.progressMs / 1000).toFixed(1)}/${(petStrokeTuning.requiredMs / 1000).toFixed(1)}s · 完成 ${petCompletions} · 速度 ${petLastVx.toFixed(2)} · ${zone}(y${yTxt} 线${lineTxt})`
	}

	const registerStageDiagnostics = (): void => {
		/** E2E / 实机调试探针: 音效图状态 + 抚摸采样状态 (纯读, 不会建图)。
		 *  实机上没有 adb 时, 也可以在控制台里手敲 `__noriPetDebug()` 看进度。 */;(window as unknown as {__noriPetDebug?: () => unknown}).__noriPetDebug = () => ({
			...petAudioState(),
			progressMs: petStroke.progressMs,
			completions: petCompletions,
			velocity: petLastVx,
			active: petStroke.active,
			/** 实时的"是否摸到头" —— 这才是判定本体 (抬手后会归 false) */
			onHead: onNoriHead,
			/** 最近一次头部决策的快照 (抬手后不清, 供调试对照) */
			lastHead: lastOnHead,
			onModel: strokeOnModel,
			headBox: petHeadBox,
			modelBox: petModelBox,
			bandLine: headZoneLine(petHeadBox, petModelBox),
			geomOk: petGeomOk,
			modelY: petLastModelY,
			/** 参数读回 (补丁 __noriGetParam)：`angleY` = 库每帧写的"注视"通道（只读对照） */
			angleY: readParam("ParamAngleY"),
			/** 眨眼: 累计次数 + 当前闭合量 (0=睁 1=全闭) —— 实机/ E2E 确认"真的在眨" */
			blinkCount: blinkCount(),
			blinkClosure: blinkClosureNow(),
			eyeLOpen: readParam("ParamEyeLOpen"),
			eyeROpen: readParam("ParamEyeROpen"),
			/** 摸头表情: 当前这张脸与是否在展示 (E2E/实机确认"摸头时播的是 shy/smile") */
			petExpression: petExpressionName(),
			petExpressionOn: petExpressionShowing(),
			/** 摸头表情的**客观证据**: 两个表情各自独占的参数（Shy→ParamCheek, Smile→ParamEyeSmile）
			 *  —— 只看我们自己的变量等于自证，读参数才能证明"表情真的生效了"。
			 *  注: 不用 `ParamEyeLSmile`（旧 happy 的独占参数）—— 实测 ARGNori **没有这个参数**
			 *  （`13_Happy.exp3.json` 引用了一堆不存在的 `ParamBrowL*`/`ParamEyeLSmile`，所以旧实现
			 *   在这模型上几乎是空操作）。这也是"不能靠表情名自证"的又一个理由。 */
			petExprCheek: readParam("ParamCheek"),
			petExprEyeSmile: readParam("ParamEyeSmile"),
			/** 摸头台词: 说了几句 / 最后一句 / 距离"可以再说"还差多少 ms(0 = 现在就能说)。
			 *  只反映**真的开口过**的次数 —— 被"正在朗读/生成中"跳过的那次**不计数也不消耗窗口**。 */
			petSpeechCount: petSpeechCount(),
			petSpeechLast: petSpeechLastLine(),
			petSpeechWaitMs: petSpeechWaitMs(performance.now()),
			/** 当前按下的手指数 (stagePointers) —— "指针事件被吞掉"这类问题只能靠它看出来 */
			pressed: stagePointers,
			/** 抚摸状态机的三个内部标志 —— 排查"没按下也冒特效"时必须能看到它们:
			 *  stroking 只在"按下后 260ms 仍在跟随"时置位, 抬手由 endHeadFollow 清掉。 */
			stroking,
			headFollow: headFollowActive,
			swayRaf: swayRaf !== 0,
		})
		/** E2E 探针: 走**已修正**的屏幕→模型坐标换算 (含 canvas CSS 变换逆变换)。
		 *  与"触摸区路径"(用 getBoundingClientRect, 本来就跟着渲染走)做交叉验证, 才抓得住
		 *  "缩放/平移后判定与渲染错位"这类问题 —— 只在默认 scale=1/offset=0 下测是抓不住的。 */
		;(window as unknown as {__noriModelPointFixed?: unknown}).__noriModelPointFixed = (x: number, y: number) => noriModelPoint(x, y)
		;(window as unknown as {__noriCanvasView?: unknown}).__noriCanvasView = () => canvasView()
		/** E2E 探针: 粒子累计生成数 (确定性证据, 不受粒子寿命/采样时机影响) */
		;(window as unknown as {__noriPetFxSpawned?: unknown}).__noriPetFxSpawned = () => petFxSpawned()
	}

	/** 模型实体命中测试 (补丁钩子 __noriHitTest): hit=落在模型实体上, err=钩子内部异常 (调试透传), null=钩子未就绪 */
	const noriHitTest = (x: number, y: number): {hit: boolean; err?: string} | null => {
		try {
			const fn = (window as unknown as {__noriHitTest?: (x: number, y: number) => {hit: boolean; err?: string} | null}).__noriHitTest
			if (typeof fn !== "function") return null
			// 同 noriModelPoint: 库的命中判定不知道 canvas 的 CSS 变换, 必须先逆变换回未变换画布坐标系。
			// 否则双指缩放/平移模型后, 判定会与渲染整体错位(在模型旁边的空白处也算"命中实体")。
			const p = canvasPointFromClient(x, y, canvasView())
			return fn(p.x, p.y)
		} catch {
			return null
		}
	}
	const zoneText = (hit: {hit: boolean; err?: string} | null): string =>
		!hit ? "未知" : hit.err ? "异常:" + hit.err : hit.hit ? "实体" : "留白"

	const resetHeadLook = (): void => { lookInit = false; lookRaf = 0 }
	return {
		touchDotHost, hitDebug, hitZoneText, petDebugText,
		onPetTouchSetting, onStagePointerDown, onStagePointerMove, onStagePointerUp,
		cancelStageInteraction, resetHeadLook, canvasView, registerStageDiagnostics,
	}
}
