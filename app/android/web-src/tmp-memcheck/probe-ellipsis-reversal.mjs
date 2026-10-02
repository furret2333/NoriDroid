/**
 * 探针: 「我想去买冰激凌」→「天气凉了 突然不想买了」为什么没消解? (2026-09-27 实机反馈)
 *
 * 这一段要把五个环节逐个摊开, 分清是"没提取到"还是"提取到了但没判出改口":
 *   ① 规则通道对这两句各提取出什么;
 *   ② 第二句会不会被 shouldSkipLlmExtract 直接跳过 (跳过 = 连 AI 都不问);
 *   ③ 现有确定性判据对"省略宾语的反悔句"能不能判出来;
 *   ④ 假设模型把宾语补全成「我不想买冰激凌了」—— 链路能不能消解 (证明"提取侧补全"这条路可行);
 *   ⑤ 单看动词的模糊匹配 (买) 会不会把「我想去买冰激凌」对上 (本地零调用兜底的可行性)。
 *
 * 运行: cd web-src && node tmp-memcheck/probe-ellipsis-reversal.mjs
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {NoriChat: {readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }}}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

const A = "我想去买冰激凌"
const B = "天气凉了 突然不想买了"

console.log("=".repeat(78))
console.log("① 规则通道提取结果")
console.log("=".repeat(78))
for (const s of [A, B]) {
	const items = core.extractMemories(s)
	console.log(`  「${s}」 → ${items.length ? JSON.stringify(items.map(i => ({type: i.type, content: i.content, imp: i.importance}))) : "(规则没接住)"}`)
}

console.log("")
console.log("=".repeat(78))
console.log("② 第二句会被 shouldSkipLlmExtract 跳过吗 (跳过 = 连 AI 通道都不跑)")
console.log("=".repeat(78))
for (const s of [A, B, "天气凉了，突然不想买了"]) {
	console.log(`  「${s}」 → skip=${core.shouldSkipLlmExtract(s)}`)
}

console.log("")
console.log("=".repeat(78))
console.log("③ 现有确定性判据能不能判出这两句是改口")
console.log("=".repeat(78))
for (const [x, y] of [[A, B], [A, "我不想买了"], [A, "我不想买冰激凌了"], [A, "我不买了"]]) {
	console.log(`  「${x}」→「${y}」 : ${mem.__isReversalForTest(x, y) ? "✓ 判为改口" : "✗ 判不出来"}`)
}

console.log("")
console.log("=".repeat(78))
console.log("④ 假设模型把宾语补全 (提取侧改进) —— 链路能不能消解")
console.log("=".repeat(78))
const seed = () => [{
	id: "ice1", content: A, type: "project", importance: 0.6, confidence: 0.7,
	createdAt: Date.now() - 60000, updatedAt: Date.now() - 60000, lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 60,
}]
files.set("memory.json", JSON.stringify({memories: seed(), summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
mem.reloadMemory()
const r = await mem.applyLlmMemoryDecision([{
	id: "m", content: "我不想买冰激凌了", type: "preference", importance: 0.6, confidence: 0.8,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 90,
}], async () => JSON.stringify({memory: [{id: "new", text: "我不想买冰激凌了", event: "ADD"}]}))
console.log(`  invalidated=${r.invalidated}  生效=${JSON.stringify(mem.listAll().memories.map(m => m.content))}  已作废=${JSON.stringify(mem.listInvalidMemories().map(m => m.content))}`)

console.log("")
console.log("=".repeat(78))
console.log("⑤ 本地零调用兜底可行性: 只共享动词(买) 能不能对上")
console.log("=".repeat(78))
const verbs = ["买", "去", "吃", "学", "养", "修", "做", "看", "玩", "用"]
const hasVerb = (s) => verbs.filter(v => s.includes(v))
console.log(`  「${A}」含动词: ${JSON.stringify(hasVerb(A))}`)
console.log(`  「${B}」含动词: ${JSON.stringify(hasVerb(B))}`)
console.log(`  共享动词: ${JSON.stringify(hasVerb(A).filter(v => hasVerb(B).includes(v)))}`)
console.log("  ⚠ 反悔词表命中: " + ["不想", "不打算", "算了", "放弃", "取消", "不买", "不去", "不弄", "反悔", "作罢"].filter(w => B.includes(w)).join(", "))
