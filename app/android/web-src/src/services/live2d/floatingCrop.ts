/** Normalized bounds in the complete rendered canvas, independent of renderScale/DPR. */
export interface CanvasBounds {l: number; t: number; r: number; b: number}
export const FULL_CANVAS: CanvasBounds = {l: 0, t: 0, r: 1, b: 1}
export const FLOAT_CROP_WARMUP_MS = 12000
export const FLOAT_CROP_SAMPLE_MS = 250

export const validCanvasBounds = (rect: CanvasBounds | null | undefined): rect is CanvasBounds =>
	!!rect && [rect.l, rect.t, rect.r, rect.b].every(Number.isFinite) &&
	rect.r > rect.l && rect.b > rect.t && rect.r > 0 && rect.b > 0 && rect.l < 1 && rect.t < 1

const clip = (r: CanvasBounds): CanvasBounds => ({
	l: Math.max(0, r.l), t: Math.max(0, r.t), r: Math.min(1, r.r), b: Math.min(1, r.b),
})
const union = (a: CanvasBounds | null, b: CanvasBounds): CanvasBounds => a ? ({
	l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b),
}) : {...b}

/** Idle bounds only expand within one aspect ratio; reacting/fading never shrinks them. */
export class FloatingCropTracker {
	private idle: CanvasBounds | null = null
	private visible: CanvasBounds | null = null
	private elapsed = 0
	private lastSample: number | null = null
	private settleUntil = 0
	private protected = false
	private aspect = 0
	constructor(private readonly warmupMs = FLOAT_CROP_WARMUP_MS) {}
	restore(bounds: CanvasBounds): void {
		if (!validCanvasBounds(bounds)) return
		this.idle = union(this.idle, clip(bounds))
		this.elapsed = this.warmupMs
		this.lastSample = null
	}

	resize(width: number, height: number): void {
		const aspect = width / height
		if (this.aspect && Math.abs(aspect / this.aspect - 1) > 0.02) {
			this.idle = null
			this.visible = null
			this.elapsed = 0
		}
		this.aspect = aspect
		this.lastSample = null
	}
	protect(): void { this.protected = true; this.lastSample = null }
	neutral(now: number): void {
		this.protected = false
		this.settleUntil = now + 2000 // Allow expression/motion cross-fades and physics to settle.
		this.lastSample = null
	}
	pause(): void { this.lastSample = null }
	sample(bounds: CanvasBounds | null, now: number): void {
		if (!validCanvasBounds(bounds)) {
			// Blank/fading/context-lost frames must not collapse or reuse a tight window.
			this.visible = null
			this.lastSample = null
			return
		}
		this.visible = clip(bounds)
		if (this.protected || now < this.settleUntil) { this.lastSample = null; return }
		this.idle = union(this.idle, this.visible)
		if (this.lastSample !== null) this.elapsed += Math.max(0, Math.min(500, now - this.lastSample))
		this.lastSample = now
	}
	geometry(now: number): {crop: CanvasBounds; hit: CanvasBounds; feet: number; precise: boolean} {
		const hit = this.idle ?? this.visible ?? FULL_CANVAS
		const precise = !!this.visible && !!this.idle && !this.protected &&
			now >= this.settleUntil && this.elapsed >= this.warmupMs
		return {crop: precise ? {...this.idle!} : {...FULL_CANVAS}, hit: {...hit}, feet: hit.b, precise}
	}
}
