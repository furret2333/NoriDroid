import {nextTick, ref, watch, type Ref} from "vue"
import {loadTouchConfig, saveTouchConfig, newTouchId, type TouchArea} from "../services/live2d/touch"
import {TouchDetector, toModelPoint, modelLayout} from "../services/live2d/touchDetection"

export interface TouchEditorOptions {
	modelId: Readonly<Ref<string>>
	ready: Readonly<Ref<boolean>>
	loading: Readonly<Ref<boolean>>
	panel: Readonly<Ref<string>>
	scale: Readonly<Ref<number>>
	offsetX: Readonly<Ref<number>>
	offsetY: Readonly<Ref<number>>
	layoutVersion: Readonly<Ref<number>>
	canvas: () => HTMLCanvasElement | null
	notify: (text: string, durationMs?: number) => void
	replyBusy: () => boolean
	modelReady: () => boolean
	onTrigger: (area: TouchArea, type: "tap" | "swipe") => void | Promise<void>
	cancelStageInteraction: () => void
	closePanel: () => void
}

/** Owns custom-area editing and preview; App retains stage pointer routing and chat execution. */
export const useTouchEditor = (options: TouchEditorOptions) => {
	const touchAreas = ref<TouchArea[]>([])
	const selectedTouchId = ref<string | null>(null)
	const touchCustomExpanded = ref(false)
	const touchEditingId = ref<string | null>(null)
	let touchEditOriginal: TouchArea | null = null
	const deletedTouch = ref<{area: TouchArea; index: number} | null>(null)

	/** 区域开关按模型保存；试用仅当前页面有效。 */
	const touchEnabled = ref(true)
	const touchTesting = ref(false)
	const touchCooldownText = ref("")
	const touchReplyPreview = ref("")
	let touchCooldownTimer: ReturnType<typeof setTimeout> | null = null

	const touchDrawing = ref(false)

	const touchAdjusting = ref(false)

	const touchDraft = ref<{x: number; y: number; w: number; h: number} | null>(null)

	const draftReady = ref(false)

	const drawingTarget = ref<string | null>(null)

	const detector = new TouchDetector((area, type) => {
		if (touchTesting.value) {
			selectedTouchId.value = area.id
			const label = type === "swipe" ? "滑动" : "点按"
			const matches = !area.gesture || area.gesture === "both" || area.gesture === type
			options.notify(`命中「${area.name}」 · ${label}${matches ? "，手势符合设置" : "，不符合该区域的触发方式"}`)
			return false
		}
		if (options.replyBusy()) {
			options.notify("Nori 正在回复或朗读，本次触摸互动已跳过")
			return false
		}
		if (!options.modelReady()) { options.notify("请先在设置中配置 API Key 和模型"); return false }
		void options.onTrigger(area, type)
		setTimeout(() => showTouchCooldown(area), 0)
		return true
	})

	detector.setCooldown(10000)

	const configureTouchDetector = () => {

		const ms = modelSize()
		detector.configure(touchEnabled.value ? touchAreas.value : [], options.canvas(), ms?.w ?? 0, ms?.h ?? 0)
	}

	const modelSize = (): {w: number; h: number} | null => {
		const m = (window as unknown as {__noriModelCanvas?: {w: number; h: number}}).__noriModelCanvas
		return m && m.w > 0 && m.h > 0 ? {w: m.w, h: m.h} : null
	}

	const loadTouchForModel = (id: string) => {
		cancelTouchEdit()
		deletedTouch.value = null
		selectedTouchId.value = null
		detector.destroy()
		detector.setPreview(false)
		const config = loadTouchConfig(id)
		touchAreas.value = config.touches
		touchEnabled.value = config.enabled !== false
		touchTesting.value = false
		touchDrawing.value = false
		touchAdjusting.value = false
		resetTouchDraft()
		nextTick(configureTouchDetector)
	}

	const saveTouch = (): boolean => {
		if (!options.ready.value || options.loading.value) { options.notify("请等待模型加载完成后再保存区域"); return false }
		if (options.modelId.value) {
			const cfg = loadTouchConfig(options.modelId.value)
			cfg.touches = touchAreas.value
			cfg.enabled = touchEnabled.value
			if (!saveTouchConfig(options.modelId.value, cfg)) {
				options.notify("保存失败：本地存储不可写，请重试", 4500)
				return false
			}
		} else {
			options.notify("请先加载一个模型")
			return false
		}
		configureTouchDetector()
		return true
	}

	const onTouchAdd = (t: {name: string; prompt: string; reactionPrompt?: string; gesture?: "tap" | "swipe" | "both"}) => {
		const d = touchDraft.value
		if (!d || d.w < 0.06 || d.h < 0.06) { options.notify("请先在模型上框选一个矩形区域"); return }
		const before = [...touchAreas.value]
		touchAreas.value = [...before, {
			id: newTouchId(), name: t.name || "未命名", type: "tap", gesture: t.gesture ?? "both",
			x: d.x, y: d.y, w: d.w, h: d.h, image: "", prompt: t.prompt || "", reactionPrompt: t.reactionPrompt || t.prompt || "",
		}]
		if (!saveTouch()) { touchAreas.value = before; return }
		selectedTouchId.value = touchAreas.value[touchAreas.value.length - 1]?.id ?? null
		touchDraft.value = null
		draftReady.value = false
		drawingTarget.value = null
		options.notify("已添加触摸区域")
	}

	const beginTouchEdit = (id: string) => {
		if (touchEditingId.value === id) return
		cancelTouchEdit()
		const area = touchAreas.value.find(t => t.id === id)
		if (!area) return
		touchEditOriginal = {...area}
		touchEditingId.value = id
		selectedTouchId.value = id
		touchDrawing.value = false
		touchTesting.value = false
		detector.setPreview(false)
		resetTouchDraft()
	}

	const cancelTouchEdit = () => {
		if (touchEditOriginal) {
			const original = touchEditOriginal
			touchAreas.value = touchAreas.value.map(t => t.id === original.id ? original : t)
		}
		touchEditOriginal = null
		touchEditingId.value = null
		drawStart = null
		drawingTarget.value = null
		movingOrigin = null
	}

	const previewTouchEdit = (id: string, patch: Partial<TouchArea>) => {
		if (touchEditingId.value !== id) return
		touchAreas.value = touchAreas.value.map(t => {
			if (t.id !== id) return t
			const next = {...t, ...patch}
			next.w = Math.min(1, Math.max(0.06, next.w))
			next.h = Math.min(1, Math.max(0.06, next.h))
			next.x = Math.max(0, Math.min(next.x, 1 - next.w))
			next.y = Math.max(0, Math.min(next.y, 1 - next.h))
			return next
		})
	}

	const onTouchUpdate = (id: string, patch: Partial<TouchArea>) => {
		if (touchEditingId.value !== id) return
		previewTouchEdit(id, patch)
		if (!saveTouch()) return
		touchEditOriginal = null
		touchEditingId.value = null
		options.notify("区域已保存")
	}

	const onTouchRemove = (id: string) => {
		cancelTouchEdit()
		const before = [...touchAreas.value]
		const index = before.findIndex(t => t.id === id)
		if (index < 0) return
		touchAreas.value = touchAreas.value.filter(t => t.id !== id)
		if (!saveTouch()) { touchAreas.value = before; return }
		deletedTouch.value = {area: {...before[index]}, index}
		if (selectedTouchId.value === id) selectedTouchId.value = null
	}

	const undoTouchRemove = () => {
		const deleted = deletedTouch.value
		if (!deleted) return
		cancelTouchEdit()
		const before = touchAreas.value
		touchAreas.value = [...before.slice(0, deleted.index), deleted.area, ...before.slice(deleted.index)]
		if (!saveTouch()) { touchAreas.value = before; return }
		selectedTouchId.value = deleted.area.id
		deletedTouch.value = null
		options.notify("已撤销删除")
	}

	const setTouchEnabled = (enabled: boolean) => {
		cancelTouchEdit()
		touchEnabled.value = enabled
		if (!saveTouch()) touchEnabled.value = !enabled
		if (!touchEnabled.value) { touchTesting.value = false; detector.setPreview(false) }
	}

	const toggleTouchTesting = () => {
		if (!touchEnabled.value) {
			options.notify("请先开启自定义区域")
			return
		}
		cancelTouchEdit()
		touchTesting.value = !touchTesting.value
		detector.setPreview(touchTesting.value)
		if (touchTesting.value) {
			touchDrawing.value = false
			touchAdjusting.value = false
			resetTouchDraft()
			options.notify("试用模式已开启：只检查命中，不会调用 AI")
		} else {
			touchCooldownText.value = ""
			options.notify("已退出试用模式")
		}
	}

	const showTouchCooldown = (area: TouchArea) => {
		if (touchCooldownTimer) clearTimeout(touchCooldownTimer)
		const tick = () => {
			const left = detector.getCooldownRemaining(area.id)
			if (left <= 0) { touchCooldownText.value = ""; touchCooldownTimer = null; return }
			touchCooldownText.value = `「${area.name}」已触发，${Math.ceil(left / 1000)} 秒内不会重复回应`
			touchCooldownTimer = setTimeout(tick, 250)
		}
		tick()
	}

	const onTouchTest = (area: TouchArea) => {
		if (!touchEnabled.value) return
		if (!options.ready.value || options.loading.value) { options.notify("请先加载模型再试 AI"); return }
		if (touchEditingId.value) { options.notify("请先保存或取消区域编辑"); return }
		if (options.replyBusy()) { options.notify("Nori 正在回复或朗读，暂时不能试 AI"); return }
		if (detector.getCooldownRemaining(area.id) > 0) { showTouchCooldown(area); return }
		touchTesting.value = false
		detector.setPreview(false)
		detector.trigger(area, area.gesture === "swipe" ? "swipe" : "tap")
	}

	const closeTouchSettings = () => {
		cancelTouchEdit()
		touchDrawing.value = false
		touchAdjusting.value = false
		touchTesting.value = false
		detector.setPreview(false)
		resetTouchDraft()
		detector.cancel()
		if (touchCooldownTimer) clearTimeout(touchCooldownTimer)
		touchCooldownTimer = null
		touchCooldownText.value = ""
		options.closePanel()
	}

	const onTouchCustomToggle = (event: Event) => {
		touchCustomExpanded.value = (event.target as HTMLDetailsElement).open
		if (touchCustomExpanded.value) return
		cancelTouchEdit()
		touchDrawing.value = false
		touchAdjusting.value = false
		touchTesting.value = false
		detector.setPreview(false)
		resetTouchDraft()
	}

	const toggleTouchDraw = () => {
		cancelTouchEdit()
		touchTesting.value = false
		detector.setPreview(false)
		touchDrawing.value = !touchDrawing.value
		if (touchDrawing.value) touchAdjusting.value = false
		touchDraft.value = null
		draftReady.value = false
		drawingTarget.value = null
		drawStart = null
		drawDragged = false
		if (touchDrawing.value) options.notify("在模型上按住拖动画新矩形")
	}

	const toggleTouchAdjust = () => {
		touchTesting.value = false
		detector.setPreview(false)
		touchAdjusting.value = !touchAdjusting.value
		if (touchAdjusting.value) touchDrawing.value = false
		touchDraft.value = null
		draftReady.value = false
		drawingTarget.value = null
		drawStart = null
		drawDragged = false
		if (touchAdjusting.value) options.notify("点住已有区域可拖动位置")
	}

	const resetTouchDraft = () => {
		touchDraft.value = null
		draftReady.value = false
		drawingTarget.value = null
		drawDragged = false
	}

	watch(() => options.panel.value, (newVal) => {
		if (newVal !== "") options.cancelStageInteraction()
		if (newVal !== 'touch') {
			touchReplyPreview.value = ""
			cancelTouchEdit()
			detector.setPreview(false)
			touchDrawing.value = false
			touchAdjusting.value = false
			touchTesting.value = false
			touchCooldownText.value = ""
			if (touchCooldownTimer) clearTimeout(touchCooldownTimer)
			touchCooldownTimer = null
			draftReady.value = false
			touchDraft.value = null
			drawingTarget.value = null
			drawStart = null
			drawDragged = false
		}
	})

	watch([options.scale, options.offsetX, options.offsetY, options.ready], () => {
		nextTick(() => configureTouchDetector())
	})

	const toModel = (clientX: number, clientY: number): {x: number; y: number} | null => {
		const el = options.canvas()
		const ms = modelSize()
		if (!el) return null
		return toModelPoint(clientX, clientY, el, ms?.w ?? 0, ms?.h ?? 0)
	}

	let drawStart: {x: number; y: number} | null = null

	let drawDragged = false

	let movingOrigin: {x: number; y: number; w: number; h: number} | null = null
	let resizingTouch = false

	const markDrawDragged = (P: {x: number; y: number}) => {
		if (drawDragged || !drawStart) return
		if (Math.abs(P.x - drawStart.x) > 0.025 || Math.abs(P.y - drawStart.y) > 0.025) drawDragged = true
	}

	const hitTouch = (p: {x: number; y: number}): {id: string; t: TouchArea} | null => {
		for (let i = touchAreas.value.length - 1; i >= 0; i--) {
			const t = touchAreas.value[i]
			if (p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h) return {id: t.id, t}
		}
		return null
	}

	const onDrawDown = (e: PointerEvent) => {
		if (!touchDrawing.value && !touchAdjusting.value) return
		const P = toModel(e.clientX, e.clientY)
		if (!P) return

		if (touchAdjusting.value) {
			const HIT = hitTouch(P)
			if (HIT) {
				beginTouchEdit(HIT.id)
				drawStart = P
				drawingTarget.value = HIT.id
				movingOrigin = {x: HIT.t.x, y: HIT.t.y, w: HIT.t.w, h: HIT.t.h}
				const size = modelSize()
				const layout = modelLayout(options.canvas(), size?.w ?? 0, size?.h ?? 0)
				resizingTouch = !!layout && (HIT.t.x + HIT.t.w - P.x) * layout.w < 28 && (HIT.t.y + HIT.t.h - P.y) * layout.h < 28
				touchDraft.value = null
				draftReady.value = false
			}
			return
		}
		drawStart = P

		drawingTarget.value = null
		movingOrigin = null
		drawDragged = false
		draftReady.value = false
		touchDraft.value = {x: P.x, y: P.y, w: 0, h: 0}
	}

	const onDrawMove = (e: PointerEvent) => {
		if (!touchDrawing.value && !touchAdjusting.value) return
		const P = toModel(e.clientX, e.clientY)
		if (!P) return
		if (!drawStart) return
		markDrawDragged(P)

		if (drawingTarget.value && movingOrigin) {
			const dx = P.x - drawStart.x
			const dy = P.y - drawStart.y
			const t = touchAreas.value.find(v => v.id === drawingTarget.value)
			if (t) {
				if (resizingTouch) {
					previewTouchEdit(t.id, {w: Math.max(0.06, Math.min(1 - t.x, movingOrigin.w + dx)), h: Math.max(0.06, Math.min(1 - t.y, movingOrigin.h + dy))})
					return
				}
				const nx = Math.max(0, Math.min(1 - t.w, movingOrigin.x + dx))
				const ny = Math.max(0, Math.min(1 - t.h, movingOrigin.y + dy))
				touchAreas.value = touchAreas.value.map(v => v.id === t.id ? {...v, x: nx, y: ny} : v)
			}
			return
		}

		if (!touchDrawing.value) return
		touchDraft.value = {
			x: Math.min(drawStart.x, P.x),
			y: Math.min(drawStart.y, P.y),
			w: Math.abs(P.x - drawStart.x),
			h: Math.abs(P.y - drawStart.y),
		}
	}

	const onDrawUp = (cancelled = false) => {
		drawStart = null

		if (drawingTarget.value) {
			if (cancelled && movingOrigin) previewTouchEdit(drawingTarget.value, movingOrigin)
			drawingTarget.value = null; movingOrigin = null; drawDragged = false; return
		}
		drawingTarget.value = null
		movingOrigin = null

		if (touchAdjusting.value) { drawDragged = false; return }

		const d = touchDraft.value
		if (!cancelled && d && drawDragged && d.w >= 0.06 && d.h >= 0.06) {
			draftReady.value = true

			touchDrawing.value = false
		} else {
			touchDraft.value = null
		}
		drawDragged = false
	}

	const boxStyle = (t: {x: number; y: number; w: number; h: number}) => {
		void options.layoutVersion.value
		const el = options.canvas()
		const ms = modelSize()
		if (!el) return {}
		const R = el.getBoundingClientRect()
		if (R.width <= 0 || R.height <= 0) return {}
		const L = modelLayout(el, ms?.w ?? 0, ms?.h ?? 0)
		if (!L) return {}

		return {
			left: `${R.left + L.x + t.x * L.w}px`,
			top: `${R.top + L.y + t.y * L.h}px`,
			width: `${t.w * L.w}px`,
			height: `${t.h * L.h}px`,
		}
	}

	/** App invokes these at the original separate cleanup points. */
	const clearTouchCooldown = (): void => {
		if (touchCooldownTimer) clearTimeout(touchCooldownTimer)
		touchCooldownTimer = null
	}
	const disposeTouchDetector = (): void => { detector.destroy() }

	return {
		touchAreas, selectedTouchId, touchCustomExpanded, touchEditingId, deletedTouch,
		touchEnabled, touchTesting, touchCooldownText, touchReplyPreview,
		touchDrawing, touchAdjusting, touchDraft, draftReady, drawingTarget,
		detector, configureTouchDetector, modelSize, loadTouchForModel, saveTouch,
		onTouchAdd, beginTouchEdit, cancelTouchEdit, previewTouchEdit, onTouchUpdate,
		onTouchRemove, undoTouchRemove, setTouchEnabled, toggleTouchTesting, showTouchCooldown,
		onTouchTest, closeTouchSettings, onTouchCustomToggle, toggleTouchDraw, toggleTouchAdjust,
		resetTouchDraft, toModel, onDrawDown, onDrawMove, onDrawUp, boxStyle,
		clearTouchCooldown, disposeTouchDetector,
	}
}
