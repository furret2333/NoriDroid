import {computed, ref, watch, type Ref} from "vue"
import type {createLive2D} from "../services/live2d"
import {normalizeFps} from "../services/live2d/frameCap"
import {normalizeRenderScale} from "../services/live2d/renderScale"
import {createBackgroundController} from "../services/background-controller"
import type {BackgroundMode} from "../services/chat"
import {footlightPosition, type VisibleBounds} from "../services/live2d/footlight"
import type {CanvasView} from "../services/live2d/stage"
import type {AppSettings} from "./useAppSettings"

export interface StageRenderingOptions {
	l2d: ReturnType<typeof createLive2D>
	ready: Readonly<Ref<boolean>>
	loading: Readonly<Ref<boolean>>
	layoutVersion: Readonly<Ref<number>>
	canvasView: () => CanvasView
	settings: () => Pick<AppSettings, "renderScale" | "l2dFps" | "dataseaBg" | "backgroundMode" | "deepseaQuality">
	persistSettings: () => string
}

/** Render controls shared by the stage and settings. App keeps lifecycle ordering explicit. */
export const useStageRendering = ({l2d, ready, loading, layoutVersion, canvasView, settings, persistSettings}: StageRenderingOptions) => {
	const dataseaCanvas = ref<HTMLCanvasElement | null>(null)
	const deepseaCanvas = ref<HTMLCanvasElement | null>(null)
	const visibleBackground = ref<BackgroundMode>("off")
	const backgroundError = ref("")
	const footlightStagePaused = ref(true)
	const footlightBounds = ref<VisibleBounds | null>(null)
	let footlightTimer: ReturnType<typeof setTimeout> | null = null
	const footlight = computed(() => {
		// Relayout updates this even when the viewport, rather than the transform, changes.
		void layoutVersion.value
		if (visibleBackground.value !== "deep-sea" || !ready.value || loading.value || footlightStagePaused.value || !l2d.canvas()) return null
		return footlightPosition(footlightBounds.value, canvasView())
	})

	/** Call at the original App watch registration point; Vue owns watch cleanup. */
	const bindFootlightSampling = () => watch([visibleBackground, ready, loading, footlightStagePaused], ([mode, isReady, isLoading, paused], _old, onCleanup) => {
		if (footlightTimer) clearTimeout(footlightTimer)
		footlightTimer = null
		footlightBounds.value = null
		if (mode !== "deep-sea" || !isReady || isLoading || paused) return
		let stopped = false
		const sample = () => {
			if (stopped) return
			try { footlightBounds.value = window.__noriVisibleBounds?.() ?? null } catch { footlightBounds.value = null }
			footlightTimer = setTimeout(sample, 2000)
		}
		// Give Live2D a frame after load/resume to update its rendering matrix.
		footlightTimer = setTimeout(sample, 150)
		onCleanup(() => { stopped = true; if (footlightTimer) clearTimeout(footlightTimer); footlightTimer = null })
	}, {flush: "sync"})

	const background = createBackgroundController({
		dataseaCanvas: () => dataseaCanvas.value,
		deepseaCanvas: () => deepseaCanvas.value,
		onVisible: (mode) => { visibleBackground.value = mode },
		onError: (message) => { backgroundError.value = message },
	})

	const renderScaleNum = computed(() => normalizeRenderScale(settings().renderScale, 1))
	const nativeDpr = computed(() => Math.max(1.5, Math.min(window.devicePixelRatio || 2, 3)))

	const applyRenderScale = () => {
		const cfg = settings()
		cfg.renderScale = normalizeRenderScale(cfg.renderScale, 1)
		l2d.setRenderScale(renderScaleNum.value)   // 先写 __noriRenderScale (库与命中钩子都读它)
		background.resize(renderScaleNum.value)
	}

	/* ---- 渲染帧率档位（背景还可设置更低的上限） ---- */
	/** 当前档位 (非法值回落默认档)。0 显示为"不限" */
	const l2dFpsNum = computed(() => normalizeFps(settings().l2dFps))
	/** 一处生效: 形象与背景读取同一个设置。 */
	const applyL2dFps = () => {
		l2d.applyFrameCap(l2dFpsNum.value)
		background.setFps(l2dFpsNum.value)
	}
	/** 切换档位: 立即生效 + 落盘 */
	const setL2dFps = (v: number): void => {
		const cfg = settings()
		cfg.l2dFps = normalizeFps(v)
		applyL2dFps()
		persistSettings()
	}

	const onBackgroundModeChange = (): void => {
		const cfg = settings()
		cfg.dataseaBg = cfg.backgroundMode !== "off"
		background.setMode(cfg.backgroundMode)
		persistSettings()
	}
	const onDeepseaQualityChange = (): void => {
		const cfg = settings()
		background.setQuality(cfg.deepseaQuality)
		persistSettings()
	}
	const retryBackground = (): void => { background.setMode(settings().backgroundMode) }

	const setStageRenderPaused = (paused: boolean): void => {
		footlightStagePaused.value = paused
		try { l2d.pauseRender(paused) } catch { /* 忽略 */ }
		try { background.setPaused(paused) } catch { /* 忽略 */ }
	}

	return {
		dataseaCanvas, deepseaCanvas, visibleBackground, backgroundError, footlight,
		background, renderScaleNum, nativeDpr, l2dFpsNum,
		bindFootlightSampling, applyRenderScale, applyL2dFps, setL2dFps,
		onBackgroundModeChange, onDeepseaQualityChange, retryBackground, setStageRenderPaused,
	}
}
