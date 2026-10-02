/* 排查: 用户反馈「我的名字是小明哦」会留下「我的名字是小明」和「是小明哦」两条。
 * 先**复现**再定位, 不先猜是哪一步漏的。
 *   A. 单句提取: extractMemories 对这句话抽出什么?
 *   B. 多句连说: 同一句话重复/换说法说两遍, 库里几条?
 *   C. 定位: 归一化后的包含关系是哪一对不成立?
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {NoriChat: {readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }}}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

const reset = () => {
	files.set("memory.json", JSON.stringify({memories: [], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
	mem.reloadMemory()
}
const lib = () => mem.listAll().memories.map(m => m.content)

console.log("=".repeat(80))
console.log("A. 单句: extractMemories 抽出什么 (规则通道)")
console.log("=".repeat(80))
for (const s of ["我的名字是小明哦", "我的名字是小明", "我叫小明", "我的名字是小明啊", "我的名字是小明。"]) {
	console.log(`  ${JSON.stringify(s)} → ${JSON.stringify(core.extractMemories(s).map(i => i.content))}`)
}

console.log("")
console.log("=".repeat(80))
console.log("B. 多句连说 (规则通道 addMemoriesFromText, 逐句入库)")
console.log("=".repeat(80))
const seqs = [
	["我的名字是小明哦", "我的名字是小明哦"],
	["我的名字是小明", "我的名字是小明哦"],
	["我叫小明", "我的名字是小明哦"],
	["我的名字是小明哦", "我叫小明"],
	["我叫小明", "我的名字是小明"],
	["我的名字是小明哦"],
]
for (const seq of seqs) {
	reset()
	for (const s of seq) mem.addMemoriesFromText(s)
	console.log(`  ${JSON.stringify(seq)}`)
	console.log(`    → ${JSON.stringify(lib())}   ${lib().length > 1 ? "★两条" : ""}`)
}

console.log("")
console.log("=".repeat(80))
console.log("C. 归一化/包含关系 (为什么没合并)")
console.log("=".repeat(80))
const pairs = [
	["我的名字是小明", "是小明哦"],
	["我的名字是小明", "我的名字是小明哦"],
	["我叫小明", "我的名字是小明哦"],
	["小明", "我的名字是小明哦"],
]
for (const [a, b] of pairs) {
	const na = core.normalizeContent(a), nb = core.normalizeContent(b)
	console.log(`  ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
	console.log(`    norm=[${na}] [${nb}]  a⊂b=${na.includes(nb)}  b⊂a=${nb.includes(na)}  isSame=${core.isSameContent(a, b)}  dice=${core.contentSimilarity(a, b).toFixed(3)}`)
}

console.log("")
console.log("=".repeat(80))
console.log("D. 走 AI 通道 (applyLlmMemoryDecision): 旧「我的名字是小明」+ 新事实「是小明哦」")
console.log("=".repeat(80))
{
	const mk = (id, content, over = {}) => ({id, content, type: "fact", importance: 0.8, confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365, ...over})
	for (const [oldC, newC] of [["我的名字是小明", "是小明哦"], ["我的名字是小明", "我的名字是小明哦"], ["我叫小明", "我的名字是小明哦"]]) {
		files.set("memory.json", JSON.stringify({memories: [mk("old_0", oldC)], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
		mem.reloadMemory()
		let calls = 0
		const res = await mem.applyLlmMemoryDecision([mk("new_0", newC)], async (p) => {
			calls += 1
			// 假 AI: 认为两者是同一件事 → NONE (不改动, 新事实不必再存)
			return p.includes("记忆库管理员") ? JSON.stringify({memory: [{id: "old_0", event: "NONE"}]}) : JSON.stringify({facts: [{content: newC, type: "fact"}]})
		})
		await mem.flushMemoryPersist()
		console.log(`  旧「${oldC}」+ 新「${newC}」 → ${JSON.stringify(lib())} llm调用=${calls} ${JSON.stringify(res)}`)
	}
}
