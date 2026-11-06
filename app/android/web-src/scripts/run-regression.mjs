// Stable project test entry point. Browser fixtures simulate native services;
// Android permissions, real Live2D assets, and audio focus still require device checks.
import {spawn} from "node:child_process"
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync} from "node:fs"
import net from "node:net"
import path from "node:path"
import {fastSuites, uiSuites, groups} from "./testing/suites.mjs"

const root = path.resolve(import.meta.dirname, "..")
const memDir = path.join(root, "tmp-memcheck")
const argv = process.argv.slice(2)
const modes = argv.filter(arg => ["--fast", "--ui", "--all"].includes(arg))
const value = flag => argv.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
const csv = flag => {
	const matches = argv.filter(arg => arg.startsWith(`${flag}=`))
	if (matches.length > 1) throw new Error(`Use ${flag} once, with comma-separated values`)
	if (!matches.length) return []
	const values = value(flag).split(",").map(item => item.trim())
	if (values.some(item => !item)) throw new Error(`${flag} requires nonempty comma-separated values`)
	return values
}
const list = argv.includes("--list"), noBuild = argv.includes("--no-build")
const help = argv.includes("--help") || argv.includes("-h")

function selectSuites() {
	const unknown = argv.filter(arg => !["--fast", "--ui", "--all", "--list", "--no-build", "--help", "-h"].includes(arg) && !arg.startsWith("--suite=") && !arg.startsWith("--group="))
	if (unknown.length) throw new Error(`Unknown option: ${unknown.join(" ")}`)
	if (modes.length > 1) throw new Error("Choose one mode: --fast, --ui, or --all")
	const mode = modes[0] ?? "--fast"
	if (noBuild && mode === "--fast") throw new Error("--no-build is only valid with --ui or --all")
	const available = mode === "--ui" ? uiSuites : mode === "--all" ? [...fastSuites, ...uiSuites] : fastSuites
	const names = csv("--suite"), requestedGroups = csv("--group")
	for (const name of names) if (!available.some(suite => suite.name === name)) throw new Error(`Unknown suite in ${mode}: ${name}`)
	for (const group of requestedGroups) if (!groups.includes(group)) throw new Error(`Unknown group: ${group}. Available: ${groups.join(", ")}`)
	const selected = available.filter(suite => (!names.length || names.includes(suite.name)) && (!requestedGroups.length || requestedGroups.some(group => suite.groups.includes(group))))
	if (!selected.length) throw new Error("No suites selected; refusing to report an empty run as passed")
	return {mode, selected}
}

const usage = `Usage: node scripts/run-regression.mjs [--fast|--ui|--all] [--list]
  --fast       ${fastSuites.length} Node suites, including module and runner checks (default)
  --ui         ${uiSuites.length} browser suites, serial; builds current source first
  --all        fast suites, production build/typecheck, then browser suites
  --suite=a,b  select exact suite names in the chosen mode
  --group=a,b  select suites in any listed feature group
  --no-build   explicitly reuse existing Web assets for --ui/--all
  --list       show the selected suites and prerequisites; do not run or write files
Groups: ${groups.join(", ")}
PowerShell: quote comma arguments, e.g. "--group=chat,audio".
UI requires Windows + Microsoft Edge at its standard Program Files (x86) path.
The harness uses fake native bridges and requires no external model directory.
Filters select a partial run. In --all, selecting only Node suites skips the build.
Quick checks do not include browser regression; run pnpm test:ui or pnpm test:all.`

let currentChild, harness, lockFd, lockFile, reportFile, runSummary, runError
let interrupted = false
const results = [], cleanupErrors = [], snapshots = new Map(), pendingStops = new Set()
// Legacy gates generate these versioned fixtures in place. Restore all of them,
// including any local edits, rather than leaving test-only changes in Git.
const protectedFiles = [
	"memory-bundle.mjs", "core-bundle.mjs", "diary-bundle.mjs",
	"chat-bundle-for-tests.mjs", "chat-bundle.mjs", "modelstore-bundle.mjs",
	"pomostats-bundle.mjs", "framecap-bundle.mjs", "clone-gate-bundle.mjs",
	"bgm-bundle.mjs", "cosy-models-bundle.mjs", "lipsync-bundle.mjs",
	"markerRules-bundle.mjs", "motionReturn-bundle.mjs", "petEffect-bundle.mjs",
	"petStroke-bundle.mjs", "petAudio-bundle.mjs", "petHeadZone-bundle.mjs",
	"stage-bundle.mjs", "pomodoro-ui/focus-mobile.png",
]
const cleanupFailure = (operation, error) => {
	const message = `${operation}: ${error.message}`
	cleanupErrors.push(message)
	console.error(`FAIL ${message}`)
	process.exitCode = interrupted ? 130 : 1
}
const stopTree = async child => {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
	if (process.platform === "win32") {
		await new Promise((resolve, reject) => {
			const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {stdio: "ignore", windowsHide: true})
			killer.once("error", reject)
			killer.once("close", code => {
				if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve()
				else reject(new Error(`Could not stop owned process tree ${child.pid} (taskkill exit ${code})`))
			})
		})
	} else {
		try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
	}
}
const signal = () => {
	interrupted = true
	process.exitCode = 130
	void requestStop(currentChild, "stopping test process")
	void requestStop(harness, "stopping harness")
}
const requestStop = (child, operation) => {
	const pending = stopTree(child).catch(error => cleanupFailure(operation, error))
	pendingStops.add(pending)
	void pending.finally(() => pendingStops.delete(pending))
	return pending
}
const ensureFree = port => new Promise((resolve, reject) => {
	const server = net.createServer()
	server.once("error", error => reject(new Error(`Port ${port} is unavailable (${error.code}); stop the existing service yourself or retry later. No existing process was stopped.`)))
	server.listen({port, host: "127.0.0.1", exclusive: true}, () => server.close(resolve))
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function runJob(job, logPrefix) {
	if (interrupted) throw new Error("Test run interrupted")
	const logFile = `${logPrefix}-${job.name}.log`, fd = openSync(logFile, "w")
	const start = Date.now()
	let timedOut = false, spawnError, jobChild
	const code = await new Promise(resolve => {
		let settled = false
		const finish = code => { if (!settled) { settled = true; clearTimeout(timer); resolve(code ?? -1) } }
		const child = jobChild = spawn(process.execPath, [path.join(root, job.file), ...(job.args ?? [])], {cwd: root, stdio: ["ignore", fd, fd], windowsHide: true, detached: process.platform !== "win32"})
		currentChild = child
		const timer = setTimeout(() => {
			timedOut = true
			void requestStop(child, `stopping timed-out ${job.name}`).finally(() => finish(-1))
		}, job.timeout ?? 180000)
		child.once("error", error => { spawnError = error.message; finish(-1) })
		child.once("close", finish)
	})
	currentChild = jobChild.exitCode === null && jobChild.signalCode === null ? jobChild : undefined
	closeSync(fd)
	const output = readFileSync(logFile, "utf8")
	const pass = (output.match(/^PASS\b/gm) ?? []).length
	const fail = (output.match(/^FAIL\b/gm) ?? []).length
	const warningMessages = output.match(/^WARN\b.*$/gm) ?? []
	const ok = code === 0 && fail === 0 && !timedOut && (!job.browser || pass > 0)
	const result = {name: job.name, code, pass, fail, warnings: warningMessages.length, warningMessages, ok, timedOut, ...(spawnError ? {spawnError} : {}), ms: Date.now() - start, log: path.relative(root, logFile)}
	results.push(result)
	writeFileSync(reportFile, JSON.stringify({complete: false, interrupted, results}, null, 2) + "\n")
	console.log(`${ok ? "PASS" : "FAIL"} ${job.name} (${(result.ms / 1000).toFixed(1)}s${job.browser ? `; ${pass} checks` : ""})`)
	for (const warning of warningMessages) console.warn(`  ${warning}`)
	if (!ok) console.error(`  ${result.log}\n${output.split("\n").slice(-10).join("\n")}`)
	if (interrupted) throw new Error("Test run interrupted")
	return ok
}

async function startHarness(logPrefix) {
	const file = path.resolve(root, "../.harness/server.mjs")
	if (!existsSync(file)) throw new Error(`Missing versioned harness: ${file}`)
	await ensureFree(8123)
	const fd = openSync(`${logPrefix}-harness.log`, "w")
	// These suites exercise UI/native contracts, not real model rendering. Never fall
	// back to the harness's historical machine-specific D:/norios/models directory.
	harness = spawn(process.execPath, [file], {cwd: path.resolve(root, ".."), stdio: ["ignore", fd, fd], windowsHide: true, detached: process.platform !== "win32", env: {...process.env, NORI_WEB_ASSETS: path.resolve(root, "../app/src/main/assets/web"), NORI_MODELS_DIR: path.join(memDir, "_regression-no-model-assets")}})
	closeSync(fd)
	let error
	harness.once("error", caught => { error = caught })
	for (let attempt = 0; attempt < 40; attempt++) {
		if (interrupted) throw new Error("Test run interrupted")
		if (error || harness.exitCode !== null) throw new Error(`Harness failed to start; see ${path.relative(root, `${logPrefix}-harness.log`)}`)
		try {
			const response = await fetch("http://127.0.0.1:8123/assets/web/index.html", {signal: AbortSignal.timeout(500)})
			if (response.ok) return
		} catch { /* wait for the process we own */ }
		await sleep(250)
	}
	throw new Error("Harness startup timed out")
}

try {
	if (help) { console.log(usage) } else {
		const {mode, selected} = selectSuites()
		const hasBrowser = selected.some(suite => suite.browser)
		const needsBuild = hasBrowser && !noBuild
		console.log(`${mode.slice(2)}: ${selected.length} suite(s)${needsBuild ? "; production typecheck/build first" : ""}`)
		if (hasBrowser && noBuild) console.log("Explicit --no-build: reusing existing Web assets; typecheck/build and source freshness checks are skipped.")
		if (list) {
			for (const suite of selected) console.log(`${suite.name.padEnd(32)} ${suite.groups.join(",")} [${suite.file}]`)
			if (selected.some(suite => suite.harness)) console.log("Prerequisite: owned harness on port 8123 (existing listeners are rejected)")
			console.log("Browser tests are serial; fast checks alone are not full validation.")
		} else {
			mkdirSync(memDir, {recursive: true})
			lockFile = path.join(memDir, "_regression-runner.lock")
			try { lockFd = openSync(lockFile, "wx") } catch (error) {
				if (error.code === "EEXIST") throw new Error(`Another runner or stale lock exists: ${lockFile}. Inspect its PID before removing it; no lock or process was changed.`)
				throw error
			}
			writeFileSync(lockFd, JSON.stringify({pid: process.pid, started: new Date().toISOString()}) + "\n")
			for (const relative of protectedFiles) {
				const file = path.join(memDir, relative)
				snapshots.set(file, existsSync(file) ? readFileSync(file) : null)
			}
			process.on("SIGINT", signal); process.on("SIGTERM", signal)
			const logPrefix = path.join(memDir, `_regression-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`)
			reportFile = `${logPrefix}-results.txt`
			if (hasBrowser) {
				if (process.platform !== "win32" || !existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")) throw new Error("Browser suites currently require Windows and Microsoft Edge at C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
				const ports = [...new Set(selected.flatMap(suite => [...(suite.ports ?? []), ...(suite.harness ? [8123] : [])]))]
				await Promise.all(ports.map(ensureFree))
			}
			for (const suite of selected.filter(suite => !suite.browser)) await runJob(suite, logPrefix)
			if (results.some(result => !result.ok)) throw new Error("Fast checks failed; production build/browser phase was not run")
			if (needsBuild) {
				if (!await runJob({name: "typecheck", file: "node_modules/vue-tsc/bin/vue-tsc.js", args: ["--noEmit"]}, logPrefix)) throw new Error("Typecheck failed; browser phase was not run")
				if (!await runJob({name: "build", file: "node_modules/vite/bin/vite.js", args: ["build"]}, logPrefix)) throw new Error("Build failed; browser phase was not run")
			}
			if (hasBrowser && !existsSync(path.resolve(root, "../app/src/main/assets/web/index.html"))) throw new Error("No built Web assets found. Run pnpm build or omit --no-build")
			if (selected.some(suite => suite.harness)) await startHarness(logPrefix)
			for (const suite of selected.filter(suite => suite.browser)) {
				await Promise.all(suite.ports.map(ensureFree))
				await runJob(suite, logPrefix)
			}
			const failed = results.filter(result => !result.ok)
			runSummary = {complete: true, interrupted, selectedSuites: selected.length, passed: results.length - failed.length, total: results.length, browserChecks: results.filter(result => selected.find(suite => suite.name === result.name)?.browser).reduce((sum, result) => sum + result.pass, 0), results}
			if (!hasBrowser) console.log("Browser regression was not run. Use pnpm test:ui or pnpm test:all for the 22 browser suites.")
			process.exitCode = failed.length ? 1 : 0
		}
	}
} catch (error) {
	console.error(`FAIL ${error.message}`)
	runError = error.message
	process.exitCode = interrupted ? 130 : 1
} finally {
	await requestStop(currentChild, "stopping test process")
	await requestStop(harness, "stopping harness")
	await Promise.all([...pendingStops])
	for (const [file, original] of snapshots) {
		try {
			if (original === null) { if (existsSync(file)) unlinkSync(file) }
			else if (!existsSync(file) || !readFileSync(file).equals(original)) {
				mkdirSync(path.dirname(file), {recursive: true})
				writeFileSync(file, original)
			}
		} catch (error) { cleanupFailure(`restoring test artifact ${file}`, error) }
	}
	if (lockFd !== undefined) {
		try { closeSync(lockFd) } catch (error) { cleanupFailure("closing runner lock", error) }
		try { unlinkSync(lockFile) } catch (error) { cleanupFailure("removing runner lock", error) }
	}
	process.removeListener("SIGINT", signal); process.removeListener("SIGTERM", signal)
	// A successful job phase is provisional until artifacts and owned resources
	// have been restored. Never publish an all-green final report before cleanup.
	if (reportFile) {
		const summary = {
			...(runSummary ?? {complete: false, interrupted, results}),
			interrupted,
			complete: !!runSummary && !interrupted && cleanupErrors.length === 0,
			ok: !!runSummary && !interrupted && !runError && cleanupErrors.length === 0 && results.every(result => result.ok),
			cleanupErrors,
			warnings: results.reduce((sum, result) => sum + result.warnings, 0),
			...(runError ? {error: runError} : {}),
		}
		try {
			writeFileSync(reportFile, JSON.stringify(summary, null, 2) + "\n")
			if (runSummary) console.log(`\n${summary.ok ? "PASS" : "FAIL"} run: ${runSummary.passed}/${runSummary.total} jobs passed; ${runSummary.browserChecks} browser checks; ${summary.warnings} warning(s); cleanup ${cleanupErrors.length ? "failed" : "passed"}. Report: ${path.relative(root, reportFile)}`)
		} catch (error) { cleanupFailure("writing final test report", error) }
	}
}
