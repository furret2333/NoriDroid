/* 临时脚本(非门禁): 逐行打印「摘要 + 记忆块」提示词的**完整原文**(对话历史按长度截断),
 * 方便用户逐句核对措辞。
 * 运行: cd web-src && node tmp-memcheck/_print-prompt-verbatim.mjs
 */
await import("./build-mem-bundles.mjs")
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {
	NoriChat: {
		readFile: (n) => files.get(n) ?? "",
		writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
	},
}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)

const now = Date.now()
const mk = (id, content, type, over = {}) => ({
	id, content, type, importance: 0.8, confidence: 0.9,
	createdAt: now, updatedAt: now, lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: null, ...over,
})
files.set("memory.json", JSON.stringify({
	memories: [
		mk("a", "我叫小桧", "fact", {importance: 0.9, tags: ["identity"]}),
		mk("b", "我最近在准备考研", "project"),
		mk("c", "我喜欢下雨天", "preference"),
		mk("d", "我前几天想养猫", "project", {invalidAt: now - 1000}),
	],
	summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], schemaVersion: 2, blocks: [],
}))
mem.reloadMemory()

const msgs = Array.from({length: 45}, (_, i) => ({role: i % 2 ? "assistant" : "user", content: `第${i}句对话`, ts: now - 90000 + i * 1000}))
let captured = ""
await mem.summarizeIfNeeded(msgs, async (prompt) => { captured = prompt; return "摘要正文。\n===MEM===\n{\"topic\":\"\",\"items\":[]}" })

const cut = captured.indexOf("---对话历史---")
const head = captured.slice(0, cut)
console.log(`===== 提示词原文 (前 ${head.length} 字符, 含换行) =====`)
head.split("\n").forEach((line, i) => console.log(`${String(i + 1).padStart(2, "0")}| ${line}`))
console.log(`---- 之后是 ---对话历史--- + ${captured.length - cut} 字符的对话正文 ----`)

/* 关掉「AI 提取与整理记忆」时走的那条提示词也打出来对照。
 * 注意: buildSummaryPrompt 从 core 导出 (memory/index.ts 没有 re-export), 所以用 core-bundle。 */
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)
console.log("\n===== 对照: 关掉 AI 整理时的提示词 (只出摘要 + 记忆要点) =====")
console.log(core.buildSummaryPrompt([{role: "user", content: "第0句对话"}], false))
