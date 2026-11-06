// Exercise growth reminders against pure counts and disposable source trees.
import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {
	copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
	statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {countLines, collectSources, evaluateGrowth, checkSourceGrowth} from "./check-source-growth.mjs"

const source = path.join(import.meta.dirname, "check-source-growth.mjs")
const parent = path.resolve(tmpdir())
const fixtures = []
const app = "src/App.vue"
const counts = extra => ({[app]: 1123, ...extra})
const baseline = extra => ({version: 1, files: counts(extra)})
let passed = 0

function check(name, test) {
	test()
	passed++
	console.log(`PASS ${name}`)
}

function fixture(files = {}, saved = {version: 1, files: {[app]: 1}}) {
	const root = mkdtempSync(path.join(parent, "nori-source-growth-selftest-"))
	assert.equal(path.dirname(root), parent)
	fixtures.push(root)
	const put = (name, content) => {
		const file = path.join(root, name)
		mkdirSync(path.dirname(file), {recursive: true})
		writeFileSync(file, content)
	}
	put(app, "app\n")
	for (const [name, content] of Object.entries(files)) put(name, content)
	put("scripts/testing/source-growth-baseline.json", JSON.stringify(saved, null, 2) + "\n")
	copyFileSync(source, path.join(root, "scripts/check-source-growth.mjs"))
	return root
}

function cli(root, args = [], cwd = root) {
	const result = spawnSync(process.execPath, [path.join(root, "scripts/check-source-growth.mjs"), ...args], {
		cwd, encoding: "utf8", windowsHide: true, timeout: 5000,
	})
	if (result.error) throw result.error
	return {...result, output: `${result.stdout}\n${result.stderr}`}
}

try {
	check("physical lines handle empty text, CRLF, CR and final newlines consistently", () => {
		for (const [text, expected] of [
			["", 0], ["one", 1], ["one\n", 1], ["one\r\n", 1],
			["one\rtwo\r", 2], ["one\r\ntwo\n", 2], ["\n", 1], ["one\n\n", 2],
		]) assert.equal(countLines(text), expected, JSON.stringify(text))
	})
	check("unchanged historical large files and shrinking files do not warn", () => {
		assert.deepEqual(evaluateGrowth(counts({"src/large.ts": 3139}), baseline({"src/large.ts": 3139})), [])
		assert.deepEqual(evaluateGrowth(counts({"src/large.ts": 2000}), baseline({"src/large.ts": 3139})), [])
	})
	check("App growth below 80 lines does not warn", () => {
		assert.deepEqual(evaluateGrowth(counts({[app]: 1202}), baseline()), [])
	})
	check("App growth at 80 lines requests responsibility review", () => {
		const warnings = evaluateGrowth(counts({[app]: 1203}), baseline())
		assert.equal(warnings.length, 1)
		assert.equal(warnings[0].file, app)
		assert.equal(warnings[0].kind, "entry-growth")
		assert.equal(warnings[0].lines, 1203)
		assert.equal(warnings[0].baselineLines, 1123)
		assert.equal(warnings[0].limit, 80)
	})
	check("small existing modules use the 80 line minimum boundary", () => {
		const saved = baseline({"src/small.ts": 100})
		assert.deepEqual(evaluateGrowth(counts({"src/small.ts": 179}), saved), [])
		const warnings = evaluateGrowth(counts({"src/small.ts": 180}), saved)
		assert.equal(warnings.length, 1)
		assert.equal(warnings[0].kind, "existing-growth")
		assert.equal(warnings[0].limit, 80)
	})
	check("medium modules round their 25 percent allowance upward", () => {
		const saved = baseline({"src/medium.ts": 401})
		assert.deepEqual(evaluateGrowth(counts({"src/medium.ts": 501}), saved), [])
		assert.equal(evaluateGrowth(counts({"src/medium.ts": 502}), saved)[0].limit, 101)
	})
	check("large modules are reminded after 200 added lines", () => {
		const saved = baseline({"src/large.ts": 3139})
		assert.deepEqual(evaluateGrowth(counts({"src/large.ts": 3338}), saved), [])
		assert.equal(evaluateGrowth(counts({"src/large.ts": 3339}), saved)[0].limit, 200)
	})
	check("new files at 400 lines are allowed and 401 lines keep reminding", () => {
		const saved = baseline()
		assert.deepEqual(evaluateGrowth(counts({"src/new.ts": 400}), saved), [])
		const current = counts({"src/new.ts": 401})
		const warnings = evaluateGrowth(current, saved)
		assert.equal(warnings[0].kind, "new-large-file")
		assert.equal(warnings[0].lines, 401)
		assert.deepEqual(evaluateGrowth(current, saved), warnings)
		assert.equal(Object.hasOwn(saved.files, "src/new.ts"), false)
	})
	check("deleting an old baseline file is a normal refactor", () => {
		assert.deepEqual(evaluateGrowth(counts(), baseline({"src/removed.ts": 2000})), [])
	})
	check("warning order is stable regardless of count insertion order", () => {
		const current = counts({"src/z.ts": 401, "src/a.ts": 402, [app]: 1203})
		const warnings = evaluateGrowth(current, baseline())
		assert.deepEqual(warnings.map(warning => warning.file), [app, "src/a.ts", "src/z.ts"])
	})
	check("missing App and unsupported baseline format are rejected", () => {
		assert.throws(() => evaluateGrowth(counts(), {version: 2, files: counts()}))
		assert.throws(() => evaluateGrowth(counts(), {version: 1, files: {}}))
		assert.throws(() => evaluateGrowth({}, baseline()))
		assert.throws(() => evaluateGrowth(counts(), {version: 1, files: []}))
	})
	check("invalid line counts and paths cannot hide source growth", () => {
		for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10"]) {
			assert.throws(() => evaluateGrowth(counts(), baseline({"src/bad.ts": value})))
			assert.throws(() => evaluateGrowth(counts({"src/bad.ts": value}), baseline()))
		}
		for (const name of ["../outside.ts", "src/../outside.ts", "src//bad.ts", "src\\bad.ts", "/src/bad.ts"]) {
			assert.throws(() => evaluateGrowth(counts(), baseline({[name]: 1})))
		}
	})
	check("collection stays inside src and ignores assets and test scripts", () => {
		const root = fixture({
			[app]: "one\r\ntwo\r\n", "src/a.ts": "a\nb\nc\n",
			"src/styles/site.less": "body {}\n", "src/prompt.txt": "ignored\n",
			"scripts/big.ts": "ignored\n".repeat(500),
		})
		const actual = collectSources(root)
		assert.deepEqual(actual, {[app]: 2, "src/a.ts": 3, "src/styles/site.less": 1})
		assert.deepEqual(collectSources(root), actual)
	})
	check("all supported Web source extensions are counted", () => {
		const extensions = ["vue", "ts", "tsx", "js", "jsx", "mjs", "css", "less", "scss", "sass"]
		const root = fixture(Object.fromEntries(extensions.map(ext => [`src/variants/file.${ext}`, "line\n"])))
		const actual = collectSources(root)
		assert.equal(Object.keys(actual).length, extensions.length + 1)
		for (const ext of extensions) assert.equal(actual[`src/variants/file.${ext}`], 1)
	})
	check("source directory links do not import external files", () => {
		const root = fixture()
		const external = fixture({"external.ts": "external\n".repeat(500)})
		symlinkSync(external, path.join(root, "src/linked"), process.platform === "win32" ? "junction" : "dir")
		assert.deepEqual(collectSources(root), {[app]: 1})
	})
	check("programmatic checks preserve baseline bytes and timestamp", () => {
		const root = fixture({"src/new.ts": "line\n".repeat(401)})
		const file = path.join(root, "scripts/testing/source-growth-baseline.json")
		const bytes = readFileSync(file), time = statSync(file, {bigint: true}).mtimeNs
		const result = checkSourceGrowth(root)
		assert.equal(result.filesScanned, 2)
		assert.equal(result.warnings.length, 1)
		assert.deepEqual(readFileSync(file), bytes)
		assert.equal(statSync(file, {bigint: true}).mtimeNs, time)
	})
	check("CLI warnings stay advisory and never update the baseline", () => {
		const root = fixture({"src/new.ts": "line\n".repeat(401)})
		const file = path.join(root, "scripts/testing/source-growth-baseline.json")
		const bytes = readFileSync(file), time = statSync(file, {bigint: true}).mtimeNs
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = cli(root)
			assert.equal(result.status, 0, result.output)
			assert.match(result.output, /^WARN\b/m)
			assert.match(result.output, /src\/new\.ts/)
			assert.deepEqual(readFileSync(file), bytes)
			assert.equal(statSync(file, {bigint: true}).mtimeNs, time)
		}
	})
	check("CLI resolves project files independently of the working directory", () => {
		const root = fixture({"src/new.js": "line\n".repeat(401)})
		const result = cli(root, [], parent)
		assert.equal(result.status, 0, result.output)
		assert.match(result.output, /^WARN\b/m)
		assert.match(result.output, /src\/new\.js/)
	})
	check("CLI help is read only and unknown flags fail", () => {
		const root = fixture()
		const file = path.join(root, "scripts/testing/source-growth-baseline.json")
		const bytes = readFileSync(file)
		assert.equal(cli(root, ["--help"]).status, 0)
		assert.notEqual(cli(root, ["--write-baseline"]).status, 0)
		assert.deepEqual(readFileSync(file), bytes)
		assert.equal(existsSync(path.join(root, "tmp-memcheck")), false)
	})
	check("missing or malformed baseline fails instead of passing silently", () => {
		const root = fixture()
		const file = path.join(root, "scripts/testing/source-growth-baseline.json")
		unlinkSync(file)
		assert.notEqual(cli(root).status, 0)
		assert.equal(existsSync(file), false)
		writeFileSync(file, "{")
		assert.notEqual(cli(root).status, 0)
		assert.equal(readFileSync(file, "utf8"), "{")
	})
	check("missing App fails instead of checking a partial source tree", () => {
		const root = fixture()
		unlinkSync(path.join(root, app))
		assert.notEqual(cli(root).status, 0)
		assert.throws(() => checkSourceGrowth(root))
	})
	console.log(`\n${passed} source growth checks passed (isolated fixtures; application source was not modified)`)
} finally {
	for (const root of fixtures) {
		// Only delete absolute directories allocated by this test under system temp.
		assert.equal(path.dirname(root), parent)
		assert.ok(path.basename(root).startsWith("nori-source-growth-selftest-"))
		rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
	}
}
