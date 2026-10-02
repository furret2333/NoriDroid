/* 临时脚本(非门禁): 打印"摘要+记忆块"提示词里**真实**长什么样, 特别是"已经记住的内容"那一段。
 * 运行: cd web-src && node tmp-memcheck/_show-summary-prompt.mjs
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
		mk("b", "我最近在准备考研", "project", {tags: ["llm"]}),
		mk("c", "我喜欢下雨天", "preference", {tags: ["llm"]}),
		mk("d", "我前几天想养猫", "project", {invalidAt: now - 1000}),   // 已作废: 不该出现在清单里
	],
	summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], schemaVersion: 2, blocks: [],
}))
mem.reloadMemory()

/* 需要 45 条才会触发自动整理 (待整理 25): 25 条时 pending 只有 5, 回调根本不会被调用 */
const msgs = Array.from({length: 45}, (_, i) => ({role: i % 2 ? "assistant" : "user", content: `第${i}句对话内容`, ts: now - 60000 + i * 1000}))
let captured = ""
await mem.summarizeIfNeeded(msgs, async (prompt) => { captured = prompt; return "摘要正文。\n===MEM===\n{\"topic\":\"\",\"items\":[]}" })

/* 只打印"已记住"那一段前后的内容, 太长的地方截断 */
const at = captured.indexOf("【已经记住的内容")
const tailStart = captured.indexOf("---对话历史---")
console.log("========== 提示词结构 (总长 " + captured.length + " 字符) ==========")
console.log(captured.slice(0, 120) + " ……（摘要+记忆块规则，略）")
if (at >= 0) {
	console.log("\n---------- 已经记住的内容（真实原文）----------")
	console.log(captured.slice(at, tailStart))
} else {
	console.log("\n(没有『已经记住的内容』段落 —— 说明没喂进去)")
}
console.log("---------- 之后接对话历史 ----------")
console.log(captured.slice(tailStart, tailStart + 60) + " ……")
console.log("\n清单段落字符数:", at >= 0 ? tailStart - at : 0)
