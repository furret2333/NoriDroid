// Versioned suite registry. Runtime reports and frozen historical snapshots are not inputs.
const unit = (name, groups = [], args = []) => ({name, file: `tmp-memcheck/${name}.mjs`, groups, args})
const moduleTest = (name, groups) => ({name, file: `scripts/${name}.mjs`, groups, args: []})
const ui = (name, groups, ports, harness = true, args = []) => ({
	...(/^(test-chat-session|test-stage-interaction|test-app-resume)$/.test(name) ? moduleTest(name, groups) : unit(name, groups, args)),
	ports, harness, browser: true,
})

// The original 23 --fast gates, plus focused module and runner tests.
export const fastSuites = [
	moduleTest("check-source-growth", ["tooling"]),
	moduleTest("test-source-growth", ["tooling"]),
	unit("run-render-lifecycle-tests", ["stage", "lifecycle"]),
	unit("run-tests", ["core", "memory"]),
	unit("run-memory-lifecycle-tests", ["memory", "lifecycle"]),
	unit("run-memory-recall-tests", ["memory", "chat"]),
	unit("probe-recall-summary-quality", ["memory", "chat"], ["--guards"]),
	unit("run-memory-collapse-tests", ["memory"]),
	unit("run-lipsync-tests", ["audio", "stage"]),
	unit("audit-memory", ["memory"]),
	unit("audit-dead-exports", ["core"]),
	unit("run-marker-tests", ["chat", "stage"]),
	unit("run-tts-tests", ["audio"]),
	unit("run-chat-tests", ["chat"]),
	unit("run-presence-tests", ["settings", "lifecycle"]),
	unit("verify-habit-peak", ["core"]),
	unit("verify-floatservice-fgs", ["float", "lifecycle"]),
	unit("probe-trim-skip", ["memory", "chat"]),
	unit("probe-organize-cadence", ["memory"]),
	unit("probe-mem-collapse-safety", ["memory"]),
	unit("probe-mem-correction", ["memory"]),
	unit("probe-mem-kw", ["memory"]),
	unit("probe-invalid-reflow", ["memory"]),
	unit("probe-restore-rollback", ["memory", "storage"]),
	unit("prop-summary-overlap", ["memory", "chat"]),
	moduleTest("test-app-settings", ["settings"]),
	moduleTest("test-canvas-transform", ["stage"]),
	moduleTest("test-speech-feedback", ["audio", "chat"]),
	moduleTest("test-diary-scheduler", ["diary", "chat", "lifecycle"]),
	moduleTest("test-native-controls", ["float", "storage", "settings", "lifecycle"]),
	moduleTest("test-app-visibility", ["lifecycle", "audio", "chat", "float", "storage"]),
	moduleTest("test-diary", ["diary", "storage"]),
	moduleTest("test-pomodoro", ["pomodoro", "audio"]),
	moduleTest("test-regression-runner", ["tooling"]),
	moduleTest("test-staged-check", ["tooling"]),
]

// Browser suites run serially. The ports include each suite's own Vite/CDP listeners.
export const uiSuites = [
	ui("probe-model-pick-persist", ["stage", "float", "settings"], [9449]),
	ui("probe-model-download-gate", ["stage", "settings"], [9470]),
	ui("test-chat-session", ["chat", "memory", "audio"], [5197, 9497], false),
	ui("test-stage-interaction", ["stage", "chat"], [5196, 9496], false),
	ui("e2e-touch-settings", ["stage", "settings", "chat"], [5188, 9483], false),
	ui("probe-chat-image-poke", ["chat", "stage"], [5190, 9477], false, ["--mock-renderer"]),
	ui("probe-pomodoro", ["pomodoro", "audio", "settings"], [9454]),
	ui("probe-ui-font", ["settings", "appearance"], [9477]),
	ui("probe-persona-import", ["persona", "chat", "settings"], [9455]),
	ui("probe-persona-download-gate", ["persona", "chat", "settings"], [9471]),
	ui("probe-sfx-download", ["audio", "settings"], [9456]),
	ui("probe-bgm-state", ["audio", "pomodoro", "settings"], [9467]),
	ui("probe-thinking-default", ["chat", "settings"], [9468]),
	ui("e2e-storage-probe", ["storage", "settings"], [9406]),
	ui("probe-about-page", ["settings"], [9456]),
	ui("e2e-intro", ["settings", "storage"], [9405]),
	ui("e2e-tts-hint", ["audio", "settings"], [9377]),
	ui("probe-clone-gate", ["audio", "settings"], [9454]),
	ui("e2e-mem-menu", ["memory", "settings"], [9403]),
	ui("e2e-mem-gate", ["memory", "audio", "settings"], [9410]),
	ui("e2e-pixel-ui", ["appearance", "settings"], [9408]),
	ui("test-app-resume", ["lifecycle", "float", "storage", "chat", "audio"], [5198, 9498], false),
]

export const groups = [...new Set([...fastSuites, ...uiSuites].flatMap(suite => suite.groups))].sort()
