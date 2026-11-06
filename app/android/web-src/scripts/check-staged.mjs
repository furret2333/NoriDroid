// Validate an isolated export of the index, never an unstaged worktree version.
// Only installed dependencies are linked; source and generated outputs stay local
// to the temporary snapshot. This command never stashes or edits the Git index.
import {spawnSync} from "node:child_process"
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {pathToFileURL} from "node:url"

const webPrefix = "app/android/web-src/"
const dependencyFiles = ["pnpm-lock.yaml", "scripts/patch-live2d.mjs"]
const dependencyKeys = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "pnpm"]
const repositoryEnvironment = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]

function git(root, args, options = {}) {
	const child = spawnSync("git", ["-C", root, ...args], {windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options})
	if (child.error) throw child.error
	if (child.status !== 0) throw new Error(`Git ${args[0]} failed: ${(child.stderr ?? "").trim()}`)
	return child.stdout
}

export function relevantPath(file) {
	return file.startsWith(webPrefix)
		|| file.startsWith("app/android/app/src/")
		|| file === "app/android/app/build.gradle"
		|| file.startsWith("app/android/.harness/")
		|| file.startsWith(".githooks/")
		|| file === ".github/workflows/android-web-checks.yml"
}

function assertDependencies(root, snapshotWeb) {
	for (const relative of dependencyFiles) {
		const local = path.join(root, webPrefix, relative)
		const staged = path.join(snapshotWeb, relative)
		// checkout-index applies core.autocrlf. These are UTF-8 text inputs;
		// Git's LF/CRLF conversion must not appear as a dependency change.
		const text = file => readFileSync(file, "utf8").replaceAll("\r\n", "\n")
		if (text(local) !== text(staged)) {
			throw new Error(`Staged ${relative} differs from the dependency installation source. Stage the intended version and install its dependencies before committing.`)
		}
	}
	const localPackage = JSON.parse(readFileSync(path.join(root, webPrefix, "package.json"), "utf8"))
	const stagedPackage = JSON.parse(readFileSync(path.join(snapshotWeb, "package.json"), "utf8"))
	for (const key of dependencyKeys) {
		if (JSON.stringify(localPackage[key]) !== JSON.stringify(stagedPackage[key])) {
			throw new Error(`Staged package.json ${key} differs from the installed dependency source. Install and stage the intended dependency set before committing.`)
		}
	}
	if (!existsSync(path.join(root, webPrefix, "node_modules/vue-tsc/bin/vue-tsc.js"))) {
		throw new Error("Missing Web dependencies. Run pnpm install --frozen-lockfile in app/android/web-src first.")
	}
}

export function checkStaged(root) {
	const changed = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"]).split("\0").filter(Boolean)
	if (!changed.some(relevantPath)) {
		console.log("PASS staged Web check: no related staged changes")
		return {skipped: true}
	}
	const entries = git(root, ["ls-files", "--stage", "-z", "--", "app/android/"]).split("\0").filter(Boolean)
	if (entries.some(entry => !/^(100644|100755) [a-f0-9]+ 0\t/.test(entry))) {
		throw new Error("Staged Android snapshot contains an unresolved entry, submodule or symbolic link; inspect it before committing.")
	}
	const files = entries.map(entry => entry.slice(entry.indexOf("\t") + 1))
	if (!files.includes(`${webPrefix}scripts/run-regression.mjs`)) {
		throw new Error("The formal regression runner is not staged. Stage all required Web sources, scripts and test fixtures before committing.")
	}
	const parent = path.resolve(tmpdir())
	const snapshot = mkdtempSync(path.join(parent, "nori-staged-web-"))
	const snapshotWeb = path.join(snapshot, webPrefix)
	const modulesLink = path.join(snapshotWeb, "node_modules")
	try {
		const prefix = snapshot.replaceAll("\\", "/") + "/"
		git(root, ["checkout-index", "--stdin", "-z", `--prefix=${prefix}`], {input: files.join("\0") + "\0"})
		assertDependencies(root, snapshotWeb)
		mkdirSync(snapshotWeb, {recursive: true})
		symlinkSync(path.join(root, webPrefix, "node_modules"), modulesLink, process.platform === "win32" ? "junction" : "dir")
		const steps = [
			["fast regression", path.join(snapshotWeb, "scripts/run-regression.mjs"), "--fast"],
			["typecheck", path.join(modulesLink, "vue-tsc/bin/vue-tsc.js"), "--noEmit"],
		]
		for (const [label, script, ...args] of steps) {
			console.log(`Checking staged snapshot: ${label}`)
			const env = {...process.env, NORI_ANDROID: path.join(snapshot, "app/android")}
			// Git sets repository-local variables in hooks. The exported tree and
			// its isolated Git self-tests must never inherit the original index.
			for (const name of repositoryEnvironment) delete env[name]
			const result = spawnSync(process.execPath, [script, ...args], {
				cwd: snapshotWeb, stdio: "inherit", windowsHide: true,
				env,
			})
			if (result.error) throw result.error
			if (result.status !== 0) throw new Error(`Staged ${label} failed (exit ${result.status ?? result.signal}). The working tree and index were not changed.`)
		}
		console.log("PASS staged Web snapshot: fast regression and typecheck")
		return {skipped: false}
	} finally {
		// Both deletion targets are fixed descendants of this checked mkdtemp path.
		if (path.dirname(snapshot) !== parent || !path.basename(snapshot).startsWith("nori-staged-web-")) throw new Error("Unexpected snapshot cleanup path")
		if (existsSync(modulesLink)) {
			if (!lstatSync(modulesLink).isSymbolicLink()) throw new Error("Refusing to remove a snapshot dependency path that is not a link")
			unlinkSync(modulesLink)
		}
		rmSync(snapshot, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
	}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	try {
		if (process.argv.length !== 2) throw new Error("Usage: node scripts/check-staged.mjs (checks the current Git index)")
		const root = git(path.resolve(import.meta.dirname, "../../../.."), ["rev-parse", "--show-toplevel"]).trim()
		checkStaged(root)
	} catch (error) {
		console.error(`FAIL staged Web check: ${error.message}`)
		process.exitCode = 1
	}
}
