/* 端到端: 「我的名字是小明哦」说两遍（含换说法），走**完整入口** extractMemoriesSmart 的三种配置。
 *
 * 真机与这里的唯一差别是"真模型怎么回答"。所以这里的假 LLM 刻意**按提示词的语义**作答
 * (读提取提示词 → 产出第一人称完整短句; 读决策提示词 → 真去比对给 ADD/NONE/UPDATE), 而不是
 * 直接返回我想看到的结论 —— 否则就是自证。
 *
 * 配置:
 *   ① AI 开关关闭 (纯规则) —— 用户可能就是这个配置
 *   ② AI 开启, 模型把整句原样给出 ("我的名字是小明哦")
 *   ③ AI 开启, 模型去掉主语给残句 ("是小明哦")
 *   ④ AI 开启, 模型给规范短句 ("小明")
 * 每种配置都: 第 1 句入库 → 第 2 句(换说法)再说 → 断言库里只剩 1 条。
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
const reset = () => {
	files.set("memory.json", JSON.stringify({memories: [], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: []}))
	mem.reloadMemory()
}
const lib = () => mem.listAll().memories.map(m => m.content)

/** 假 LLM: 按**提示词语义**作答。
 *  - 提取提示词 (「个人信息整理员」) → 返回该配置下模型给的 facts
 *  - 决策提示词 (「你是记忆库管理员」) → 真读候选列表, 与事实逐条比较后给 ADD/NONE/UPDATE
 */
const makeLlm = (factOf) => async (prompt) => {
	if (prompt.includes("记忆库管理员")) {
		// 从提示词里解析出"新事实"与"已有记忆 id|内容"
		const factLines = [...prompt.matchAll(/^- (.+?) \(/gm)].map(m => m[1])
		const oldLines = [...prompt.matchAll(/^(\S+) \| (.+?) \(/gm)].map(m => ({id: m[1], content: m[2]}))
		const norm = (s) => String(s).toLowerCase().replace(/[，。！？!?,.、\s"'“”‘’]+/g, "").replace(/(?:啊|呀|哦|哟|啦|呢|吧|嘛|哈|喔|噢)+$/, "")
		const out = []
		for (const f of factLines) {
			const nf = norm(f)
			// 同一个人的名字：归一化后互为子串即视为同一件事
			const hit = oldLines.find(o => {
				const no = norm(o.content)
				return no === nf || no.includes(nf) || nf.includes(no)
			})
			if (hit) {
				// 更全的一方留下 → 用更长的作为最终文本 (UPDATE), 否则 NONE
				const longer = norm(hit.content).length >= nf.length ? hit.content : f
				out.push(longer === hit.content ? {id: hit.id, event: "NONE"} : {id: hit.id, text: longer, event: "UPDATE"})
			} else {
				out.push({id: "new", text: f, event: "ADD"})
			}
		}
		return JSON.stringify({memory: out})
	}
	// 提取提示词: 用配置给定的"模型输出"
	return JSON.stringify({facts: factOf().map(c => ({content: c, type: "fact", importance: 0.9, confidence: 0.95}))})
}

console.log("=".repeat(78))
console.log("① AI 开关关闭 (纯规则通道) —— 用户可能就是这个配置")
console.log("=".repeat(78))
{
	reset()
	await mem.extractMemoriesSmart("我的名字是小明哦", null)
	const after1 = lib()
	console.log(`   第 1 句「我的名字是小明哦」→ ${JSON.stringify(after1)}`)
	await mem.extractMemoriesSmart("我的名字是小明", null)
	const after2 = lib()
	console.log(`   第 2 句「我的名字是小明」→ ${JSON.stringify(after2)}`)
	check("① 纯规则: 换说法再说一遍仍只有 1 条", after2.length === 1, JSON.stringify(after2))
	await mem.extractMemoriesSmart("我叫小明", null)
	const after3 = lib()
	console.log(`   第 3 句「我叫小明」→ ${JSON.stringify(after3)}`)
	check("① 纯规则: 三种说法合起来仍是 1 条", after3.length === 1, JSON.stringify(after3))
}

const configs = [
	["② 模型给整句「我的名字是小明哦」", () => ["我的名字是小明哦"]],
	["③ 模型给残句「是小明哦」", () => ["是小明哦"]],
	["④ 模型给规范短句「小明」", () => ["小明"]],
]
for (const [label, factOf] of configs) {
	console.log("")
	console.log("=".repeat(78))
	console.log(label)
	console.log("=".repeat(78))
	reset()
	const llm = makeLlm(factOf)
	const r1 = await mem.extractMemoriesSmart("我的名字是小明哦", llm)
	await mem.flushMemoryPersist()
	const a1 = lib()
	console.log(`   第 1 句「我的名字是小明哦」→ ${JSON.stringify(a1)}  (规则+AI, added=${r1.added})`)
	const r2 = await mem.extractMemoriesSmart("我的名字是小明", llm)
	await mem.flushMemoryPersist()
	const a2 = lib()
	console.log(`   第 2 句「我的名字是小明」→ ${JSON.stringify(a2)}  (added=${r2.added} updated=${r2.updated})`)
	check(`${label} → 说两遍只剩 1 条`, a2.length === 1, JSON.stringify(a2))
	// 重启后仍是 1 条 (落盘 + 载入收敛)
	mem.reloadMemory()
	const a3 = lib()
	check(`${label} → 重启后仍是 1 条`, a3.length === 1, JSON.stringify(a3))
}

console.log("")
console.log("=".repeat(78))
console.log("反向: 同一配置下**不同**的事不能被并掉")
console.log("=".repeat(78))
{
	reset()
	const llm = makeLlm(() => ["小明"])
	await mem.extractMemoriesSmart("我的名字是小明哦", llm)
	await mem.extractMemoriesSmart("我叫小刚", llm)      // 另一个人
	await mem.extractMemoriesSmart("我喜欢下雨天", llm)   // 另一件事
	await mem.flushMemoryPersist()
	const a = lib()
	console.log(`   库: ${JSON.stringify(a)}`)
	check("反向: 「小明」与「小刚」没被并 (≥2 条)", a.length >= 2, JSON.stringify(a))
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { process.exitCode = 1; console.log("FAILED:", failed.map(f => f.name).join(" | ")) }
