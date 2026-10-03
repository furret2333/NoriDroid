#!/usr/bin/env node
/**
 * Update the Android version without touching generated files.
 *
 * Usage:
 *   node scripts/bump-version.mjs 2.0.0 --code 2
 *   node scripts/bump-version.mjs 2.0.0 --code 2 --release
 *
 * `--release` is deliberately explicit: it commits the version file, creates
 * a tag, and pushes both. Omit it for local release preparation.
 */

import {readFileSync, writeFileSync} from "node:fs"
import {execSync} from "node:child_process"
import {fileURLToPath} from "node:url"
import path from "node:path"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const FILE = path.join(ROOT, "app", "android", "app", "build.gradle")
const WEB_FILE = path.join(ROOT, "app", "android", "web-src", "src", "App.vue")
const args = process.argv.slice(2)
const version = args.find((arg) => !arg.startsWith("--"))
const codeIndex = args.indexOf("--code")
const versionCode = codeIndex >= 0 ? args[codeIndex + 1] : version?.split(".")[0]
const isRelease = args.includes("--release")

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error("Usage: node scripts/bump-version.mjs <x.y.z> [--code <positive integer>]")
	process.exit(1)
}
if (!versionCode || !/^\d+$/.test(versionCode) || Number(versionCode) <= 0) {
	console.error("--code must be a positive Android versionCode")
	process.exit(1)
}

const relativeFile = path.relative(ROOT, FILE).replace(/\\/g, "/")
const relativeWebFile = path.relative(ROOT, WEB_FILE).replace(/\\/g, "/")
const tagName = `v${version}`
const raw = readFileSync(FILE, "utf8")
const webRaw = readFileSync(WEB_FILE, "utf8")
const oldCode = raw.match(/versionCode\s+(\d+)/)?.[1]
const oldName = raw.match(/versionName\s+"([^"]+)"/)?.[1]
if (!oldCode || !oldName) {
	console.error(`Could not find versionCode/versionName in ${relativeFile}`)
	process.exit(1)
}
const updated = raw
	.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
	.replace(/versionName\s+"[^"]+"/, `versionName "${version}"`)
writeFileSync(FILE, updated)

const updatedWeb = webRaw.replace(/const\s+APP_VERSION\s*=\s*"[^"]+"/, `const APP_VERSION = "${version}"`)
if (updatedWeb === webRaw) {
	console.error(`Could not find APP_VERSION in ${relativeWebFile}`)
	process.exit(1)
}
writeFileSync(WEB_FILE, updatedWeb)

const verify = readFileSync(FILE, "utf8")
if (!new RegExp(`versionCode\\s+${versionCode}`).test(verify) ||
	!new RegExp(`versionName\\s+"${version.replace(/\./g, "\\.")}"`).test(verify)) {
	console.error("Version verification failed")
	process.exit(1)
}
const webVerify = readFileSync(WEB_FILE, "utf8")
if (!new RegExp(`const\\s+APP_VERSION\\s*=\\s*"${version.replace(/\./g, "\\.")}"`).test(webVerify)) {
	console.error("Web version verification failed")
	process.exit(1)
}
console.log(`${relativeFile}: versionCode ${oldCode} -> ${versionCode}, versionName ${oldName} -> ${version}`)
console.log(`${relativeWebFile}: APP_VERSION -> ${version}`)

if (!isRelease) {
	console.log("Local update complete. Review and commit the change manually when ready.")
	process.exit(0)
}

const status = execSync("git status --porcelain", {cwd: ROOT, encoding: "utf8"})
const changed = status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim().replace(/\\/g, "/"))
if (changed.some((file) => file !== relativeFile && file !== relativeWebFile)) {
	console.error("Refusing --release while unrelated working-tree changes exist:")
	console.error(changed.filter((file) => file !== relativeFile && file !== relativeWebFile).join("\n"))
	process.exit(1)
}
if (execSync(`git tag -l "${tagName}"`, {cwd: ROOT, encoding: "utf8"}).trim() === tagName) {
	console.error(`Tag ${tagName} already exists; refusing to overwrite it.`)
	process.exit(1)
}
execSync(`git add "${relativeFile}" "${relativeWebFile}"`, {cwd: ROOT, stdio: "inherit"})
execSync(`git commit -m "Release ${tagName}"`, {cwd: ROOT, stdio: "inherit"})
execSync(`git tag "${tagName}"`, {cwd: ROOT, stdio: "inherit"})
const branch = execSync("git rev-parse --abbrev-ref HEAD", {cwd: ROOT, encoding: "utf8"}).trim()
execSync(`git push origin ${branch}`, {cwd: ROOT, stdio: "inherit"})
execSync(`git push origin "${tagName}"`, {cwd: ROOT, stdio: "inherit"})
console.log(`Released ${tagName}`)
