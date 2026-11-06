import assert from "node:assert/strict"
import {readdirSync} from "node:fs"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {mock} from "node:test"
import {pathToFileURL} from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")))
const dir = await mkdtemp(path.join(tmpdir(), "nori-canvas-transform-"))
const priorStorage = globalThis.localStorage
const data = new Map(), writes = []
let throwStorage = false
globalThis.localStorage = {
	getItem: key => { if (throwStorage) throw new Error("storage denied"); return data.get(key) ?? null },
	setItem: (key, value) => { if (throwStorage) throw new Error("storage denied"); data.set(key, String(value)); writes.push([key, String(value)]) },
	removeItem: key => { if (throwStorage) throw new Error("storage denied"); data.delete(key) },
}
const touch = (id, x, y = 0, ui = false) => ({
	identifier: id, clientX: x, clientY: y,
	target: {closest: selector => { assert.equal(selector, ".sheet, .chat-panel, .dock, .topbar, .side-rail, .side-rail-mask"); return ui ? {} : null }},
})
const event = (...touches) => ({touches})
let captures = []
const pointer = (overrides = {}) => ({isPrimary: true, button: 0, pointerId: 1, clientX: 0, clientY: 0,
	currentTarget: {setPointerCapture: id => captures.push(id)}, ...overrides})
try {
	const outfile = path.join(dir, "canvas.mjs")
	await build({entryPoints: [path.join(root, "src/composables/useCanvasTransform.ts")], outfile, bundle: true, format: "esm", platform: "node"})
	const {useCanvasTransform} = await import(pathToFileURL(outfile))
	let layouts, opens, touchSettings, modelId
	const make = (seed = {}) => {
		mock.timers.reset()
		mock.timers.enable({apis: ["setTimeout"]})
		data.clear(); writes.length = 0; captures = []; throwStorage = false
		for (const [key, value] of Object.entries(seed)) data.set(key, String(value))
		layouts = 0; opens = 0; touchSettings = false; modelId = {value: "Nori"}
		return useCanvasTransform({modelId, inTouchSettings: () => touchSettings, relayout: () => layouts++, openModelPanel: () => opens++})
	}
	const start = c => c.onTouchStart(event(touch(1, 0), touch(2, 100)))
	const position = c => [c.scale.value, c.offsetX.value, c.offsetY.value]
	const modelWrites = () => writes.filter(([key]) => key !== "l2d_canvas_locked")

	let c = make()
	await c.restoreTransform("Nori")
	assert.deepEqual(position(c), [1.12, 0, 0])
	data.set("l2d_scale", "1.5"); data.set("l2d_offset_x", "25"); data.set("l2d_offset_y", "-40")
	data.set("l2d_scale_Nori", "8"); data.set("l2d_offset_x_Nori", "120")
	await c.restoreTransform("Nori")
	assert.deepEqual(position(c), [3, 120, -40])
	data.set("l2d_scale_Other", "0.2"); data.set("l2d_offset_y_Other", "70")
	await c.restoreTransform("Other")
	assert.deepEqual(position(c), [0.6, 25, 70])
	console.log("PASS per-model restoration, legacy fallback and scale bounds")

	c = make()
	c.onTouchStart(event(touch(1, 0), touch(2, 100, 0, true)))
	c.onTouchMove(event(touch(1, -100), touch(2, 200)))
	assert.deepEqual(position(c), [1, 0, 0]); assert.equal(layouts, 0)
	c.clearTransformTouches()
	c.onTouchMove(event(touch(1, 0), touch(2, 100)))
	assert.equal(layouts, 0)
	touchSettings = true; start(c); c.onTouchMove(event(touch(1, -100), touch(2, 200)))
	assert.equal(layouts, 0); mock.timers.tick(1000); assert.equal(writes.length, 0)
	console.log("PASS UI fingers, unregistered move fingers and touch-settings gestures are excluded")

	c = make(); start(c)
	c.onTouchMove(event(touch(1, 20, 50), touch(2, 220, 50)))
	assert.deepEqual(position(c), [2, 70, 50]); assert.equal(layouts, 1)
	c.onTouchMove(event(touch(1, 1000, 1000), touch(2, 2000, 1000)))
	assert.deepEqual(position(c), [3, 500, 400])
	c.onTouchMove(event(touch(1, -2000, -2000), touch(2, -1999, -2000)))
	assert.deepEqual(position(c), [0.6, -500, -800])
	c.onTouchEnd(event())
	assert.equal(layouts, 3); assert.equal(modelWrites().length, 3)
	assert.equal(data.get("l2d_scale_Nori"), "0.6")
	console.log("PASS pinch scaling, midpoint translation, clamp limits and relayout")

	c = make(); start(c)
	c.onTouchMove(event(touch(1, 0), touch(2, 150)))
	mock.timers.tick(399); assert.equal(writes.length, 0)
	c.onTouchMove(event(touch(1, 10), touch(2, 210)))
	mock.timers.tick(1); assert.equal(modelWrites().length, 3)
	assert.equal(data.get("l2d_scale_Nori"), "2"); assert.equal(data.get("l2d_offset_x_Nori"), "60")
	c.onTouchMove(event(touch(1, 20), touch(2, 270)))
	mock.timers.tick(399); assert.equal(modelWrites().length, 3)
	c.onTouchEnd(event(touch(1, 20)))
	assert.equal(modelWrites().length, 6); assert.equal(data.get("l2d_scale_Nori"), "2.5")
	mock.timers.tick(1000); assert.equal(modelWrites().length, 6)
	c.onTouchMove(event(touch(1, 900))); assert.equal(layouts, 3)
	console.log("PASS 400ms save throttle uses latest values and touch end flushes without duplicate writes")

	c = make(); start(c)
	c.onTouchMove(event(touch(1, 10), touch(2, 210)))
	c.clearTransformTouches(); c.flushTransformSave(); c.cancelModelTagPress()
	assert.equal(modelWrites().length, 3)
	c.onTouchMove(event(touch(1, 100), touch(2, 400)))
	assert.equal(layouts, 1); mock.timers.tick(1000); assert.equal(modelWrites().length, 3)
	modelId.value = "Other"; start(c); c.onTouchMove(event(touch(1, 0), touch(2, 150))); c.flushTransformSave()
	assert.equal(data.get("l2d_scale_Other"), "3")
	console.log("PASS explicit cleanup clears active touches, flushes once and subsequent writes use current model")

	c = make(); start(c); c.onTouchMove(event(touch(1, 0), touch(2, 150)))
	c.onModelTagDown(pointer()); assert.deepEqual(captures, [1])
	mock.timers.tick(699); assert.equal(c.canvasLocked.value, false)
	mock.timers.tick(1); assert.equal(c.canvasLocked.value, true); assert.equal(data.get("l2d_canvas_locked"), "1")
	assert.equal(modelWrites().length, 3)
	const lockedPosition = position(c)
	start(c); c.onTouchMove(event(touch(1, -100), touch(2, 300)))
	assert.deepEqual(position(c), lockedPosition)
	c.onModelTagClick(); assert.equal(opens, 0)
	c.onModelTagClick(); assert.equal(opens, 1)
	c.onModelTagSpace({repeat: true}); assert.equal(c.canvasLocked.value, true)
	c.onModelTagSpace({repeat: false}); assert.equal(c.canvasLocked.value, false); assert.equal(data.get("l2d_canvas_locked"), "0")
	c.onTouchMove(event(touch(1, -100), touch(2, 300)))
	assert.deepEqual(position(c), lockedPosition)
	console.log("PASS long press locks and persists, preserves final transform, suppresses click and space ignores repeats")

	c = make(); c.onModelTagDown(pointer()); c.onModelTagMove(pointer({clientX: 11}))
	mock.timers.tick(800); assert.equal(c.canvasLocked.value, false)
	c.onModelTagClick(); assert.equal(opens, 0)
	c.onModelTagDown(pointer()); c.onModelTagMove(pointer({pointerId: 2, clientX: 40}))
	mock.timers.tick(700); assert.equal(c.canvasLocked.value, true)
	c.onModelTagDown(pointer()); c.cancelModelTagPress(); mock.timers.tick(700)
	assert.equal(c.canvasLocked.value, true)
	c.onModelTagClick(); assert.equal(opens, 1)
	c.onModelTagDown(pointer({isPrimary: false})); mock.timers.tick(700)
	assert.equal(c.canvasLocked.value, true)
	c.onModelTagDown(pointer({button: 2})); mock.timers.tick(700)
	assert.equal(c.canvasLocked.value, true)
	console.log("PASS drag cancellation suppresses accidental opening; other pointers, cancelled timers and non-primary presses are handled")

	c = make({l2d_canvas_locked: "1"}); assert.equal(c.canvasLocked.value, true)
	throwStorage = true
	c.onModelTagSpace({repeat: false}); assert.equal(c.canvasLocked.value, false)
	await c.restoreTransform("Nori"); assert.deepEqual(position(c), [1.12, 0, 0])
	start(c); c.onTouchMove(event(touch(1, 0), touch(2, 150))); c.onTouchEnd(event())
	c = useCanvasTransform({modelId, inTouchSettings: () => false, relayout() {}, openModelPanel() {}})
	assert.equal(c.canvasLocked.value, false)
	console.log("PASS stored lock restores and storage failures leave gestures usable")
	console.log("8/8 groups passed")
} finally {
	mock.timers.reset()
	if (priorStorage === undefined) delete globalThis.localStorage
	else globalThis.localStorage = priorStorage
	await rm(dir, {recursive: true, force: true})
}
