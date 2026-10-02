/* 旁路基准: collapseDuplicateMemories 的成本曲线 (2026-09-30, P3 修完计数 bug 后暴露)
 *
 * 背景: 修掉「已收起占名额」之后, 最坏情况的内存库真的会顶到 MAX_MEMORIES=300 条生效,
 * 于是**载入时的存量去重**成了瓶颈: 实测冷载入 180ms (修复前只有 10ms —— 因为那时生效只剩 2 条,
 * 这条路径根本没被跑到)。
 *
 * 本脚本只做两件事 (不改 src):
 *   ① 量真函数的成本曲线: 生效 N 条 × 已收起 M 条 → 耗时;
 *   ② 量一个**判据完全相同**的改写版 (把 normalization 记忆化, 不重复算) 能省多少 ——
 *      用来决定"值不值得改"。
 *
 * 运行: cd web-src && node tmp-memcheck/_dbg-collapse-cost.mjs
 */
import {pathToFileURL} from "node:url"

await import("./build-mem-bundles.mjs")
const core = await import(pathToFileURL("./tmp-memcheck/core-bundle.mjs").href)

const now = Date.now()
const mk = (id, content, over = {}) => ({id, content, type: "preference", importance: 0.6, confidence: 0.9,
	createdAt: now, updatedAt: now, lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 90, ...over})

const timed = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return {ms: Number(process.hrtime.bigint() - t) / 1e6, r} }

/* ---- ② 判据完全相同的改写版: normalization 记忆化 + 廉价长度早退 ----
 * 原版每次比较都 collapseSameContent(a, b) → 内部对 a、b 各 normalize 一次;
 * 同一批里 a 会被反复 normalize (n² 次)。这里每个条目只 normalize 一次。 */
const fastCollapse = (list, limit = core.COLLAPSE_MAX_MERGES) => {
	const PREFIXES = ["我的名字是", "我的名字叫", "我的名字", "我叫", "我是", "我", "自己", "主人"]
	const same = (x, y) => {
		if (x === y) return true
		const [s, l] = x.length <= y.length ? [x, y] : [y, x]
		return PREFIXES.some(p => l.length === s.length + p.length && l.startsWith(p) && l.slice(p.length) === s)
	}
	const kept = []   // {it, norm}
	const gone = []
	let removed = 0
	for (const it of list) {
		if (!it || typeof it.content !== "string" || !core.isActiveMemory(it)) { kept.push({it, norm: null}); continue }
		const norm = core.normalizeForCompare(it.content)
		if (!norm) { kept.push({it, norm: null}); continue }
		let hit = -1
		for (let i = kept.length - 1; i >= 0; i -= 1) {
			const k = kept[i]
			if (k.norm === null || !core.isActiveMemory(k.it)) continue
			if (same(k.norm, norm)) { hit = i; break }
		}
		if (hit < 0 || removed >= limit) { kept.push({it, norm}); continue }
		removed += 1
		gone.push(it)
	}
	return {removed, dropped: gone}
}

const cases = [
	{act: 70, fad: 0}, {act: 70, fad: 2000},
	{act: 150, fad: 0}, {act: 300, fad: 0}, {act: 300, fad: 2000},
]
console.log("生效 | 已收起 | 原版 collapse | 改写版 (判据相同) | 提速")
for (const c of cases) {
	/* 内容彼此不同, 但都带常见主语前缀 (最坏情况: 早退帮不上忙) */
	const list = [
		...Array.from({length: c.act}, (_, i) => mk(`a${i}`, `我在做第${i}件事的时候想了很多`) ),
		...Array.from({length: c.fad}, (_, i) => mk(`f${i}`, `早就收起的旧记忆${i}`, {fadedAt: now - 1000, fadedReason: "lowvalue"})),
	]
	const base = timed(() => core.collapseDuplicateMemories({memories: list.map(x => ({...x}))}))
	const fast = timed(() => fastCollapse(list.map(x => ({...x}))))
	console.log(`${String(c.act).padStart(4)} | ${String(c.fad).padStart(6)} | ${base.ms.toFixed(1).padStart(13)}ms | ${fast.ms.toFixed(1).padStart(16)}ms | ${(base.ms / Math.max(0.01, fast.ms)).toFixed(1)}×`)
}

/* 顺带核对: 两者结果一致 (同一批数据的 removed 数 + 保留条数) */
const dup = [mk("d1", "我喜欢下雨天"), mk("d2", "我喜欢下雨天哦"), mk("d3", "我的名字是小明"), mk("d4", "小明"),
	mk("d5", "我在准备考研"), mk("d6", "在准备考研"), mk("d7", "我不吃香菜")]
const A = core.collapseDuplicateMemories({memories: dup.map(x => ({...x}))})
const B = fastCollapse(dup.map(x => ({...x})))
console.log(`\n判据一致性核对 (7 条含 2 组真重复 + 1 组"只少主语"该不收): 原版 removed=${A.removed} 改写版 removed=${B.removed}`)
console.log(`  原版丢的: ${JSON.stringify(A.dropped.map(m => m.content))}`)
console.log(`  改写丢的: ${JSON.stringify(B.dropped.map(m => m.content))}`)

/* ---- 把"最坏情况的 180ms 冷载入"拆开: 解析 / 双实例合并 / 存量去重 各占多少 ---- */
{
	const list = [
		...Array.from({length: 300}, (_, i) => mk(`a${i}`, `我在做第${i}件事的时候想了很多`)),
		...Array.from({length: 1974}, (_, i) => mk(`f${i}`, `早就收起的旧记忆${i}`, {fadedAt: now - 1000, fadedReason: "lowvalue"})),
	]
	const raw = JSON.stringify({memories: list, summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], schemaVersion: 2})
	const parse = timed(() => JSON.parse(raw))
	const store = parse.r
	const merge = timed(() => core.mergeStores(store, JSON.parse(raw)))
	const collapse = timed(() => core.collapseDuplicateMemories(JSON.parse(raw)))
	const fast = timed(() => fastCollapse(JSON.parse(raw).memories))
	console.log(`\n冷载入 180ms 的构成 (2274 条: 生效 300 + 已收起 1974, memory.json ${(raw.length / 1024).toFixed(0)} KB):`)
	console.log(`  JSON.parse            ${parse.ms.toFixed(1)}ms`)
	console.log(`  双实例合并 mergeStores ${merge.ms.toFixed(1)}ms`)
	console.log(`  存量去重 (原版)        ${collapse.ms.toFixed(1)}ms   ← 可优化`)
	console.log(`  存量去重 (改写版)      ${fast.ms.toFixed(1)}ms`)
	console.log(`  ⇒ 改完预计冷载入 ≈ ${(parse.ms + merge.ms + fast.ms).toFixed(0)}ms (现在 ≈ ${(parse.ms + merge.ms + collapse.ms).toFixed(0)}ms)`)
}

