/* 为 harness 测试页构建两个记忆服务 bundle: 修复后 / 修复前 (对比用)。
   产物落在 .harness/ (测试专用, 不进 APK)。
   用法: node .harness/build-sumtest.mjs */
import {readFileSync, readdirSync, rmSync, copyFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

const HARNESS = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
const WEB = path.join(HARNESS, "..", "web-src")
const root = path.resolve(WEB)

const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("找不到 esbuild")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

/** vite 的 ?raw 导入 (chat/index.ts 引了 nori-prompt.md?raw) */
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

const MEMDIR = path.join(root, "src/services/memory")
// 把基线 (修复前) 源码临时放进源码树, 以解析其相对导入 (./core, ../chat)
copyFileSync(path.join(HARNESS, "sumtest/old-index.ts"), path.join(MEMDIR, "oldbaseline.testgen.ts"))
copyFileSync(path.join(HARNESS, "sumtest/old-core.ts"), path.join(MEMDIR, "oldbaseline-core.testgen.ts"))
// 基线 index 里 import {...} from "./core" → 指向临时 core 文件
const oldIdx = readFileSync(path.join(MEMDIR, "oldbaseline.testgen.ts"), "utf8")
	.replace(/from "\.\/core"/g, 'from "./oldbaseline-core.testgen"')
	.replace(/from "\.\.\/chat"/g, 'from "../chat"')
	.replace(/\?raw/g, "?raw")
writeFileSync(path.join(MEMDIR, "oldbaseline.testgen.ts"), oldIdx)

const jobs = [
	["修复后 (当前源码)", path.join(root, "src/services/memory/index.ts"), path.join(HARNESS, "sumtest/now.js")],
	// 修复前版本: 临时放进 src/services/memory/ 以解析相对导入 (./core, ../chat), 构建后删除
	["修复前 (1.1.27 基线)", path.join(root, "src/services/memory/oldbaseline.testgen.ts"), path.join(HARNESS, "sumtest/old.js")],
]
for (const [label, entry, out] of jobs) {
	await build({
		entryPoints: [entry], bundle: true, platform: "neutral", format: "esm",
		logLevel: "silent", outfile: out, plugins: [rawPlugin],
	})
	console.log(`  built ${label} -> ${path.basename(out)} (${(readFileSync(out).length / 1024).toFixed(0)} KB)`)
}
// 清理临时源文件 (含修复前的旧代码, 不该留在产品源码树里)
for (const f of ["oldbaseline.testgen.ts", "oldbaseline-core.testgen.ts"]) {
	try { rmSync(path.join(root, "src/services/memory", f), {force: true}) } catch { /* 忽略 */ }
}
console.log("完成")
