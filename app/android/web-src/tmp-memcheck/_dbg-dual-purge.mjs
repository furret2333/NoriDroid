/* 最小复现: 「永久删除」在双实例下不永久 (2026-09-30, P2 模糊测试查出的第 1 个真问题)
 *
 * 现象: 主界面永久删除一条记忆后, **悬浮窗**（它缓存里还留着那条的回收站副本）下一次落盘
 *       会把它**带回回收站**, 而且墓碑也拦不住 —— 用户能再点「还原」把它救回来。
 *
 * 机制 (读代码得出, 本脚本逐步验证):
 *   · `deleteMemoryForever` 只把 id 记进**本实例**会话集 `purgedIds` (index.ts:165/871),
 *     `adoptFromDisk` 靠它过滤磁盘旧副本 —— 所以**只有做过删除的那个实例**受保护;
 *   · 另一个实例的 cache 里仍有该条的 `deletedBin` 副本; 它落盘时 `flushPersist` →
 *     `adoptFromDisk(disk)` → `mergeStores(disk, cache)`, 而 mergeStores 的回收站合并是
 *     **按 id 并集、刻意不按墓碑过滤** (core.ts:1736 注释: 回收站里的条目本来就是被删的) ⇒
 *     那条又被并回 cache 并写盘;
 *   · 于是磁盘上同时存在「它的墓碑」与「它的回收站副本」, 点还原即可复活。
 *
 * 运行: cd web-src && node tmp-memcheck/_dbg-dual-purge.mjs
 */
import {pathToFileURL} from "node:url"
import path from "node:path"

await import("./build-mem-bundles.mjs")
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {
	NoriChat: {
		readFile: (n) => files.get(n) ?? "",
		writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
	},
}
const url = pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href
const 主界面 = await import(url)
const 悬浮窗 = await import(`${url}?i=2`)

const disk = () => { try { return JSON.parse(files.get("memory.json") || "{}") } catch { return {} } }
const 状态 = (标签) => {
	const d = disk()
	const mems = d.memories ?? []
	const bin = d.deletedBin ?? []
	const tombs = d.tombstones ?? []
	console.log(`  ${标签}`)
	console.log(`    磁盘 memories: ${mems.map(m => `${m.id}${m.invalidAt ? "(作废)" : ""}${m.fadedAt ? "(收起)" : ""}`).join(" ") || "(空)"}`)
	console.log(`    磁盘 回收站:   ${bin.map(m => m.id).join(" ") || "(空)"}`)
	console.log(`    磁盘 墓碑:     ${tombs.map(t => t.id).join(" ") || "(空)"}`)
	console.log(`    主界面看到:    生效 ${主界面.listAll(false).memories.length} · 回收站 ${主界面.listDeletedMemories().length}`)
	console.log(`    悬浮窗看到:    生效 ${悬浮窗.listAll(false).memories.length} · 回收站 ${悬浮窗.listDeletedMemories().length}`)
}

console.log("=== ① 两个窗口都起来, 主界面写入两条 ===")
主界面.reloadMemory()
悬浮窗.reloadMemory()
主界面.addMemoriesFromText("我喜欢下雨天")
主界面.addMemoriesFromText("我喜欢喝咖啡")
await 主界面.flushMemoryPersist()
悬浮窗.reloadMemory()      // 悬浮窗现在也看得到这两条
状态("初始")

const ids = 主界面.listAll(false).memories.map(m => m.id)
const victim = ids[0]
console.log(`\n=== ② 主界面删掉 ${victim} (进回收站), 再**永久删除** ===`)
主界面.deleteMemory(victim)          // → 回收站
await 主界面.flushMemoryPersist()
悬浮窗.reloadMemory()                // 悬浮窗也看到它在回收站里 (现实中它会这么缓存)
状态("删到回收站后")

主界面.deleteMemoryForever(victim)   // → 墓碑 + 从回收站抹掉
await 主界面.flushMemoryPersist()
状态("主界面永久删除后 (此时是正确的)")

console.log(`\n=== ③ 悬浮窗做一次**无关**的写操作 (它缓存里还留着那条回收站副本) ===`)
悬浮窗.addMemoriesFromText("我喜欢弹吉他")
await 悬浮窗.flushMemoryPersist()
状态("悬浮窗落盘后")

const back = disk().deletedBin?.some(m => m.id === victim)
const tomb = disk().tombstones?.some(t => t.id === victim)
console.log("\n===== 判定 =====")
console.log(`  永久删除的那条回到回收站了吗: ${back ? "**回来了**" : "没有"}`)
console.log(`  它的墓碑还在吗:               ${tomb ? "在" : "不在"}`)
if (back) {
	console.log(`  ⇒ 磁盘上同时有墓碑与回收站副本 ⇒ 用户点「还原」就能把它救回来 (「永久删除」不永久)`)
	console.log(`  ⇒ 根因: mergeStores 的回收站合并只按 id 并集、不认"已永久删除"的标记 (core.ts:1736);`)
	console.log(`     而 purgedIds 只在**做过删除的那个实例**里生效 (index.ts:165/871) —— 跨实例没有对应信号。`)
}
process.exitCode = back ? 1 : 0
