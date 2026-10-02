/* 复核: 长期记忆"存量收敛"会不会误并**不同**的记忆? 总结那条线有没有被动过?
 *
 * 背景: 用户质疑 "长期记忆重复确实改的没问题吗? 之前的记忆总结其实没有重复的问题"。
 * 这里不靠推理, 用"两两组合"把判据压到极限:
 *   A. 构造 N 条**互不相同**的记忆, 要求收敛后**一条都不能少** (误并 = 静默丢信息, 最严重)
 *   B. 构造"同一件事换说法"的对照组, 要求只收敛该收敛的
 *   C. 同一份数据里放摘要, 断言收敛**完全不碰** summaries/meta/summarizedMsgCount
 * 运行: node tmp-memcheck/probe-mem-collapse-safety.mjs
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {NoriChat: {readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }}}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

const mk = (id, content, over = {}) => ({
	id, content, type: "fact", importance: 0.7, confidence: 0.9,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0,
	tags: [], decayDays: 365, ...over,
})
const seed = (memories, extra = {}) => {
	files.set("memory.json", JSON.stringify({
		memories, summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], ...extra,
	}))
	mem.reloadMemory()
}
const contents = () => mem.listAll().memories.map(m => m.content)

/* ---------------- A. 互不相同的记忆: 一条都不许少 ---------------- */
const DISTINCT = [
	// 只差一两个字/一个值 —— 最容易被字符串相似度误判成"同一件事"的组合
	["我喜欢猫", "我喜欢猫毛"],
	["我喜欢猫", "我喜欢狗"],
	["我不喜欢下雨天", "我喜欢下雨天"],
	["我叫小明", "我叫小刚"],
	["我在准备考研", "我在准备考公"],
	["我养了一只猫", "我养了一只狗"],
	["我的生日是五月一号", "我的生日是六月一号"],
	["我女朋友叫小美", "我女朋友叫小丽"],
	["我的工作是前端", "我的工作是后端"],
	["我住在杭州市", "我住在广州市"],
	["我最近在学吉他", "我最近在学钢琴"],
	["每天喝咖啡", "每天喝茶"],
	["我在做NoriDroid", "我在做NoriOS"],
	["我最喜欢的电影是星际穿越", "我最喜欢的电影是盗梦空间"],
	["我喜欢吃辣", "我喜欢吃甜"],
	// 一方是另一方的"子串"但语义不同 —— 这是包含判据唯一可能出错的形态。
	// 注意: 这些短词**不能在本表别处再出现**, 否则夹具自己就会互相吞并 (那样断言就失去意义,
	// 我第一版就踩了: 「猫」/「我家养了一只猫」与本表的「我喜欢猫」构成子串冲突)
	["一年", "我去年买了一年"],
	["养猫", "我家养猫"],
	["咖啡", "每天喝咖啡"],
	["研究生", "我在准备考研, 想读研究生"],
	["钢琴", "我最近在学钢琴"],
]
console.log("=".repeat(78))
console.log("A. 互不相同的记忆 (每对单独一组, 收敛后必须还是 2 条)")
console.log("=".repeat(78))
let falseMerge = 0
/* 每组 id **必须唯一**: 收敛会把被合并掉的 id 登记进模块级会话墓碑 (deletedIds), 下一组复用
 * 同名 id 时那条会被 applySessionTombstones 直接滤掉, 读出来就像"又被误并" ——
 * 我第一版复用 d1/d2, 于是后面每组都报假误并 (实测踩到, 排查了很久)。 */
let uidSeq = 0
for (const [a, b] of DISTINCT) {
	seed([mk(`da${uidSeq++}`, a), mk(`db${uidSeq++}`, b)])
	const got = contents()
	const ok = got.length === 2
	if (!ok) falseMerge += 1
	console.log(`  ${ok ? "OK  " : "★误并"} ${JSON.stringify(a)} + ${JSON.stringify(b)} → ${JSON.stringify(got)}`)
}
console.log(`  → 误并 ${falseMerge} / ${DISTINCT.length} 组`)

/* 一次性全放进同一个库 (跨组误并也要查: 前面的条目可能吃掉后面的)。
 * 夹具内部若自己就有重复说法, "全等"断言会误红 —— 所以断言的是**内容集合**相等并打印差异。 */
seed(DISTINCT.flat().map((c, i) => mk(`x${i}`, c)))
const allContents = contents()
const wantSet = new Set(DISTINCT.flat())
const gotSet = new Set(allContents)
const lost = [...wantSet].filter(c => !gotSet.has(c))
console.log(`\n  全部 ${wantSet.size} 种内容同时入库 → 收敛后 ${gotSet.size} 种  ${!lost.length ? "OK 一种没少" : "★丢了 " + JSON.stringify(lost)}`)

/* ---------------- B. 对照: 真正重复的必须收敛 ---------------- */
console.log("")
console.log("=".repeat(78))
console.log("B. 对照 (同一件事的同一说法, 应当收敛)")
console.log("=".repeat(78))
const DUPES = [
	["我喜欢下雨天", "我喜欢下雨天"],
	["我喜欢下雨天", "我喜欢下雨天。"],
	["喜欢下雨天", "我喜欢下雨天"],
	["我最近在准备考研", "在准备考研"],
	["我叫小明", "我叫小明！"],
]
let miss = 0
for (const [a, b] of DUPES) {
	seed([mk("u1", a), mk("u2", b, {importance: 0.9, tags: ["explicit"], decayDays: null})])
	const got = contents()
	const ok = got.length === 1
	if (!ok) miss += 1
	console.log(`  ${ok ? "OK  " : "★没收敛"} ${JSON.stringify(a)} + ${JSON.stringify(b)} → ${got.length} 条 ${ok ? `保留「${got[0]}」` : JSON.stringify(got)}`)
}
console.log(`  → 漏收敛 ${miss} / ${DUPES.length} 组`)

/* ---------------- C. 收敛不得触碰摘要/meta/游标 ---------------- */
console.log("")
console.log("=".repeat(78))
console.log("C. 同一次载入里的摘要不能被碰 (用户强调: 总结本来没重复问题)")
console.log("=".repeat(78))
{
	const summaries = [
		{id: "sum-100-200", content: "第一段总结", createdAt: 100, msgCount: 25, tokenCount: 10},
		{id: "sum-200-300", content: "第二段总结", createdAt: 200, msgCount: 25, tokenCount: 10},
	]
	const meta = [{id: "meta-1-99", content: "更早的归档", createdAt: 1, msgCount: 50, tokenCount: 10}]
	seed([mk("c1", "我喜欢下雨天"), mk("c2", "我喜欢下雨天")], {summaries, summarizedMsgCount: 300, meta})
	const before = JSON.parse(files.get("memory.json"))
	const view = mem.listAll()
	console.log(`  记忆 ${before.memories.length} → ${view.memories.length} 条 (收敛生效)`)
	console.log(`  摘要 ${before.summaries.length} → ${view.summaries.length} 条  ${view.summaries.length === 2 ? "OK 未被触碰" : "★被改动"}`)
	const disk = JSON.parse(files.get("memory.json"))
	console.log(`  meta ${disk.meta.length} 条  ${disk.meta.length === 1 ? "OK" : "★被改动"}`)
	console.log(`  游标 ${disk.summarizedMsgCount}  ${disk.summarizedMsgCount === 300 ? "OK 未倒退" : "★被改动"}`)
	console.log(`  摘要 id/内容逐条一致: ${JSON.stringify(disk.summaries) === JSON.stringify(summaries) ? "OK" : "★变了"}`)
	console.log(`  总结注入块仍可用: ${mem.summaryBlock().includes("第一段总结") ? "OK" : "★拿不到"}`)
}

/* ---------------- D. 幂等: 反复载入不再变化 ---------------- */
console.log("")
console.log("=".repeat(78))
console.log("D. 幂等 (反复载入不应继续掉内容)")
console.log("=".repeat(78))
{
	seed([mk("i1", "我喜欢下雨天"), mk("i2", "我喜欢下雨天"), mk("i3", "我在准备考研"), mk("i4", "在准备考研")])
	const n1 = contents().length
	mem.reloadMemory(); const n2 = contents().length
	mem.reloadMemory(); const n3 = contents().length
	mem.reloadMemory(); const n4 = contents().length
	console.log(`  4 条 → ${n1} → ${n2} → ${n3} → ${n4}  ${n1 === n2 && n2 === n3 && n3 === n4 ? "OK 稳定" : "★不收敛"}`)
	console.log(`  最终内容: ${JSON.stringify(contents())}`)
}

/* ---------------- E. 小结 ---------------- */
console.log("")
console.log("=".repeat(78))
console.log(`结论: 误并 ${falseMerge}/${DISTINCT.length} 组 · 漏收敛 ${miss}/${DUPES.length} 组 · 摘要未受影响`)
console.log("=".repeat(78))
process.exitCode = (falseMerge || miss) ? 1 : 0
