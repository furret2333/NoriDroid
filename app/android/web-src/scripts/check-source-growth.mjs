// Advisory only: file size can prompt a responsibility review, not judge cohesion.
// The fixed baseline is reviewed data; this checker never refreshes it.
import {readFileSync, readdirSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

const projectRoot = path.resolve(import.meta.dirname, "..")
const entryFile = "src/App.vue"
const extensions = new Set([".vue", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".less", ".scss", ".sass"])
const decoder = new TextDecoder("utf-8", {fatal: true})
const readText = file => decoder.decode(readFileSync(file))

export function countLines(text) {
	if (!text) return 0
	const lines = text.split(/\r\n|\n|\r/)
	return lines.length - (lines.at(-1) === "" ? 1 : 0)
}

export function collectSources(root) {
	const files = {}
	const walk = directory => {
		for (const item of readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
			if (item.isSymbolicLink()) continue
			const file = path.join(directory, item.name)
			if (item.isDirectory()) walk(file)
			else if (item.isFile() && extensions.has(path.extname(item.name).toLowerCase())) {
				files[path.relative(root, file).split(path.sep).join("/")] = countLines(readText(file))
			}
		}
	}
	walk(path.join(root, "src"))
	return files
}

function validateCounts(files, label) {
	if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error(`${label} must be a source path/count object`)
	for (const [file, lines] of Object.entries(files)) {
		if (!file.startsWith("src/") || file.includes("\\") || file.split("/").some(part => !part || part === "." || part === "..") || !extensions.has(path.posix.extname(file).toLowerCase())) {
			throw new Error(`${label} has a noncanonical source path: ${file}`)
		}
		if (!Number.isSafeInteger(lines) || lines < 0) throw new Error(`${label} has an invalid line count: ${file}`)
	}
	if (!Object.hasOwn(files, entryFile)) throw new Error(`${label} must contain ${entryFile}`)
}

export function evaluateGrowth(current, baseline) {
	if (!baseline || baseline.version !== 1) throw new Error("Source growth baseline must have version 1")
	validateCounts(baseline.files, "Baseline files")
	validateCounts(current, "Current files")
	const warnings = []
	for (const file of Object.keys(current).sort()) {
		const lines = current[file]
		if (!Object.hasOwn(baseline.files, file)) {
			if (lines > 400) warnings.push({file, kind: "new-large-file", lines, baselineLines: null, limit: 400})
			continue
		}
		const baselineLines = baseline.files[file]
		const limit = file === entryFile ? 80 : Math.min(200, Math.max(80, Math.ceil(baselineLines * 0.25)))
		if (lines - baselineLines >= limit) {
			warnings.push({file, kind: file === entryFile ? "entry-growth" : "existing-growth", lines, baselineLines, growth: lines - baselineLines, limit})
		}
	}
	return warnings
}

export function checkSourceGrowth(root = projectRoot) {
	const baseline = JSON.parse(readText(path.join(root, "scripts/testing/source-growth-baseline.json")))
	const current = collectSources(root)
	return {filesScanned: Object.keys(current).length, warnings: evaluateGrowth(current, baseline)}
}

function runCli() {
	const args = process.argv.slice(2)
	if (args.length === 1 && args[0] === "--help") {
		console.log("Usage: node scripts/check-source-growth.mjs [--help]\nScan src against scripts/testing/source-growth-baseline.json without writing files.\nApp.vue: +80 lines; existing files: +25% (minimum 80, maximum 200); new files: over 400 lines.\nWARN means review module responsibility and related features; it does not fail tests.\nInvalid baseline or unreadable sources fail. Baselines are never automatically refreshed.")
		return
	}
	if (args.length) throw new Error(`Unknown source growth option: ${args.join(" ")}`)
	const {filesScanned, warnings} = checkSourceGrowth()
	for (const warning of warnings) {
		const growth = warning.kind === "new-large-file"
			? `new file exceeds ${warning.limit} lines`
			: `+${warning.growth} from ${warning.baselineLines}; review at +${warning.limit}`
		console.log(`WARN source-growth ${warning.file}: ${warning.lines} lines (${growth}). Review responsibility, state ownership, and affected features; record the outcome before handoff.`)
	}
	console.log(`PASS source-growth scan: ${filesScanned} source files; ${warnings.length} review reminder(s). Size checks are advisory, not an architecture approval.`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	try { runCli() } catch (error) {
		console.error(`FAIL source-growth: ${error.message}`)
		process.exitCode = 1
	}
}
