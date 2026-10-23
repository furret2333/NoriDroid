/** Native ownership and browser visibility are independent reasons to stop drawing.
 * A visible event caused by moving a WebView between windows must not cancel a
 * pause requested by the foreground Activity.
 */
export const createRenderPauseState = (apply: (paused: boolean) => void) => {
	let nativePaused = false
	let hidden = false
	let applied: boolean | undefined
	const sync = (): boolean => {
		const paused = nativePaused || hidden
		if (paused !== applied) { applied = paused; apply(paused) }
		return paused
	}
	return {
		setNativePaused(paused: boolean): boolean { nativePaused = paused; return sync() },
		setHidden(value: boolean): boolean { hidden = value; return sync() },
	}
}

declare global {
	interface Window {
		__noriAppPaused?: boolean
		__noriFloatNativePaused?: boolean
	}
}
