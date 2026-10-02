/* 等价性证明: collapseDuplicateMemories 的"记忆化改写版"必须与旧实现**逐条同判**
 * (2026-09-30, 8.1 冷载入优化前的风险控制)
 *
 * 为什么要有它: 这个函数在**每次载入**时自动合并"确定无疑的重复", 误并 = 静默丢主人信息。
 * 改写版唯一的"新东西"是缓存 (normalize 结果记忆化) —— 而**合并会把 kept[hit] 的内容
 * 换成更长的那条**, 缓存若不跟着更新就会用旧内容继续比对 (这正是要证明的地方)。
 *
 * 做法: 本文件里内置一份**旧实现的逐字拷贝**(oracle), 让它和 bundle 里的当前实现在同一批语料上
 * 跑, 比对: removed 数 / 被丢的 id 与顺序 / 留下的完整 store (含各字段), 时钟钉死以便比较 updatedAt。
 *
 * 运行: cd web-src && node tmp-memcheck/_dbg-collapse-equivalence.mjs
 *   (8.1 改动**前**跑: 两边本就是同一套逻辑, 用于验证本脚本本身有效 —— 应全绿;
 *    改动**后**跑: 才是在证明新实现与旧判定等价 —— 也必须全绿, 否则回退)
 */
import {pathToFileURL} from "node:url"

await import("./build-mem-bundles.mjs")
const core = await import(pathToFileURL("./tmp-memcheck/core-bundle.mjs").href)

/* 时钟钉死: 合并时会写 updatedAt: Date.now(), 不钉死就没法逐字段比对 */
const FIXED = 1_800_000_000_000
const REAL_NOW = Date.now
Date.now = () => FIXED

const isActive = (m) => !!m && !m.invalidAt && !m.fadedAt

/* ---------- 旧实现 (逐字拷贝自 core.ts, 改动前的那一版) ---------- */
const COLLAPSE_SUBJECT_PREFIXES = ["我的名字是", "我的名字叫", "我的名字", "我叫", "我是", "我", "自己", "主人"]
const collapseSameContent = (a, b) => {
	const x = core.normalizeForCompare(a)
	const y = core.normalizeForCompare(b)
	if (!x || !y) return false
	if (x === y) return true
	const [short, long] = x.length <= y.length ? [x, y] : [y, x]
	return COLLAPSE_SUBJECT_PREFIXES.some(p => long.startsWith(p) && long.slice(p.length) === short)
}
const oracleCollapse = (store, limit = 50) => {
	const list = store.memories
	if (list.length < 2) return {removed: 0, dropped: []}
	const kept = []
	const gone = []
	let removed = 0
	for (const it of list) {
		if (!it || typeof it.content !== "string") { kept.push(it); continue }
		if (!isActive(it)) { kept.push(it); continue }
		const norm = core.normalizeForCompare(it.content)
		if (!norm) { kept.push(it); continue }
		let hit = -1
		for (let i = kept.length - 1; i >= 0; i -= 1) {
			if (!isActive(kept[i])) continue
			if (collapseSameContent(kept[i].content, it.content)) { hit = i; break }
		}
		if (hit < 0 || removed >= limit) { kept.push(it); continue }
		removed += 1
		gone.push(it)
		const a = kept[hit]
		kept[hit] = {
			...a,
			content: it.content.length > a.content.length ? it.content : a.content,
			importance: Math.max(a.importance, it.importance),
			confidence: Math.max(a.confidence, it.confidence),
			decayDays: a.decayDays === null || it.decayDays === null ? null : a.decayDays,
			tags: [...new Set([...(a.tags ?? []), ...(it.tags ?? [])])],
			updatedAt: Date.now(),
		}
	}
	if (!removed) return {removed: 0, dropped: []}
	store.memories = kept
	return {removed, dropped: gone}
}

/* ---------- 语料 ---------- */
const mk = (id, content, over = {}) => ({id, content, type: "preference", importance: 0.6, confidence: 0.9,
	createdAt: FIXED - 1000, updatedAt: FIXED - 1000, lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 90, ...over})
const faded = (id, content) => mk(id, content, {fadedAt: FIXED - 10, fadedReason: "lowvalue"})
const invalid = (id, content) => mk(id, content, {invalidAt: FIXED - 10})

/** ① 边界用例: 每条都对着 collapseSameContent 的一条规则 */
const edge = [
	mk("e01", "我喜欢下雨天"), mk("e02", "我喜欢下雨天哦"),            // 尾语气词 → 该并
	mk("e03", "我喜欢下雨天呀"),                                      // 同上 (同一组第三条)
	mk("e04", "我的名字是小明"), mk("e05", "小明"),                    // 白名单前缀 → 该并
	mk("e06", "我叫小明"), mk("e07", "我是小明"), mk("e08", "自己小明"), mk("e09", "主人小明"),
	mk("e10", "在准备考研"), mk("e11", "我最近在准备考研"),            // 注释明确说**不收** (只剥一次)
	mk("e12", "咖啡"), mk("e13", "每天喝咖啡"),                        // 负例: 不该并
	mk("e14", "猫"), mk("e15", "我家养了一只猫"),                      // 负例: 「我家」不在白名单
	mk("e16", "我喜欢猫"), mk("e17", "我喜欢猫毛"),                    // 负例: 只差一字
	mk("e18", "我喜欢下雨天"), mk("e19", "我不喜欢下雨天"),            // 负例: 改口方向相反
	mk("e20", "   "), mk("e21", ""), mk("e22", "。。。"),               // 清洗后为空
	mk("e23", null), {id: "e24", content: 123},                        // 结构异常
	faded("e25", "我喜欢下雨天"),                                      // 已收起 → 旁观者
	invalid("e26", "我喜欢下雨天"),                                    // 已作废 → 旁观者
	mk("e27", "我喜欢下雨天", {decayDays: null, importance: 0.9, tags: ["explicit"]}),  // 合并要取更永久/更高重要
	mk("e28", "我喜欢下雨天哦", {importance: 0.3, tags: ["pinned"]}),
	mk("e29", "我养了一只龟"), mk("e30", "我养了一只龟"),
]
/** ② 50 条上限: 80 条完全重复 */
const limitCase = Array.from({length: 80}, (_, i) => mk(`L${i}`, "我每天都喝水"))
/** ③ 真实语料复刻 (P3 剧本 + 实机反例 + 常见说法), 每组给不同变体 */
const BASE = ["我在准备考研", "我最近一直在熬夜", "我喜欢下雨天", "我养了一只叫团子的猫", "我不吃香菜",
	"记住：我叫小桧", "我在一家做地图的公司上班", "我最近一直在加班", "我在学吉他", "记住：我每周三晚上要上课",
	"我（小桧）想买鸡蛋", "我想买鸡蛋", "我有点困，准备去睡觉", "我现在困了，准备去睡觉", "今天下雨了",
	"我刚下班到家", "手机快没电了", "在收拾房间", "有点头疼", "在听歌"]
const realish = []
BASE.forEach((t, i) => {
	realish.push(mk(`r${i}a`, t))
	const v = i % 3 === 0 ? `${t}了` : i % 3 === 1 ? `${t}哦` : t
	realish.push(mk(`r${i}b`, v))
})
realish.push(faded("rF1", "我在准备考研"), invalid("rI1", "我喜欢下雨天"), mk("rN1", "我的名字是小桧"))
/** ④ 随机语料 (固定种子) + 故意制造重复/前缀/尾词/埋没在中间 */
let seed = 20260930
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const CH = "我你喜欢不喜欢下雨天考研吉他猫狗咖啡茶睡觉加班公司地图名字小明桧香菜周三四晚上课"
const random = []
for (let i = 0; i < 1500; i += 1) {
	const n = 2 + Math.floor(rnd() * 8)
	let s = ""
	for (let k = 0; k < n; k += 1) s += CH[Math.floor(rnd() * CH.length)]
	const kind = rnd()
	if (kind < 0.12 && random.length > 3) {
		const src = random[Math.floor(rnd() * random.length)]
		s = src.content + ["哦", "呀", "了"][Math.floor(rnd() * 3)]          // 尾语气词重复
	} else if (kind < 0.2 && random.length > 3) {
		s = "我" + random[Math.floor(rnd() * random.length)].content           // 主语前缀重复
	} else if (kind < 0.24) {
		s = faded(`s${i}`, s).content                                          // 已收起 (旁观者)
	}
	const item = mk(`x${i}`, s)
	if (kind >= 0.24 && kind < 0.28) item.fadedAt = FIXED - 5
	if (kind >= 0.28 && kind < 0.31) item.invalidAt = FIXED - 5
	random.push(item)
}

const CORPUS = [["边界用例", edge], ["50 条上限 (80 条重复)", limitCase], ["真实语料复刻", realish], ["随机语料 1500 条", random]]

/* ---------- 比对 ---------- */
let bad = 0
for (const [name, list] of CORPUS) {
	const storeA = {memories: list.map(x => (x ? {...x} : x))}
	const storeB = {memories: list.map(x => (x ? {...x} : x))}
	const A = oracleCollapse(storeA)
	const B = core.collapseDuplicateMemories(storeB)
	const sameIds = (p, q) => p.length === q.length && p.every((x, i) => x === q[i])
	const dropA = A.dropped.map(m => m.id)
	const dropB = B.dropped.map(m => m.id)
	const keptA = (storeA.memories ?? false) === false ? list.map(m => m?.id) : storeA.memories.map(m => m?.id)
	const keptB = (storeB.memories ?? false) === false ? list.map(m => m?.id) : storeB.memories.map(m => m?.id)
	const jsonA = JSON.stringify(storeA.memories ?? list)
	const jsonB = JSON.stringify(storeB.memories ?? list)
	const ok = A.removed === B.removed && sameIds(dropA, dropB) && sameIds(keptA, keptB) && jsonA === jsonB
	if (!ok) {
		bad += 1
		console.log(`FAIL  ${name}: removed ${A.removed} vs ${B.removed} · dropped ${JSON.stringify(dropA)} vs ${JSON.stringify(dropB)}`)
		console.log(`      保留顺序相同? ${sameIds(keptA, keptB)} · 完整内容相同? ${jsonA === jsonB} (长度 ${jsonA.length}/${jsonB.length})`)
	} else {
		console.log(`PASS  ${name}: ${list.length} 条 → 两边都 removed=${A.removed}, 保留 ${keptA.length} 条, 逐字段一致`)
	}
}

Date.now = REAL_NOW
console.log(bad
	? `\n${bad}/${CORPUS.length} 批语料**判定不一致** —— 不许改! (先把差异查清楚)`
	: `\n${CORPUS.length}/${CORPUS.length} 批语料判定完全一致 (removed / 丢弃顺序 / 保留顺序 / 全字段)`)
process.exitCode = bad ? 1 : 0
