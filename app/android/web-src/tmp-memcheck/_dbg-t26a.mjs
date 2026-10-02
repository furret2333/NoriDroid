/* 临时排查脚本: 复现 T26-A 的 7 条种子, 看载入后每条变成了什么 (含 invalidAt/fadedAt) */
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
const mk = (id, content, over = {}) => ({
	id, content, type: "fact", importance: 0.8, confidence: 0.9,
	createdAt: now, updatedAt: now, lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 90, ...over,
})
/* 假设: 失败与"时间戳是否同毫秒"有关 —— 「我喜欢下雨天。」与「我不喜欢下雨天」是一对改口,
   载入时 collapseReversals 只在**判得出先后**时作废更早的那条; 同毫秒并列则不动。
   这里把 keep3 的 createdAt 显式 +2ms, 让它晚于 dup1/dup2 → 预期 dup 那条被作废。 */
const base = now
const mkT = (id, content, t, over = {}) => ({...mk(id, content, over), createdAt: t, updatedAt: t})
files.set("memory.json", JSON.stringify({
	memories: [
		mkT("dup1", "我喜欢下雨天", base, {importance: 0.6}),
		mkT("dup2", "我喜欢下雨天。", base, {importance: 0.9, tags: ["explicit"], decayDays: null}),
		mk("dup3", "我最近在准备考研", {type: "project"}),
		mk("dup4", "在准备考研", {type: "project"}),
		mk("keep1", "我家养了一只猫", {decayDays: 365}),
		mk("keep2", "我喜欢猫毛", {decayDays: 365}),
		mkT("keep3", "我不喜欢下雨天", base + 2, {}),
	],
	summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], schemaVersion: 2, blocks: [],
}))
mem.reloadMemory()
const show = (label, list) => {
	console.log(`\n===== ${label} (${list.length} 条) =====`)
	for (const m of list) {
		console.log(`  ${m.id.padEnd(6)} | ${m.content.padEnd(12)} | inv=${m.invalidAt ?? "-"} faded=${m.fadedAt ?? "-"}(${m.fadedReason ?? "-"}) decay=${m.decayDays} tags=${JSON.stringify(m.tags)}`)
	}
}
show("listAll 生效", mem.listAll().memories)
show("已作废", mem.listInvalidMemories())
show("已收起", mem.listFadedMemories())
const disk = JSON.parse(files.get("memory.json"))
show("磁盘 memories (全部)", disk.memories)
console.log("\n墓碑:", JSON.stringify(disk.tombstones ?? []))
