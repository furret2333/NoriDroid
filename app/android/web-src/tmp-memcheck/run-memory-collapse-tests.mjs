/* 长期记忆收敛判据的**语料门禁** (2026-09-26 起)。
 *
 * 为什么要有它: 这条判据跑在每次载入、自动、无预览, 误并 = 静默丢信息且没有撤销入口。
 * 之前靠"想到几个例子就试几个", 结果反复"修一处冒一处" —— 换成固定语料 + 全量同库检查:
 *   SAME 组: 同一件事的不同说法 → 必须收敛成 1 条 (漏收只是不够干净)
 *   DIFF 组: 两件不同的事 (含只差一字/互为子串/方向相反/主语不同) → **一条都不能少**
 * 判定标准: DIFF 组误并必须为 0 ---- 它是这条判据的红线。
 *
 * 运行: node tmp-memcheck/run-memory-collapse-tests.mjs
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {NoriChat: {readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }}}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)

const results = []
const check = (name, cond, detail = "") => {
	results.push({name, ok: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ← ${detail}`}`)
}
const mk = (id, content, over = {}) => ({
	id, content, type: "fact", importance: 0.7, confidence: 0.9,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365, ...over,
})
/** 每组独立载入; id 必须唯一 —— 复用 id 会撞上模块级会话墓碑 (deletedIds), 读出来像"又被误并" */
let uidSeq = 0
const collapse = (pairs) => {
	const items = []
	for (const c of pairs) items.push(mk(`u${uidSeq++}`, c))
	files.set("memory.json", JSON.stringify({memories: items, summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
	mem.reloadMemory()
	return mem.listAll().memories.map(m => m.content)
}

/* ============ SAME: 期望收敛成 1 条 (漏收扣分但不红线) ============ */
const SAME = [
	["我喜欢下雨天", "我喜欢下雨天"],
	["我喜欢下雨天", "我喜欢下雨天。"],
	["我的名字是小明", "我的名字是小明！"],
	["小明哦", "小明"],
	["我的名字是小明哦", "我的名字是小明"],
	["每天喝咖啡哦", "每天喝咖啡"],
	["我在准备考研呀", "我在准备考研"],
	["小明", "我的名字是小明"],
	["小明", "我叫小明"],
	["小明", "我是小明"],
	["是小明哦", "我的名字是小明"],
	["小明哦", "我的名字是小明"],
	["喜欢下雨天", "我喜欢下雨天"],
	["在准备考研", "我在准备考研"],
]
let miss = 0
for (const [a, b] of SAME) {
	const got = collapse([a, b])
	if (got.length !== 1) { miss += 1; check(`语料-同义:「${a}」+「${b}」收敛为 1 条`, false, JSON.stringify(got)) }
}
check(`语料-同义组: ${SAME.length - miss}/${SAME.length} 收敛`, miss === 0, `漏收 ${miss}`)

/* ============ DIFF: 红线, 一条都不能少 ============ */
const DIFF = [
	// 只差一字/一词
	["我喜欢猫", "我喜欢猫毛"],
	["我喜欢猫", "我喜欢狗"],
	["我叫小明", "我叫小刚"],
	["我在准备考研", "我在准备考公"],
	["我的生日是五月一号", "我的生日是六月一号"],
	["我女朋友叫小美", "我女朋友叫小丽"],
	["我的工作是前端", "我的工作是后端"],
	["我住在杭州市", "我住在广州市"],
	["我最近在学吉他", "我最近在学钢琴"],
	["每天喝咖啡", "每天喝茶"],
	["我在做NoriDroid", "我在做NoriOS"],
	["我最喜欢的电影是星际穿越", "我最喜欢的电影是盗梦空间"],
	["我喜欢吃辣", "我喜欢吃甜"],
	["我每天睡7小时", "我每天睡8小时"],
	["我身高175", "我身高176"],
	// 方向相反
	["我喜欢下雨天", "我不喜欢下雨天"],
	["我喜欢狗", "我讨厌狗"],
	["我爱吃辣", "我不爱吃辣"],
	["在北京上班", "我在北京上班吗"],
	// 一方是另一方的子串, 但语义是"提到"而非"同一件事"
	["咖啡", "每天喝咖啡"],
	["咖啡", "我喜欢喝咖啡"],
	["猫", "我家养了一只猫"],
	["猫粮", "我喜欢买猫粮"],
	["研究生", "我在准备考研, 想读研究生"],
	["一年", "我去年买了一年"],
	["钢琴", "我最近在学钢琴"],
	["跑步", "我每天早上跑步"],
	["日语", "我在学日语"],
	// 主语不同
	["我妈喜欢猫", "我喜欢猫"],
	["我哥在北京", "我在北京"],
]
let falseMerge = 0
for (const [a, b] of DIFF) {
	const got = collapse([a, b])
	if (got.length !== 2) { falseMerge += 1; check(`语料-异义(红线):「${a}」+「${b}」保留 2 条`, false, JSON.stringify(got)) }
}
check(`语料-异义组: ${DIFF.length - falseMerge}/${DIFF.length} 一条没少 (红线: 误并必须为 0)`,
	falseMerge === 0, `误并 ${falseMerge}`)

/* ============ 全量同库: 抓跨组误并 ============ */
{
	const all = DIFF.flat()
	const got = collapse(all)
	const lost = [...new Set(all)].filter(c => !got.includes(c))
	check("语料-全量同库: 所有异义记忆一起入库后一种都没少", lost.length === 0, `丢失 ${JSON.stringify(lost)}`)
}

/* ============ 用户实测的原始形态 (这条必须永远绿) ============ */
{
	const got = collapse(["我的名字是小明", "是小明哦"])
	check("用户实测形态:「我的名字是小明」+「是小明哦」收敛为 1 条", got.length === 1, JSON.stringify(got))
	const got2 = collapse(["小明哦", "我的名字是小明"])
	check("用户实测形态:「小明哦」+「我的名字是小明」收敛为 1 条", got2.length === 1, JSON.stringify(got2))
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
	process.exitCode = 1
	console.log("FAILED:", failed.map(f => f.name).join(" | "))
}
