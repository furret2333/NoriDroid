import assert from "node:assert/strict"
import {createRequire} from "node:module"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const require = createRequire(path.join(root, "package.json"))
const viteRequire = createRequire(require.resolve("vite/package.json"))
const {build} = viteRequire("esbuild")
const compiled = await build({
	stdin: {
		contents: 'export {createRenderPauseState} from "./src/services/renderPause"; export {installFrameCap, setRenderPaused} from "./src/services/live2d/frameCap"',
		resolveDir: root,
	},
	bundle: true, write: false, platform: "node", format: "esm",
})
const {createRenderPauseState, installFrameCap, setRenderPaused} = await import(
	`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
)

const model = () => {
	const host = {}
	let time = 0, updates = 0, clocks = 0
	installFrameCap(host, 0, () => ++time)
	return {
		pause: createRenderPauseState(value => setRenderPaused(host, value)),
		frame() { host.__noriL2dTick({updateTime() { clocks++ }}, {update() { updates++ }}) },
		counts: () => [updates, clocks],
	}
}

// Repeated lifecycle notifications must not restart an unchanged render state.
{
	const applied = []
	const pause = createRenderPauseState(value => applied.push(value))
	pause.setHidden(false)
	pause.setHidden(false)
	pause.setNativePaused(true)
	pause.setNativePaused(true)
	pause.setHidden(true)
	pause.setHidden(false)
	pause.setNativePaused(false)
	assert.deepEqual(applied, [false, true, false], "apply only when the effective pause changes")
}

// Closing/reparenting the bubble emits hidden -> visible after native has
// already paused the overlay for the main Activity. Neither event may restart it.
{
	const float = model()
	float.pause.setHidden(false)
	float.frame()
	float.pause.setNativePaused(true)
	float.pause.setHidden(true)
	float.pause.setHidden(false)
	for (let i = 0; i < 120; i++) float.frame()
	assert.deepEqual(float.counts(), [1, 1], "reattachment must not resume native-paused rendering")
	float.pause.setNativePaused(false)
	float.frame()
	assert.deepEqual(float.counts(), [2, 2], "desktop overlay resumes when it owns rendering again")
}

// onPause with a still-visible document (translucent Activity / multi-window).
{
	const main = model()
	main.pause.setHidden(false)
	main.pause.setNativePaused(true)
	main.frame()
	assert.deepEqual(main.counts(), [0, 0], "native onPause must stop a visible main page")
	main.pause.setHidden(true)
	main.pause.setNativePaused(false)
	main.frame()
	assert.deepEqual(main.counts(), [0, 0], "native resume must still respect a hidden document")
	main.pause.setHidden(false)
	main.frame()
	assert.deepEqual(main.counts(), [1, 1])
}

// A pause arriving during model download must survive installing the draw loop.
{
	const host = {}
	const pause = createRenderPauseState(value => setRenderPaused(host, value))
	pause.setNativePaused(true)
	installFrameCap(host, 60, () => 0)
	host.__noriL2dTick({updateTime() { assert.fail("paused startup advanced its clock") }},
		{update() { assert.fail("paused startup drew a frame") }})
}

// Repeated main -> desktop -> chat -> desktop -> main transitions must not
// leave both models drawing, including late visibility events from reattachment.
{
	const main = model(), float = model()
	for (let cycle = 0; cycle < 100; cycle++) {
		main.pause.setNativePaused(true)
		float.pause.setNativePaused(false)
		float.pause.setHidden(false)
		main.frame(); float.frame()
		float.pause.setHidden(true)
		float.pause.setHidden(false)
		float.frame()
		float.pause.setNativePaused(true)
		main.pause.setNativePaused(false)
		float.pause.setHidden(true)
		float.pause.setHidden(false)
		main.frame(); float.frame()
	}
	assert.deepEqual(main.counts(), [100, 100])
	assert.deepEqual(float.counts(), [200, 200])
}

console.log("PASS render lifecycle: native/browser pause arbitration, startup and 100 chat round trips")
