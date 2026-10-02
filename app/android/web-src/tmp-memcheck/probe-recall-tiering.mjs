/* 量测 A4「召回分层」的收益与代价 (2026-09-29, 第二版)
 *
 * ⚠ 第一版教训: 我按"共享一个字"设计语料 ⇒ 大面积 0 条 —— 真实分词器是**相邻双字 bigram**
 *   (「想喝」与「喝茶」**不**共享 bigram)。所以本版每个场景都按 bigram 真实重叠来设计,
 *   并把"目标条的基线得分 + 命中的 bigram"打出来, 便于审计语料本身对不对。
 *
 * A4 定义: 召回现在「重叠>0 是必要条件」+ 阈值 0.35 + 取前 6。
 * 分层 = 给**重要条目**放宽 —— 但**不碰**"重叠>0"那道闸 (历史注释明确警告过: 不要求重叠的话,
 * 高重要度记忆光靠静态分就能对任何提问被召回)。
 *   V1: 重要条目阈值 0.35 → 0（只要求有一点词面重叠）
 *   V2: 重要条目"衰减下限 0.5"（把被时间衰减压低的分数抬回来, 静态弱项不变）
 *   V3: 重要条目分数 ×1.3
 * 重要 = core / explicit / identity / pinned / goal / importance≥阈值 —— 阈值分两档看敏感度。
 *
 * 运行: cd web-src && node tmp-memcheck/probe-recall-tiering.mjs
 */
await import("./build-mem-bundles.mjs")
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

const DAY = 24 * 3600 * 1000
const NOW = Date.now()
/** ageDays = 距今多少天"最后活跃过" (决定新鲜度与类型衰减) */
const mk = (id, content, over = {}, ageDays = 0) => {
	const t = NOW - ageDays * DAY
	return {
		id, content, type: over.type ?? "fact", importance: over.importance ?? 0.7,
		confidence: 0.9, createdAt: t, updatedAt: t, lastAccessedAt: over.lastAccessedAt ?? 0,
		accessCount: over.accessCount ?? 0, tags: over.tags ?? [],
		decayDays: over.decayDays === undefined ? 365 : over.decayDays,
	}
}
const tagged = (it) => (it.tags ?? []).some(t => ["explicit", "identity", "pinned", "goal"].includes(t))
const mkImpCheck = (thr) => (it) => it.type === "core" || tagged(it) || it.importance >= thr

/* ---------------- 语料: 收益类 (重要+老+弱重叠 ⇒ 基线会漏) ---------------- */
const BENEFIT = [
	{name: "B1 考研计划 (project 0.9, 400 天没提)", query: "我那个考研的准备得怎么样了",
		lib: [mk("exam", "我最近在准备考研", {type: "project", importance: 0.9, decayDays: 60}, 400),
			mk("coffee", "我每天喝咖啡", {type: "preference", importance: 0.5, decayDays: 90}, 5)],
		expect: ["exam"], forbid: ["coffee"]},
	{name: "B3 朋友小林 (relationship 0.9, 500 天)", query: "小林你还记得吗",
		lib: [mk("friend", "我有个朋友叫小林", {type: "relationship", importance: 0.9, decayDays: 180}, 500),
			mk("tea", "我喜欢喝茶", {type: "preference", importance: 0.4, decayDays: 90}, 5)],
		expect: ["friend"], forbid: ["tea"]},
	{name: "B5 上班的公司 (fact 0.9, 900 天)", query: "我那个上班的公司是做什么的",
		lib: [mk("job", "我在一家做地图的公司上班", {type: "fact", importance: 0.9, decayDays: 365}, 900),
			mk("game", "我喜欢玩原神", {type: "preference", importance: 0.5, decayDays: 90}, 5)],
		expect: ["job"], forbid: ["game"]},
	{name: "B6 熬夜习惯 (preference 0.9, 200 天)", query: "我熬夜的习惯改不掉",
		lib: [mk("stayup", "我最近总是熬夜", {type: "preference", importance: 0.9, decayDays: 90}, 200),
			mk("movie", "我喜欢看科幻电影", {type: "preference", importance: 0.5, decayDays: 90}, 4)],
		expect: ["stayup"], forbid: ["movie"]},
	{name: "B7 玩原神 (preference 0.9, 300 天)", query: "那个原神你还玩吗",
		lib: [mk("genshin", "我喜欢玩原神", {type: "preference", importance: 0.9, decayDays: 90}, 300),
			mk("cat", "我家养了一只猫", {type: "fact", importance: 0.6}, 20)],
		expect: ["genshin"], forbid: ["cat"]},
	{name: "B8 准备一个考试 (project 0.9, 500 天)", query: "我那个考试怎么样了",
		lib: [mk("exam2", "我在准备一个考试", {type: "project", importance: 0.9, decayDays: 60}, 500),
			mk("dog", "我想养狗", {type: "project", importance: 0.6, decayDays: 60}, 10)],
		expect: ["exam2"], forbid: ["dog"]},
	{name: "B9 忌口香菜 (pinned, 永久, 400 天)", query: "我不吃的东西有哪些",
		lib: [mk("allergy", "我不吃香菜", {type: "fact", importance: 0.9, tags: ["pinned"], decayDays: null}, 400),
			mk("ramen", "我喜欢吃拉面", {type: "preference", importance: 0.5, decayDays: 90}, 5)],
		expect: ["allergy"], forbid: ["ramen"]},
	{name: "B10 生日 (core/explicit, 永久, 300 天)", query: "我的生日是几号来着",
		lib: [mk("bday", "记住：我的生日是 3 月 2 号", {type: "core", importance: 0.95, tags: ["explicit"], decayDays: null}, 300),
			mk("milk", "别忘了买牛奶", {type: "fact", importance: 0.5}, 5)],
		expect: ["bday"], forbid: ["milk"]},
]

/* ---------------- 代价类 (重要+老+共享常用 bigram, 但**与提问无关**: 基线会漏, 放宽会误注入) ---------------- */
const COST = [
	{name: "C1 无关的旅行计划 vs 考研 (共享 我最/最近)", query: "我最近在准备考研的事",
		lib: [mk("travel", "我最近想去旅行", {type: "project", importance: 0.9, decayDays: 60}, 300)],
		expect: [], forbid: ["travel"]},
	{name: "C2 无关的熬夜 vs 学吉他 (共享 我最/最近)", query: "我最近想去学吉他",
		lib: [mk("stayup2", "我最近总是熬夜", {type: "preference", importance: 0.9, decayDays: 90}, 300)],
		expect: [], forbid: ["stayup2"]},
	{name: "C3 无关的拉面 vs 去哪儿玩 (共享 我最)", query: "我最想去哪儿玩",
		lib: [mk("ramen2", "我最喜欢吃拉面", {type: "preference", importance: 0.9, decayDays: 90}, 400)],
		expect: [], forbid: ["ramen2"]},
	{name: "C4 无关的猫 vs 猫粮 (共享 猫)", query: "猫粮买哪个牌子好",
		lib: [mk("cat2", "我家养了一只猫", {type: "fact", importance: 0.9, decayDays: 365}, 700)],
		expect: [], forbid: ["cat2"]},
	{name: "C5 无关的上班 vs 上班路上 (共享 上班)", query: "上班路上听什么歌好",
		lib: [mk("job2", "我在一家做地图的公司上班", {type: "fact", importance: 0.9, decayDays: 365}, 900)],
		expect: [], forbid: ["job2"]},
]

/* ---------------- 对照类 (基线本来就该过) ---------------- */
const CONTROL = [
	{name: "K1 近期偏好 (喝茶, 3 天)", query: "你喜欢喝茶吗",
		lib: [mk("tea2", "我喜欢喝茶", {type: "preference", importance: 0.9, decayDays: 90}, 3)],
		expect: ["tea2"], forbid: []},
	{name: "K2 过敏 (identity, 永久)", query: "我吃海鲜行不行",
		lib: [mk("sea", "我对海鲜过敏", {type: "fact", importance: 0.95, tags: ["identity"], decayDays: null}, 100)],
		expect: ["sea"], forbid: []},
]

const CASES = [...BENEFIT.map(c => ({...c, kind: "收益"})), ...COST.map(c => ({...c, kind: "代价"})), ...CONTROL.map(c => ({...c, kind: "对照"}))]
const T_BASE = 0.35
const CONFIGS = ["V0", "V1", "V2", "V3"]

const run = (items, query, cfg, impCheck) => {
	const now = Date.now()
	const tokens = core.tokenize(query)
	if (!tokens.length) return []
	const scored = items
		.filter(it => core.isActiveMemory(it))
		.filter(it => core.overlapCount(tokens, it) > 0)
		.map(it => {
			const raw = core.scoreMemory(tokens, it, now)
			const imp = impCheck(it)
			let score = raw
			if (imp && cfg === "V2") {
				const d = core.decayFactor(it, now)
				if (d > 0 && d < 0.5) score = (raw / d) * 0.5
			}
			if (imp && cfg === "V3") score = raw * 1.3
			return {it, score, imp, raw}
		})
		.sort((a, b) => b.score - a.score)
	const keep = (s) => s.score > ((cfg === "V1" && s.imp) ? 0 : T_BASE)
	return {ids: scored.filter(keep).slice(0, 6).map(s => s.it.id), scored}
}

/* ---------------- 1) 先自证语料: 打出每个场景的重叠与基线得分 ---------------- */
console.log("=========== 语料自证 (重叠 bigram / 基线得分 / 是否过阈值) ===========")
for (const c of CASES) {
	const tokens = core.tokenize(c.query)
	const parts = c.lib.map(it => {
		const ov = core.overlapCount(tokens, it)
		const sc = core.scoreMemory(tokens, it, NOW)
		return `${it.id}: 重叠${ov} 分${sc.toFixed(3)}${sc > T_BASE ? "✓" : "✗"}`
	})
	console.log(`  [${c.kind}] ${c.name}`)
	console.log(`      期望=${JSON.stringify(c.expect)} 禁忌=${JSON.stringify(c.forbid)} :: ${parts.join(" · ")}`)
}

/* ---------------- 2) 汇总: 两种"重要"定义 × 四种配置 ---------------- */
const summarize = (impThr) => {
	const impCheck = mkImpCheck(impThr)
	const agg = Object.fromEntries(CONFIGS.map(c => [c, {miss: 0, extra: 0, inj: 0, exp: 0}]))
	for (const c of CASES) {
		for (const cfg of CONFIGS) {
			const {ids} = run(c.lib, c.query, cfg, impCheck)
			agg[cfg].miss += c.expect.filter(id => !ids.includes(id)).length
			agg[cfg].extra += ids.filter(id => c.forbid.includes(id)).length
			agg[cfg].inj += ids.length
			agg[cfg].exp += c.expect.length
		}
	}
	return agg
}

for (const thr of [0.85, 0.7]) {
	const agg = summarize(thr)
	const base = agg.V0
	console.log(`\n=========== 汇总 (重要 = core/标签/importance≥${thr}) · 语料 ${CASES.length} 场景 / 应召回 ${base.exp} 条 ===========`)
	console.log(`  V0 基线:    漏召回 ${base.miss} · 误注入 ${base.extra} · 注入总量 ${base.inj}`)
	for (const cfg of ["V1", "V2", "V3"]) {
		const t = agg[cfg]
		console.log(`  ${cfg}: 补回漏召回 ${base.miss - t.miss} 条 · 新增误注入 ${t.extra - base.extra} 条 · 注入总量 ${t.inj - base.inj >= 0 ? "+" : ""}${t.inj - base.inj} (${base.inj}→${t.inj})`)
	}
}

/* ---------------- 3) 收益/代价分开展示 (阈值 0.85) ---------------- */
{
	const agg = summarize(0.85)
	const detail = {收益: {}, 代价: {}, 对照: {}}
	for (const kind of Object.keys(detail)) {
		const cases = CASES.filter(c => c.kind === kind)
		for (const cfg of CONFIGS) {
			let miss = 0, extra = 0
			for (const c of cases) {
				const {ids} = run(c.lib, c.query, cfg, mkImpCheck(0.85))
				miss += c.expect.filter(id => !ids.includes(id)).length
				extra += ids.filter(id => c.forbid.includes(id)).length
			}
			detail[kind][cfg] = {miss, extra}
		}
	}
	console.log("\n=========== 分块看 (重要 = importance≥0.85) ===========")
	for (const [kind, v] of Object.entries(detail)) {
		console.log(`  【${kind}】基线 漏${v.V0.miss}/误${v.V0.extra} → V1 漏${v.V1.miss}/误${v.V1.extra} · V2 漏${v.V2.miss}/误${v.V2.extra} · V3 漏${v.V3.miss}/误${v.V3.extra}`)
	}
}
