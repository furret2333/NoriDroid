// Isolated Git repositories and tiny Node fixtures verify index/worktree separation.
import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"

const parent = path.resolve(tmpdir())
const fixtures = []
const webPrefix = "app/android/web-src/"
let passed = 0

function fixture() {
	const root = mkdtempSync(path.join(parent, "nori-staged-check-selftest-"))
	assert.equal(path.dirname(root), parent)
	fixtures.push(root)
	const put = (file, bytes) => {
		const target = path.join(root, file)
		mkdirSync(path.dirname(target), {recursive: true})
		writeFileSync(target, bytes)
	}
	const env = {...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "no-global-git-config")}
	for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) delete env[name]
	const run = (command, args, extra = {}) => {
		const child = spawnSync(command, args, {cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 20000, ...extra})
		if (child.error) throw child.error
		return {...child, output: child.stdout + child.stderr}
	}
	const git = (...args) => {
		const child = run("git", args)
		assert.equal(child.status, 0, child.output)
		return child.stdout
	}
	git("init", "-q")
	put(`${webPrefix}package.json`, '{"type":"module","dependencies":{}}\n')
	put(`${webPrefix}pnpm-lock.yaml`, "fixture lock\n")
	put(`${webPrefix}scripts/patch-live2d.mjs`, "// fixture patch\n")
	put(`${webPrefix}src/value.txt`, "staged-good\n")
	put(`${webPrefix}scripts/run-regression.mjs`, 'import{readFileSync,writeFileSync}from"node:fs";if(readFileSync("src/value.txt","utf8")!=="staged-good\\n")process.exit(7);writeFileSync("generated.txt","snapshot only");console.log("PASS staged fixture")\n')
	put(`${webPrefix}node_modules/vue-tsc/bin/vue-tsc.js`, 'const fs=require("node:fs");if(fs.readFileSync("src/value.txt","utf8")!=="staged-good\\n")process.exit(8)\n')
	put(".githooks/pre-commit", '#!/bin/sh\nexec node "$(git rev-parse --show-toplevel)/app/android/web-src/scripts/check-staged.mjs"\n')
	put(".gitignore", "node_modules/\n")
	for (const file of ["check-staged.mjs", "install-git-hooks.mjs"]) {
		mkdirSync(path.join(root, webPrefix, "scripts"), {recursive: true})
		copyFileSync(path.join(import.meta.dirname, file), path.join(root, webPrefix, "scripts", file))
	}
	git("add", ".")
	const cli = file => run(process.execPath, [path.join(root, webPrefix, "scripts", file)])
	return {root, put, git, run, cli}
}

function check(name, task) {
	task()
	passed++
	console.log(`PASS ${name}`)
}

try {
	check("staged snapshot ignores unstaged fixes and preserves original index/worktree", () => {
		const f = fixture()
		f.put(`${webPrefix}src/value.txt`, "unstaged-bad\n")
		const index = f.git("ls-files", "--stage")
		const result = f.cli("check-staged.mjs")
		assert.equal(result.status, 0, result.output)
		assert.match(result.output, /PASS staged Web snapshot/)
		assert.equal(readFileSync(path.join(f.root, webPrefix, "src/value.txt"), "utf8"), "unstaged-bad\n")
		assert.equal(f.git("ls-files", "--stage"), index)
		assert.equal(existsSync(path.join(f.root, webPrefix, "generated.txt")), false)
		assert.equal(existsSync(path.join(f.root, webPrefix, "node_modules/vue-tsc/bin/vue-tsc.js")), true)
	})
	check("a staged failure cannot be masked by an unstaged good version", () => {
		const f = fixture()
		f.put(`${webPrefix}src/value.txt`, "staged-bad\n")
		f.git("add", `${webPrefix}src/value.txt`)
		f.put(`${webPrefix}src/value.txt`, "staged-good\n")
		const result = f.cli("check-staged.mjs")
		assert.notEqual(result.status, 0)
		assert.match(result.output, /Staged fast regression failed/)
		assert.equal(f.git("show", `:${webPrefix}src/value.txt`), "staged-bad\n")
	})
	check("missing staged dependencies fail without changing the worktree", () => {
		const f = fixture()
		f.put(`${webPrefix}scripts/run-regression.mjs`, 'import "../src/missing.mjs"\n')
		f.git("add", `${webPrefix}scripts/run-regression.mjs`)
		f.put(`${webPrefix}src/missing.mjs`, 'console.log("PASS untracked only")\n')
		const result = f.cli("check-staged.mjs")
		assert.notEqual(result.status, 0)
		assert.match(result.output, /Staged fast regression failed/)
		assert.equal(existsSync(path.join(f.root, webPrefix, "src/missing.mjs")), true)
	})
	check("dependency definitions must match the staged installation source", () => {
		const f = fixture()
		f.put(`${webPrefix}pnpm-lock.yaml`, "unstaged lock\n")
		const result = f.cli("check-staged.mjs")
		assert.notEqual(result.status, 0)
		assert.match(result.output, /differs from the dependency installation source/)
	})
	check("dependency comparison accepts Git newline conversion without changing inputs", () => {
		for (const autocrlf of ["false", "true"]) {
			const f = fixture()
			f.git("config", "core.autocrlf", autocrlf)
			// The tiny runner fixture deliberately asserts LF for its value input.
			f.put(".gitattributes", "*.txt text eol=lf\n")
			f.git("add", ".gitattributes")
			for (const eol of ["\n", "\r\n"]) {
				f.put(`${webPrefix}pnpm-lock.yaml`, `fixture lock${eol}`)
				f.put(`${webPrefix}scripts/patch-live2d.mjs`, `// fixture patch${eol}`)
				const result = f.cli("check-staged.mjs")
				assert.equal(result.status, 0, result.output)
				assert.equal(readFileSync(path.join(f.root, webPrefix, "pnpm-lock.yaml"), "utf8"), `fixture lock${eol}`)
			}
		}
	})
	check("a typecheck failure blocks an otherwise passing staged regression", () => {
		const f = fixture()
		f.put(`${webPrefix}node_modules/vue-tsc/bin/vue-tsc.js`, "process.exit(8)\n")
		const result = f.cli("check-staged.mjs")
		assert.notEqual(result.status, 0)
		assert.match(result.output, /Staged typecheck failed/)
	})
	check("irrelevant commits skip Web tests", () => {
		const f = fixture()
		// Reset only this disposable fixture's index; the real repository is untouched.
		f.git("rm", "-r", "--cached", ".")
		f.put("notes.md", "unrelated\n")
		f.git("add", "notes.md")
		const result = f.cli("check-staged.mjs")
		assert.equal(result.status, 0, result.output)
		assert.match(result.output, /no related staged changes/)
	})
	check("hook installation is explicit, local and idempotent", () => {
		const f = fixture()
		assert.equal(f.cli("install-git-hooks.mjs").status, 0)
		assert.equal(f.git("config", "--local", "--get", "core.hooksPath").trim(), ".githooks")
		assert.equal(f.cli("install-git-hooks.mjs").status, 0)
	})
	check("existing custom hooksPath is preserved", () => {
		const f = fixture()
		f.git("config", "--local", "core.hooksPath", "custom-hooks")
		const result = f.cli("install-git-hooks.mjs")
		assert.notEqual(result.status, 0)
		assert.equal(f.git("config", "--local", "--get", "core.hooksPath").trim(), "custom-hooks")
	})
	check("existing default pre-commit hook is preserved", () => {
		const f = fixture()
		const bytes = "#!/bin/sh\nexit 9\n"
		f.put(".git/hooks/pre-commit", bytes)
		const result = f.cli("install-git-hooks.mjs")
		assert.notEqual(result.status, 0)
		assert.equal(readFileSync(path.join(f.root, ".git/hooks/pre-commit"), "utf8"), bytes)
		assert.notEqual(f.run("git", ["config", "--get", "core.hooksPath"]).status, 0)
	})
	console.log(`\n${passed} staged-check and installer tests passed (isolated Git fixtures)`)
} finally {
	for (const root of fixtures) {
		assert.equal(path.dirname(root), parent)
		assert.ok(path.basename(root).startsWith("nori-staged-check-selftest-"))
		rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
	}
}
