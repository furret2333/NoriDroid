export interface CanvasLayoutOptions {
	zIndex: string
	scale: number
	offsetX: number
	offsetY: number
	animate: boolean
	inset?: number
}

/** canvas 的 CSS 变换参数（与 `applyCanvasLayout` 写进去的一致） */
export interface CanvasView {
	/** 视口宽高（canvas 未变换时铺满视口） */
	w: number
	h: number
	scale: number
	offsetX: number
	offsetY: number
}

/**
 * **正向**：未变换的 canvas 坐标 → 屏幕 client 坐标。
 *
 * 与 `applyCanvasLayout` 的 `transform-origin: center` +
 * `transform: scale(s) translate(ox, oy)` 一致：先 translate 再 scale，两次都绕画布中心。
 * （transform 函数列表是**从右往左**作用的，所以 translate 先于 scale，其位移量也会被 s 缩放。）
 *
 * 用途：调试叠层要把"模型坐标系里的位置"画回屏幕上时用；也是下面逆变换的对照实现（门禁做往返验证）。
 */
export const clientFromCanvasPoint = (x: number, y: number, v: CanvasView): {x: number; y: number} => {
	const s = Number.isFinite(v.scale) && v.scale !== 0 ? v.scale : 1
	const ox = Number.isFinite(v.offsetX) ? v.offsetX : 0
	const oy = Number.isFinite(v.offsetY) ? v.offsetY : 0
	const cx = v.w / 2
	const cy = v.h / 2
	return {x: cx + s * (x + ox - cx), y: cy + s * (y + oy - cy)}
}

/**
 * **逆向**：屏幕 client 坐标 → **未变换的 canvas 坐标**。
 *
 * ## 为什么必须有它（实机 bug 的根因）
 * 命中/坐标钩子内部走的是库的 `transformViewX/Y`：
 * ```js
 * transformViewX(t) { return this._viewMatrix.invertTransformX(this._deviceToScreen.transformX(t)) }
 * ```
 * 它**完全不知道** canvas 上那个 CSS 变换 —— CSS 变换只影响浏览器如何显示已画好的像素，
 * WebGL/库的矩阵里没有它。于是**只要 scale≠1 或 offsetX/Y≠0，渲染与命中就整体错位**：
 * 库认为的模型框会比实际渲染更大/更偏，手指落在模型旁边的空白处也会被判成"命中实体"。
 *
 * 症状（实机）：模型被双指缩小后，在她头顶**上方**滑动时坐标被算成"落在头上"，
 * 抚摸粒子就冒在她头顶上空。
 *
 * 所以喂给 `__noriHitTest` / `__noriModelPoint` 之前，必须先把 client 坐标逆变换回未变换的画布坐标系。
 * 触摸区那条路不需要（它用 `getBoundingClientRect`，本来就跟着 CSS 变换走，是对的）。
 */
export const canvasPointFromClient = (cx: number, cy: number, v: CanvasView): {x: number; y: number} => {
	const s = Number.isFinite(v.scale) && v.scale !== 0 ? v.scale : 1
	const ox = Number.isFinite(v.offsetX) ? v.offsetX : 0
	const oy = Number.isFinite(v.offsetY) ? v.offsetY : 0
	const mx = v.w / 2
	const my = v.h / 2
	return {x: mx + (cx - mx) / s - ox, y: my + (cy - my) / s - oy}
}

export const applyCanvasLayout = (
	canvas: HTMLCanvasElement | null,
	box: HTMLElement | null | undefined,
	options: CanvasLayoutOptions
): void => {
	if (!canvas) return
	canvas.style.position = "fixed"
	canvas.style.pointerEvents = "none"
	canvas.style.transformOrigin = "center"

	if (box) {
		canvas.style.transformOrigin = "bottom center"
		const rect = box.getBoundingClientRect()
		const inset = options.inset ?? 0
		canvas.style.left = `${rect.left + inset}px`
		canvas.style.top = `${rect.top + inset}px`
		canvas.style.width = `${Math.max(0, rect.width - inset * 2)}px`
		canvas.style.height = `${Math.max(0, rect.height - inset * 2)}px`
		canvas.style.zIndex = options.zIndex
	} else {
		canvas.style.left = "0"; canvas.style.top = "0"
		canvas.style.width = "100%"; canvas.style.height = "100%"
		canvas.style.zIndex = options.zIndex || "1"
	}
	canvas.style.transform = `scale(${options.scale}) translate(${options.offsetX}px, ${options.offsetY}px)`
	canvas.style.opacity = "1"

	if (options.animate) {
		const ease = "0.42s cubic-bezier(0.4, 0, 0.2, 1)"
		canvas.style.transition = `left ${ease}, top ${ease}, width ${ease}, height ${ease}, opacity 0.3s ease`
	} else {
		canvas.style.transition = "none"
	}
}
