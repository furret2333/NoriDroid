// Explicit, local-only installation. Never replace an existing custom hook setup.
import {spawnSync} from "node:child_process"
import {chmodSync, existsSync, readFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

function git(root, args, optional = false) {
	const child = spawnSync("git", ["-C", root, ...args], {encoding: "utf8", windowsHide: true})
	if (child.error) throw child.error
	if (child.status !== 0 && !(optional && child.status === 1)) throw new Error(`Git ${args[0]} failed: ${child.stderr.trim()}`)
	return child.stdout.trim()
}

export function installHooks(root) {
	const current = git(root, ["config", "--get", "core.hooksPath"], true)
	if (current && current !== ".githooks") {
		throw new Error(`Existing core.hooksPath is ${current}; no configuration was changed. Integrate .githooks/pre-commit into that setup explicitly.`)
	}
	const defaultHook = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks/pre-commit"]))
	if (!current && existsSync(defaultHook)) {
		throw new Error(`Existing pre-commit hook at ${defaultHook}; no configuration was changed. Integrate the versioned hook explicitly.`)
	}
	const hook = path.join(root, ".githooks/pre-commit")
	if (!existsSync(hook) || !readFileSync(hook, "utf8").includes("scripts/check-staged.mjs")) throw new Error("Missing versioned staged-check hook")
	chmodSync(hook, 0o755)
	git(root, ["config", "--local", "core.hooksPath", ".githooks"])
	console.log("PASS local Git hooks installed: .githooks/pre-commit checks the staged Web snapshot")
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	try {
		if (process.argv.length !== 2) throw new Error("Usage: node scripts/install-git-hooks.mjs")
		const root = git(path.resolve(import.meta.dirname, "../../../.."), ["rev-parse", "--show-toplevel"])
		installHooks(root)
	} catch (error) {
		console.error(`FAIL hook installation: ${error.message}`)
		process.exitCode = 1
	}
}
