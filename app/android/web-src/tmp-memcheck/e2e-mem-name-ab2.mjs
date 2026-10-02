/* 最小对照: 用户看到的那两条, 在**旧代码**里是不是真的并存? (A/B 探针第 3 行一直是这个结论, 这里单独固化)
 * 场景: 库里已有「我的名字是小明」(用户先说过), 这一轮 AI 抽出的新事实是「是小明哦」。
 */
import {readFileSync, writeFileSync, readdirSync, copyFileSync, unlinkSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"
const root = path.resolve(import.meta.dirname, "..")
const OLD_TREE = "D:/norios/noriVerZCode/DeepEr-main/app/android/web-src/src/services/memory"
const OI = path.join(root, "tmp-memcheck/on2-index.ts"), OC = path.join(root, "tmp-memcheck/on2-core.ts")
const cleanup = []
copyFileSync(path.join(OLD_TREE, "index.ts"), OI); copyFileSync(path.join(OLD_TREE, "core.ts"), OC)
cleanup.push(OI, OC, path.join(root, "tmp-memcheck/on2-mem.mjs"), path.join(root, "tmp-memcheck/on2-core.mjs"))
writeFileSync(OI, readFileSync(OI, "utf8").split('from "../chat"').join('from "../src/services/chat"').split('from "./core"').join('from "./on2-core"'))
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)
const rawPlugin = {name: "raw", setup(b) {
	b.onResolve({filter: /\?raw$/}, (a) => ({path: a.path, namespace: "raw-file"}))
	b.onLoad({filter: /./, namespace: "raw-file"}, (a) => {
		const rel = a.path.replace(/\?raw$/, "").replace(/^\.\//, "")
		const base = path.dirname(a.importer || path.join(root, "src/services/chat/index.ts"))
		return {loader: "text", contents: readFileSync(path.resolve(base, rel), "utf8")}
	})
}}
await build({entryPoints: [OI], bundle: true, platform: "neutral", format: "esm", logLevel: "silent", outfile: path.join(root, "tmp-memcheck/on2-mem.mjs"), plugins: [rawPlugin]})
await build({entryPoints: [OC], bundle: true, platform: "neutral", format: "esm", logLevel: "silent", outfile: path.join(root, "tmp-memcheck/on2-core.mjs")})

const mkFiles = () => new Map()
const bridge = (f) => ({readFile: (n) => f.get(n) ?? "", writeFile: (n, c) => { f.set(n, String(c)); return "ok" }})
const newFiles = mkFiles(), oldFiles = mkFiles()
globalThis.window = {NoriChat: bridge(newFiles)}
const newMod = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const oldMod = await import(pathToFileURL(path.join(root, "tmp-memcheck/on2-mem.mjs")).href)

const item = (id, content) => ({id, content, type: "fact", importance: 0.9, confidence: 0.95, createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365})
const scenario = async (mod, files, oldContent, newFact) => {
	globalThis.window = {NoriChat: bridge(files)}
	files.clear()
	files.set("memory.json", JSON.stringify({memories: [item("old_0", oldContent)], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
	mod.reloadMemory()
	let calls = 0
	// 假模型: 决策段给 NONE ("库里已有同一件事, 不必再存") —— 这是对模型最有利的假设
	const res = await mod.applyLlmMemoryDecision([item("new_0", newFact)], async (p) => {
		calls += 1
		return p.includes("记忆库管理员") ? JSON.stringify({memory: [{id: "old_0", event: "NONE"}]}) : "{}"
	})
	await mod.flushMemoryPersist()
	return {n: mod.listAll().memories.length, list: mod.listAll().memories.map(m => m.content), calls, res}
}

const pairs = [
	["我的名字是小明", "是小明哦"],
	["我的名字是小明", "我的名字是小明哦"],
	["我的名字是小明", "小明哦"],
	["小明哦", "我的名字是小明"],
]
console.log("=".repeat(76))
console.log("对照组: 库里已有旧条 + 新事实措辞不同 (模型已判 NONE —— 最有利假设)")
console.log("=".repeat(76))
for (const [oldC, newC] of pairs) {
	const o = await scenario(oldMod, oldFiles, oldC, newC)
	const n = await scenario(newMod, newFiles, oldC, newC)
	console.log(`\n旧「${oldC}」+ 新「${newC}」`)
	console.log(`  旧代码: ${o.n} 条 ${JSON.stringify(o.list)}  ${o.n > 1 ? "★并存" : ""}  (llm调用=${o.calls})`)
	console.log(`  新代码: ${n.n} 条 ${JSON.stringify(n.list)}  ${n.n > 1 ? "★并存" : ""}  (llm调用=${n.calls})`)
}
for (const f of cleanup) { try { unlinkSync(f) } catch { /* 忽略 */ } }
