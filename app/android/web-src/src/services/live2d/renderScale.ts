/** Shared validation for the Live2D backing-store scale. */
export const RENDER_SCALE_MIN = 0.5
export const RENDER_SCALE_MAX = 3

export const normalizeRenderScale = (value: unknown, fallback = 1): number => {
	const safeFallback = Number(fallback)
	const base = Number.isFinite(safeFallback)
		? Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, safeFallback))
		: 1
	const n = Number(value)
	if (!Number.isFinite(n)) return base
	return Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, n))
}
