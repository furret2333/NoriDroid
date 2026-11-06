import {reactive, ref, type Ref} from "vue"
import {readModelConfig, writeModelConfig} from "../services/live2d/config"

interface CanvasTransformOptions {
	modelId: Ref<string>
	inTouchSettings: () => boolean
	relayout: () => void
	openModelPanel: () => void
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Main-stage transform and lock input. The app controls model loading and cleanup order. */
export const useCanvasTransform = (options: CanvasTransformOptions) => {
	const scale = ref(1)
	const offsetX = ref(0)
	const offsetY = ref(0)

	const gesture = reactive<Record<number, {x: number; y: number}>>({})
	let pinchBase = {dist: 0, midX: 0, midY: 0, scale: 1, ox: 0, oy: 0}

	// 主画布只锁位置与缩放，保留抚摸和聊天互动；不影响独立悬浮窗。
	const CANVAS_LOCK_KEY = "l2d_canvas_locked"
	const canvasLocked = ref((() => {
		try { return localStorage.getItem(CANVAS_LOCK_KEY) === "1" } catch { return false }
	})())
	let modelTagTimer: ReturnType<typeof setTimeout> | null = null
	let modelTagPointer: {id: number; x: number; y: number} | null = null
	let modelTagClickSuppressed = false

	const toggleCanvasLock = (): void => {
		canvasLocked.value = !canvasLocked.value
		for (const id of Object.keys(gesture)) delete gesture[Number(id)]
		pinchBase = {dist: 0, midX: 0, midY: 0, scale: 1, ox: 0, oy: 0}
		flushTransformSave()
		try { localStorage.setItem(CANVAS_LOCK_KEY, canvasLocked.value ? "1" : "0") } catch { /* 保留本次状态 */ }
	}

	const cancelModelTagPress = (suppressClick = false): void => {
		if (suppressClick && modelTagPointer) modelTagClickSuppressed = true
		if (modelTagTimer) clearTimeout(modelTagTimer)
		modelTagTimer = null
		modelTagPointer = null
	}

	const onModelTagDown = (event: PointerEvent): void => {
		if (!event.isPrimary || event.button !== 0) { cancelModelTagPress(true); return }
		cancelModelTagPress()
		modelTagClickSuppressed = false
		modelTagPointer = {id: event.pointerId, x: event.clientX, y: event.clientY}
		;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
		modelTagTimer = setTimeout(() => {
			modelTagTimer = null
			modelTagClickSuppressed = true
			toggleCanvasLock()
		}, 700)
	}

	const onModelTagMove = (event: PointerEvent): void => {
		const press = modelTagPointer
		if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelModelTagPress(true)
	}

	const onModelTagSpace = (event: KeyboardEvent): void => {
		if (!event.repeat) { cancelModelTagPress(); modelTagClickSuppressed = false; toggleCanvasLock() }
	}

	const onModelTagClick = (): void => {
		if (modelTagClickSuppressed) { modelTagClickSuppressed = false; return }
		options.openModelPanel()
	}

	const isUI = (t: Touch): boolean =>
		!!(t.target as HTMLElement)?.closest?.(".sheet, .chat-panel, .dock, .topbar, .side-rail, .side-rail-mask")

	const onTouchStart = (e: TouchEvent) => {
		if (options.inTouchSettings()) return
		if (canvasLocked.value) return
		for (const t of Array.from(e.touches)) {
			if (isUI(t)) continue
			gesture[t.identifier] = {x: t.clientX, y: t.clientY}
		}
		if (Object.keys(gesture).length === 2) {
			const [a, b] = Object.values(gesture)
			pinchBase = {
				dist: Math.hypot(a.x - b.x, a.y - b.y),
				midX: (a.x + b.x) / 2,
				midY: (a.y + b.y) / 2,
				scale: scale.value,
				ox: offsetX.value,
				oy: offsetY.value,
			}
		}
	}

	const onTouchMove = (e: TouchEvent) => {
		if (canvasLocked.value) return
		// 只更新起手时登记的画布触点，不能把 UI 上的手指重新算进捏合。
		for (const t of Array.from(e.touches)) {
			if (gesture[t.identifier]) gesture[t.identifier] = {x: t.clientX, y: t.clientY}
		}
		const pts = Object.values(gesture)
		if (pts.length !== 2) return
		const [a, b] = pts
		const dist = Math.hypot(a.x - b.x, a.y - b.y)
		const midX = (a.x + b.x) / 2
		const midY = (a.y + b.y) / 2
		if (pinchBase.dist > 0) {
			/* 缩放下限从 0.3 提到 0.6（2026-10-05）。0.3 时角色只占屏幕约 1%，
			   而 Live2D 画布**始终是整个视口**、不跟着缩放变 ⇒ 那种情况下等于为 99% 的空白
			   照价付"每帧清屏 + 合成"。实际也没有缩到那么小的需求，所以直接把下限抬上来，
			   从源头上不出现那个画面。要回退就把 0.6 改回 0.3。 */
			scale.value = clamp(pinchBase.scale * (dist / pinchBase.dist), 0.6, 3)
		}
		
		offsetX.value = clamp(pinchBase.ox + (midX - pinchBase.midX), -500, 500)
		offsetY.value = clamp(pinchBase.oy + (midY - pinchBase.midY), -800, 400)
		options.relayout()
		scheduleSaveTransform()
	}

	const onTouchEnd = (e: TouchEvent) => {

		const liveSet = new Set(Array.from(e.touches).map((t) => t.identifier))
		for (const id of Object.keys(gesture)) {
			if (!liveSet.has(Number(id))) delete gesture[Number(id)]
		}
		if (Object.keys(gesture).length !== 2) pinchBase = {dist: 0, midX: 0, midY: 0, scale: 1, ox: 0, oy: 0}
		// 手势结束: 把节流期间挂起的变换立即落盘 (拖动/缩放的最终位置不丢)
		flushTransformSave()
	}

	const flushTransformSave = (): void => {
		if (transformSaveTimer) { clearTimeout(transformSaveTimer); transformSaveTimer = null }
		if (transformDirty) { transformDirty = false; saveTransform() }
	}

	/** 拖动/缩放中节流保存: touchmove 每帧同步写 3 个 localStorage 键会掉帧,
	 *  移动中最多 400ms 落一次盘, 手势结束 (onTouchEnd) 再兜底写最终值 */
	let transformSaveTimer: ReturnType<typeof setTimeout> | null = null
	let transformDirty = false
	const scheduleSaveTransform = (): void => {
		transformDirty = true
		if (transformSaveTimer) return
		transformSaveTimer = setTimeout(() => {
			transformSaveTimer = null
			if (transformDirty) {
				transformDirty = false
				saveTransform()
			}
		}, 400)
	}

	const saveTransform = () => {
		const id = options.modelId.value
		if (!id) return
		writeModelConfig(id, "l2d_scale", scale.value)
		writeModelConfig(id, "l2d_offset_x", offsetX.value)
		writeModelConfig(id, "l2d_offset_y", offsetY.value)
	}

	const restoreTransform = async (id: string): Promise<void> => {
		// Match the pinch limits when restoring older model-specific settings.
		scale.value = clamp((await readModelConfig(id, "l2d_scale", (v) => (typeof v === "number" ? v : parseFloat(String(v))), 1.12)) || 1.12, 0.6, 3)
		offsetX.value = (await readModelConfig(id, "l2d_offset_x", (v) => (typeof v === "number" ? v : parseFloat(String(v))), 0)) || 0
		offsetY.value = (await readModelConfig(id, "l2d_offset_y", (v) => (typeof v === "number" ? v : parseFloat(String(v))), 0)) || 0
	}

	const clearTransformTouches = (): void => {
		for (const id of Object.keys(gesture)) delete gesture[Number(id)]
	}

	return {
		scale, offsetX, offsetY, canvasLocked, restoreTransform, clearTransformTouches,
		onModelTagDown, onModelTagMove, onModelTagSpace, onModelTagClick, cancelModelTagPress,
		onTouchStart, onTouchMove, onTouchEnd, flushTransformSave,
	}
}
