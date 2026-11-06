// --baseline executes the same checks against the frozen, pre-stage8 App declarations.
import assert from "node:assert/strict"
import {readFileSync, readdirSync} from "node:fs"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {pathToFileURL} from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const baseline = process.argv.includes("--baseline")
const mode = baseline ? "baseline" : "current"
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")))
const dir = await mkdtemp(path.join(tmpdir(), "nori-native-controls-"))
const globals = ["window", "document", "HTMLInputElement", "__nativeControlsTest"]
const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
const floatExports = "floatPermission, floatPermissionHint, saveFloatEnabled, refreshFloatPermission, onFloatToggle, resetFloatWindow, onFloatRenderScale"
const storageExports = "storageReady, storagePath, storageProbeMsg, allFilesAccess, doRequestAllFiles, doStorageProbe, grantStorage, refreshStorage, initializeStorage"
const services = ["isStorageReady", "requestStoragePermission", "getStorageDir", "probePublicFiles", "hasAllFilesAccess", "requestAllFilesAccess"]
let passed = 0
const failures = []

try {
	let contents
	if (baseline) {
		const source = readFileSync(path.join(root, "tmp-memcheck/_mock/App-stage8-before.vue"), "utf8").replaceAll("\r\n", "\n")
		const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))).trimEnd()
		const floatBody = block("const floatPermission =", "// 音色选择后自动保存")
		const storageRefs = source.match(/const storageReady = [^\n]*\nconst storagePath = [^\n]*/)[0]
		const probeStart = source.lastIndexOf("/**", source.indexOf("const storageProbeMsg"))
		const probe = source.slice(probeStart, source.indexOf("/* ---------------- 自定义人设", probeStart)).trimEnd()
		const grant = block("const grantStorage =", "const saveSettingsNow =")
		const refresh = block("const refreshStorage =", "/**\n * 页面不可见")
		const initialize = source.match(/\tstoragePath\.value = getStorageDir\(\)\n\tstorageReady\.value = isStorageReady\(\)\n\tallFilesAccess\.value = hasAllFilesAccess\(\)/)[0]
		contents = `
			import {computed, ref} from "vue"
			import {normalizeRenderScale} from "./src/services/live2d/renderScale"
			import {${services.join(",")}} from "./src/services/chat"
			export const useFloatControls = options => {
				const {persistSettings, notify: triggerBubble} = options
				// App owns this stable object; the proxy only forwards the test's lazy setting port.
				const cfg = new Proxy({}, {
					get: (_target, key) => options.settings()[key],
					set: (_target, key, value) => { options.settings()[key] = value; return true },
				})
				const nativeDpr = {get value() { return options.nativeDpr() }}
				${floatBody}
				return {${floatExports}}
			}
			export const useStorageAccess = options => {
				const {notify: triggerBubble, scheduleDiary, refreshPomodoroStorage} = options
				${storageRefs}
				${probe}
				${grant}
				${refresh}
				const initializeStorage = () => { ${initialize} }
				return {${storageExports}}
			}
		`
	} else {
		contents = `
			export {useFloatControls} from "./src/composables/useFloatControls"
			export {useStorageAccess} from "./src/composables/useStorageAccess"
		`
	}
	const outfile = path.join(dir, "native-controls.mjs")
	await build({
		stdin: {contents, resolveDir: root, loader: "ts"},
		outfile, bundle: true, format: "esm", platform: "node",
		plugins: [{name: "native-controls-io", setup(b) {
			b.onResolve({filter: /services\/chat$/}, () => ({path: "chat", namespace: "native-controls-test"}))
			b.onLoad({filter: /.*/, namespace: "native-controls-test"}, () => ({
				contents: services.map(name => `export const ${name} = (...args) => globalThis.__nativeControlsTest.${name}(...args);`).join("\n"),
			}))
		}}],
	})
	const {useFloatControls, useStorageAccess} = await import(pathToFileURL(outfile))
	class Input { checked = true }
	globalThis.HTMLInputElement = Input
	const fixture = () => {
		const h = {
			calls: [], notes: [], granted: false, ready: false, access: false, path: "test-storage",
			reads: 0, dprReads: 0, dpr: 2, cfg: {floatEnabled: false, floatRenderScale: 2},
			throws: {}, probes: new Map(), requestResult: "requested",
		}
		const call = (name, ...args) => {
			h.calls.push([name, ...args])
			if (h.throws[name]) throw Error(name)
		}
		h.isStorageReady = () => { call("storage-ready"); return h.ready }
		h.hasAllFilesAccess = () => { call("all-files-access"); return h.access }
		h.getStorageDir = () => { call("storage-dir"); return h.path }
		h.requestStoragePermission = () => { call("request-storage"); return h.requestResult }
		h.requestAllFilesAccess = () => { call("request-all-files") }
		h.probePublicFiles = name => { call("probe", name); return h.probes.get(name) ?? "missing" }
		globalThis.__nativeControlsTest = h
		globalThis.document = {hidden: false}
		globalThis.window = {
			NoriChat: {
				canFloat: () => { call("can-float"); return h.granted },
				requestFloatPermission: () => { call("request-float") },
				setFloatEnabled: value => { call("float-enabled", value) },
				hideFloat: () => { call("hide-float") },
				resetFloatWindow: () => { call("reset-float") },
				setFloatRenderScale: value => { call("float-scale", value) },
			},
			dispatchEvent: event => { call("event", event.type); return true },
		}
		const notify = (...args) => { h.notes.push(args); call("notify", ...args) }
		h.float = useFloatControls({
			settings: () => { h.reads++; return h.cfg },
			nativeDpr: () => { h.dprReads++; return h.dpr },
			persistSettings: () => { call("persist") },
			notify,
		})
		h.storage = useStorageAccess({
			notify,
			scheduleDiary: () => { call("schedule-diary") },
			refreshPomodoroStorage: () => { call("refresh-pomodoro") },
		})
		h.toggle = (enabled = true, target = new Input()) => {
			h.cfg.floatEnabled = enabled
			h.float.onFloatToggle({target})
			return target
		}
		h.clear = () => { h.calls.length = 0; h.notes.length = 0 }
		return h
	}
	const test = async (name, run) => {
		try { await run(fixture()); passed++; console.log(`PASS ${mode}: ${name}`) }
		catch (error) { failures.push(name); console.error(`FAIL ${mode}: ${name}\n${error.stack}`) }
	}
	const names = ["chat.json", "memory.json", "settings.json", "nori-diary.json", "nori-diary.json.bak", "nori-diary-src.json"]
	const callNames = h => h.calls.map(([name]) => name)
	const pending = h => { h.toggle(); h.clear(); assert.equal(h.float.floatPermission.value, "pending") }

	await test("construction has no config, DPR, bridge or storage reads", h => {
		assert.equal(h.reads, 0); assert.equal(h.dprReads, 0); assert.deepEqual(h.calls, [])
		assert.equal(h.float.floatPermissionHint.value, "首次开启需要授权悬浮窗权限。")
		assert.equal(h.storage.storageReady.value, false); assert.equal(h.storage.storagePath.value, "Download/NoriDroid")
		assert.equal(h.storage.storageProbeMsg.value, ""); assert.equal(h.storage.allFilesAccess.value, false)
	})
	await test("already granted toggle reports success before persist and native enable", h => {
		h.granted = true; const target = h.toggle()
		assert.equal(target.checked, true); assert.equal(h.cfg.floatEnabled, true)
		assert.equal(h.float.floatPermission.value, "granted")
		assert.deepEqual(callNames(h), ["can-float", "notify", "persist", "float-enabled"])
		assert.deepEqual(h.calls.at(-1), ["float-enabled", true])
	})
	await test("permission request first restores the setting and native checkbox", h => {
		const target = h.toggle()
		assert.equal(target.checked, false); assert.equal(h.cfg.floatEnabled, false)
		assert.equal(h.float.floatPermissionHint.value, "等待系统授权，授权返回后自动开启。")
		assert.deepEqual(callNames(h), ["can-float", "persist", "float-enabled", "notify", "request-float"])
		assert.deepEqual(h.calls[2], ["float-enabled", false])
	})
	await test("granted return automatically enables exactly once after a pending request", h => {
		pending(h); h.granted = true; h.float.refreshFloatPermission()
		assert.equal(h.cfg.floatEnabled, true); assert.equal(h.float.floatPermission.value, "granted")
		assert.deepEqual(h.calls, [["can-float"], ["persist"], ["float-enabled", true]])
		h.clear(); h.float.refreshFloatPermission(); assert.deepEqual(h.calls, [["can-float"]])
	})
	await test("denied return persists disabled state and hides the float", h => {
		pending(h); h.float.refreshFloatPermission()
		assert.equal(h.cfg.floatEnabled, false); assert.equal(h.float.floatPermission.value, "denied")
		assert.deepEqual(h.calls, [["can-float"], ["persist"], ["float-enabled", false], ["hide-float"]])
	})
	await test("an explicit off toggle cancels automatic enable from an earlier request", h => {
		pending(h); h.toggle(false); h.clear(); h.granted = true; h.float.refreshFloatPermission()
		assert.equal(h.cfg.floatEnabled, false); assert.deepEqual(h.calls, [["can-float"]])
	})
	await test("without a permission request method, denial never becomes pending", h => {
		delete window.NoriChat.requestFloatPermission
		assert.equal(h.toggle().checked, false); assert.equal(h.float.floatPermission.value, "denied")
		h.clear(); h.granted = true; h.float.refreshFloatPermission()
		assert.equal(h.cfg.floatEnabled, false); assert.deepEqual(h.calls, [["can-float"]])
	})
	await test("an absent native bridge disables the checkbox without throwing", h => {
		delete window.NoriChat
		assert.equal(h.toggle().checked, false); assert.equal(h.cfg.floatEnabled, false)
		assert.equal(h.float.floatPermission.value, "denied"); assert.deepEqual(callNames(h), ["persist", "notify"])
	})
	await test("permission revocation disables and persists before hiding", h => {
		h.cfg.floatEnabled = true; h.float.refreshFloatPermission()
		assert.equal(h.cfg.floatEnabled, false); assert.equal(h.float.floatPermission.value, "revoked")
		assert.deepEqual(h.calls, [["can-float"], ["persist"], ["float-enabled", false], ["hide-float"]])
	})
	await test("continued denial retains the revoked hint without repeated persistence", h => {
		h.cfg.floatEnabled = true; h.float.refreshFloatPermission(); h.clear(); h.float.refreshFloatPermission()
		assert.equal(h.float.floatPermissionHint.value, "悬浮窗权限已被撤销，请重新开启并授权。")
		assert.deepEqual(h.calls, [["can-float"], ["hide-float"]])
	})
	await test("a granted refresh alone never enables a user-disabled float", h => {
		h.granted = true; h.float.refreshFloatPermission()
		assert.equal(h.cfg.floatEnabled, false); assert.equal(h.float.floatPermission.value, "granted")
		assert.deepEqual(h.calls, [["can-float"]])
	})
	await test("an ordinary denied refresh only updates permission state and hides", h => {
		h.float.refreshFloatPermission()
		assert.equal(h.float.floatPermission.value, "denied"); assert.deepEqual(h.calls, [["can-float"], ["hide-float"]])
	})
	await test("hidden pages defer pending permission settlement until visible", h => {
		pending(h); h.granted = true; document.hidden = true; h.float.refreshFloatPermission()
		assert.deepEqual(h.calls, []); assert.equal(h.float.floatPermission.value, "pending")
		document.hidden = false; h.float.refreshFloatPermission(); assert.equal(h.cfg.floatEnabled, true)
	})
	await test("missing canFloat leaves the state untouched", h => {
		delete window.NoriChat.canFloat; h.cfg.floatEnabled = true; h.float.refreshFloatPermission()
		assert.equal(h.cfg.floatEnabled, true); assert.equal(h.float.floatPermission.value, "unknown")
		assert.deepEqual(h.calls, [])
	})
	await test("refresh tolerates a throwing native permission read", h => {
		h.throws["can-float"] = true; h.cfg.floatEnabled = true; h.float.refreshFloatPermission()
		assert.equal(h.cfg.floatEnabled, true); assert.equal(h.float.floatPermission.value, "unknown")
		assert.deepEqual(h.calls, [["can-float"]])
	})
	await test("checkbox synchronization only targets an actual input element", h => {
		const target = {checked: true}; h.toggle(true, target)
		assert.equal(h.cfg.floatEnabled, false); assert.equal(target.checked, true)
	})
	await test("toggle permission exceptions still persist the disabled setting", h => {
		h.throws["can-float"] = true; assert.equal(h.toggle().checked, false)
		assert.equal(h.cfg.floatEnabled, false)
		assert.deepEqual(h.calls, [["can-float"], ["persist"], ["float-enabled", false]])
	})
	await test("off toggle hides before persisting and tolerates hide errors", h => {
		h.throws["hide-float"] = true; h.toggle(false)
		assert.deepEqual(h.calls, [["hide-float"], ["persist"], ["float-enabled", false]])
	})
	await test("native enabled-flag failures do not escape saveFloatEnabled", h => {
		h.throws["float-enabled"] = true; h.cfg.floatEnabled = true; h.float.saveFloatEnabled()
		assert.deepEqual(h.calls, [["persist"], ["float-enabled", true]])
	})
	await test("request exceptions retain the pre-existing pending settlement behavior", h => {
		h.throws["request-float"] = true; assert.equal(h.toggle().checked, false)
		assert.equal(h.float.floatPermission.value, "pending")
		assert.equal(callNames(h).filter(name => name === "persist").length, 2)
		h.clear(); h.granted = true; h.float.refreshFloatPermission(); assert.equal(h.cfg.floatEnabled, true)
	})
	await test("reset without the native method stays silent", h => {
		delete window.NoriChat.resetFloatWindow; h.float.resetFloatWindow(); assert.deepEqual(h.calls, [])
	})
	await test("successful reset calls native before the success feedback", h => {
		h.float.resetFloatWindow()
		assert.deepEqual(h.calls, [["reset-float"], ["notify", "已重置，离开应用后可查看悬浮窗"]])
	})
	await test("failed reset reports the original retry feedback", h => {
		h.throws["reset-float"] = true; h.float.resetFloatWindow()
		assert.deepEqual(h.calls, [["reset-float"], ["notify", "重置失败，请重试"]])
	})
	await test("render scale clamps and saves before notifying native", h => {
		h.cfg.floatRenderScale = 99; h.float.onFloatRenderScale()
		assert.equal(h.cfg.floatRenderScale, 3); assert.deepEqual(h.calls, [["persist"], ["float-scale", 3]])
	})
	await test("render scale uses the current DPR when the selected value is invalid", h => {
		h.cfg.floatRenderScale = NaN; h.dpr = 1.5; h.float.onFloatRenderScale()
		assert.equal(h.cfg.floatRenderScale, 1.5); assert.deepEqual(h.calls, [["persist"], ["float-scale", 1.5]])
		assert.equal(h.dprReads, 1)
	})
	await test("render scale bridge errors are contained after persistence", h => {
		h.throws["float-scale"] = true; h.cfg.floatRenderScale = 0.1; h.float.onFloatRenderScale()
		assert.equal(h.cfg.floatRenderScale, 0.5); assert.deepEqual(h.calls, [["persist"], ["float-scale", 0.5]])
	})
	await test("actions read the current settings object instead of a constructor snapshot", h => {
		h.cfg = {floatEnabled: true, floatRenderScale: 1.25}; h.granted = true; h.float.saveFloatEnabled()
		h.float.onFloatRenderScale()
		assert.deepEqual(h.calls, [["persist"], ["float-enabled", true], ["persist"], ["float-scale", 1.25]])
	})
	await test("initial storage reads preserve path, readiness and access order", h => {
		h.ready = true; h.access = true; h.storage.initializeStorage()
		assert.deepEqual(h.calls, [["storage-dir"], ["storage-ready"], ["all-files-access"]])
		assert.equal(h.storage.storagePath.value, "test-storage"); assert.equal(h.storage.storageReady.value, true)
		assert.equal(h.storage.allFilesAccess.value, true)
	})
	await test("storage initialization rereads changed native values", h => {
		h.storage.initializeStorage(); h.clear(); h.path = "new-dir"; h.ready = true; h.access = true
		h.storage.initializeStorage()
		assert.equal(h.storage.storagePath.value, "new-dir"); assert.equal(h.storage.storageReady.value, true)
		assert.equal(h.storage.allFilesAccess.value, true)
	})
	await test("storage permission action preserves the native return value", h => {
		assert.equal(h.storage.grantStorage(), "requested"); assert.deepEqual(h.calls, [["request-storage"]])
	})
	await test("all-files access asks native before showing the original instruction", h => {
		h.storage.doRequestAllFiles()
		assert.deepEqual(h.calls, [["request-all-files"], ["notify", "请在系统设置里打开「允许管理所有文件」，然后返回这里点「自检」", 4200]])
	})
	await test("storage self-check preserves file order, formatting and final parsed access", h => {
		for (const [index, name] of names.entries()) h.probes.set(name, JSON.stringify({
			onDisk: true, fileBytes: index + 10, fileReadable: true, inMediaStore: true, mediaStoreBytes: index + 20,
			allFilesAccess: index === 5, dir: "native-dir", dirExists: true, dirReadable: true, listed: ["chat.json"],
		}))
		h.storage.doStorageProbe()
		assert.deepEqual(h.calls, [...names.map(name => ["probe", name]), ["storage-dir"]])
		assert.equal(h.storage.allFilesAccess.value, true); assert.equal(h.storage.storagePath.value, "test-storage")
		assert.equal(h.storage.storageProbeMsg.value.split("\n\n").length, 6)
		assert.ok(h.storage.storageProbeMsg.value.startsWith("chat.json\n  磁盘上存在: 是(10 字节)  可直读: 是\n"))
		assert.ok(h.storage.storageProbeMsg.value.includes('  目录内容: ["chat.json"]'))
		assert.ok(h.storage.storageProbeMsg.value.includes("nori-diary-src.json\n  磁盘上存在: 是(15 字节)"))
	})
	await test("malformed self-check responses retain raw diagnostics and prior access", h => {
		h.storage.allFilesAccess.value = true
		h.storage.doStorageProbe()
		assert.equal(h.storage.allFilesAccess.value, true)
		assert.equal(h.storage.storageProbeMsg.value, names.map(name => `${name}\n  missing`).join("\n\n"))
	})
	await test("a native probe exception propagates before updating displayed diagnostics", h => {
		h.throws.probe = true; h.storage.storageProbeMsg.value = "previous"
		assert.throws(() => h.storage.doStorageProbe(), /probe/)
		assert.equal(h.storage.storageProbeMsg.value, "previous"); assert.deepEqual(h.calls, [["probe", "chat.json"]])
	})
	await test("visible refresh dispatches diary and refreshes pomodoro around permission reads", h => {
		h.ready = true; h.access = true; h.storage.refreshStorage()
		assert.deepEqual(h.calls, [["event", "nori-diary-updated"], ["schedule-diary"], ["storage-ready"], ["all-files-access"], ["refresh-pomodoro"]])
		assert.equal(h.storage.storageReady.value, true); assert.equal(h.storage.allFilesAccess.value, true)
		assert.equal(h.storage.storagePath.value, "Download/NoriDroid")
	})
	await test("hidden refresh still updates permission state without diary or pomodoro work", h => {
		document.hidden = true; h.ready = true; h.access = true; h.storage.refreshStorage()
		assert.deepEqual(h.calls, [["storage-ready"], ["all-files-access"]])
		assert.equal(h.storage.storageReady.value, true); assert.equal(h.storage.allFilesAccess.value, true)
	})
	console.log(`\n${passed}/${passed + failures.length} native controls groups passed (${mode})`)
	if (failures.length) process.exitCode = 1
} finally {
	for (const [name, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor)
		else delete globalThis[name]
	}
	assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()))
	assert.ok(path.basename(dir).startsWith("nori-native-controls-"))
	await rm(dir, {recursive: true, force: true})
}
