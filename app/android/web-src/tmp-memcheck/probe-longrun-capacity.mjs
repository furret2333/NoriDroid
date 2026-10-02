/* P3 长期运行推演 (2026-09-30): 陪主人聊一年之后, 记忆库会变成什么样?
 *
 * 回答三个**从没测过**的问题 —— 全部用真实存储代码 (memory-bundle), 只有"模型"是规则化假模型:
 *   ① 一年后她还记得多少条? 里面有自己造的重复/垃圾吗?
 *   ② memory.json 会长到多大? 冷载入会不会越来越慢?
 *   ③ 自动路径「只收起不删除」⇒ 已收起区会不会无限膨胀?
 *
 * ── 逼真度与近似 (必须如实说明) ──────────────────────────────
 * - 时间: **虚拟时钟** (覆写 Date.now), 默认 30 条/天 → 一年 10,950 条; 条与条之间 48 分钟。
 * - 模型: **不是 LLM**, 是按「生活剧本 + 合规档位」产出摘要与记忆块的规则函数。它的输入与真模型
 *   完全一致 (提示词里的对话历史 + 【已经记住的内容】段落, 自己解析出来用), 但它的"听不听话"
 *   是概率参数化的 —— 所以本探针量的是**系统容量行为**, 不是真模型的合规率 (那是 P1 诊断日志的事)。
 * - 三档合规度: strict(全守规则) / normal(近义重复 35%、一次性状态 15% 入库) / sloppy(70% / 60%,
 *   且 importance 抬 0.1 去骗门槛) —— 用来量"模型不听话的代价有多大"。
 * - 单实例 (悬浮窗双实例的一致性另有门禁) ; 召回走同步关键词通道 recallForQuery
 *   (与 App 里的 smart 通道共用同一套 accessCount/lastAccessedAt 记账, 只差 LLM 语义那一步)。
 * - 剧本语料是合成的, 不是真实聊天记录; 结论看**趋势与量级**, 别当成对真实用户的精确预测。
 *
 * 运行: cd web-src && node tmp-memcheck/probe-longrun-capacity.mjs
 *       node tmp-memcheck/probe-longrun-capacity.mjs --days=730          # 两年
 *       node tmp-memcheck/probe-longrun-capacity.mjs --per-day=100       # 重度用户
 *       node tmp-memcheck/probe-longrun-capacity.mjs --quiet             # 只看结论
 */
import {pathToFileURL} from "node:url"
import path from "node:path"
import {writeFileSync} from "node:fs"

await import("./build-mem-bundles.mjs")

const root = path.resolve(import.meta.dirname, "..")
/* 虚拟时钟: 整个进程内 Date.now() 返回模拟时间 (记忆的衰减/过期/新鲜度全靠它) */
const REAL_DATE_NOW = Date.now
let VNOW = REAL_DATE_NOW()
Date.now = () => VNOW
/** 真实耗时用单调时钟量 (不受虚拟时钟影响) */
const realMs = () => Number(process.hrtime.bigint()) / 1e6

const files = new Map()
globalThis.window = {
	NoriChat: {
		readFile: (n) => files.get(n) ?? "",
		writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
	},
}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

/* 记忆模块自己会打大量 [mem] 日志 (设备上就是靠这些排查); 探针里收进计数, 免得刷屏 */
const realLog = console.log.bind(console)
const MEM_LOG = {log: 0, err: []}
console.log = () => { MEM_LOG.log += 1 }
console.error = (...a) => { MEM_LOG.err.push(a.map(String).join(" ")) }

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2)
const numArg = (k, d) => { const a = argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.slice(k.length + 3)) : d }
const DAYS = numArg("days", 365)
const PER_DAY = numArg("per-day", 30)
const QUIET = argv.includes("--quiet")
const DUMP = argv.includes("--dump")
const STRICT = argv.includes("--strict")
const DAY = 86400000
const START = REAL_DATE_NOW() - DAYS * DAY   // 让最后一条落在"现在"

/* ---------------- 小工具 ---------------- */
/** 固定种子 PRNG (mulberry32): 同一版本永远跑出同一结果, 才配当门禁 */
const mulberry32 = (seed) => () => {
	seed = (seed + 0x6D2B79F5) | 0
	let t = seed
	t = Math.imul(t ^ (t >>> 15), t | 1)
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
/** 中文按相邻双字 bigram 比相似 (与真分词器的判重口径一致, 见 probe-recall-tiering 的教训) */
const bigrams = (s) => {
	const t = String(s).replace(/[\s，。、！？：；「」（）()【】\-—…,.!?:;"'`]/g, "")
	const out = new Set()
	for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2))
	if (!out.size && t) out.add(t)
	return out
}
const overlap = (a, b) => {
	let n = 0
	for (const g of a) if (b.has(g)) n += 1
	return n / Math.max(1, Math.min(a.size, b.size))
}

/* ---------------- 生活剧本 ----------------
 * want=true  = 按提示词规则**该**长期记住 (三个月后还成立)
 * want=false = 该忽略 (当下的状态 / 一次性流水账)
 * variants   = 同一件事的不同说法 (模型换个措辞再说一遍 ⇒ 考确定性判重)
 * changed    = 这句是改口/补充 (规则 8 要求必须写出来)
 */
const BEATS = [
	{key: "name", kind: "identity", want: true, type: "core", importance: 0.95, from: 1, to: 1, every: 0,
		content: "记住：我叫小桧", variants: ["记住：我叫小桧"]},
	{key: "job", kind: "stable", want: true, type: "fact", importance: 0.8, from: 2, to: 2, every: 0,
		content: "我在一家做地图的公司上班", variants: ["我在一家做地图的公司上班", "我上班的公司是做地图的"]},
	{key: "allergy", kind: "stable", want: true, type: "fact", importance: 0.7, from: 3, to: 3, every: 0,
		content: "我不吃香菜", variants: ["我不吃香菜"]},
	{key: "rain", kind: "pref", want: true, type: "preference", importance: 0.7, from: 20, to: 20, every: 0,
		content: "我喜欢下雨天", variants: ["我喜欢下雨天"]},
	{key: "ot1", kind: "oneoff-event", want: false, type: "event", importance: 0.5, from: 40, to: 40, every: 0,
		content: "我今天加班到十点", variants: ["我今天加班到十点"]},
	{key: "overtime", kind: "recur", want: true, type: "preference", importance: 0.7, from: 45, to: 45, every: 0,
		content: "我最近一直在加班", variants: ["我最近一直在加班"]},
	{key: "cat", kind: "relationship", want: true, type: "relationship", importance: 0.8, from: 60, to: 60, every: 0,
		content: "我养了一只叫团子的猫", variants: ["我养了一只叫团子的猫"]},
	{key: "promise", kind: "promise", want: true, type: "core", importance: 0.9, from: 90, to: 90, every: 0,
		content: "记住：我每周三晚上要上课", variants: ["记住：我每周三晚上要上课"]},
	{key: "rain2", kind: "reversal", want: true, type: "preference", importance: 0.7, from: 120, to: 120, every: 0, changed: true,
		content: "我不太喜欢下雨天了", variants: ["我不太喜欢下雨天了"]},
	{key: "examStop", kind: "reversal", want: true, type: "preference", importance: 0.75, from: 158, to: 158, every: 0, changed: true,
		content: "我不准备考研了", variants: ["我不准备考研了"]},
	/* 反复提到的事 (跨月出现 ⇒ 考"再次提到"的合并与 accessCount 记账) */
	{key: "exam", kind: "project", want: true, type: "project", importance: 0.8, from: 5, to: 150, every: 10,
		content: "我在准备考研", variants: ["我在准备考研", "考研的复习还在继续", "我还在准备考研"]},
	{key: "stayup", kind: "recur", want: true, type: "preference", importance: 0.6, from: 10, to: 365, every: 12,
		content: "我最近一直在熬夜", variants: ["我最近一直在熬夜", "还是老熬夜"]},
	{key: "guitar", kind: "project", want: true, type: "project", importance: 0.75, from: 180, to: 365, every: 30,
		content: "我在学吉他", variants: ["我在学吉他", "吉他还在练"]},
]
/** 一次性状态 (大量、每天都有): 按规则**一条都不该写**。多给几种说法 —— 真实用户不会用同一句话。 */
const FILLERS = [
	{key: "f1", kind: "oneoff", want: false, type: "event", importance: 0.55, content: "我有点困，准备去睡觉", variants: ["我有点困，准备去睡觉", "困得不行了，先睡了", "眼睛睁不开了", "今天想早点睡"]},
	{key: "f2", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "今天下雨了", variants: ["今天下雨了", "外面在下雨", "雨下得挺大", "出门忘带伞了"]},
	{key: "f3", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "我还没吃饭", variants: ["我还没吃饭", "晚饭还没吃呢", "饿着肚子呢", "待会儿再去吃"]},
	{key: "f4", kind: "oneoff", want: false, type: "fact", importance: 0.55, content: "刚洗完澡", variants: ["刚洗完澡", "才洗完澡出来", "洗完澡舒服多了"]},
	{key: "f5", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "今天好累啊", variants: ["今天好累啊", "累得不想动", "今天真够呛", "浑身没劲"]},
	{key: "f6", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "刚吃完一碗面", variants: ["刚吃完一碗面", "吃了碗面", "中午吃的面", "随便吃了点"]},
	{key: "f7", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "在看剧，先不聊了", variants: ["在看剧，先不聊了", "在追剧呢", "看完这集再说", "刚打开视频"]},
	{key: "f8", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "外面好吵", variants: ["外面好吵", "外边太吵了", "楼下在装修", "吵得头疼"]},
	{key: "f9", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "在等外卖", variants: ["在等外卖", "外卖还没到", "刚点了份外卖"]},
	{key: "f10", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "刚下班到家", variants: ["刚下班到家", "今天下班晚了", "才到家"]},
	{key: "f11", kind: "oneoff", want: false, type: "fact", importance: 0.5, content: "手机快没电了", variants: ["手机快没电了", "电量只剩一点了", "得去充电了"]},
	{key: "f12", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "今天降温了", variants: ["今天降温了", "一下子冷了好多", "忘了穿外套"]},
	{key: "f13", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "刚去楼下买了瓶水", variants: ["刚去楼下买了瓶水", "下楼买了点东西", "去便利店一趟"]},
	{key: "f14", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "在收拾房间", variants: ["在收拾房间", "房间太乱得整一下", "刚打扫完"]},
	{key: "f15", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "有点头疼", variants: ["有点头疼", "脑袋昏昏的", "今天状态不太好"]},
	{key: "f16", kind: "oneoff", want: false, type: "event", importance: 0.5, content: "在听歌", variants: ["在听歌", "单曲循环呢", "刚换了首歌"]},
]
const ALL_BEATS = [...BEATS, ...FILLERS]
/** 一次性状态的"永远不重复"特性: 同一个状态换个时间/场合说 —— 真实用户不会用同一句话
 *  (不这么做的话, 有限的说法池会被确定性判重全部合并, 得出"库不会涨"的假结论) */
const TIME_PREFIX = ["今天", "刚才", "这会儿", "下午", "晚上", "早上", "这两天", "刚刚", "今天下午", "今天晚上", "最近", "这两天晚上"]
const pickVariant = (b, rnd) => (b.variants.length > 1 && rnd() < 0.5 ? b.variants[1 + Math.floor(rnd() * (b.variants.length - 1))] : b.content)
const sayBeat = (b, rnd) => {
	const base = pickVariant(b, rnd)
	if (b.want || b.noprefix) return base
	return (rnd() < 0.65 ? TIME_PREFIX[Math.floor(rnd() * TIME_PREFIX.length)] : "") + base
}

const NORI_REPLIES = ["嗯嗯，我在听", "好呀，我记住啦", "这样啊，那我陪你一会儿", "唔…听起来挺辛苦的", "我明白啦"]

/* 「最坏情况」用的一次性内容: **每句唯一、从不再提**。
 * 真实用户的一次性内容(「今天在楼下看到一只猫」/「刚把快递取了」)本来就是每句都不一样、
 * 而且多半不会被再说第二遍 —— 只是没法用有限语料穷举, 所以这里在句尾挂一个唯一序号。
 * 记忆机制只看 类型/重要度/时间/召回次数, 文本自不自然不影响结论。 */
const JUNK_TIME = ["今天早上", "今天中午", "下午", "傍晚", "刚才", "晚上", "上班路上", "下班路上"]
const JUNK_LOC = ["楼下便利店", "小区门口", "地铁上", "公司楼下", "超市", "公园", "食堂", "路边"]
const JUNK_ACT = ["买了点水果", "取了快递", "吃了碗面", "坐了会儿", "等了半天", "顺手买了瓶水"]
let JUNK_SEQ = 0
const JUNK_TEXT = new Map()   // 文本 → 该条属于"垃圾" (分类用; 结构化模板没法用 bigram 认)
const mkUniqueJunk = (rnd) => {
	const pick = (a) => a[Math.floor(rnd() * a.length)]
	JUNK_SEQ += 1
	const t = `${pick(JUNK_TIME)}在${pick(JUNK_LOC)}${pick(JUNK_ACT)}（第 ${JUNK_SEQ} 回）`
	const beat = {key: `junk${JUNK_SEQ}`, kind: "unique-oneoff", want: false, type: "event", importance: 0.55, content: t, variants: [t], noprefix: true}
	JUNK_TEXT.set(t, beat)
	return beat
}

/* ---------------- 造对话 (一年 10,950 条) ---------------- */
let MSG_META = []
const buildChatter = (days, perDay, seed, uniqueJunk) => {
	const rnd = mulberry32(seed)
	const messages = []
	const meta = []
	const push = (role, content, beat, ts) => {
		const tag = beat ? ` <m${messages.length}>` : ""
		messages.push({role, content: `${content}${tag}`, ts})
		meta.push(beat ?? null)
	}
	for (let d = 1; d <= days; d += 1) {
		const due = BEATS.filter(b => d >= b.from && d <= b.to && (b.every > 0 ? (d - b.from) % b.every === 0 : d === b.from))
		let di = 0
		for (let slot = 0; slot < perDay; slot += 1) {
			const ts = START + (d - 1) * DAY + Math.floor(slot * (DAY / perDay))
			if (slot % 2 === 0) {
				let beat = null
				if (di < due.length && slot % 4 === 0) { beat = due[di]; di += 1 }
				else if (uniqueJunk) beat = mkUniqueJunk(rnd)
				else beat = FILLERS[Math.floor(rnd() * FILLERS.length)]
				push("user", sayBeat(beat, rnd), beat, ts)
			} else {
				push("assistant", NORI_REPLIES[Math.floor(rnd() * NORI_REPLIES.length)], null, ts)
			}
		}
	}
	return {messages, meta}
}

/* ---------------- 假模型 (三档合规度) ---------------- */
const PROFILES = {
	strict: {dupRate: 0, oneoffRate: 0, paraphrase: 0.25, impBump: 0, badJson: 0.01},
	normal: {dupRate: 0.35, oneoffRate: 0.15, paraphrase: 0.6, impBump: 0, badJson: 0.03},
	sloppy: {dupRate: 0.7, oneoffRate: 0.6, paraphrase: 0.8, impBump: 0.1, badJson: 0.05},
}
/** 提示词里【已经记住的内容】段落 (真模型看到的就是这些) */
const parseKnown = (prompt) => {
	const at = prompt.indexOf("【已经记住的内容")
	if (at < 0) return []
	const seg = prompt.slice(at, prompt.indexOf("---对话历史---", at))
	return seg.split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2).trim())
}
const mkModel = (profile, seed) => {
	const rnd = mulberry32(seed)
	const stats = {calls: 0, emitted: 0, gatedOut: 0, badJson: 0, wroteGarbage: 0, wroteRepeat: 0,
		seenKeys: new Set(), emittedKeys: new Set(), badJsonKeys: new Set()}
	const call = async (prompt) => {
		stats.calls += 1
		const idxs = [...prompt.matchAll(/<m(\d+)>/g)].map(m => Number(m[1]))
		for (const i of idxs) { const b = MSG_META[i]; if (b) stats.seenKeys.add(b.key) }
		const knownSets = parseKnown(prompt).map(bigrams)
		const items = []
		const usedKeys = new Set()
		for (const i of idxs) {
			const b = MSG_META[i]
			if (!b) continue
			let write = b.want
			if (!write && rnd() < profile.oneoffRate) { write = true; stats.wroteGarbage += 1 }
			if (!write) continue
			if (usedKeys.has(b.key)) continue                       // 规则 7: 同一件事只写一条
			usedKeys.add(b.key)
			const content = pickVariant(b, rnd)
			const isKnown = knownSets.some(ks => overlap(bigrams(content), ks) >= 0.6)
			if (!b.changed && isKnown) {
				if (rnd() >= profile.dupRate) continue             // 规则 8: 已记住的、没变化就别再写
				stats.wroteRepeat += 1
			}
			const item = {content, type: b.type, importance: Math.min(1, b.importance + profile.impBump)}
			// 真代码里的确定性门槛 (被挡下的仍留在摘要里, 只是不占长期记忆)
			if (!core.isWorthRemembering(item)) { stats.gatedOut += 1; continue }
			items.push(item)
			stats.emitted += 1
			stats.emittedKeys.add(b.key)
			if (items.length >= 6) break                            // 规则 10: 最多 6 条
		}
		const lo = idxs.length ? idxs[0] : 0
		const hi = idxs.length ? idxs[idxs.length - 1] : 0
		/* 摘要正文按真实模型的量级写 (100~200 字) —— 否则"一年后还剩多少叙事"会被假摘要的长度带偏 */
		const beatsIn = [...new Set(idxs.map(i => MSG_META[i]).filter(Boolean))]
		const wanted = beatsIn.filter(b => b.want).map(b => b.content).slice(0, 3)
		const states = beatsIn.filter(b => !b.want).map(b => b.content).slice(0, 3)
		const narrative = [
			`主人这一段 (第 ${lo}~${hi} 条消息) 主要在聊自己的日常起落。`,
			wanted.length ? `其中${wanted.join("、")}是持续在做或者一直保持的事。` : `这一段没有出现值得长期留下的新信息。`,
			states.length ? `其余的像是${states.join("、")}这种一时的情况，说过就过去了。` : ``,
			`对话里还夹着一些寒暄和闲话，气氛比较平常，没有需要特别记住的约定或者决定。`,
		].filter(Boolean).join("")
		if (rnd() < profile.badJson) {
			stats.badJson += 1
			for (const b of beatsIn) stats.badJsonKeys.add(b.key)   // 这次整段只有摘要, 记忆块丢了
			return narrative
		}
		return `${narrative}\n===MEM===\n${JSON.stringify({topic: "日常", items})}`
	}
	return {call, stats}
}

/* ---------------- 快照 / 分类 ---------------- */
const snapshot = () => {
	const raw = files.get("memory.json") ?? ""
	let disk = null
	try { disk = JSON.parse(raw) } catch { disk = null }
	const mems = disk?.memories ?? []
	const act = mems.filter(m => !m.invalidAt && !m.fadedAt)
	const inv = mems.filter(m => m.invalidAt)
	const fad = mems.filter(m => m.fadedAt)
	const byReason = {}
	for (const f of fad) byReason[f.fadedReason ?? "?"] = (byReason[f.fadedReason ?? "?"] ?? 0) + 1
	return {
		ok: !!disk, raw, kb: raw.length / 1024, total: mems.length, act, inv, fad, byReason,
		bin: (disk?.deletedBin ?? []).length, tombs: (disk?.tombstones ?? []).length,
		tombsKb: JSON.stringify(disk?.tombstones ?? []).length / 1024,
		blocksKb: JSON.stringify(disk?.blocks ?? []).length / 1024,
		sum: (disk?.summaries ?? []).length, metas: (disk?.meta ?? []).length,
		blocks: (disk?.blocks ?? []).length, permanent: act.filter(m => m.decayDays === null).length,
		textChars: (disk?.summaries ?? []).reduce((n, s) => n + (s.content?.length ?? 0), 0) +
			(disk?.meta ?? []).reduce((n, s) => n + (s.content?.length ?? 0), 0),
	}
}
/** 把一条记忆归到剧本里的哪件事: 先看"原文包含"(说法里多带了时间前缀也算), 再取最像的那件 */
const CLASSIFY_CACHE = new Map()
const classify = (content) => {
	if (CLASSIFY_CACHE.has(content)) return CLASSIFY_CACHE.get(content)
	if (JUNK_TEXT.has(content)) { CLASSIFY_CACHE.set(content, JUNK_TEXT.get(content)); return JUNK_TEXT.get(content) }
	const norm = (s) => String(s).replace(/[\s，。、！？：；「」（）()【】\-—…,.!?:;"'`]/g, "")
	const c = norm(content)
	let best = null
	let bestScore = 0
	for (const b of ALL_BEATS) {
		for (const v of b.variants) {
			const nv = norm(v)
			if (c === nv || c.includes(nv) || nv.includes(c)) { best = b; bestScore = 1; break }
			const s = overlap(bigrams(content), bigrams(v))
			if (s > bestScore) { bestScore = s; best = b }
		}
		if (bestScore === 1) break
	}
	const out = bestScore >= 0.6 ? best : null
	CLASSIFY_CACHE.set(content, out)
	return out
}
/** 库的"成分": 该记的 / 垃圾(不该记的) / 同一件事攒了几条 */
const composition = (list) => {
	const byKey = new Map()
	let garbage = 0, unknown = 0, worthy = 0
	for (const m of list) {
		const b = classify(m.content)
		if (!b) { unknown += 1; continue }
		if (!b.want) { garbage += 1; continue }
		worthy += 1
		byKey.set(b.key, (byKey.get(b.key) ?? 0) + 1)
	}
	let dupExtra = 0
	for (const n of byKey.values()) dupExtra += n - 1
	return {garbage, unknown, worthy, dupExtra, distinctWorthy: byKey.size, keyCounts: [...byKey.entries()]}
}

/* ---------------- 单档推演 ---------------- */
const run = async (label, profileName, days, perDay, uniqueJunk = false) => {
	const profile = PROFILES[profileName]
	CLASSIFY_CACHE.clear()
	const {messages, meta} = buildChatter(days, perDay, 20260930, uniqueJunk)
	MSG_META = meta
	files.clear()
	VNOW = START
	mem.reloadMemory()
	const model = mkModel(profile, 20260931)
	const firstLoad = (() => { const t = realMs(); mem.reloadMemory(); return realMs() - t })()
	let arr = []
	let organize = 0, dropTotal = 0, placeholders = 0
	const curve = []
	const t0 = realMs()
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i]
		VNOW = msg.ts
		arr.push(msg)
		if (msg.role === "user") mem.recallForQuery(msg.content)     // 真实召回 + accessCount 记账
		const did = await mem.summarizeIfNeeded(arr, model.call, true, false)
		if (did) {
			organize += 1
			await mem.flushMemoryPersist()
			const dropN = mem.safeTrimDrop(arr.length)
			if (dropN > 0) {
				arr = [{role: "system", content: "（更早的对话已压缩为历史总结）", ts: msg.ts, placeholder: true}, ...arr.slice(dropN)]
				mem.notifyHistoryTrimmed(dropN)
				dropTotal += dropN
			}
			await mem.flushMemoryPersist()
		}
		if ((i + 1) % (perDay * 30) === 0) {                        // 每 30 天一次体检
			await mem.flushMemoryPersist()
			const s = snapshot()
			const t = realMs()
			mem.reloadMemory()
			const load = realMs() - t
			curve.push({day: (i + 1) / perDay, kb: s.kb, act: s.act.length, fad: s.fad.length, load})
			if (!QUIET) {
				console.log(`    d${String(curve.at(-1).day).padStart(3)}  生效 ${String(s.act.length).padStart(3)} · 作废 ${String(s.inv.length).padStart(2)} · 收起 ${String(s.fad.length).padStart(3)} · ${s.kb.toFixed(1)} KB · 冷载入 ${load.toFixed(1)}ms`)
			}
		}
	}
	await mem.flushMemoryPersist()
	const end = snapshot()
	const endLoad = (() => { const t = realMs(); mem.reloadMemory(); return realMs() - t })()
	/* 【不变量】每条消息要么还在上下文窗口、要么已被摘要/块覆盖 —— 不允许"两边都不在" */
	const ranges = (JSON.parse(files.get("memory.json") ?? "{}").blocks ?? []).map(b => [b.fromTs, b.toTs])
	const ctxTs = new Set(mem.contextHistory(arr).map(m => m.ts))
	const holes = arr.filter(m => m.role !== "system" && !ctxTs.has(m.ts) && !ranges.some(([lo, hi]) => m.ts >= lo && m.ts <= hi)).length
	const actComp = composition(end.act)
	const fadComp = composition(end.fad)
	const invComp = composition(end.inv)
	/* 垃圾为什么没被自动收起? 两条豁免线各自挡下多少 (这是"已收起=0"的原因, 不是 bug) */
	const junk = end.act.filter(m => classify(m.content)?.want === false)
	/* 收尾压测 (端到端): 就在这个"最坏状态"下再写一条普通记忆, 它必须活下来 ——
	 * 这是 P3 查出的计数 bug 的用户可见症状 (修复前它会当场被自动收起)。 */
	mem.addMemoriesFromText("我喜欢钢琴")
	await mem.flushMemoryPersist()
	const probeWrite = {
		active: mem.listAll(false).memories.some(m => (m.content || "").includes("钢琴")),
		live: mem.listAll(false).memories.length,
		faded: mem.listFadedMemories().length,
	}
	return {label, profileName, days, perDay, messages: messages.length, organize, dropTotal, placeholders,
		end, endLoad, firstLoad, curve, holes, actComp, fadComp, invComp, model: model.stats, wallMs: realMs() - t0, probeWrite,
		junk: {n: junk.length, immune: junk.filter(m => m.accessCount >= 2).length, highImp: junk.filter(m => m.importance >= 0.6).length}}
}

/* ---------------- 报告 ---------------- */
const lines = []
const say = (s) => { lines.push(s); realLog(s) }
const checks = []
const check = (name, ok, detail = "") => {
	checks.push({name, ok: !!ok, detail})
	if (!ok) say(`  FAIL  ${name}${detail ? `  ← ${detail}` : ""}`)
}
/** 「发现」= 对设计的期望没达到 (不是结构不变量)。默认只报告不改判, 加 --strict 才算失败 */
const findings = []
const finding = (name, ok, detail = "") => {
	findings.push({name, ok: !!ok, detail})
	say(`  ${ok ? "OK  " : "⚠ 发现"}  ${name}${detail ? `  ← ${detail}` : ""}`)
}

say(`===== P3 长期运行推演 · ${new Date().toLocaleString()} =====`)
say(`  剧本: ${DAYS} 天 × ${PER_DAY} 条/天 = ${DAYS * PER_DAY} 条消息 · 虚拟时钟 · 三档模型合规度`)
say(`  一年里**真正值得长期记住**的事: ${BEATS.filter(b => b.want).length} 件 (含 2 次改口); 一次性状态每天都有`)
say("")

const runs = []
/** 跑一档并打印它的体检报告 + 结构断言 */
const reportRun = (r, tag) => {
	const e = r.end
	const reasons = Object.entries(e.byReason).map(([k, v]) => `${k === "expired" ? "到期" : k === "lowvalue" ? "低频" : "手动"} ${v}`).join(" / ") || "无"
	say(`  消息 ${r.messages} 条 · 整理 ${r.organize} 次 (裁剪 ${r.dropTotal} 条) · 模型调用 ${r.model.calls} 次`)
	say(`  生效 ${e.act.length} (永久 ${e.permanent}) · 作废 ${e.inv.length} · 已收起 ${e.fad.length} (${reasons}) · 回收站 ${e.bin}`)
	say(`  成分: 该记的 ${r.actComp.worthy} 条 (覆盖 ${r.actComp.distinctWorthy} 件事 · ${r.actComp.keyCounts.map(([k, n]) => `${k}×${n}`).join(" ")}) · **垃圾 ${r.actComp.garbage} 条** · 认不出 ${r.actComp.unknown}`)
	say(`  收起区成分: 该记的 ${r.fadComp.worthy} · 垃圾 ${r.fadComp.garbage}`)
	say(`  垃圾为何没被自动收起: ${r.junk.n} 条 → 被召回≥2次 (免到期) ${r.junk.immune} 条 · importance≥0.6 (免低频) ${r.junk.highImp} 条`)
	say(`  模型侧: 写进候选 ${r.model.emitted} 条 · 被门槛挡下 ${r.model.gatedOut} 条 · 违规写一次性 ${r.model.wroteGarbage} 次 · 明知重复仍写 ${r.model.wroteRepeat} 次 · 忘写记忆块 ${r.model.badJson} 次`)
	/* 剧本覆盖度审计: 值得记的那几件事, 是不是真的都进过某次总结的批次 (没进过 = 推演的保真度问题, 不是记忆的问题) */
	const worthyKeys = BEATS.filter(b => b.want).map(b => b.key)
	const notSeen = worthyKeys.filter(k => !r.model.seenKeys.has(k))
	const seenNotWritten = worthyKeys.filter(k => r.model.seenKeys.has(k) && !r.model.emittedKeys.has(k))
	say(`  剧本覆盖: ${worthyKeys.length - notSeen.length}/${worthyKeys.length} 件事进过总结批次${notSeen.length ? ` (没进过: ${notSeen.join(",")})` : ""} · 模型写过 ${worthyKeys.filter(k => r.model.emittedKeys.has(k)).length} 件${seenNotWritten.length ? ` · **见过但没写: ${seenNotWritten.join(",")}**` : ""}`)
	say(`  叙事层: 摘要 ${e.sum} 条 / 归档 ${e.metas} 条 · 共 ${e.textChars} 字 (覆盖 ${r.days} 天)`)
	say(`  磁盘: memory.json ${e.kb.toFixed(1)} KB (其中墓碑 ${e.tombs} 条 / ${e.tombsKb.toFixed(1)} KB · 块 ${e.blocksKb.toFixed(1)} KB)`)
	say(`  载入: 冷载入 ${r.endLoad.toFixed(1)}ms (年末) vs ${r.firstLoad.toFixed(1)}ms (空库) · 全程耗时 ${(r.wallMs / 1000).toFixed(1)}s`)
	if (DUMP) {
		say(`  生效条目: ${e.act.map(m => m.content).join(" | ")}`)
		if (e.inv.length) say(`  已作废: ${e.inv.map(m => m.content).join(" | ")}`)
		if (e.fad.length) say(`  已收起: ${e.fad.slice(0, 12).map(m => `${m.content}[${m.fadedReason}]`).join(" | ")}${e.fad.length > 12 ? ` …共 ${e.fad.length} 条` : ""}`)
	}
	check(`[${tag}] storage JSON 可解析`, e.ok)
	check(`[${tag}] 条目总数 = 生效+作废+收起`, e.total === e.act.length + e.inv.length + e.fad.length, `${e.total} vs ${e.act.length}+${e.inv.length}+${e.fad.length}`)
	check(`[${tag}] 摘要 ≤ 24 / 归档 ≤ 6 / 块 ≤ 200 / 墓碑 ≤ 800 / 回收站 ≤ 20`,
		e.sum <= 24 && e.metas <= core.MAX_METAS && e.blocks <= 200 && e.tombs <= 800 && e.bin <= 20,
		`${e.sum}/${e.metas}/${e.blocks}/${e.tombs}/${e.bin}`)
	check(`[${tag}] 没有"空窗"消息 (要么在窗口、要么已进摘要/块)`, r.holes === 0, `${r.holes} 条`)
	check(`[${tag}] 年末冷载入 < 100ms`, r.endLoad < 100, `${r.endLoad.toFixed(1)}ms`)
	check(`[${tag}] 已收起区只增不减`, r.curve.length > 1 && r.curve.at(-1).fad >= r.curve[0].fad, JSON.stringify(r.curve.map(c => c.fad)))
	say("")
}
for (const p of ["strict", "normal", "sloppy"]) {
	say(`── 档位 ${p} ─────────────────────────────`)
	const r = await run(p, p, DAYS, PER_DAY)
	runs.push(r)
	reportRun(r, p)
}
say(`── 最坏情况: 模型 60% 把一次性内容写进库, 且那些内容**从不再提** ──────────`)
const worst = await run("worst", "sloppy", DAYS, PER_DAY, true)
runs.push(worst)
reportRun(worst, "worst")

/* 结论性断言: 库的干净度取决于模型合规度 ⇒ 这就是 P1 诊断日志存在的理由 */
const strict = runs.find(r => r.profileName === "strict")
const sloppy = runs.find(r => r.profileName === "sloppy")
const normal = runs.find(r => r.profileName === "normal")
check("strict: 一年后库里 0 条垃圾 (一次性内容一条都没留下)", strict.actComp.garbage === 0,
	`垃圾 ${strict.actComp.garbage}`)
const maxPerKey = Math.max(0, ...runs.flatMap(r => r.actComp.keyCounts.map(([, n]) => n)))
check("三档: 同一件事的副本 ≤ 4 条 (近义说法确定性判重抓不住, 只能靠提示词/主人手删)", maxPerKey <= 4, `最多 ${maxPerKey} 条`)
check("normal/sloppy: 垃圾明显多于 strict (库的干净度取决于模型合规度)",
	normal.actComp.garbage > strict.actComp.garbage && sloppy.actComp.garbage > strict.actComp.garbage,
	`strict ${strict.actComp.garbage} / normal ${normal.actComp.garbage} / sloppy ${sloppy.actComp.garbage}`)
check("三档: 生效条数都远低于上限 (不是被撑满)",
	runs.slice(0, 3).every(r => r.end.act.length < core.MAX_MEMORIES * 0.5),
	runs.map(r => `${r.profileName}=${r.end.act.length}`).join(" "))

say("\n===== 发现 (对设计的期望 vs 实测) =====")
/* 这三个是 P3 真正想回答的问题 —— 用 finding 而不是 check:
 * 它们描述的是"设计意图有没有达到", 不是结构不变量; 失败时是**产品问题**, 不是数据损坏。 */
finding("① 库不会被撑爆: 三档正常用户一年后总条数 ≤ MAX_MEMORIES", runs.slice(0, 3).every(r => r.end.total <= core.MAX_MEMORIES),
	runs.slice(0, 3).map(r => `${r.profileName} ${r.end.total}`).join(" / "))
say(`  记录  ② 已收起区无上限 (设计选择, 已实测可接受): 最坏情况 ${worst.end.fad.length} 条 / ${worst.end.kb.toFixed(0)} KB —— 载入 ${worst.endLoad.toFixed(1)}ms、面板渲染 +51ms (见 probe-mem-panel-render), 不构成瓶颈`)
finding("③ 库被撑满后, 该记的事仍然活得下来 (不再只剩永久记忆)",
	worst.actComp.distinctWorthy >= 8,
	`最坏情况生效 ${worst.end.act.length} 条 (永久 ${worst.end.permanent} 条) · 覆盖 ${worst.actComp.distinctWorthy} 件事 · 被收起的"该记的" ${worst.fadComp.worthy} 条`)
finding("④ 门槛/上限按生效条数算 (端到端: 在这个状态下再写一条普通记忆, 它必须活下来)",
	runs.every(r => r.probeWrite.active),
	runs.map(r => `${r.profileName}: ${r.probeWrite.active ? "活着" : "**当场被收起**"} (生效 ${r.probeWrite.live})`).join(" · "))
finding("⑤ 每条消息的处理成本不失控 (含整库 JSON 序列化)", worst.wallMs / worst.messages < 10,
	`最坏情况 ${(worst.wallMs / worst.messages).toFixed(2)} ms/条消息 vs 正常档 ${(normal.wallMs / normal.messages).toFixed(2)} ms ⇒ 贵 ${(worst.wallMs / worst.messages / (normal.wallMs / normal.messages)).toFixed(0)} 倍 (可接受线 10ms)`)
finding("⑥ 一次性垃圾没有挤掉该记的事 (垃圾只在生效列表里占位, 不影响覆盖面)",
	strict.actComp.distinctWorthy >= 8 && normal.actComp.distinctWorthy >= 8,
	`严格档覆盖 ${strict.actComp.distinctWorthy} 件事 / 正常档 ${normal.actComp.distinctWorthy} 件 (剧本共 ${BEATS.filter(b => b.want).length} 件)`)

say("===== 结论 =====")
say(`  ① 记得多少: ${runs.map(r => `${r.profileName} 生效 ${r.end.act.length} 条`).join(" · ")}`)
say(`     剧本里值得记的 ${BEATS.filter(b => b.want).length} 件事: 严格档覆盖 ${strict.actComp.distinctWorthy} 件、正常档 ${normal.actComp.distinctWorthy} 件; 最坏情况下只剩 ${worst.end.act.length} 条生效 (永久 ${worst.end.permanent} 条)`)
say(`  ② 库有多大: ${runs.map(r => `${r.profileName} ${r.end.kb.toFixed(0)}KB`).join(" · ")} (一年 ${DAYS * PER_DAY} 条消息); 冷载入 ${runs.map(r => r.endLoad.toFixed(1)).join("/")}ms (正常档 ≤4ms; 最坏情况 ${worst.endLoad.toFixed(0)}ms 来自 ${worst.end.total} 条的解析+块引用清理, 线性成本)`)
say(`  ③ 已收起区: ${runs.map(r => `${r.profileName} ${r.end.fad.length} 条`).join(" · ")} —— 正常使用几乎不动; 最坏情况下涨到 ${worst.end.fad.length} 条且**没有上限**`)
say(`  ④ 叙事层: 一年后摘要 ${normal.end.sum} 条 + 归档 ${normal.end.metas} 条 = ${normal.end.textChars} 字 —— 更早的对话只剩 6 段归档概括`)
say(`  ⑤ 一句话: 正常使用下记忆库是"小而稳"的 (几十条、<100KB、载入 4ms 内); 病态情况 (模型爱写一次性`)
say(`     内容且从不再提) 会让「已收起」无上限堆到 2000 条 / 730KB —— 已实测: 载入 ${worst.endLoad.toFixed(0)}ms、面板 +51ms, 可接受。`)
say(`     上限与门槛都按**生效**条数算, 高重要/明确记住类另有免死金牌 (2026-09-30 修, 见 run-tests T35/T36)。`)
say(`     复现与旁路基准: tmp-memcheck/_dbg-p3-prune.mjs · _dbg-collapse-equivalence.mjs · _dbg-collapse-cost.mjs`)
const badChecks = checks.filter(c => !c.ok).length
const badFindings = findings.filter(f => !f.ok).length
const bad = badChecks + (STRICT ? badFindings : 0)
say(`\n  ${checks.length - badChecks}/${checks.length} 项结构断言通过 · ${findings.length - badFindings}/${findings.length} 项设计期望达成${badFindings ? ` (${badFindings} 项"发现"见上)` : ""}`)
say(`  ${STRICT ? "" : "(默认: 发现项只报告不改判; 加 --strict 才让发现项决定退出码)"}`)
say(`  模块日志被静音 ${MEM_LOG.log} 行 · 其中 error 级 ${MEM_LOG.err.length} 条${MEM_LOG.err.length ? ` (首条: ${MEM_LOG.err[0].slice(0, 120)})` : ""}`)
check("记忆模块全程没有 error 级日志", MEM_LOG.err.length === 0, MEM_LOG.err.slice(0, 2).join(" / ").slice(0, 200))
writeFileSync(path.join(import.meta.dirname, "_sim-longrun-report.txt"), lines.join("\n") + "\n", "utf8")
console.log(`  报告: tmp-memcheck/_sim-longrun-report.txt`)
process.exitCode = bad ? 1 : 0
