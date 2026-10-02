/* A/B: 用**旧版源码**与新版跑同一场景, 看"旧代码是否也会留一条"。
 *
 * 背景: 我曾在报告里断言"旧「我在准备考研考试」+ 新「我准备考研」在旧代码里会并存两条",
 * 用户当场指出"实际测试留一条啊"。这里把 D:\norios 那棵树的旧源码复制进来编成第二个 bundle,
 * 与新代码跑同一场景 —— 结论见文件末尾的判读。
 *
 * 运行: node tmp-memcheck/probe-mem-ab.mjs
 * 依赖: 旧树 D:\norios\noriVerZcode\DeepEr-main (缺失则只跑新代码并明确说明)
 */
import {readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, unlinkSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const OLD_TREE = "D:/norios/noriVerZcode/DeepEr-main/app/android/web-src/src/services/memory"
const OLD_INDEX = path.join(root, "tmp-memcheck/old-memory-index.ts")
const OLD_CORE = path.join(root, "tmp-memcheck/old-memory-core.ts")
const hasOld = existsSync(path.join(OLD_TREE, "index.ts"))
const cleanup = []
if (hasOld) {
	copyFileSync(path.join(OLD_TREE, "index.ts"), OLD_INDEX)
	copyFileSync(path.join(OLD_TREE, "core.ts"), OLD_CORE)
	cleanup.push(OLD_INDEX, OLD_CORE, path.join(root, "tmp-memcheck/old-memory-bundle.mjs"), path.join(root, "tmp-memcheck/old-core-bundle.mjs"))
	// 旧 index.ts 的 import/export 路径要指到本树 (export ... from "./core" 也要一起改)
	const src = readFileSync(OLD_INDEX, "utf8")
		.split('from "../chat"').join('from "../src/services/chat"')
		.split('from "./core"').join('from "./old-memory-core"')
	writeFileSync(OLD_INDEX, src)
} else {
	console.log("⚠ 找不到旧树源码, 只跑新代码 (A/B 不可用):", OLD_TREE)
}

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
if (hasOld) {
	await build({
		entryPoints: [OLD_INDEX],
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
		outfile: path.join(root, "tmp-memcheck/old-memory-bundle.mjs"),
		plugins: [rawPlugin],
	})
	await build({
		entryPoints: [OLD_CORE],
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
		outfile: path.join(root, "tmp-memcheck/old-core-bundle.mjs"),
	})
}

const mkFiles = () => {
	const files = new Map()
	globalThis.window = {NoriChat: {readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }}}
	return files
}
const mk = (id, content, over = {}) => ({
	id, content, type: "fact", importance: 0.8, confidence: 0.9,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365, ...over,
})
/* 关键: 两个 bundle 都通过全局 window.NoriChat 读写文件 —— 必须让它们各用各的文件表。
   做法: 每次调用前把 window.NoriChat 指到对应版本的表 (模块闭包里读的是 window, 不是缓存桥)。 */
const newFiles = new Map()
const oldFiles = new Map()
const bridgeFor = (files) => ({readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }})
globalThis.window = {NoriChat: bridgeFor(newFiles)}
const newMod = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const newCore = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)
const oldMod = hasOld ? await import(pathToFileURL(path.join(root, "tmp-memcheck/old-memory-bundle.mjs")).href) : null
const oldCore = hasOld ? await import(pathToFileURL(path.join(root, "tmp-memcheck/old-core-bundle.mjs")).href) : null
const useNew = () => { globalThis.window = {NoriChat: bridgeFor(newFiles)} }
const useOld = () => { globalThis.window = {NoriChat: bridgeFor(oldFiles)} }
useNew()

const scenarios = [
	{name: "旧「我在准备考研考试」+ 新「我准备考研」", old: "我在准备考研考试", fact: "我准备考研", decision: "NONE"},
	{name: "旧「我在准备考研考试」+ 新「我准备考研」(决策给空)", old: "我在准备考研考试", fact: "我准备考研", decision: "EMPTY"},
	{name: "旧「我的名字是小明」+ 新「我叫小明」", old: "我的名字是小明", fact: "我叫小明", decision: "NONE"},
	{name: "旧「我的名字叫小明，是个前端工程师」+ 新「我叫小明」", old: "我的名字叫小明，是个前端工程师", fact: "我叫小明", decision: "UPDATE_SHORT"},
	{name: "旧「我在准备考研」+ 新「我在准备考研」(完全重复)", old: "我在准备考研", fact: "我在准备考研", decision: "EMPTY"},
]

const runOne = async (mod, core, files, sc, use) => {
	use()
	files.clear()
	files.set("memory.json", JSON.stringify({memories: [mk("old_0", sc.old)], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
	mod.reloadMemory()
	const decisionRaw = sc.decision === "EMPTY" ? JSON.stringify({memory: []})
		: sc.decision === "UPDATE_SHORT" ? JSON.stringify({memory: [{id: "old_0", event: "UPDATE", text: sc.fact}]})
		: JSON.stringify({memory: [{id: "old_0", event: "NONE"}]})
	let calls = 0
	const res = await mod.applyLlmMemoryDecision([mk("f_new", sc.fact)], async (p) => {
		calls += 1
		return p.includes("记忆库管理员") ? decisionRaw : JSON.stringify({facts: [{content: sc.fact, type: "fact"}]})
	})
	await mod.flushMemoryPersist()
	return {count: mod.listAll().memories.length, contents: mod.listAll().memories.map(m => m.content), res, calls}
}

console.log("=".repeat(82))
console.log(hasOld ? "A/B 实测: 旧源码 (D:\\norios, SHA 523D204A22F0)  vs  新源码" : "只有新源码 (旧树缺失)")
console.log("=".repeat(82))
for (const sc of scenarios) {
	const n = await runOne(newMod, newCore, newFiles, sc, useNew)
	console.log(`\n${sc.name}   [决策=${sc.decision}]`)
	if (hasOld) {
		const o = await runOne(oldMod, oldCore, oldFiles, sc, useOld)
		console.log(`  旧代码: ${o.count} 条 ${JSON.stringify(o.contents)}  llm调用=${o.calls}  ${JSON.stringify(o.res)}`)
		console.log(`  新代码: ${n.count} 条 ${JSON.stringify(n.contents)}  llm调用=${n.calls}  ${JSON.stringify(n.res)}`)
		console.log(`  判读: 旧 ${o.count === 1 ? "1 条" : "2 条"} / 新 ${n.count === 1 ? "1 条" : "2 条"}`)
	} else {
		console.log(`  新代码: ${n.count} 条 ${JSON.stringify(n.contents)}  llm调用=${n.calls}`)
	}
}

/* 判读 (2026-09-26 用户当场纠正过我一次, 结论以本探针输出为准):
 *   完全相同 ("我在准备考研" / "我在准备考研")  → 旧代码**本来就只留一条** (归一化后命中原文包含);
 *   换说法/长短不同 ("...考研考试" / "我准备考研") → 旧代码留 2 条 (keywordHit 数不到 2 ⇒ 不调 AI 判重);
 *   零字面重叠 ("我的名字是小明" / "我叫小明")   → 旧代码留 2 条 (llm 调用 0 次)。
 * 所以准确表述是: 旧代码能收"完全相同", 收不住"近重复"; 新代码两者都收。
 */
for (const f of cleanup) { try { unlinkSync(f) } catch { /* 忽略 */ } }
