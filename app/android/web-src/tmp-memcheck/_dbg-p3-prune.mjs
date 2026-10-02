/* 最小复现 / 回归用例: pruneMemories 的计数口径 (P3 长期推演查出, 2026-09-30)
 *
 * 期望行为: **已收起 / 已作废** 的条目不占用 MAX_MEMORIES 的名额 —— 它们不参与召回, 只占文件。
 * 现状 (实测): `pruneMemories` 用**传入数组的总长度**跟 PRUNE_AFTER / MAX_MEMORIES 比,
 *   而 store.memories 里含已收起/已作废的条目, 且自动路径只标记不移出 ⇒ 总条数只增不减。
 *   一旦越过 300, 溢出量被已收起的条数抬高 ⇒ **每写一条普通记忆下一拍就被自动收起**,
 *   最终生效列表只剩永久记忆 (decayDays=null)。推演里的后果: 生效 2 条 / 已收起 2402 条。
 *
 * 修好后本脚本应输出 0/2 项未通过 (exit 0); 现在有 2 项未通过 —— 这是**在报 bug**, 不是脚本坏了。
 *
 * 运行: cd web-src && node tmp-memcheck/_dbg-p3-prune.mjs
 */
import {pathToFileURL} from "node:url"

await import("./build-mem-bundles.mjs")
const core = await import(pathToFileURL("./tmp-memcheck/core-bundle.mjs").href)

const now = Date.now()
const mk = (id, over = {}) => ({id, content: `记忆${id}`, type: "preference", importance: 0.8, confidence: 0.9,
	createdAt: now, updatedAt: now, lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 90, ...over})
const faded = (_, i) => mk(`f${i}`, {fadedAt: now - 1000, fadedReason: "lowvalue"})
const invalid = (_, i) => mk(`v${i}`, {invalidAt: now - 1000})

const cases = [
	{name: "300 条已收起 + 2 条新记忆", items: [...Array.from({length: 300}, faded), mk("a1"), mk("a2")]},
	{name: "300 条已作废 + 2 条新记忆", items: [...Array.from({length: 300}, invalid), mk("b1"), mk("b2")]},
	{name: "50 条已收起 + 2 条新记忆 (未越上限)", items: [...Array.from({length: 50}, faded), mk("c1"), mk("c2")]},
]

console.log(`PRUNE_AFTER = ${core.PRUNE_AFTER} · MAX_MEMORIES = ${core.MAX_MEMORIES}`)
let bad = 0
for (const c of cases) {
	const dropped = core.pruneMemories(c.items).map(x => x.id)
	/* 期望: 三种情形都不该判任何一条"该清理" —— 已收起/已作废不占名额, 生效只有 2 条 (远低于 MAX_MEMORIES) */
	const ok = dropped.length === 0
	if (!ok) bad += 1
	console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}: 总条数 ${c.items.length} → 判该清理 ${JSON.stringify(dropped)}`)
}
console.log(bad
	? `\n${bad}/${cases.length} 项未通过 —— **这是 bug 的复现**: 已收起/已作废的条数把"溢出量"抬高了, 普通记忆一写进去就被收起。`
	: `\n${cases.length}/${cases.length} 项通过 —— 上限只按生效条数算。`)
process.exitCode = bad ? 1 : 0
