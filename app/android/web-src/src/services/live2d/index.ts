import {
	getAllMotionsInfo,
	load,
	playExpression,
	playMotion,
	reSetAngle,
	setAngleXY,
	setLipSync as libSetLipSync,
	stop,
	stopExpression,
} from "live2d-easy-control"
import {live2dUrl} from "./config"
import {installFrameCap, setFrameCap, setRenderPaused, L2D_FPS_DEFAULT, L2D_FPS_OPTIONS, normalizeFps, type L2dFps} from "./frameCap"

declare global {
	interface Window {
		__noriRenderScale?: number
		/** 帧率上限对应的最小帧间隔 (ms); 0 = 不限制。由 frameCap 写入 */
		__noriL2dMinInterval?: number
		/** 上一帧实际绘制的时刻 (performance.now) */
		__noriL2dLast?: number
		/** 渲染暂停开关 (悬浮窗在主 App 前台 / 页面不可见时为 true); 见 frameCap.setRenderPaused */
		__noriL2dPaused?: boolean
		/** 真正画过的帧数 (诊断/门禁: 断言"暂停期间一帧都没画") */
		__noriL2dDraws?: number
		/** 节流版"更新+绘制"; 补丁后的库渲染循环调用它 (见 patch-live2d 的 l2d-fps-cap) */
		__noriL2dTick?: (updater: {updateTime: () => void}, model: {update: () => void}) => void
	}
}

/* 渲染帧率上限: 把库的裸 rAF 循环限到设定值 (120Hz 屏省一半, 60Hz 屏只有低于 60 才有效)。
 * 档位由设置页控制 (applyL2dFps); 逻辑与单测见 ./frameCap。
 * 排障逃生口: 控制台执行 setFrameCap 等价的 window.__noriL2dMinInterval = 0 */
installFrameCap(window, L2D_FPS_DEFAULT)

export {L2D_FPS_OPTIONS, normalizeFps, type L2dFps}

export interface Live2DModelSpec {
	directory: string
	fileBase: string
}

export interface MotionGroup {
	group: string
	names: string[]
}

export const MOTION_PRIORITY = {
	none: 0,
	idle: 1,
	normal: 2,
	force: 3,
} as const

export interface Live2DMountOptions {
	canvasWidth?: string
	canvasHeight?: string
	
	host?: HTMLElement | null
}



const buildLoadConfig = (model: Live2DModelSpec, options: Live2DMountOptions = {}): Record<string, unknown> => ({
	modelDir: model.fileBase,
	resourcesPath: `${live2dUrl(model.directory)}/`,
	canvasSize: "auto",
	canvasWidth: options.canvasWidth ?? "100%",
	canvasHeight: options.canvasHeight ?? "100%",
})

export const createLive2D = () => {
	let canvasEl: HTMLCanvasElement | null = null
	
	
	let didLoad = false

	const canvas = (): HTMLCanvasElement | null => canvasEl

	
	const srcSize = (): {w: number; h: number} | null => {
		if (!canvasEl) return null
		const w = canvasEl.width
		const h = canvasEl.height
		if (!w || !h) return null
		return {w, h}
	}

	const mount = async (model: Live2DModelSpec, options?: Live2DMountOptions): Promise<void> => {
		if (canvasEl && canvasEl.isConnected) canvasEl.remove()
		canvasEl = null
		await load(buildLoadConfig(model, options))
		didLoad = true
		// 只认"body 的直接 canvas 子元素" (库挂载时新建的那个)。应用自身也有 canvas
		// (如数据海背景), 全局 querySelector 会错抓它: Live2D 被渲染进背景画布,
		// 而库自建的空画布留在 body 末尾 —— 透明但可点击, 整屏吞掉所有按钮的事件
		canvasEl = (document.body.querySelector(":scope > canvas") as HTMLCanvasElement | null)
		if (canvasEl) {


			if (options?.host) options.host.appendChild(canvasEl)
			canvasEl.style.pointerEvents = "none"
			canvasEl.style.position = "fixed"
			canvasEl.style.left = "0"
			canvasEl.style.top = "0"
			canvasEl.style.bottom = "auto"
			canvasEl.style.right = "auto"
			canvasEl.style.width = "100%"
			canvasEl.style.height = "100%"
			canvasEl.style.transform = "none"

			canvasEl.style.zIndex = "1"
		}
	}

	const destroy = async (): Promise<void> => {
		if (didLoad) {
			try { await stop() } catch {  }
			didLoad = false
		}
		if (canvasEl && canvasEl.isConnected) canvasEl.remove()
		canvasEl = null
	}

	const getMotions = async (): Promise<MotionGroup[] | null> => {
		try { return await getAllMotionsInfo() } catch { return null }
	}

	
	
	
	const setRenderScale = (scale: number): void => {
		try {
			window.__noriRenderScale = scale
			if (canvasEl) {
				const w = canvasEl.style.width, h = canvasEl.style.height
				canvasEl.style.width = "99.99%"
				canvasEl.style.height = "99.99%"
				
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						canvasEl!.style.width = w
						canvasEl!.style.height = h
					})
				})
			}
		} catch {  }
	}

	/** 运行时切换帧率档位 (设置页调用)。0 = 不限制 */
	const applyFrameCap = (fps: number): void => {
		try { setFrameCap(window, normalizeFps(fps)) } catch { /* 忽略 */ }
	}

	/**
	 * 暂停 / 恢复渲染 (悬浮窗主 App 回前台、页面不可见时调用)。
	 * 只是让库的渲染循环**不画**，不销毁模型、不碰 canvas —— 恢复是即时的。
	 */
	const pauseRender = (paused: boolean): void => {
		try { setRenderPaused(window, paused) } catch { /* 忽略 */ }
	}

	const playMotionByIndex = async (group: string, no: number, priority = MOTION_PRIORITY.force): Promise<boolean> => {
		try { await playMotion(group, no, priority); return true } catch { return false }
	}

	const playMotionByName = async (name: string, priority = MOTION_PRIORITY.force): Promise<boolean> => {
		const groups = await getMotions()
		if (!groups) return false
		for (const g of groups) {
			const idx = g.names.findIndex((n) => n === name)
			if (idx >= 0) return playMotionByIndex(g.group, idx, priority)
		}
		return false
	}

	/** 设置任意模型参数 (由 patch-live2d 暴露) */
	const setParam = (id: string, value: number): void => {
		try {
			const fn = (window as unknown as {__noriSetParam?: (pid: string, v: number) => void}).__noriSetParam
			fn?.(id, value)
		} catch { /* 忽略 */ }
	}

	/** 查询模型是否含某参数 */
	const hasParam = (id: string): boolean => {
		try {
			const fn = (window as unknown as {__noriHasParam?: (pid: string) => boolean}).__noriHasParam
			return !!fn?.(id)
		} catch { return false }
	}

	return {
		mount,
		// 库内部 setAngleXY(x, y) 会把参数转置 (touchesMoved(y, x)), 这里换回来, 否则上下左右会反
		lookAt: (x: number, y: number, duration?: number) => setAngleXY(y, x, duration),
		resetLook: () => reSetAngle(),
		/* 口型：库的公开 API（每帧 addParameterValueById(ParamMouthOpenY, value, weight)）。
		   此前产品代码 0 处调用 ⇒ 说话时嘴不动；语音聊天期间由 PCM 包络驱动。 */
		setLipSync: (v: number) => libSetLipSync(Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0),
		playExpression: (name: string) => playExpression(name),
		stopExpression: () => stopExpression(),
		setParam,
		hasParam,
		destroy,
		canvas,
		srcSize,
		getMotions,
		setRenderScale,
		applyFrameCap,
		pauseRender,
		playMotionByIndex,
		playMotionByName,
	}
}

export type Live2DController = ReturnType<typeof createLive2D>

export {
	live2dUrl,
	L2D_CONFIG_KEYS,
	readModelConfig,
	writeModelConfig,
	parseNumber,
	l2dModelKey,
} from "./config"