import assert from "node:assert/strict"
import {readdirSync} from "node:fs"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {pathToFileURL} from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")))
const dir = await mkdtemp(path.join(tmpdir(), "nori-app-settings-"))
const priorWindow = globalThis.window
let disk = "", writeResult = "ok", writeError = null
globalThis.window = {NoriChat: {
	readFile: () => disk,
	writeFile: (name, content) => {
		assert.equal(name, "settings.json")
		if (writeError) throw writeError
		if (writeResult === "ok") disk = content
		return writeResult
	},
}}
try {
	const outfile = path.join(dir, "settings.mjs")
	await build({stdin: {contents: 'export {useAppSettings} from "./src/composables/useAppSettings"; export {loadSettings} from "./src/services/chat"; export {DEFAULT_POMO} from "./src/services/pomodoro"', resolveDir: root}, outfile, bundle: true, format: "esm", platform: "node"})
	const {useAppSettings, loadSettings, DEFAULT_POMO} = await import(pathToFileURL(outfile))
	let pomo = {...DEFAULT_POMO}
	const make = () => useAppSettings({nativeDpr: () => 2.5, pomo: () => pomo})
	const first = make()
	assert.equal(first.cfg.lipSyncEnabled, false)
	assert.equal(first.cfg.presenceEnabled, true)
	assert.equal(first.cfg.memoryRealtimeExtract, false)
	assert.equal(first.cfg.memoryAutoTuneExamples, false)
	assert.equal(first.cfg.memoryDiagnostics, false)
	console.log("PASS initial state preserves opt-in and opt-out defaults")

	const configured = {
		apiKey: "test-key", baseUrl: "https://test.invalid/v1", model: "test-model", live2dModel: "Nori",
		bubbleScale: 1.25, bubbleWidth: 76, renderScale: 1.5, l2dFps: 30,
		ttsEnabled: true, lipSyncEnabled: true, petTouchEnabled: false, petTouchEffects: false, petTouchSound: false, petTouchSpeech: false,
		ttsProvider: "cosyvoice", ttsApiKey: "fish-test", ttsBaseUrl: "https://fish.invalid", ttsReferenceId: "reference", ttsModel: "s2.1-pro", ttsFormat: "wav", ttsChunkLength: 180, ttsLatency: "normal",
		cosyApiKey: "cosy-test", cosyBaseUrl: "https://cosy.invalid", cosyModel: "cosyvoice-v3.5-flash", cosyVoice: "nori-test", cosyRate: 1.2,
		ttsVolume: 0, bgmEnabled: true, bgmTrack: "bgm1", bgmVolume: 0, sfxVolume: 0,
		dataseaBg: true, backgroundMode: "deep-sea", deepseaQuality: "fine", uiFont: "wenkai",
		timeAware: false, ambientEnabled: false, quietMode: "manual", quietOn: true,
		cosyCloneVoices: [{id: "nori-test", model: "cosyvoice-v3.5-flash"}],
		trimHistory: false, memoryLlmExtract: false, memoryRealtimeExtract: true, memoryAutoTuneExamples: true, memoryDiagnostics: true,
		smartRecall: false, emotionLlm: false, deepseekThinking: false, thinkDefaultV2: true,
		lookFlipX: true, lookFlipY: true, lookSens: 0.35, floatEnabled: true, floatBubbleW: 65, floatRenderScale: 1.75, presenceEnabled: false,
	}
	disk = JSON.stringify(configured)
	first.hydrateSettings(loadSettings())
	assert.equal(first.persistSettings(), "ok")
	const saved = JSON.parse(disk)
	for (const [key, value] of Object.entries(configured)) assert.deepEqual(saved[key], value, `round trip: ${key}`)
	assert.deepEqual(saved.pomo, DEFAULT_POMO)
	const restored = make()
	restored.hydrateSettings(loadSettings())
	assert.deepEqual({...restored.cfg}, {...first.cfg})
	console.log("PASS all settings fields, disabled switches, voice bindings and zero volumes survive save/reload")

	pomo = {...DEFAULT_POMO, focusMin: 45, dailyGoal: 0, notify: false, goal: "  Read  "}
	first.persistSettings()
	assert.equal(JSON.parse(disk).pomo.focusMin, 45)
	assert.equal(JSON.parse(disk).pomo.dailyGoal, 0)
	assert.equal(JSON.parse(disk).pomo.notify, false)
	assert.equal(JSON.parse(disk).pomo.goal, "Read")
	console.log("PASS persistence reads the current pomodoro configuration lazily")

	disk = JSON.stringify({deepseekThinking: false, dataseaBg: false, cosyCloneVoices: ["cosyvoice-v3.5-flash-old"]})
	const legacy = make()
	legacy.hydrateSettings(loadSettings())
	assert.equal(legacy.cfg.deepseekThinking, true)
	assert.equal(legacy.cfg.backgroundMode, "off")
	assert.equal(legacy.cfg.dataseaBg, false)
	assert.equal(legacy.cfg.lipSyncEnabled, false)
	assert.equal(legacy.cfg.memoryRealtimeExtract, false)
	assert.equal(legacy.cfg.memoryAutoTuneExamples, false)
	assert.equal(legacy.cfg.uiFont, "system")
	assert.deepEqual(legacy.cfg.cosyCloneVoices, [{id: "cosyvoice-v3.5-flash-old", model: "cosyvoice-v3.5-flash"}])
	legacy.cfg.deepseekThinking = false
	legacy.persistSettings()
	assert.equal(JSON.parse(disk).thinkDefaultV2, true)
	const migrated = make()
	migrated.hydrateSettings(loadSettings())
	assert.equal(migrated.cfg.deepseekThinking, false)
	console.log("PASS legacy background and voice migration, one-time thinking default and subsequent explicit choice")

	const invalid = {...loadSettings(), renderScale: Infinity, floatRenderScale: NaN, l2dFps: 17, uiFont: "invalid", quietMode: "invalid", ttsVolume: -1, bgmVolume: 3, sfxVolume: "bad"}
	migrated.hydrateSettings(invalid)
	assert.equal(migrated.cfg.renderScale, 1.5)
	assert.equal(migrated.cfg.floatRenderScale, 2.5)
	assert.equal(migrated.cfg.l2dFps, 60)
	assert.equal(migrated.cfg.uiFont, "system")
	assert.equal(migrated.cfg.quietMode, "off")
	assert.deepEqual([migrated.cfg.ttsVolume, migrated.cfg.bgmVolume, migrated.cfg.sfxVolume], [0, 1, 0.5])
	migrated.cfg.renderScale = NaN
	migrated.cfg.floatRenderScale = Infinity
	migrated.cfg.l2dFps = 17
	migrated.persistSettings()
	assert.equal(JSON.parse(disk).renderScale, 1)
	assert.equal(JSON.parse(disk).floatRenderScale, 2.5)
	assert.equal(JSON.parse(disk).l2dFps, 60)
	console.log("PASS malformed rendering, font, quiet-mode and volume values retain prior normalization")

	disk = "{broken"
	const unreadable = make()
	unreadable.hydrateSettings(loadSettings())
	assert.equal(unreadable.cfg.baseUrl, "https://api.openai.com/v1")
	assert.equal(unreadable.cfg.presenceEnabled, true)
	writeResult = "err:insert"
	assert.equal(unreadable.persistSettings(), "err:insert")
	assert.equal(disk, "{broken")
	writeError = new Error("mock-denied")
	assert.equal(unreadable.persistSettings(), "err:throw:mock-denied")
	console.log("PASS corrupt reads keep defaults and failed writes preserve the raw failure reason")
	console.log("6/6 groups passed")
} finally {
	if (priorWindow === undefined) delete globalThis.window
	else globalThis.window = priorWindow
	await rm(dir, {recursive: true, force: true})
}
