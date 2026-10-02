/**
 * 探针: 复现 T29-B 的失败 (「还原后被静默回滚」) —— 打印每一步的内存/磁盘状态。
 * 运行: cd web-src && node tmp-memcheck/probe-restore-rollback.mjs
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {NoriChat: {readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }}}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const mkMem = (id, content, over = {}) => ({
	id, content, type: "preference", importance: 0.7, confidence: 0.9,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 90, ...over,
})
const seedDisk = (items) => files.set("memory.json", JSON.stringify({memories: items, summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
const dump = (tag) => {
	const mems = JSON.parse(files.get("memory.json") || "{}").memories ?? []
	const fmt = (list) => list.map(m => `${m.id}${m.invalidAt ? "(作废)" : ""}@${m.updatedAt}`).join(" ")
	console.log(`  ${tag}\n    内存: ${fmt(mem.listAll(true).memories)}\n    磁盘: ${fmt(mems)}`)
}

seedDisk([
	mkMem("nm1", "我叫小明", {type: "fact", importance: 0.9, tags: ["identity"], decayDays: null}),
	mkMem("keep29", "我喜欢下雨天", {importance: 0.6}),
	mkMem("trash", "一条马上被删掉的记忆", {}),
])
mem.reloadMemory()
/* ⚠ 关键前置: 先删一条, 让**会话墓碑非空**。
 * 墓碑非空 ⇒ `applySessionTombstones` 每次载入返回新对象 ⇒ `lastWrittenRaw = null`
 * ⇒ 之后每次落盘都会走 `adoptFromDisk` (磁盘合并)。**没有这一步就复现不出来**
 * (第一版探针漏了它, 于是"还原被回滚"这个 bug 在探针里看不见, 反而在 run-tests 里炸出来)。 */
console.log("  deleteMemory(trash) =", mem.deleteMemory("trash"))
dump("删一条后(墓碑已非空)")
console.log("  invalidateMemory(nm1) =", mem.invalidateMemory("nm1"))
dump("作废后")
await mem.flushMemoryPersist()
dump("flush 后")

/* T29-A: 决策 DELETE 已经做过; 这里直接进入 T29-B */
mem.reloadMemory()
dump("重载(应为作废)")
console.log("  restoreMemory(nm1) =", mem.restoreMemory("nm1"))
dump("还原后(未落盘)")
await mem.flushMemoryPersist()
dump("还原 flush 后")
mem.reloadMemory()
dump("再次重载")
