/* 直接把**旧代码**内部的判定过程打印出来, 不猜。
 * 用户两次指出: 旧「我在准备考研考试」+ 新「我准备考研」实测留一条。
 * 这里打印: 词元、重叠数、keywordHit 是否命中、LLM 是否被调用、最终库里几条。
 * 旧源码来自 D:\norios\noriVerZcode\DeepEr-main (SHA 523D204A22F0), 用后自动清理。
 */
import {readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, unlinkSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const OLD_TREE = "D:/norios/noriVerZcode/DeepEr-main/app/android/web-src/src/services/memory"
const OLD_INDEX = path.join(root, "tmp-memcheck/old2-index.ts")
const OLD_CORE = path.join(root, "tmp-memcheck/old2-core.ts")
const cleanup = []
if (!existsSync(path.join(OLD_TREE, "index.ts"))) throw new Error("找不到旧树: " + OLD_TREE)
copyFileSync(path.join(OLD_TREE, "index.ts"), OLD_INDEX)
copyFileSync(path.join(OLD_TREE, "core.ts"), OLD_CORE)
cleanup.push(OLD_INDEX, OLD_CORE, path.join(root, "tmp-memcheck/old2-memory.mjs"), path.join(root, "tmp-memcheck/old2-core.mjs"))
const src = readFileSync(OLD_INDEX, "utf8")
	.split('from "../chat"').join('from "../src/services/chat"')
	.split('from "./core"').join('from "./old2-core"')
writeFileSync(OLD_INDEX, src)

const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)
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
await build({entryPoints: [OLD_INDEX], bundle: true, platform: "neutral", format: "esm", logLevel: "silent", outfile: path.join(root, "tmp-memcheck/old2-memory.mjs"), plugins: [rawPlugin]})
await build({entryPoints: [OLD_CORE], bundle: true, platform: "neutral", format: "esm", logLevel: "silent", outfile: path.join(root, "tmp-memcheck/old2-core.mjs")})

const files = new Map()
globalThis.window = {NoriChat: {readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }}}
const oldMem = await import(pathToFileURL(path.join(root, "tmp-memcheck/old2-memory.mjs")).href)
const oldCore = await import(pathToFileURL(path.join(root, "tmp-memcheck/old2-core.mjs")).href)

const mk = (id, content) => ({id, content, type: "fact", importance: 0.8, confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365})

const OLD_C = "我在准备考研考试", NEW_C = "我准备考研"
files.set("memory.json", JSON.stringify({memories: [mk("old_0", OLD_C)], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
oldMem.reloadMemory()

console.log("=".repeat(78))
console.log("旧代码内部判定过程 (逐条打印)")
console.log("=".repeat(78))
const factTokens = oldCore.tokenize(NEW_C)
console.log(`  新事实 tokenize = ${JSON.stringify(factTokens)}  (${factTokens.length} 个词元)`)
const hits = oldCore.recallMemories([mk("old_0", OLD_C)], NEW_C, 5).hits
console.log(`  recallMemories 命中 = ${JSON.stringify(hits.map(h => h.content))}`)
for (const h of hits) {
	const hTokens = oldCore.tokenize(h.content)
	const overlap = hTokens.filter(t => factTokens.includes(t))
	console.log(`  旧条 tokenize = ${JSON.stringify(hTokens)}`)
	console.log(`  重叠词元 = ${JSON.stringify(overlap)}  → overlap=${overlap.length}`)
	console.log(`  旧代码的闸: overlap>=2 ? ${overlap.length >= 2}   (overlap>=1 && factTokens<=2) ? ${overlap.length >= 1 && factTokens.length <= 2}`)
	console.log(`  ⇒ keywordHit = ${overlap.length >= 2 || (overlap.length >= 1 && factTokens.length <= 2)}`)
}
console.log(`  isSameContent 在本旧版本里不存在 —— 旧版判重是内联的 normalizeContent + includes`)
console.log(`  normalizeContent: [${oldCore.normalizeContent(OLD_C)}] vs [${oldCore.normalizeContent(NEW_C)}]`)
const na = oldCore.normalizeContent(OLD_C), nb = oldCore.normalizeContent(NEW_C)
console.log(`  包含判定: a===b? ${na === nb}  a.includes(b)? ${na.includes(nb)}  b.includes(a)? ${nb.includes(na)}`)
console.log(`  ⇒ 旧版 mergeMemories 会不会合并 = ${na === nb || na.includes(nb) || nb.includes(na)}`)

let calls = 0
const res = await oldMem.applyLlmMemoryDecision([mk("new_0", NEW_C)], async (p) => {
	calls += 1
	return JSON.stringify({memory: [{id: "old_0", event: "NONE"}]})
})
await oldMem.flushMemoryPersist()
console.log("")
console.log(`  LLM 调用次数 = ${calls}`)
console.log(`  返回 = ${JSON.stringify(res)}`)
console.log(`  库里 = ${JSON.stringify(oldMem.listAll().memories.map(m => m.content))}   (${oldMem.listAll().memories.length} 条)`)

console.log("")
console.log("=".repeat(78))
console.log("换成不同的模型回答, 结果会不会变 (同一对句子)")
console.log("=".repeat(78))
const runWith = async (label, decision) => {
	files.set("memory.json", JSON.stringify({memories: [mk("old_0", OLD_C)], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
	oldMem.reloadMemory()
	let calls = 0
	const res = await oldMem.applyLlmMemoryDecision([mk("new_0", NEW_C)], async (p) => {
		calls += 1
		return decision
	})
	await oldMem.flushMemoryPersist()
	console.log(`  ${label}  llm调用=${calls}  → ${JSON.stringify(oldMem.listAll().memories.map(m => m.content))}  ${JSON.stringify(res)}`)
}
await runWith("模型答 NONE       ", JSON.stringify({memory: [{id: "old_0", event: "NONE"}]}))
await runWith("模型答 UPDATE(旧文本)", JSON.stringify({memory: [{id: "old_0", event: "UPDATE", text: OLD_C}]}))
await runWith("模型答 UPDATE(新文本)", JSON.stringify({memory: [{id: "old_0", event: "UPDATE", text: NEW_C}]}))
await runWith("模型答 DELETE     ", JSON.stringify({memory: [{id: "old_0", event: "DELETE"}]}))
await runWith("模型答空数组      ", JSON.stringify({memory: []}))
await runWith("模型答坏 JSON     ", "not json at all")

for (const f of cleanup) { try { unlinkSync(f) } catch { /* 忽略 */ } }
