/* 核对: 记忆能否被"纠正"。
 * 场景全部走真实入口 (extractMemoriesSmart / applyLlmMemoryDecision + 假模型), 不猜。
 *
 * ⚠️ 2026-09-27 下午起 DELETE 的语义已从"真删"改为"**作废** (invalidAt, 可还原)":
 *   - 旧结论 (③④⑤ 里"importance ≥ 0.85 被保护 ⇒ 纠正失败") **已过时**;
 *   - 现在: 被点名的旧条一律进「已作废」(不在 listAll() 里、不注入), 用户可一键还原;
 *   - 所以本探针的判据也改了: 看的是"被点名的那条是否退出生效列表", 不是"库里还剩几条"
 *     (库里同时存在两条近义旧记忆时, AI 只点名一条, 另一条本来就不该被连坐)。
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {NoriChat: {readFile: (n) => files.get(n) ?? "", writeFile: (n, c) => { files.set(n, String(c)); return "ok" }}}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

const mk = (id, content, over = {}) => ({
	id, content, type: "fact", importance: 0.8, confidence: 0.9,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365, ...over,
})
const reset = (items = [], extra = {}) => {
	files.set("memory.json", JSON.stringify({memories: items, summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], ...extra}))
	mem.reloadMemory()
}
const lib = () => mem.listAll().memories.map(m => ({c: m.content, imp: m.importance, tags: m.tags}))
const inv = () => mem.listInvalidMemories().map(m => m.content)
/** 生效列表里还有没有这条内容 (判"纠正是否生效"的正确判据) */
const activeHas = (s) => mem.listAll().memories.some(m => m.content.includes(s))

/** 假模型: 决策段返回指定事件 (模拟"AI 发现用户改口, 要求 DELETE 旧的") */
const llmDelete = (oldId) => async (p) => p.includes("记忆库管理员")
	? JSON.stringify({memory: [{id: oldId, event: "DELETE"}]})
	: JSON.stringify({facts: []})

console.log("=".repeat(78))
console.log("① 手动删除 (现有能力)")
console.log("=".repeat(78))
reset([mk("m1", "我叫小明", {importance: 0.9})])
console.log(`  删除前: ${JSON.stringify(lib())}`)
const okDel = mem.deleteMemory("m1")
console.log(`  deleteMemory → ${okDel}; 之后: ${JSON.stringify(lib())}`)

console.log("")
console.log("=".repeat(78))
console.log("② 有没有「编辑某条记忆文字」的接口?")
console.log("=".repeat(78))
const editish = ["updateMemory", "editMemory", "setMemoryContent", "renameMemory", "patchMemory"].filter(k => typeof mem[k] === "function")
console.log(`  记忆 API 里形如"编辑"的导出: ${editish.length ? editish.join(", ") : "无"}`)
console.log(`  index.ts 导出的记忆写操作: ${Object.keys(mem).filter(k => /^(add|merge|apply|delete|pin|clear|restore|remove)/.test(k)).join(", ")}`)

console.log("")
console.log("=".repeat(78))
console.log("③ 自动改口: 旧条 importance 0.8 (<0.85) → AI 要求 DELETE")
console.log("=".repeat(78))
reset([mk("old1", "我叫小明", {importance: 0.8})])
const r3 = await mem.applyLlmMemoryDecision([mk("new1", "我叫小刚", {importance: 0.8})], llmDelete("old1"))
await mem.flushMemoryPersist()
console.log(`  之后(生效): ${JSON.stringify(lib())}  已作废: ${JSON.stringify(inv())}  invalidated=${r3.invalidated}`)
console.log(`  ⇒ ${!activeHas("小明") && activeHas("小刚") ? "✓ 旧说法失效, 新说法生效" : "★ 纠正未生效"}`)

console.log("")
console.log("=".repeat(78))
console.log("④ 同样的改口, 但旧条 importance 0.9 (原实现里被 ≥0.85 保护闸拦下)")
console.log("=".repeat(78))
reset([mk("old2", "我叫小明", {importance: 0.9})])
const r4 = await mem.applyLlmMemoryDecision([mk("new2", "我叫小刚", {importance: 0.8})], llmDelete("old2"))
await mem.flushMemoryPersist()
console.log(`  之后(生效): ${JSON.stringify(lib())}  已作废: ${JSON.stringify(inv())}  invalidated=${r4.invalidated}`)
console.log(`  ⇒ ${!activeHas("小明") && activeHas("小刚") ? "✓ 高重要记忆**也能**被纠正 (保护闸已随'可还原'一起去掉)" : "★ 仍被保护, 新旧并存"}`)

console.log("")
console.log("=".repeat(78))
console.log("⑤ 关键风险: importance 会不会被 merge 顶高, 从而'永久免疫' DELETE?")
console.log("=".repeat(78))
// 两条同义记忆: 一条 importance 0.86, 一条 0.5 → merge 后取 max 0.86
reset([mk("a1", "我叫小明", {importance: 0.5}), mk("a2", "我的名字是小明", {importance: 0.86})])
console.log(`  合并前: ${JSON.stringify(lib())}`)
// 触发一次同义合并 (再说一遍)
mem.addMemoriesFromText("我叫小明")
console.log(`  再说一遍后: ${JSON.stringify(lib())}`)
const cur = mem.listAll().memories[0]
console.log(`  被点名那条: importance=${cur.importance} tags=${JSON.stringify(cur.tags)} (原实现里 ≥0.85 会免疫)`)
await mem.applyLlmMemoryDecision([mk("new3", "我叫小刚", {importance: 0.8})], llmDelete(cur.id))
await mem.flushMemoryPersist()
console.log(`  AI 点名 DELETE 之后(生效): ${JSON.stringify(lib())}`)
console.log(`  已作废: ${JSON.stringify(inv())}`)
console.log(`  ⇒ ${!mem.listAll().memories.some(m => m.id === cur.id) ? "✓ 被点名的高重要条已作废 (不再注入)" : "★ 仍在生效列表里 (纠正失败)"}`)
console.log("  注: 另一条近义旧条没被 AI 点名 ⇒ 按设计**不连坐** (这与「高重要免疫」是两件事, 别混)")

console.log("")
console.log("=".repeat(78))
console.log("⑥ 反例对照: 偏好方向相反 (isPrefReversal) 是否更可靠")
console.log("=".repeat(78))
reset([mk("p1", "喜欢下雨天", {type: "preference", importance: 0.7})])
mem.addMemoriesFromText("我不喜欢下雨天了")
console.log(`  「喜欢下雨天」+「我不喜欢下雨天了」→ ${JSON.stringify(lib())}  ${lib().length === 1 ? "✓ 改口被消解" : "★ 未消解"}`)
reset([mk("p2", "喜欢下雨天", {type: "preference", importance: 0.9})])
mem.addMemoriesFromText("我不喜欢下雨天了")
console.log(`  同上但旧条 importance 0.9 → ${JSON.stringify(lib())}  (偏好消解走 isPrefReversal, 不受 0.85 保护影响)`)
