import {FLOAT_CROP_SAMPLE_MS, FloatingCropTracker, validCanvasBounds, type CanvasBounds} from "../services/live2d/floatingCrop"
import {loadFloatingCrop, saveFloatingCrop} from "../services/live2d/floatingCropCache"

interface GeometryBridge {
	beginFloatModelGeometry?: () => number
	setFloatVisibleGeometry?: (json: string) => void
	setFloatModelGeometry?: (l: number, t: number, r: number, b: number, w: number, h: number) => void
	setFloatModelRect?: (l: number, t: number, r: number, b: number) => void
	setFloatModelFeet?: (feet: number) => void
	floatFrameDrawn?: (request: number) => void
}
declare global {
	interface Window {
		__noriVisibleBounds?: () => CanvasBounds | null
		__noriAfterL2dDraw?: () => void
		__noriFloatGeometryApplied?: (generation: number, revision: number) => void
		__noriFloatFrameRequest?: number
	}
}

/** One instance per mounted model. Native acknowledgement precedes any reaction playback. */
export const installFloatingGeometry = (modelKey?: string) => {
	const bridge = window.NoriChat as GeometryBridge | undefined
	const generation = bridge?.beginFloatModelGeometry?.() ?? 1
	const tracker = new FloatingCropTracker()
	let revision = 0, lastSample = -Infinity, signature = "", stopped = false, ready = false
	let cacheAspect = 0, cachedBounds = "", lastSaved = -Infinity
	const waiters = new Map<number, {resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>}>()
	const resize = () => {
		tracker.resize(window.innerWidth, window.innerHeight)
		lastSample = -Infinity
		const aspect = window.innerWidth / window.innerHeight
		if (cacheAspect && Math.abs(aspect / cacheAspect - 1) <= 0.02) return
		cacheAspect = aspect
		cachedBounds = ""
		if (modelKey) try {
			const saved = loadFloatingCrop(window.localStorage, modelKey, aspect)
			if (saved) { tracker.restore(saved); cachedBounds = JSON.stringify(saved) }
		} catch { /* localStorage may be unavailable; keep normal calibration. */ }
	}
	resize()
	const ack = (epoch: number, applied: number) => {
		if (epoch !== generation || stopped) return
		for (const [id, waiter] of waiters) if (id <= applied) {
			clearTimeout(waiter.timer); waiters.delete(id); waiter.resolve(true)
		}
	}
	window.__noriFloatGeometryApplied = ack
	const publish = (acknowledge = false): Promise<boolean> => {
		if (stopped) return Promise.resolve(false)
		const dpr = window.devicePixelRatio || 1
		const width = Math.round(window.innerWidth * dpr), height = Math.round(window.innerHeight * dpr)
		const state = tracker.geometry(performance.now())
		const pixels = (r: CanvasBounds) => [Math.floor(r.l * width), Math.floor(r.t * height),
			Math.ceil(r.r * width), Math.ceil(r.b * height)]
		const data = {width, height, crop: pixels(state.crop), hit: pixels(state.hit),
			feet: Math.ceil(state.feet * height), precise: state.precise}
		const next = JSON.stringify(data)
		if (!acknowledge && next === signature) return Promise.resolve(true)
		signature = next
		const seq = ++revision
		let result = Promise.resolve(true)
		if (acknowledge && bridge?.setFloatVisibleGeometry) result = new Promise<boolean>(resolve => {
			const timer = setTimeout(() => { waiters.delete(seq); resolve(false) }, 1500)
			waiters.set(seq, {resolve, timer})
		})
		try {
			if (bridge?.setFloatVisibleGeometry) bridge.setFloatVisibleGeometry(JSON.stringify({generation, revision: seq, ...data}))
			else {
				// Old bridge compatibility: use the safe crop rectangle, not a tight reaction frame.
				const [l, t, r, b] = data.crop
				if (bridge?.setFloatModelGeometry) bridge.setFloatModelGeometry(l!, t!, r!, b!, width, height)
				else bridge?.setFloatModelRect?.(l!, t!, r!, b!)
				bridge?.setFloatModelFeet?.(data.feet)
			}
		} catch {
			const waiter = waiters.get(seq)
			if (waiter) { clearTimeout(waiter.timer); waiters.delete(seq); waiter.resolve(false) }
			return Promise.resolve(false)
		}
		return result
	}
	const onDraw = () => {
		const now = performance.now()
		if (stopped || !ready) return
		if (window.__noriFloatFrameRequest && validCanvasBounds(window.__noriVisibleBounds?.())) {
			const request = window.__noriFloatFrameRequest
			delete window.__noriFloatFrameRequest
			bridge?.floatFrameDrawn?.(request)
		}
		if (now - lastSample < FLOAT_CROP_SAMPLE_MS) return
		lastSample = now
		tracker.sample(window.__noriVisibleBounds?.() ?? null, now)
		void publish()
		const state = tracker.geometry(now), bounds = JSON.stringify(state.crop)
		if (modelKey && state.precise && bounds !== cachedBounds && now - lastSaved >= 2000) {
			try { saveFloatingCrop(window.localStorage, modelKey, cacheAspect, state.crop) } catch { /* Optional cache. */ }
			cachedBounds = bounds
			lastSaved = now
		}
	}
	window.__noriAfterL2dDraw = onDraw
	void publish()
	return {
		start: () => { ready = true; lastSample = -Infinity },
		resize: () => { resize(); void publish() },
		pause: () => { tracker.pause(); lastSample = -Infinity },
		contextLost: () => {
			ready = false
			tracker.sample(null, performance.now())
			void publish()
		},
		protect: () => { tracker.protect(); return publish(true) },
		neutral: () => { tracker.neutral(performance.now()); void publish() },
		stop: () => {
			stopped = true
			if (window.__noriAfterL2dDraw === onDraw) delete window.__noriAfterL2dDraw
			if (window.__noriFloatGeometryApplied === ack) delete window.__noriFloatGeometryApplied
			for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.resolve(false) }
			waiters.clear()
		},
	}
}
