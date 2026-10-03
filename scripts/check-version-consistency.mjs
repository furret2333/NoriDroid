#!/usr/bin/env node

import {readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const gradleFile = path.join(root, "app", "android", "app", "build.gradle")
const appFile = path.join(root, "app", "android", "web-src", "src", "App.vue")

const gradle = readFileSync(gradleFile, "utf8")
const app = readFileSync(appFile, "utf8")
const gradleVersion = gradle.match(/versionName\s+"([^"]+)"/)?.[1]
const appVersion = app.match(/const\s+APP_VERSION\s*=\s*"([^"]+)"/)?.[1]

if (!gradleVersion) {
	console.error(`Could not find versionName in ${path.relative(root, gradleFile)}`)
	process.exit(1)
}
if (!appVersion) {
	console.error(`Could not find APP_VERSION in ${path.relative(root, appFile)}`)
	process.exit(1)
}
if (gradleVersion !== appVersion) {
	console.error(`Version mismatch: Android ${gradleVersion}, Web ${appVersion}`)
	process.exit(1)
}

console.log(`Version consistent: ${gradleVersion}`)
