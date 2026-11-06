import {
	initDataseaBg, setDataseaBgEnabled, resizeDataseaBg, stopDataseaBg,
	setDataseaFps, dataseaTouchStart, dataseaTouchMove, dataseaTouchEnd,
} from './datasea-bg'
import type {BackgroundMode} from './chat'
import type {createDeepseaBg, DeepseaQuality} from './deepsea-bg'

type Deepsea = ReturnType<typeof createDeepseaBg>
type VisibleMode = BackgroundMode

/** One owner for both renderers, including asynchronous loading and lifecycle. */
export const createBackgroundController = (options: {
	dataseaCanvas: () => HTMLCanvasElement | null
	deepseaCanvas: () => HTMLCanvasElement | null
	onVisible: (mode: VisibleMode) => void
	onError: (message: string) => void
}) => {
	let mode: BackgroundMode = 'off'
	let visible: VisibleMode = 'off'
	let paused = true
	let disposed = false
	let generation = 0
	let dataseaInitialized = false
	let deepsea: Deepsea | null = null
	let failed = false
	let scale = 1
	let fps = 60
	let quality: DeepseaQuality = 'balanced'

	const show = (value: VisibleMode) => { visible = value; options.onVisible(value) }
	const stopCurrent = () => {
		dataseaTouchEnd()
		setDataseaBgEnabled(false)
		deepsea?.touchEnd()
		deepsea?.destroy()
		deepsea = null
		show('off')
	}
	const startDatasea = () => {
		const canvas = options.dataseaCanvas()
		if (!canvas) return
		setDataseaFps(fps)
		if (!dataseaInitialized) { initDataseaBg(canvas); dataseaInitialized = true }
		else setDataseaBgEnabled(true)
		show('datasea')
	}
	const fallback = () => {
		if (disposed || mode !== 'deep-sea') return
		generation++
		failed = true
		stopCurrent()
		options.onError('深海场景暂时不可用，已切换到数据海。可重试或选择其他背景。')
		if (!paused) startDatasea()
	}
	const reconcile = () => {
		const token = ++generation
		if (disposed) return
		if (paused) { stopDataseaBg(); deepsea?.pause(); return }
		if (mode === 'off') { stopCurrent(); return }
		if (mode === 'datasea' || failed) {
			if (visible !== 'datasea') { stopCurrent(); startDatasea() }
			else setDataseaBgEnabled(true)
			return
		}
		if (deepsea) {
			try { deepsea.start() } catch { fallback() }
			return
		}
		stopCurrent()
		void import('./deepsea-bg').then(({createDeepseaBg}) => {
			if (disposed || paused || mode !== 'deep-sea' || token !== generation) return
			const canvas = options.deepseaCanvas()
			if (!canvas) throw new Error('missing deep sea canvas')
			deepsea = createDeepseaBg(canvas, fallback)
			deepsea.setQuality(quality)
			deepsea.resize(scale)
			deepsea.setFps(fps)
			deepsea.start()
			show('deep-sea')
		}).catch(() => { if (token === generation && !disposed) fallback() })
	}
	return {
		setMode(next: BackgroundMode) {
			if (next !== mode || failed) { stopCurrent(); failed = false; options.onError('') }
			mode = next
			reconcile()
		},
		setPaused(value: boolean) { paused = value; reconcile() },
		resize(value: number) { scale = value; resizeDataseaBg(); deepsea?.resize(value) },
		setFps(value: number) { fps = value; setDataseaFps(value); deepsea?.setFps(value) },
		setQuality(value: DeepseaQuality) {
			quality = value === 'fine' ? 'fine' : 'balanced'
			try { deepsea?.setQuality(quality) } catch { fallback() }
		},
		touchStart(x: number, y: number) { if (!paused) { if (visible === 'datasea') dataseaTouchStart(x, y); else deepsea?.touchStart(x, y) } },
		touchMove(x: number, y: number) { if (!paused) { if (visible === 'datasea') dataseaTouchMove(x, y); else deepsea?.touchMove(x, y) } },
		touchEnd() { dataseaTouchEnd(); deepsea?.touchEnd() },
		destroy() { disposed = true; generation++; stopCurrent() },
	}
}
