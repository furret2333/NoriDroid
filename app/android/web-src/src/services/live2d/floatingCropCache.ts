import {validCanvasBounds, type CanvasBounds} from "./floatingCrop"

const CACHE_KEY = "nori.float-crop.v1"
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
interface Entry {model: string; aspect: number; bounds: CanvasBounds; savedAt: number}
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">
const valid = (entry: Entry, now: number): boolean => !!entry && typeof entry.model === "string" &&
	Number.isFinite(entry.aspect) && entry.aspect > 0 && Number.isFinite(entry.savedAt) &&
	now >= entry.savedAt && now - entry.savedAt < MAX_AGE_MS && validCanvasBounds(entry.bounds) &&
	entry.bounds.l >= 0 && entry.bounds.t >= 0 && entry.bounds.r <= 1 && entry.bounds.b <= 1
const read = (storage: Storage, now: number): Entry[] => {
	try {
		const entries = JSON.parse(storage.getItem(CACHE_KEY) || "[]")
		return Array.isArray(entries) ? entries.filter(entry => valid(entry, now)) : []
	} catch { return [] }
}
const matches = (entry: Entry, model: string, aspect: number): boolean =>
	entry.model === model && Math.abs(entry.aspect / aspect - 1) <= 0.02

/** Model revision and aspect are required; renderScale/DPR do not affect normalized bounds. */
export const loadFloatingCrop = (storage: Storage, model: string, aspect: number, now = Date.now()): CanvasBounds | null => {
	try {
		const entry = read(storage, now).find(entry => matches(entry, model, aspect))
		return entry ? {...entry.bounds} : null
	} catch { return null }
}
export const saveFloatingCrop = (storage: Storage, model: string, aspect: number, bounds: CanvasBounds, now = Date.now()): void => {
	try {
		const entry = {model, aspect, bounds: {...bounds}, savedAt: now}
		if (!valid(entry, now)) return
		const entries = read(storage, now).filter(item => !matches(item, model, aspect))
		storage.setItem(CACHE_KEY, JSON.stringify([entry, ...entries].slice(0, 16)))
	} catch { /* Storage failures retain normal full-cycle calibration. */ }
}
