/* 宏观排查: 用一个**足够大的语料**同时量"误并"与"漏收", 一次看清判据的边界。
 * 背景: 之前每改一版只验几个例子, 反复"修一处冒一处" —— 换成大样本先定边界。
 *
 * 语料两类:
 *   SAME  = 同一件事的不同说法 (期望: 收敛掉)
 *   DIFF  = 两件不同的事, 含"只差一字/互为子串/方向相反"等最危险的形态 (期望: 一条不少)
 * 除判据本身, 还跑一遍**全量同库** (所有 DIFF 一起入库), 抓"跨组误并"。
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
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365, ...over,
})
const seed = (memories) => {
	files.set("memory.json", JSON.stringify({memories, summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
	mem.reloadMemory()
}
let uidSeq = 0
/** 每组独立: 唯一 id (避免撞会话墓碑), 返回收敛后条数 */
const collapseCount = (a, b) => {
	seed([mk(`a${uidSeq++}`, a), mk(`b${uidSeq++}`, b)])
	return mem.listAll().memories.length
}

/* ---------------- SAME: 同一件事的不同说法 ---------------- */
const SAME = [
	// 完全相同 / 只差标点
	["我喜欢下雨天", "我喜欢下雨天"],
	["我喜欢下雨天", "我喜欢下雨天。"],
	["我的名字是小明", "我的名字是小明！"],
	// 只差句尾语气词
	["小明哦", "小明"],
	["我的名字是小明哦", "我的名字是小明"],
	["每天喝咖啡哦", "每天喝咖啡"],
	["我在准备考研呀", "我在准备考研"],
	["我喜欢下雨天啦", "我喜欢下雨天"],
	// 少主语前缀
	["小明", "我的名字是小明"],
	["小明", "我叫小明"],
	["小明", "我是小明"],
	["小明", "我的名字叫小明"],
	["在准备考研", "我在准备考研"],
	["喜欢下雨天", "我喜欢下雨天"],
	["养了一只猫", "我家养了一只猫"],
	// 少主语 + 尾语气词
	["是小明哦", "我的名字是小明"],
	["小明哦", "我的名字是小明"],
	["在准备考研呀", "我在准备考研"],
	["喜欢下雨天哦", "我喜欢下雨天"],
]
/* ---------------- DIFF: **不能**合并 (含最危险形态) ---------------- */
const DIFF = [
	// 只差一字/一词, 语义不同
	["我喜欢猫", "我喜欢猫毛"],
	["我喜欢猫", "我喜欢狗"],
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
	["在北京上班", "我在北京上班吗"],
	["我喜欢猫", "我不喜欢猫"],
	["我喜欢狗", "我讨厌狗"],
	// 方向相反
	["我喜欢下雨天", "我不喜欢下雨天"],
	["我喜欢下雨天", "我讨厌下雨天"],
	["我爱吃辣", "我不爱吃辣"],
	// 一方是另一方的子串, 但语义是"提到"而非"同一件事"
	["咖啡", "每天喝咖啡"],
	["咖啡", "我喜欢喝咖啡"],
	["猫", "我家养了一只猫"],
	["猫粮", "我喜欢买猫粮"],
	["研究生", "我在准备考研, 想读研究生"],
	["一年", "我去年买了一年"],
	["养猫", "我家养猫"],
	["钢琴", "我最近在学钢琴"],
	["跑步", "我每天早上跑步"],
	["日语", "我在学日语"],
	// 主语不同却是同一动词短语形态
	["我妈喜欢猫", "我喜欢猫"],
	["我哥在北京", "我在北京"],
	// 数字/单位只差一字
	["我每天睡7小时", "我每天睡8小时"],
	["我身高175", "我身高176"],
	["我今年25岁", "我今年26岁"],
]

console.log("=".repeat(78))
console.log(`SAME 组 (${SAME.length} 对): 期望收敛成 1 条`)
console.log("=".repeat(78))
let missCollapse = 0
for (const [a, b] of SAME) {
	const n = collapseCount(a, b)
	if (n !== 1) { missCollapse += 1; console.log(`  ★漏收 ${JSON.stringify(a)} + ${JSON.stringify(b)} → ${n} 条`) }
}
console.log(`  漏收 ${missCollapse} / ${SAME.length}`)

console.log("")
console.log("=".repeat(78))
console.log(`DIFF 组 (${DIFF.length} 对): 期望保留 2 条`)
console.log("=".repeat(78))
let falseMerge = 0
for (const [a, b] of DIFF) {
	const n = collapseCount(a, b)
	if (n !== 2) { falseMerge += 1; console.log(`  ★误并 ${JSON.stringify(a)} + ${JSON.stringify(b)} → ${n} 条`) }
}
console.log(`  误并 ${falseMerge} / ${DIFF.length}`)

/* ---------------- 全量同库: 跨组误并 ---------------- */
console.log("")
console.log("=".repeat(78))
console.log("全量同库 (所有 DIFF 一起入库): 内容一种都不能少")
console.log("=".repeat(78))
{
	const all = DIFF.flat()
	seed(all.map((c, i) => mk(`x${i}`, c)))
	const got = new Set(mem.listAll().memories.map(m => m.content))
	const lost = [...new Set(all)].filter(c => !got.has(c))
	console.log(`  输入 ${new Set(all).size} 种 → 收敛后 ${got.size} 种   ${lost.length ? "★丢失 " + JSON.stringify(lost) : "OK 一种没少"}`)
}

/* ---------------- 判据分档统计 (看清边界在哪) ---------------- */
console.log("")
console.log("=".repeat(78))
console.log("判据分档 (只读统计, 不依赖收敛)")
console.log("=".repeat(78))
const bucket = (s) => {
	const x = core.normalizeForCompare(s)
	return x
}
console.log(`  normalizeForCompare 示例: 「小明哦」→「${bucket("小明哦")}」 · 「是我的」→「${bucket("是我的")}」`)
console.log(`  isSameContent(「小明」,「我的名字是小明」) = ${core.isSameContent("小明", "我的名字是小明")}`)
console.log(`  isSameContent(「咖啡」,「每天喝咖啡」)     = ${core.isSameContent("咖啡", "每天喝咖啡")}`)
console.log("")
console.log(`结论: 漏收 ${missCollapse}/${SAME.length} · 误并 ${falseMerge}/${DIFF.length}`)
process.exitCode = (falseMerge || missCollapse) ? 1 : 0
