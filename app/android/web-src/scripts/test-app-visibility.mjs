// The same observable visibility contract runs against stage8's frozen App or the extracted module.
import assert from "node:assert/strict"
import {readFileSync, readdirSync} from "node:fs"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {pathToFileURL} from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const baseline = process.argv.includes("--baseline")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(name => name.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")))
const dir = await mkdtemp(path.join(tmpdir(), "nori-app-visibility-"))
const globals = ["window", "document", "__noriVisibilityTest"]
const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
let passed = 0
const failures = []

const originalFactory = () => {
	const app = readFileSync(path.join(root, "tmp-memcheck/_mock/App-stage8-before.vue"), "utf8").replaceAll("\r\n", "\n")
	const start = app.indexOf("const renderPause = createRenderPauseState(setStageRenderPaused)")
	const end = app.indexOf("\nonMounted(async () => {", start)
	assert.ok(start >= 0 && end > start, "stage8 visibility baseline boundaries")
	return `
import {createRenderPauseState} from "./src/services/renderPause"
import {loadChat, flushChatPersist} from "./src/services/chat"
import {flushMemoryPersist} from "./src/services/memory"
import {stop as stopTTS} from "./src/services/tts"
import {pauseBgm, resumeBgm} from "./src/services/bgm"
import {presenceOnVisible} from "./src/services/presence"
export const useAppVisibility = options => {
 const APP_VERSION = options.version
 const cfg = {get presenceEnabled() {return options.settings().presenceEnabled}}
 const health = {get value() {return {lastPersistError: options.memoryHasPersistError()}}}
 const {
  setStageRenderPaused, refreshFloatPermission, refreshStorage,
  cancelStageInteraction, stopAutoDiary, pomoUpdateDisplay, pomoRefreshDate,
  refreshMemFromDisk, bgmHeld, chatStreaming, touchStreaming, messages,
 } = options
 ${app.slice(start, end)}
 return {renderPause, onNativeVisibility, onVisibility}
}
export {ref, watch, effectScope, toRaw} from "vue"
`
}

try {
	const outfile = path.join(dir, "visibility.mjs")
	const stubs = {
		chat: `
export const flushChatPersist = () => globalThis.__noriVisibilityTest.calls.push("flush-chat")
export const loadChat = () => {
 const h = globalThis.__noriVisibilityTest
 h.calls.push("load-chat")
 if (h.loadError) throw new Error("load-failed")
 return h.loaded
}`,
		memory: `
export const flushMemoryPersist = () => {
 const h = globalThis.__noriVisibilityTest
 h.calls.push("flush-memory")
 return h.memoryFlush ?? Promise.resolve()
}`,
		tts: 'export const stop = () => globalThis.__noriVisibilityTest.calls.push("stop-tts")',
		bgm: `
export const pauseBgm = () => globalThis.__noriVisibilityTest.calls.push("pause-bgm")
export const resumeBgm = () => globalThis.__noriVisibilityTest.calls.push("resume-bgm")`,
		presence: 'export const presenceOnVisible = version => globalThis.__noriVisibilityTest.calls.push("presence:"+version)',
	}
	await build({
		stdin: {
			contents: baseline ? originalFactory() : 'export {useAppVisibility} from "./src/composables/useAppVisibility"; export {ref, watch, effectScope, toRaw} from "vue"',
			resolveDir: root, loader: "ts",
		},
		outfile, bundle: true, format: "esm", platform: "node",
		plugins: [{name: "visibility-io-fixture", setup(b) {
			b.onResolve({filter: /\/services\/(chat|memory|tts|bgm|presence)$/}, args => ({
				path: args.path.slice(args.path.lastIndexOf("/") + 1), namespace: "visibility-test",
			}))
			b.onLoad({filter: /.*/, namespace: "visibility-test"}, args => ({contents: stubs[args.path], loader: "js"}))
		}}],
	})
	const {useAppVisibility, ref, watch, effectScope, toRaw} = await import(pathToFileURL(outfile))
	const pauseEffects = ["storage", "cancel-interaction", "stop-diary", "pomo-display", "pomo-date", "flush-chat", "flush-memory", "stop-tts", "pause-bgm"]
	const resumeEffects = ["float", "storage", "settings", "presence:2.5.3", "memory-health", "bgm-held", "resume-bgm", "load-chat", "replace-messages"]
	const fixture = (overrides = {}) => {
		const h = {calls: [], loaded: [{role: "assistant", content: "shared-window history"}], loadError: false, memoryFlush: null}
		globalThis.__noriVisibilityTest = h
		globalThis.window = {__noriAppPaused: false}
		globalThis.document = {hidden: false}
		const cfg = {presenceEnabled: true}
		const chatStreaming = ref(false), touchStreaming = ref(false)
		const messages = ref([{role: "assistant", content: "current history"}])
		const state = {memoryError: false, bgmHeld: false}
		const scope = effectScope()
		const record = name => () => { h.calls.push(name) }
		const options = {
			version: "2.5.3",
			settings: () => { h.calls.push("settings"); return cfg },
			setStageRenderPaused: paused => h.calls.push(`render:${paused}`),
			refreshFloatPermission: record("float"), refreshStorage: record("storage"),
			cancelStageInteraction: record("cancel-interaction"), stopAutoDiary: record("stop-diary"),
			pomoUpdateDisplay: record("pomo-display"), pomoRefreshDate: record("pomo-date"),
			refreshMemFromDisk: record("reload-memory"),
			memoryHasPersistError: () => { h.calls.push("memory-health"); return state.memoryError },
			bgmHeld: () => { h.calls.push("bgm-held"); return state.bgmHeld },
			chatStreaming, touchStreaming, messages, ...overrides,
		}
		const f = scope.run(() => {
			watch(messages, () => h.calls.push("replace-messages"), {flush: "sync"})
			return useAppVisibility(options)
		})
		return {h, cfg, state, chatStreaming, touchStreaming, messages, f, close: () => scope.stop()}
	}
	const test = async (name, run, overrides) => {
		const a = fixture(overrides)
		try { await run(a); passed++; console.log(`PASS ${name}`) }
		catch (error) { failures.push(name); console.error(`FAIL ${name}\n${error.stack}`) }
		finally { a.close() }
	}
	const count = (a, name) => a.h.calls.filter(value => value === name).length

	await test("construction defers settings, native state and every IO effect", ({h}) => {
		assert.deepEqual(h.calls, [])
	}, {settings: () => { throw Error("settings accessed before visibility event") }})
	await test("first visible event refreshes state and shared history in original order", ({h, f, messages}) => {
		assert.equal(f.onVisibility(), undefined)
		assert.deepEqual(h.calls, ["render:false", ...resumeEffects])
		assert.equal(toRaw(messages.value), h.loaded)
	})
	await test("hidden event flushes and pauses in original order", ({h, f}) => {
		document.hidden = true
		f.onVisibility()
		assert.deepEqual(h.calls, ["render:true", ...pauseEffects])
	})
	await test("native pause applies rendering before visibility side effects", ({h, f}) => {
		window.__noriAppPaused = true
		f.onNativeVisibility()
		assert.deepEqual(h.calls, ["render:true", ...pauseEffects])
	})
	await test("web-visible event cannot release an outstanding native pause", a => {
		window.__noriAppPaused = true
		a.f.onNativeVisibility(); a.h.calls.length = 0
		a.f.onVisibility()
		assert.deepEqual(a.h.calls, pauseEffects)
	})
	await test("native resume cannot release a document-hidden pause", a => {
		document.hidden = true; window.__noriAppPaused = true
		a.f.onNativeVisibility(); a.h.calls.length = 0
		window.__noriAppPaused = false; a.f.onNativeVisibility()
		assert.deepEqual(a.h.calls, pauseEffects)
	})
	await test("rendering resumes only when native and document pauses both clear", a => {
		window.__noriAppPaused = true; a.f.onNativeVisibility()
		document.hidden = true; a.f.onVisibility()
		window.__noriAppPaused = false; a.f.onNativeVisibility()
		assert.equal(count(a, "render:false"), 0)
		a.h.calls.length = 0
		document.hidden = false; a.f.onVisibility()
		assert.deepEqual(a.h.calls, ["render:false", ...resumeEffects])
	})
	await test("native resume while visible restores permission and history", a => {
		window.__noriAppPaused = true; a.f.onNativeVisibility(); a.h.calls.length = 0
		window.__noriAppPaused = false; a.f.onNativeVisibility()
		assert.deepEqual(a.h.calls, ["render:false", ...resumeEffects])
	})
	await test("repeated paused events deduplicate rendering but retain every flush", a => {
		document.hidden = true
		a.f.onVisibility(); a.f.onVisibility()
		assert.deepEqual(a.h.calls, ["render:true", ...pauseEffects, ...pauseEffects])
	})
	await test("repeated visible events still refresh permission, storage and history", a => {
		a.f.onVisibility(); a.h.calls.length = 0
		a.h.loaded = [{role: "assistant", content: "newer history"}]
		a.f.onVisibility()
		assert.deepEqual(a.h.calls, resumeEffects)
		assert.equal(toRaw(a.messages.value), a.h.loaded)
	})
	await test("browser event does not read a native flag until its native event arrives", a => {
		window.__noriAppPaused = true
		a.f.onVisibility()
		assert.deepEqual(a.h.calls, ["render:false", ...resumeEffects])
		a.h.calls.length = 0
		a.f.onNativeVisibility()
		assert.deepEqual(a.h.calls, ["render:true", ...pauseEffects])
	})
	for (const nativeValue of [undefined, 1, "true"]) {
		await test(`only boolean true pauses native rendering (${String(nativeValue)})`, a => {
			window.__noriAppPaused = nativeValue
			a.f.onNativeVisibility()
			assert.deepEqual(a.h.calls, ["render:false", ...resumeEffects])
		})
	}
	await test("exposed pause state preserves startup use and applies only changed values", ({h, f}) => {
		assert.equal(f.renderPause.setNativePaused(true), true)
		assert.equal(f.renderPause.setHidden(true), true)
		assert.equal(f.renderPause.setNativePaused(false), true)
		assert.equal(f.renderPause.setHidden(false), false)
		assert.equal(f.renderPause.setHidden(false), false)
		assert.deepEqual(h.calls, ["render:true", "render:false"])
	})
	await test("disabled presence skips heartbeat but retains the rest of resume", a => {
		a.cfg.presenceEnabled = false; a.f.onVisibility()
		assert.deepEqual(a.h.calls, ["render:false", ...resumeEffects.filter(value => !value.startsWith("presence:"))])
	})
	await test("later configuration changes are read at each resume", a => {
		a.cfg.presenceEnabled = false; a.f.onVisibility()
		a.h.calls.length = 0; a.cfg.presenceEnabled = true
		a.h.loaded = []; a.f.onVisibility()
		assert.equal(count(a, "presence:2.5.3"), 1)
	})
	await test("persistence error reloads memory before deciding whether to resume music", a => {
		a.state.memoryError = true; a.f.onVisibility()
		assert.deepEqual(a.h.calls, ["render:false", "float", "storage", "settings", "presence:2.5.3", "memory-health", "reload-memory", "bgm-held", "resume-bgm", "load-chat", "replace-messages"])
	})
	await test("held BGM stays held while shared chat history can still refresh", a => {
		a.state.bgmHeld = true; a.f.onVisibility()
		assert.deepEqual(a.h.calls, ["render:false", ...resumeEffects.filter(value => value !== "resume-bgm")])
	})
	for (const [chat, touch, label] of [[true, false, "typed"], [false, true, "touch"], [true, true, "both"]]) {
		await test(`${label} stream preserves the live message array on resume`, a => {
			a.chatStreaming.value = chat; a.touchStreaming.value = touch
			const liveMessages = a.messages.value
			a.f.onVisibility()
			assert.equal(a.messages.value, liveMessages)
			assert.deepEqual(a.h.calls, ["render:false", ...resumeEffects.filter(value => !["load-chat", "replace-messages"].includes(value))])
		})
	}
	await test("a later idle resume loads history after a stream finishes", a => {
		a.chatStreaming.value = true; a.f.onVisibility()
		const liveMessages = a.messages.value
		a.chatStreaming.value = false; a.h.calls.length = 0
		a.f.onVisibility()
		assert.notEqual(a.messages.value, liveMessages)
		assert.equal(toRaw(a.messages.value), a.h.loaded)
		assert.deepEqual(a.h.calls, resumeEffects)
	})
	await test("history read failure is caught and preserves current messages", a => {
		a.h.loadError = true
		const liveMessages = a.messages.value
		assert.doesNotThrow(() => a.f.onVisibility())
		assert.equal(a.messages.value, liveMessages)
		assert.deepEqual(a.h.calls, ["render:false", ...resumeEffects.filter(value => value !== "replace-messages")])
	})
	await test("an empty shared history replaces old messages", a => {
		a.h.loaded = []; a.f.onVisibility()
		assert.deepEqual(a.messages.value, [])
		assert.equal(toRaw(a.messages.value), a.h.loaded)
		assert.equal(count(a, "replace-messages"), 1)
	})
	await test("memory flush stays fire-and-forget so audio pauses immediately", async a => {
		let resolve, settled = false
		a.h.memoryFlush = new Promise(done => { resolve = () => { settled = true; done() } })
		document.hidden = true
		assert.equal(a.f.onVisibility(), undefined)
		assert.equal(settled, false)
		assert.deepEqual(a.h.calls, ["render:true", ...pauseEffects])
		resolve(); await a.h.memoryFlush
	})
	await test("pause never reloads history or reads resume-only settings", a => {
		a.chatStreaming.value = true; a.touchStreaming.value = true
		const liveMessages = a.messages.value
		document.hidden = true; a.f.onVisibility()
		assert.equal(a.messages.value, liveMessages)
		assert.equal(count(a, "settings"), 0)
		assert.equal(count(a, "memory-health"), 0)
		assert.equal(count(a, "bgm-held"), 0)
		assert.equal(count(a, "load-chat"), 0)
	})

	console.log(`\n${passed}/${passed + failures.length} app visibility groups passed (${baseline ? "stage8 baseline" : "current"})`)
	if (failures.length) process.exitCode = 1
} finally {
	for (const [name, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor)
		else delete globalThis[name]
	}
	assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()))
	assert.ok(path.basename(dir).startsWith("nori-app-visibility-"))
	await rm(dir, {recursive: true, force: true})
}
