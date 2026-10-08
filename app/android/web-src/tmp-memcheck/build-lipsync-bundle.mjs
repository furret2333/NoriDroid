/**
 * 重建 `lipsync-bundle.mjs`（口型单测用）。
 *
 * 为什么与 `build-mem-bundles.mjs` 分开一个文件：口型不属于记忆系统，混在一起会让
 * "改记忆却重建口型"这种无关动作也发生。共用同一套纪律：**测试脚本自己先重建 bundle**，
 * 否则源码已改、测试仍报旧结论（`build-mem-bundles.mjs` 文件头记着这个教训）。
 *
 * 运行: cd web-src && node tmp-memcheck/build-lipsync-bundle.mjs
 */
import {readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

// lipSync 只依赖 ./beforeUpdate（Node 里安全: 缺 window 时静默跳过安装）
await build({
	entryPoints: [path.join(root, "src/services/live2d/lipSync.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/lipsync-bundle.mjs"),
})
export {}
