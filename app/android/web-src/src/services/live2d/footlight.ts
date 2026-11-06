import {clientFromCanvasPoint, type CanvasView} from "./stage"

/** Visible mesh bounds in the untransformed Live2D canvas, normalised to 0..1. */
export interface VisibleBounds { l: number; t: number; r: number; b: number }
export interface FootlightPosition { x: number; y: number; width: number; height: number }

/**
 * Place a soft pool of light under the visible mesh. A mesh cut by the canvas
 * or viewport has no trustworthy lower edge, so hide the light rather than
 * pinning it to the screen border. This is an approximation, not foot detection.
 */
export const footlightPosition = (bounds: VisibleBounds | null, view: CanvasView): FootlightPosition | null => {
	if (!bounds || ![bounds.l, bounds.t, bounds.r, bounds.b, view.w, view.h, view.scale, view.offsetX, view.offsetY].every(Number.isFinite)) return null
	if (view.w <= 0 || view.h <= 0 || view.scale <= 0 || bounds.r <= bounds.l || bounds.b <= bounds.t) return null
	// The canvas clips before its CSS transform; an edge at the bottom cannot establish where the body ends.
	if (bounds.b >= 0.995 || bounds.b <= 0 || bounds.r <= 0 || bounds.l >= 1) return null
	const left = clientFromCanvasPoint(bounds.l * view.w, bounds.b * view.h, view)
	const right = clientFromCanvasPoint(bounds.r * view.w, bounds.b * view.h, view)
	const x = (left.x + right.x) / 2
	const y = left.y
	if (x <= 0 || x >= view.w || y < view.h * 0.5 || y >= view.h - 2) return null
	const width = Math.min(view.w * 0.75, Math.max(64, Math.min(320, (right.x - left.x) * 0.8)))
	return {x, y, width, height: Math.max(18, Math.min(62, width * 0.23))}
}
