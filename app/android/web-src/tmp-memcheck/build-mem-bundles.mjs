/**
 * 重建"记忆 + 核心"两个 bundle (探针用)。
 *
 * 为什么单独拆一个脚本: bundle 只有 run-tests.mjs 会重建, 探针直接 import 的话会
 * **静默读到旧产物** —— 本次就踩到了 (源码已改、探针仍报旧结论, 白排查一小时)。
 * 探针开头 `await import("./build-mem-bundles.mjs")` 即可保证测的是当前源码。
 *
 * 运行: cd web-src && node tmp-memcheck/build-mem-bundles.mjs
 */
import {readFileSync, readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

/** 让 esbuild 认识 vite 的 `?raw` 导入 (chat/index.ts 引了 nori-prompt.md?raw) */
const rawPlugin = {
	name: "raw",
	setup(b) {
		b.onResolve({filter: /\?raw$/}, (args) => ({path: args.path, namespace: "raw-file"}))
		b.onLoad({filter: /./, namespace: "raw-file"}, (args) => {
			const rel = args.path.replace(/\?raw$/, "").replace(/^\.\//, "")
			const base = path.dirname(args.importer || path.join(root, "src/services/chat/index.ts"))
			return {loader: "text", contents: readFileSync(path.resolve(base, rel), "utf8")}
		})
	},
}

await build({
	entryPoints: [path.join(root, "src/services/memory/index.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/memory-bundle.mjs"),
	plugins: [rawPlugin],
})
await build({
	entryPoints: [path.join(root, "src/services/memory/core.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/core-bundle.mjs"),
})
export {}
