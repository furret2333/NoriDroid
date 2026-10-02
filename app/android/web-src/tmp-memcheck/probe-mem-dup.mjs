/* 探针: 长期记忆"重复"到底怎么产生的 —— 只读测量, 不改产品代码。
   用真实 memory-bundle (services/memory) 复现两条入库通道:
     ① 规则通道 addMemoriesFromText (extractMemoriesSmart 的第 1 步)
     ② LLM 通道 applyLlmMemoryDecision (记忆开关开启时, 有 fake LLM 提供事实与决策)
   关注: 同一件事换一种说法再说一遍, 库里会不会变成 2 条。 */
import path from "node:path"
import {pathToFileURL} from "node:url"

await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)   // 先重建 bundle, 避免读到旧产物
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {
	NoriChat: {
		readFile: (n) => files.get(n) ?? "",
		writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
	},
}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

const seedDisk = (memories = []) => {
	files.set("memory.json", JSON.stringify({
		memories, summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [],
	}))
	mem.reloadMemory()
}
const contents = () => mem.listAll().memories.map(m => m.content)

/* ---------------- ① 规则通道: 同一件事换说法 ---------------- */
console.log("=".repeat(72))
console.log("① 规则通道 addMemoriesFromText —— 同一件事的不同说法")
console.log("=".repeat(72))
const ruleGroups = [
	["我叫小明", "我的名字是小明", "我是小明"],
	["我喜欢下雨天", "我最喜欢下雨天", "我超喜欢下雨天"],
	["我在准备考研", "我准备考研", "我在备考考研"],
	["我养了只猫", "我养了一只猫", "我家养了只猫"],
	["我住在杭州市", "我家在杭州市", "我住在杭州"],
	["我是做前端的", "我的工作是前端", "我职业是前端开发"],
]
for (const group of ruleGroups) {
	seedDisk([])
	for (const text of group) mem.addMemoriesFromText(text)
	const list = contents()
	console.log(`  ${JSON.stringify(group.join(" / "))}`)
	console.log(`    → 库内 ${list.length} 条: ${JSON.stringify(list)}  ${list.length > 1 ? "★重复" : ""}`)
}

/* ---------------- ② LLM 通道: AI 提取 + 决策 ---------------- */
console.log("")
console.log("=".repeat(72))
console.log("② LLM 通道 applyLlmMemoryDecision —— 有旧记忆且字面重叠时的判重")
console.log("=".repeat(72))

const fact = (content, type = "fact", importance = 0.8) => ({
	id: `m_${Math.random().toString(36).slice(2, 8)}`, content, type,
	importance, confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now(),
	lastAccessedAt: 0, accessCount: 0, tags: [],
	decayDays: core.defaultDecayDays(type),
})

/** fake LLM: 决策提示词 (「你是记忆库管理员」) → 决策 JSON; 其余 (提取提示词) → facts 包装 */
const fakeLlm = (facts, decisions) => async (prompt) => {
	if (prompt.includes("记忆库管理员")) return JSON.stringify({memory: decisions})
	return JSON.stringify({facts})
}

const llmCases = [
	{
		name: "同义改写 (零字面重叠) → 同类兜底把旧条交给 AI, 决策 NONE",
		old: ["我的名字是小明"],
		facts: ["我叫小明"],
		decisions: [{id: "OLD", event: "NONE"}],
	},
	{
		name: "LLM 事实 与旧记忆有 2 个 bigram 重叠 → 调决策; 决策给 NONE",
		old: ["我在准备考研考试"],
		facts: ["我准备考研"],
		decisions: [{id: "OLD", event: "NONE"}],
	},
	{
		name: "决策给出编造 id (旧条保留 + 新事实照常入库)",
		old: ["我在准备考研"],
		facts: ["我在准备考研"],
		decisions: [{id: "not-exist", event: "DELETE"}],
	},
	{
		name: "决策 UPDATE 文本比旧条短 (拒绝改写, 新事实另存)",
		old: ["我的名字叫小明，是个前端工程师"],
		facts: ["我叫小明"],
		decisions: [{id: "OLD", event: "UPDATE", text: "我叫小明"}],
	},
]

for (const c of llmCases) {
	const seedItems = c.old.map((t, i) => ({...fact(t), id: `old_${i}`}))
	seedDisk(seedItems)
	// 决策里的 OLD 换成真实 id (用占位 id 时产品会正确地忽略该决策 —— 那是探针的错, 不是产品的)
	const decisions = c.decisions.map(d => ({...d, id: d.id === "OLD" ? seedItems[0].id : d.id}))
	const res = await mem.applyLlmMemoryDecision(
		c.facts.map(f => fact(f)),
		fakeLlm(c.facts.map(f => ({content: f, type: "fact"})), decisions),
	)
	await mem.flushMemoryPersist()
	const list = contents()
	const dup = list.length > c.old.length
	console.log(`  ${c.name}`)
	console.log(`    旧: ${JSON.stringify(c.old)} + 新: ${JSON.stringify(c.facts)}`)
	console.log(`    → ${list.length} 条 ${JSON.stringify(list)} | 结果 ${JSON.stringify(res)}  ${dup ? "★重复" : "✓不重复"}`)
}

/* ---------------- ③ 摘要「记忆要点」回流 ---------------- */
console.log("")
console.log("=".repeat(72))
console.log("③ 摘要要点回流 summarizeIfNeeded —— 要点 vs 已有记忆")
console.log("=".repeat(72))
{
	seedDisk([{...fact("我喜欢下雨天", "preference"), id: "p0"}])
	const msgs = []
	for (let i = 0; i < 60; i += 1) msgs.push({role: "user", content: `消息${i}`, ts: 1700000000000 + i * 1000})
	const ok = await mem.summarizeIfNeeded(msgs, async () => "【摘要】聊了天气。\n【记忆要点】\n- 我喜欢下雨天\n- 我在准备考研")
	await mem.flushMemoryPersist()
	console.log(`  生成摘要=${ok}`)
	console.log(`    → 库内 ${contents().length} 条: ${JSON.stringify(contents())}`)
}

/* ---------------- ④ 归一化边界: 哪些"同义"写法被判为不同 ---------------- */
console.log("")
console.log("=".repeat(72))
console.log("④ normalizeContent 的判重能力边界 (merge 的实际比较键)")
console.log("=".repeat(72))
const pairs = [
	["我叫小明", "我的名字是小明"],
	["我喜欢下雨天", "雨天我很喜欢"],
	["我在准备考研", "考研在准备中"],
	["我养了一只猫", "我有一只猫"],
	["我是前端工程师", "我做前端开发"],
	["我的生日是五月一号", "我五月一号生日"],
]
for (const [a, b] of pairs) {
	const na = core.normalizeContent(a), nb = core.normalizeContent(b)
	const hit = na === nb || na.includes(nb) || nb.includes(na)
	// bigram Dice 相似度 (候选去重判据)
	const bi = (s) => { const o = []; for (let i = 0; i < s.length - 1; i += 1) o.push(s.slice(i, i + 2)); return o }
	const A = bi(na), B = bi(nb)
	const inter = A.filter(x => B.includes(x)).length
	const dice = (A.length + B.length) ? (2 * inter) / (A.length + B.length) : 0
	console.log(`  ${a}  vs  ${b}`)
	console.log(`    normalize: "${na}" / "${nb}"  包含判重=${hit ? "命中" : "★漏"}  bigramDice=${dice.toFixed(3)}`)
}
