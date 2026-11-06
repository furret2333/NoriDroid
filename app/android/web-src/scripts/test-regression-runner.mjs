// Exercise the real CLI against disposable Node-only fixtures. No browser, real
// project artifacts, application source, or project test lock is touched.
import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {
	copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
	rmSync, statSync, writeFileSync,
} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"

const runner = path.join(import.meta.dirname, "run-regression.mjs")
const parent = path.resolve(tmpdir())
const fixtures = []
const artifactNames = ["chat-bundle-for-tests.mjs", "chat-bundle.mjs", "stage-bundle.mjs", "cosy-models-bundle.mjs", "pomodoro-ui/focus-mobile.png"]
let passed = 0

function fixture(source = 'console.log("PASS fixture")', timeout) {
	const root = mkdtempSync(path.join(parent, "nori-regression-selftest-"))
	assert.equal(path.dirname(root), parent)
	fixtures.push(root)
	mkdirSync(path.join(root, "scripts/testing"), {recursive: true})
	writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n')
	copyFileSync(runner, path.join(root, "scripts/run-regression.mjs"))
	writeFileSync(path.join(root, "scripts/fixture.mjs"), source)
	const job = {name: "fixture", file: "scripts/fixture.mjs", groups: ["fixture"], ...(timeout ? {timeout} : {})}
	writeFileSync(path.join(root, "scripts/testing/suites.mjs"), `export const fastSuites=${JSON.stringify([job])};export const uiSuites=[];export const groups=["fixture","unused"];\n`)
	return root
}

function run(root, args = ["--fast"]) {
	const mem = path.join(root, "tmp-memcheck")
	const before = new Set(existsSync(mem) ? readdirSync(mem) : [])
	const child = spawnSync(process.execPath, [path.join(root, "scripts/run-regression.mjs"), ...args], {
		cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000,
	})
	if (child.error) throw child.error
	const files = existsSync(mem) ? readdirSync(mem).filter(name => name.endsWith("-results.txt") && !before.has(name)) : []
	assert.ok(files.length <= 1, "one report per CLI invocation")
	const report = files.length ? JSON.parse(readFileSync(path.join(mem, files[0]), "utf8")) : undefined
	return {...child, report, output: `${child.stdout}\n${child.stderr}`}
}

function check(name, test) {
	test()
	passed++
	console.log(`PASS ${name}`)
}

function seedArtifacts(root) {
	const originals = new Map()
	for (const [index, name] of artifactNames.entries()) {
		const file = path.join(root, "tmp-memcheck", name)
		mkdirSync(path.dirname(file), {recursive: true})
		// Deliberately include invalid UTF-8 and pre-existing local edits.
		const bytes = Buffer.from([0xff, index, 0, ...Buffer.from(`local user edit ${name}`)])
		writeFileSync(file, bytes)
		originals.set(file, bytes)
	}
	return originals
}

const unlocked = root => assert.equal(existsSync(path.join(root, "tmp-memcheck/_regression-runner.lock")), false)
const failed = result => {
	assert.notEqual(result.status, 0)
	assert.equal(result.report?.ok, false)
	assert.equal(result.report?.complete, false)
}

try {
	check("list performs no writes and does not acquire a lock", () => {
		const root = fixture()
		const result = run(root, ["--fast", "--list"])
		assert.equal(result.status, 0)
		assert.match(result.output, /fixture/)
		assert.equal(existsSync(path.join(root, "tmp-memcheck")), false)
		assert.equal(result.report, undefined)
	})
	for (const [name, args, message] of [
		["unknown suite", ["--fast", "--suite=missing"], /Unknown suite/],
		["empty suite", ["--fast", "--suite="], /nonempty/],
		["conflicting modes", ["--fast", "--all"], /Choose one mode/],
		["empty group selection", ["--fast", "--group=unused"], /No suites selected/],
	]) {
		check(`${name} is rejected before running jobs`, () => {
			const root = fixture('throw new Error("job must not run")')
			const result = run(root, args)
			assert.notEqual(result.status, 0)
			assert.match(result.output, message)
			assert.equal(result.report, undefined)
			assert.equal(existsSync(path.join(root, "tmp-memcheck")), false)
		})
	}
	check("a PASS line cannot mask a nonzero child exit", () => {
		const root = fixture('console.log("PASS misleading");process.exitCode=7')
		const result = run(root)
		failed(result)
		assert.equal(result.report.results[0].code, 7)
		assert.equal(result.report.results[0].ok, false)
		unlocked(root)
	})
	check("a FAIL line cannot pass even with child exit zero", () => {
		const root = fixture('console.log("PASS first");console.log("FAIL deliberate")')
		const result = run(root)
		failed(result)
		assert.equal(result.report.results[0].code, 0)
		assert.equal(result.report.results[0].fail, 1)
		unlocked(root)
	})
	check("successful job warnings reach the terminal and final report", () => {
		const root = fixture('console.log("WARN source-growth src/App.vue needs review");console.log("PASS fixture")')
		const result = run(root)
		assert.equal(result.status, 0)
		assert.equal(result.report.ok, true)
		assert.match(result.output, /WARN source-growth src\/App.vue needs review/)
		assert.equal(result.report.warnings, 1)
		assert.equal(result.report.results[0].warnings, 1)
		assert.deepEqual(result.report.results[0].warningMessages, ["WARN source-growth src/App.vue needs review"])
		unlocked(root)
	})
	check("a timed-out child fails and its owned process is stopped", () => {
		// The fixture also expires on its own if a broken runner fails to stop it.
		const root = fixture('import{writeFileSync}from"node:fs";writeFileSync("child.pid",String(process.pid));console.log("PASS started");setTimeout(()=>{},4000)', 250)
		const result = run(root)
		failed(result)
		assert.equal(result.report.results[0].timedOut, true)
		const pidFile = path.join(root, "child.pid")
		if (existsSync(pidFile)) {
			const pid = Number(readFileSync(pidFile, "utf8"))
			assert.throws(() => process.kill(pid, 0), {code: "ESRCH"})
		}
		unlocked(root)
	})
	check("generated artifacts restore exact pre-existing dirty bytes", () => {
		const source = `import{mkdirSync,writeFileSync}from"node:fs";import path from"node:path";for(const name of ${JSON.stringify(artifactNames)}){const file=path.join("tmp-memcheck",name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,"generated replacement")}console.log("PASS generated")`
		const root = fixture(source)
		const originals = seedArtifacts(root)
		const result = run(root)
		assert.equal(result.status, 0)
		assert.equal(result.report.complete, true)
		assert.equal(result.report.ok, true)
		assert.deepEqual(result.report.cleanupErrors, [])
		for (const [file, bytes] of originals) assert.deepEqual(readFileSync(file), bytes)
		unlocked(root)
	})
	check("unchanged artifacts are not rewritten during cleanup", () => {
		const root = fixture()
		const originals = seedArtifacts(root)
		const times = new Map([...originals.keys()].map(file => [file, statSync(file, {bigint: true}).mtimeNs]))
		const result = run(root)
		assert.equal(result.status, 0)
		for (const [file, bytes] of originals) {
			assert.deepEqual(readFileSync(file), bytes)
			assert.equal(statSync(file, {bigint: true}).mtimeNs, times.get(file))
		}
		unlocked(root)
	})
	check("newly generated protected artifacts are removed after the run", () => {
		const source = `import{mkdirSync,writeFileSync}from"node:fs";import path from"node:path";for(const name of ${JSON.stringify(artifactNames)}){const file=path.join("tmp-memcheck",name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,"new generated artifact")}console.log("PASS generated")`
		const root = fixture(source)
		const result = run(root)
		assert.equal(result.status, 0)
		assert.equal(result.report.ok, true)
		for (const name of artifactNames) assert.equal(existsSync(path.join(root, "tmp-memcheck", name)), false)
		unlocked(root)
	})
	check("cleanup failure prevents an all-green final report", () => {
		const root = fixture('import{unlinkSync,mkdirSync}from"node:fs";unlinkSync("tmp-memcheck/chat-bundle.mjs");mkdirSync("tmp-memcheck/chat-bundle.mjs");console.log("PASS job completed")')
		seedArtifacts(root)
		const result = run(root)
		failed(result)
		assert.equal(result.report.results[0].ok, true)
		assert.ok(result.report.cleanupErrors.some(message => message.includes("chat-bundle.mjs")))
		assert.match(result.output, /FAIL run:/)
		assert.doesNotMatch(result.output, /PASS run:/)
		unlocked(root)
	})
	check("an existing lock remains untouched and no job runs", () => {
		const root = fixture('import{writeFileSync}from"node:fs";writeFileSync("unexpected-job","ran")')
		const lock = path.join(root, "tmp-memcheck/_regression-runner.lock")
		mkdirSync(path.dirname(lock), {recursive: true})
		const bytes = Buffer.from('{"pid":123,"owner":"pre-existing fixture"}\n')
		writeFileSync(lock, bytes)
		const result = run(root)
		assert.notEqual(result.status, 0)
		assert.equal(result.report, undefined)
		assert.deepEqual(readFileSync(lock), bytes)
		assert.equal(existsSync(path.join(root, "unexpected-job")), false)
	})
	console.log(`\n${passed} regression runner checks passed (isolated Node fixtures; no browser or application artifacts)`)
} finally {
	for (const root of fixtures) {
		// Each deletion target is the checked, absolute mkdtemp result under the
		// system temporary directory; no path comes from job output or user input.
		assert.equal(path.dirname(root), parent)
		assert.ok(path.basename(root).startsWith("nori-regression-selftest-"))
		// Never kill from a saved PID: it may have been reused by another process.
		// The timeout fixture is bounded, so exceptional cleanup needs no PID kill.
		rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
	}
}
