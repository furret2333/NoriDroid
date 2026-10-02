/**
 * 探针: 「我想养猫」→「我不想养猫了」这种**跨类型改口**到底有没有机会被作废?
 *
 * 用户实机反馈 (2026-09-27): 前者进「项目」标签, 后者进「偏好」标签, 两条并存,
 * 记忆库里也**没有**任何「已作废」条目。
 *
 * 本探针不改产品代码, 只把链路一段段摊开:
 *   ① 规则通道把这两句各提取成什么 (type/content) —— 类型不一致是不是规则表的问题;
 *   ② 第二条消息时, 判重决策 (LLM) **有没有被调用**;
 *   ③ 被调用时, 提示词里的**候选清单**有没有把「我想养猫」交给模型 (没给 = 模型想删也删不了);
 *   ④ 模型说 ADD (现实里最常见) vs 说 DELETE 两种结果。
 *
 * 运行: cd web-src && node tmp-memcheck/probe-cross-type-reversal.mjs
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {NoriChat: {readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }}}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

const reset = (items = []) => {
	files.set("memory.json", JSON.stringify({memories: items, summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
	mem.reloadMemory()
}
const show = (tag) => {
	const active = mem.listAll().memories.map(m => `[${m.type}]${m.content}`)
	const inv = mem.listInvalidMemories().map(m => `[${m.type}]${m.content}`)
	console.log(`  ${tag}\n    生效: ${JSON.stringify(active)}\n    已作废: ${JSON.stringify(inv)}`)
}

const A = "我想养猫"
const B = "我不想养猫了"

console.log("=".repeat(78))
console.log("① 规则通道对这两句的提取结果 (type 乱 的根源之一)")
console.log("=".repeat(78))
for (const s of [A, B]) {
	const items = core.extractMemories(s)
	console.log(`  「${s}」 → ${items.length ? JSON.stringify(items.map(i => ({type: i.type, content: i.content, imp: i.importance, tags: i.tags}))) : "(规则没接住)"}`)
}

/** 假模型: 交互式记录每次调用, 便于判断"决策到底调没调、候选里有没有旧条" */
const makeLlm = (decisionAnswer) => {
	const calls = []
	const llm = async (p) => {
		const isDecision = p.includes("记忆库管理员")
		calls.push({isDecision, prompt: p})
		if (isDecision) return typeof decisionAnswer === "function" ? decisionAnswer(p) : decisionAnswer
		// 提取段: 只交出"新事实" (现实里模型基本都会这么答)
		return JSON.stringify({facts: [{content: B, type: "preference"}]})
	}
	llm.calls = calls
	return llm
}

/* ② 现实路径: 旧条是**模型**提取的 (规则没接住), 模型这次只 ADD 新事实、对旧条只字不提 */
console.log("")
console.log("=".repeat(78))
console.log("② 模型只给 ADD (对旧条只字不提) —— 实机最可能的情况")
console.log("=".repeat(78))
const seedOld = () => [{
	id: "old_cat", content: A, type: "project", importance: 0.6, confidence: 0.7,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 60,
}]
{
	reset(seedOld())
	console.log(`  第一条已入库 (模型标的类型): ${JSON.stringify(seedOld().map(i => ({type: i.type, content: i.content})))}`)
	const llm = makeLlm(JSON.stringify({memory: [{id: "new", text: B, event: "ADD"}]}))
	const r = await mem.extractMemoriesSmart(B, llm)
	await mem.flushMemoryPersist()
	console.log(`  LLM 调用: ${llm.calls.length} 次 (提取 ${llm.calls.filter(c => !c.isDecision).length} · 判重决策 ${llm.calls.filter(c => c.isDecision).length})`)
	const dec = llm.calls.find(c => c.isDecision)
	console.log(`  ${dec ? "决策候选清单里有没有旧条: " + (dec.prompt.includes(A) ? "有 ✓ (模型有机会删)" : "没有 ✗ (模型想删也删不了)") : "★ 压根没调判重决策 (成本闸没过)"}`)
	show(`结果 (added=${r.added} updated=${r.updated} invalidated=${r.invalidated} usedLlm=${r.usedLlm})`)
}

/* ③ 模型愿意 DELETE 时, 链路能不能真的作废 */
console.log("")
console.log("=".repeat(78))
console.log("③ 模型明确 DELETE 旧条 (对照: 链路本身通不通)")
console.log("=".repeat(78))
{
	reset(seedOld())
	const oldId = mem.listAll().memories[0].id
	const llm = makeLlm(JSON.stringify({memory: [{id: oldId, text: A, event: "DELETE"}]}))
	const r = await mem.extractMemoriesSmart(B, llm)
	await mem.flushMemoryPersist()
	show(`结果 (added=${r.added} updated=${r.updated} invalidated=${r.invalidated} usedLlm=${r.usedLlm})`)
}

/* ④ 确定性判据的覆盖范围 (正例 / 反例), 直接用判据本体 (测试钩子) */
console.log("")
console.log("=".repeat(78))
console.log("④ 改口判据覆盖范围 (反例比正例更重要: 误作废 = 记忆莫名进历史)")
console.log("=".repeat(78))
{
	const pos = [
		["我想养猫", "我不想养猫了", "实机那例 (跨类型: project → preference)"],
		["我想养猫", "我不打算养猫了", "换说法"],
		["我要去北京", "我不去北京了", "意愿"],
		["我想学日语", "我不想学日语了", "想学"],
		["我不想养猫了", "我又想养猫了", "反向回摆 (加「又」)"],
		["喜欢下雨天", "我不喜欢下雨天了", "偏好族 (原有能力, 现在改为作废而非删除)"],
		["我喜欢猫", "我讨厌猫", "偏好族"],
	]
	const neg = [
		["我想养猫", "我想养猫了", "同方向 → 交给 merge 合并, 绝不作废"],
		["我想养猫", "我不想养狗", "宾语不同 (猫/狗)"],
		["我想买手机", "我不想买手机壳了", "★ 宾语只是包含关系 (手机 ⊂ 手机壳) → 必须不命中"],
		["我想养猫", "我不喜欢养猫了", "偏好反向 ≠ 意愿反向 (不同词族, 宾语也不同)"],
		["我喜欢猫", "我想养猫", "同为正向 → 不命中"],
		["我要", "我不要", "宾语不足 2 字 → 不命中"],
		["我最近在准备考研", "我不想养猫了", "完全无关"],
		["我没去北京", "我想去北京", "★ 没去=过去没发生, 不是对计划的否定"],
		["我不在家", "我要在家", "★ 宾语是状态 (在家) 而非要做的事"],
	]
	let bad = 0
	for (const [a, b, label] of pos) {
		const ok = mem.__isReversalForTest(a, b)
		if (!ok) bad += 1
		console.log(`  ${ok ? "✓" : "✗ 漏判"}  正例: 「${a}」→「${b}」  (${label})`)
	}
	for (const [a, b, label] of neg) {
		const ok = mem.__isReversalForTest(a, b)
		if (ok) bad += 1
		console.log(`  ${ok ? "✗ 误判" : "✓"}  反例: 「${a}」→「${b}」  (${label})`)
	}
	console.log(`  ⇒ ${bad === 0 ? "全部符合预期" : `${bad} 项不符`}`)
}
