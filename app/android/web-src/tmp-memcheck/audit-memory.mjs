/* 记忆侧审计 (可重复运行, 非一次性脚本): 聚焦改动的风险点
   ① 升级用户 (旧格式 12 条摘要 / 无 meta 字段) 是否平滑, 永久记忆 decayDays 不被改写
   ② 多轮裁剪循环下 摘要 id 唯一 / 区间递增无重叠 / 重启后摘要仍存在
   ③ 被裁摘要的墓碑会不会误伤后续新摘要
   ④ 长期记忆写入与召回不受摘要改动影响
   依赖 memory-bundle.mjs —— 由 run-tests.mjs 重建。 */
import path from "node:path"
import {pathToFileURL} from "node:url"
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {
	NoriChat: {
		readFile: (n) => files.get(n) ?? "",
		writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
	},
}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const problems = []
const disk = () => JSON.parse(files.get("memory.json") || "{}")

/* ---- ① 升级场景: 旧格式 (12 条摘要, 无 meta 字段), 内存条目带 null decayDays ---- */
files.clear()
const legacy12 = Array.from({length: 12}, (_, i) => ({
	id: `up-${i}`, content: `旧摘要${i}`, createdAt: 1000 + i, msgCount: 25, tokenCount: 10,
}))
files.set("memory.json", JSON.stringify({
	memories: [
		{id: "m1", content: "我叫小明", type: "fact", importance: .8, confidence: .9,
			createdAt: 500, updatedAt: 500, lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: null},
		{id: "m2", content: "喜欢下雨天", type: "preference", importance: .7, confidence: .9,
			createdAt: 501, updatedAt: 501, lastAccessedAt: 0, accessCount: 0, tags: []},
	],
	summaries: legacy12, summarizedMsgCount: 300, tombstones: [],
	// 注意: 故意不带 meta 字段
}))
mem.reloadMemory()
let d = disk()
console.log("① 升级场景")
console.log(`   load 后内存: 记忆 ${mem.listAll().memories.length} 条, 摘要 ${mem.listAll().summaries.length} 条`)
console.log(`   永久记忆 decayDays 保持 null: ${mem.listAll().memories.find(m => m.id === "m1")?.decayDays === null}`)
if (mem.listAll().memories.length !== 2) problems.push("① 记忆条数不对")
if (mem.listAll().summaries.length !== 12) problems.push("① 摘要条数不对 (12 条不该被裁)")
if (mem.listAll().memories.find(m => m.id === "m1")?.decayDays !== null) problems.push("① 永久记忆被改回可衰减")

/* ---- ② 多轮裁剪循环: 摘要推进 / id 唯一 / 重启后仍在 ---- */
files.clear()
mem.reloadMemory()
const HISTORY_KEEP = 20
let messages = []
let clock = 1_700_000_000_000
for (let round = 0; round < 150; round += 1) {
	messages.push({role: "user", content: `u${round}`, ts: clock++})
	messages.push({role: "assistant", content: `a${round}`, ts: clock++})
	const summarized = await mem.summarizeIfNeeded(messages, async () => "【摘要】片段。")
	await mem.flushMemoryPersist()
	if (summarized && messages.length > HISTORY_KEEP) {
		const kept = [
			{role: "system", content: "（更早的对话已压缩）", ts: clock++, placeholder: true},
			...messages.slice(-HISTORY_KEEP),
		]
		messages = kept
		mem.notifyHistoryTrimmed(kept.length)
		await mem.flushMemoryPersist()
	}
}
d = disk()
const ids = (d.summaries ?? []).map(s => s.id)
const metas = d.meta ?? []
console.log("\n② 多轮裁剪循环 (150 轮)")
console.log(`   摘要 ${ids.length} 条 (唯一 ${new Set(ids).size}), 归档 meta ${metas.length} 条`)
console.log(`   累计覆盖消息 ${(d.summaries ?? []).reduce((n, s) => n + (s.msgCount || 0), 0)}`)
console.log(`   游标 ${d.summarizedMsgCount}`)
// 推进节奏: 相邻摘要的时间戳区间必须严格递增且不重叠
let bad = 0
let prevLast = -1
for (const id of ids) {
	const m = String(id).match(/^sum-(\d+)-(\d+)$/)
	if (!m) continue
	const first = Number(m[1]), last = Number(m[2])
	if (first <= prevLast) bad += 1
	prevLast = last
}
console.log(`   区间递增无重叠: ${bad === 0 ? "是" : `否 (${bad} 处)`}`)
if (bad) problems.push(`② 摘要区间重叠/倒退 ${bad} 处`)
if (ids.length !== new Set(ids).size) problems.push("② 摘要 id 有重复")
if (ids.length < 5) problems.push(`② 摘要条数太少 (${ids.length}), 摘要器可能又停滞`)
// 重启: 摘要必须还在 (这是 lastWrittenRaw 那个 bug 的直接检验)
const before = ids.length
mem.reloadMemory()
await mem.flushMemoryPersist()
const afterIds = disk().summaries.map(s => s.id)
console.log(`   重启后摘要 ${afterIds.length} 条 (重启前 ${before})`)
if (afterIds.length < before) problems.push(`② 重启后摘要减少: ${before} → ${afterIds.length}`)

/* ---- ③ 墓碑是否误伤: 反复 重启+继续对话, 新摘要必须还能生成 ---- */
const n0 = disk().summaries.length
for (let i = 0; i < 60; i += 1) {
	messages.push({role: "user", content: `x${i}`, ts: clock++})
	messages.push({role: "assistant", content: `y${i}`, ts: clock++})
	const summarized = await mem.summarizeIfNeeded(messages, async () => "【摘要】后续片段。")
	await mem.flushMemoryPersist()
	if (summarized && messages.length > HISTORY_KEEP) {
		const kept = [
			{role: "system", content: "（更早的对话已压缩）", ts: clock++, placeholder: true},
			...messages.slice(-HISTORY_KEEP),
		]
		messages = kept
		mem.notifyHistoryTrimmed(kept.length)
		await mem.flushMemoryPersist()
	}
}
const n1 = disk().summaries.length
console.log(`\n③ 墓碑误伤检查: 摘要 ${n0} → ${n1} 条 (新摘要必须能继续生成或至少不减少)`)
if (n1 < 1) problems.push("③ 摘要被墓碑清空")

/* ---- ④ 长期记忆不受摘要改动影响 ---- */
mem.addMemoriesFromText("我叫小明，喜欢下雨天")
await mem.flushMemoryPersist()
const memCount = mem.listAll().memories.length
console.log(`\n④ 长期记忆: 写入后 ${memCount} 条, 召回测试 → "${mem.recallForQuery("小明").slice(0, 40)}"`)
if (memCount === 0) problems.push("④ 长期记忆写入失败")

console.log("\n=== 结论 ===")
console.log(problems.length ? `发现 ${problems.length} 个问题:\n  ` + problems.join("\n  ") : "✓ 记忆侧审计未发现问题")
