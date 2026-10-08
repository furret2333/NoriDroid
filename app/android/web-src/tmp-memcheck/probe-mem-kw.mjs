/**
 * A1 探针 (2026-10-08): 关键词/别名 (`kw`) 的**收益与风险** —— 用数字决定它能不能留。
 *
 * ## 它回答什么
 * 检索底层是 `tokenize` + bigram 重叠，**没有向量** ⇒ "换个说法"命中不了。
 * 记忆块本来就是同一次 LLM 调用产出的 JSON，多要 3~5 个近义词等于白捡一层近似语义索引。
 * 但格式变复杂会抬高解析失败率，而记忆块的**唯一主通道**就是那次 JSON ——
 * 失败丢的是**那一整批条目**（摘要还在）。所以落地前先把三件事量出来：
 *
 * ① **解析容错 / malformed 率**：带 kw / 不带 kw / kw 是脏结构 / JSON 坏掉，条目回收率会不会下降；
 * ② **同义命中率**：正文零重叠、只有别称能命中的语料，加 kw 前 vs 后各命中几条（A/B 对照）；
 * ③ **三条红线**：kw 不许进 `tags`（免死金牌）· 不许参与 0.35 主门槛（只能空命中时兜底）·
 *    泛词必须被清洗掉。
 *
 * 运行: cd web-src && node tmp-memcheck/probe-mem-kw.mjs
 * 会先 `build-mem-bundles.mjs` 重建 bundle ⇒ 测的是**当前源码**。
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {NoriChat: {
	readFile: (n) => files.get(n) ?? "",
	writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
}}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

const results = []
const check = (name, cond, detail = "") => {
	results.push({name, ok: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `  ← ${detail}`}`)
}
const mk = (id, content, over = {}) => ({
	id, content, type: "fact", importance: 0.7, confidence: 0.9,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365, ...over,
})
const box = (title) => { console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`) }
/** 记忆块的**唯一主通道**形状: 摘要 + 哨兵 + JSON */
const block = (json, head = "主人聊了备考的事。") => `${head}\n===MEM===\n${json}`

/* ============================================================================
 * ① 解析容错 / malformed 率
 * ==========================================================================*/
box("① 解析容错: 加 kw 之后条目回收率不许下降")
const CASES = [
	{name: "带 kw (规范数组)", raw: block(`{"topic":"备考","items":[{"content":"我在准备考研","type":"project","importance":0.8,"kw":["考研","那场考试"]}]}`), items: 1, kw: 2},
	{name: "无 kw 字段 (旧格式, 完全兼容)", raw: block(`{"topic":"备考","items":[{"content":"我在准备考研","type":"project","importance":0.8}]}`), items: 1, kw: 0},
	{name: "kw 是字符串 (逗号分隔)", raw: block(`{"topic":"备考","items":[{"content":"我在准备考研","type":"project","importance":0.8,"kw":"考研, 那场考试"}]}`), items: 1, kw: 2},
	{name: "kw 是脏数组 (null/数字/空串/重复/泛词/超长)", raw: block(`{"topic":"t","items":[{"content":"我在准备考研","type":"project","importance":0.8,"kw":["考试",null,7,"","  考研  ","考试","这个","一个特别特别长的关键词啊啊"]}]}`), items: 1, kw: 2},
	{name: "kw 全是泛词 (去停用词后为空)", raw: block(`{"topic":"t","items":[{"content":"我在准备考研","type":"event","importance":0.9,"kw":["东西","事情","那个","最近","喜欢","什么"]}]}`), items: 1, kw: 0},
	{name: "kw 塞了免死金牌词 (goal/identity/pinned)", raw: block(`{"topic":"t","items":[{"content":"我随便说说","type":"event","importance":0.6,"kw":["goal","identity","pinned"]}]}`), items: 1, kw: 3},
	{name: "代码围栏 + 前后废话", raw: `分析如下：\n===MEM===\n\`\`\`json\n{"topic":"备考","items":[{"content":"我在准备考研","type":"project","importance":0.8,"kw":["考研"]}]}\n\`\`\`\n希望有帮助。`, items: 1, kw: 1},
	{name: "两个字段同时给 (kw 优先于 keywords)", raw: block(`{"topic":"t","items":[{"content":"我在准备考研","type":"project","importance":0.8,"keywords":["考研"],"kw":["那场考试"]}]}`), items: 1, kw: 1},
	{name: "多条目混排 (一条有 kw 一条没有)", raw: block(`{"topic":"t","items":[{"content":"我在准备考研","type":"project","importance":0.8,"kw":["考研"]},{"content":"我最喜欢的电影是星际穿越","type":"preference","importance":0.6}]}`), items: 2, kw: 1},
]
let recovered = 0
let expected = 0
for (const c of CASES) {
	const out = core.parseBlockOutput(c.raw)
	expected += c.items
	const gotKw = out.items.reduce((n, it) => n + (it.kw?.length ?? 0), 0)
	recovered += out.items.length
	const detail = `items=${out.items.length} kw合计=${gotKw} ${JSON.stringify(out.items.map(i => i.kw ?? []))}`
	if (c.name.includes("脏数组")) {
		// 逐个核对: 泛词/空串/超长/null/重复 都要被剔掉, 只留「考试」「考研」
		check(`① ${c.name} → 条目 ${c.items} 条 / kw ${c.kw} 个`,
			out.items.length === c.items && gotKw === c.kw && JSON.stringify(out.items[0]?.kw) === JSON.stringify(["考试", "考研"]), detail)
	} else {
		check(`① ${c.name} → 条目 ${c.items} 条 / kw ${c.kw} 个`,
			out.items.length === c.items && gotKw === c.kw, detail)
	}
}
// 坏 JSON: 与加 kw 之前**同一行为** —— 摘要照用, 条目为空 (整批丢, 所以格式越简单越好)
{
	const broken = core.parseBlockOutput(`主人聊了备考。\n===MEM===\n{"topic":"备考","items":[{"content":"我在准备考研",`)
	check("① JSON 坏掉 → 条目为空但**摘要保留** (与加 kw 之前同一降级路径)",
		broken.items.length === 0 && broken.summaryText.includes("主人聊了备考"),
		JSON.stringify({items: broken.items.length, summary: broken.summaryText.slice(0, 30)}))
	const noSentinel = core.parseBlockOutput("只有摘要，没有哨兵")
	check("① 无哨兵 → 整段当摘要 (条目为空)",
		noSentinel.items.length === 0 && noSentinel.summaryText === "只有摘要，没有哨兵")
	console.log(`\n  条目回收: ${recovered} / ${expected} (期望全回收)`)
	check("① 条目回收率 100% (kw 只做加法, 绝不因为它丢条目)", recovered === expected, `${recovered}/${expected}`)
}

/* ============================================================================
 * ② 同义命中率: 正文零重叠、只有别称能命中 (A/B 对照)
 * ==========================================================================*/
box("② 同义命中率: 正文词面重叠 = 0, 只能靠别称")
// 每一对都**逐对核对过**: 正文与提问的 bigram 交集为空
// (中文 bigram 极容易意外重叠 —— 所以刻意避开共享数字/共享双字词)
const SYN = [
	{content: "我最喜欢的电影是星际穿越", kw: ["科幻片"], q: "有什么好看的科幻片推荐吗"},
	{content: "我在准备考研", kw: ["考试"], q: "考试快到了有点紧张"},
	{content: "我家养了一只猫", kw: ["宠物"], q: "养宠物要花多少钱"},
	{content: "我女朋友叫小美", kw: ["对象"], q: "你对象是做什么的"},
	{content: "我每天早上跑步", kw: ["运动"], q: "平时做什么运动好"},
	{content: "我在做NoriDroid", kw: ["项目"], q: "这个项目进度怎么样了"},
]
let beforeHit = 0
let afterHit = 0
let controlHit = 0
for (const s of SYN) {
	const withKw = [mk("a", s.content, {kw: s.kw})]
	const noKw = [mk("b", s.content)]
	// 落地前 = 只会走正文词面: recallMemories (diversify 关闭, 与写入侧同一路径)
	const before = core.recallMemories(withKw, s.q, 6, false).hits.length
	// 落地后 = 正文为空时才跑的别名兜底
	const after = core.recallMemoriesByKeywords(withKw, s.q, 2).hits.length
	// 对照组: 把 kw 摘掉, 兜底也必须一无所获 (证明命中**确实来自别称**)
	const control = core.recallMemoriesByKeywords(noKw, s.q, 2).hits.length
	beforeHit += before > 0 ? 1 : 0
	afterHit += after > 0 ? 1 : 0
	controlHit += control > 0 ? 1 : 0
	console.log(`  「${s.q}」 → 正文命中 ${before} · 别名命中 ${after} · 摘掉 kw 后 ${control}   (${s.content} / kw=${JSON.stringify(s.kw)})`)
}
check(`② 落地前: 正文一条都命中不了 (${beforeHit}/${SYN.length}) —— 同义缺口真实存在`,
	beforeHit === 0, `before=${beforeHit}`)
check(`② 落地后: 别名补上了 (${afterHit}/${SYN.length})`, afterHit === SYN.length, `after=${afterHit}/${SYN.length}`)
check(`② 对照组: 摘掉 kw 后兜底也命中不了 (${controlHit}) —— 命中确实来自别称`,
	controlHit === 0, `control=${controlHit}`)

/* ============================================================================
 * ③ 红线②: 不许参与 0.35 主门槛 —— 只能是"主路径空手而归"时的兜底
 * ==========================================================================*/
box("③ 红线②: 别名**不参与**主门槛 (只加不抢)")
{
	// X 正文能命中; Y 只有别称能命中。主路径必须给 X, 且**不**把 Y 挤进来
	const X = mk("x", "我在准备考研", {type: "project", importance: 0.7})
	const Y = mk("y", "我喜欢玩游戏", {type: "preference", importance: 0.95, kw: ["考试"]})
	const q = "我最近考试准备得怎么样"
	const primary = core.recallMemories([X, Y], q, 6, false)
	check("③ 主路径只吃正文命中 (Y 靠别名也进不来)",
		primary.hits.some(h => h.id === "x") && !primary.hits.some(h => h.id === "y"),
		JSON.stringify(primary.hits.map(h => h.id)))
	check("③ 别名兜底本身能命中 Y (能力在, 只是不该抢)",
		core.recallMemoriesByKeywords([X, Y], q, 2).hits.some(h => h.id === "y"))

	// 端到端: recallForQuery 拿到主路径命中后, **根本不该**去问别名兜底
	const seed = (list) => {
		files.clear()
		files.set("memory.json", JSON.stringify({memories: list, summaries: [], summarizedMsgCount: 0, tombstones: []}))
		mem.reloadMemory()
	}
	seed([X, Y])
	const block1 = mem.recallForQuery(q)
	check("③ 端到端: 注入块里有 X、没有 Y (主路径有收获时兜底不跑)",
		block1.includes("我在准备考研") && !block1.includes("我喜欢玩游戏"),
		JSON.stringify(block1.slice(0, 60)))

	// 主路径空 → 兜底接住, 并且**真的算被用到** (与"取数与渲染数一致"同一条纪律)
	seed([Y])
	const block2 = mem.recallForQuery(q)
	const yAfter = mem.listAll().memories.find(m => m.id === "y")
	check("③ 主路径空 → 别名兜底接住, 且 accessCount+1 (不会给没用过的记忆发免死金牌)",
		block2.includes("我喜欢玩游戏") && (yAfter?.accessCount ?? 0) === 1,
		JSON.stringify({block: block2.slice(0, 30), access: yAfter?.accessCount}))

	// 泛词清洗: 模型要是把泛词当 kw, 它**在写入侧**就该被剔掉 (makeMemoryItem 是写 kw 的入口)
	const cleaned = core.makeMemoryItem({content: "我喜欢玩游戏", kw: ["那个", "事情", "最近"]})
	check("③ 泛词 kw 在写入侧被清洗 (kw 为空, 不落库)", (cleaned.kw ?? []).length === 0, JSON.stringify(cleaned.kw))
	seed([cleaned])
	const block3 = mem.recallForQuery("最近那个事情怎么样了")
	check("③ 落库的那条没有 kw ⇒ 兜底也无从命中 (泛词污染进不来)", block3 === "", JSON.stringify(block3))
}

/* ============================================================================
 * ④ 红线①: kw 绝不许进 tags (免死金牌 / 永久豁免判据)
 * ==========================================================================*/
box("④ 红线①: kw 与 tags 零交集")
{
	const out = core.parseBlockOutput(block(`{"topic":"t","items":[{"content":"我随便说说","type":"event","importance":0.3,"kw":["goal","identity","pinned","explicit"]}]}`))
	const it = out.items[0]
	check("④ 解析结果里 kw 是**独立字段** (解析层没有 tags), 且受条数上限约束",
		(it?.kw?.length ?? 0) === core.MAX_KW_PER_ITEM && it?.tags === undefined,
		JSON.stringify({kw: it?.kw, tags: it?.tags, cap: core.MAX_KW_PER_ITEM}))

	const made = core.makeMemoryItem({content: "我随便说说", type: "event", importance: 0.3, kw: ["goal", "identity", "pinned", "explicit"]})
	check("④ 入库后的 tags 里没有 goal/identity/pinned/explicit",
		!(made.tags ?? []).some(t => ["goal", "identity", "pinned", "explicit"].includes(t)),
		JSON.stringify(made.tags))
	check("④ 写入门槛判据不受 kw 影响 (event + importance 0.3 仍被挡)",
		core.isWorthRemembering({type: "event", importance: 0.3, tags: made.tags}) === false)
	check("④ 永久豁免判据不受 kw 影响 (decayDays 仍是类型默认值, 不是 null)",
		made.decayDays === 30, String(made.decayDays))

	// 端到端: 真的经 summarizeIfNeeded 入库一次, tags 里也不许出现免死金牌词
	const files2 = files
	files2.clear()
	mem.reloadMemory()
	const msgs = Array.from({length: 45}, (_, i) => ({role: i % 2 ? "assistant" : "user", content: `第${i}句`, ts: 1_810_000_000_000 + i * 1000}))
	await mem.summarizeIfNeeded(msgs, async () => block(`{"topic":"闲聊","items":[{"content":"我随便说说","type":"event","importance":0.6,"kw":["goal","identity","explicit"]}]}`, "随便聊了聊。"), true, false)
	const stored = mem.listAll(true).memories.find(m => m.content === "我随便说说")
	check("④ 端到端入库: 那条记忆的 tags 里没有免死金牌词, kw 独立存着",
		!!stored && !(stored.tags ?? []).some(t => ["goal", "identity", "pinned", "explicit"].includes(t)) && (stored.kw?.length ?? 0) === 3,
		JSON.stringify({tags: stored?.tags, kw: stored?.kw}))
}

/* ============================================================================
 * ⑤ 回归护栏: 主路径逐条不变 (kw 不许从任何缝里漏进正文召回)
 * ==========================================================================*/
box("⑤ 回归护栏: diversify=false 的主路径与「纯正文前 N」逐条一致")
{
	// 语料刻意让**正文本体**与**别名**完全不共享 bigram:
	// 中文 bigram 很容易意外重叠(例如两位数字 "12" 会同时出现在 "别名12" 与 "第12种" 里),
	// 所以这里用两组互不相交的词, 保证"别名命中只可能来自 kw"。
	const FOODS = ["苹果", "香蕉", "橘子", "葡萄", "西瓜", "草莓", "蓝莓", "桃子", "梨子", "柠檬", "芒果", "樱桃",
		"菠萝", "椰子", "石榴", "杨梅", "枇杷", "山楂", "荔枝", "龙眼", "木瓜", "柿子", "红枣", "核桃"]
	const ALIAS = ["红红", "黄黄", "橙橙", "紫紫", "绿绿", "粉粉", "蓝蓝", "白白", "脆脆", "酸酸", "甜甜", "小小",
		"大大", "圆圆", "方方", "长长", "短短", "高高", "低低", "近近", "远远", "快快", "慢慢", "轻轻"]
	const items = FOODS.map((f, i) => mk(`r${i}`, `我喜欢吃${f}`, {kw: [ALIAS[i], "水果"], type: i % 3 === 0 ? "preference" : "fact", importance: 0.5 + (i % 5) * 0.1}))
	const contentQueries = FOODS.map(f => `我想吃点${f}`)
	const aliasQueries = ALIAS.map(a => `说说${a}吧`)

	// 参照实现: 手工按「只看正文」复算, 必须与 recallMemories 逐条一致
	let mismatch = 0
	for (const q of [...contentQueries, ...aliasQueries]) {
		const plain = core.recallMemories(items, q, 6, false).hits.map(h => h.id)
		const tk = core.tokenize(q)
		const ref = items
			.filter(it => core.isActiveMemory(it) && core.overlapCount(tk, it) > 0)
			.map(it => ({it, s: core.scoreMemory(tk, it, Date.now())}))
			.filter(x => x.s > 0.35)
			.sort((a, b) => b.s - a.s)
			.slice(0, 6)
			.map(x => x.it.id)
		if (JSON.stringify(plain) !== JSON.stringify(ref)) mismatch += 1
	}
	check(`⑤ ${contentQueries.length + aliasQueries.length} 个查询的正文召回与参照实现完全一致`, mismatch === 0, `不一致 ${mismatch} 个`)

	const leak = aliasQueries.filter(q => core.recallMemories(items, q, 6, false).hits.length > 0).length
	check("⑤ 纯别名查询在主路径上一条都命中不了 (kw 没有漏进正文索引)", leak === 0, `漏进 ${leak}/${aliasQueries.length}`)

	const kwHit = aliasQueries.filter(q => core.recallMemoriesByKeywords(items, q, 2).hits.length > 0).length
	check(`⑤ 同一批纯别名查询在**兜底**通道上能命中 (${kwHit}/${aliasQueries.length})`,
		kwHit === aliasQueries.length, `kw=${kwHit}`)
}

/* ============================================================================
 * 汇总
 * ==========================================================================*/
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
	process.exitCode = 1
	console.log("FAILED:", failed.map(f => f.name).join(" | "))
}
