/** 当前源码的严格回归：生命周期、双窗口、异步提交、坏数据与有界整理。 */
import assert from "node:assert/strict"
import {mkdtempSync, readFileSync, readdirSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {pathToFileURL} from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const output = mkdtempSync(path.join(tmpdir(), "norinew-memory-regression-"))
const dir = readdirSync(path.join(root, "node_modules/.pnpm")).find(x => x.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", dir, "node_modules/esbuild/lib/main.js")))
const raw = {name: "raw", setup(b) {
	b.onResolve({filter: /\?raw$/}, args => ({path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw"}))
	b.onLoad({filter: /./, namespace: "raw"}, args => ({loader: "text", contents: readFileSync(args.path, "utf8")}))
}}
for (const [name, entry] of [["memory", "memory/index.ts"], ["core", "memory/core.ts"], ["chat", "chat/index.ts"], ["context", "memory/context.ts"]]) {
	const input = name === "context" ? {stdin: {contents: 'export * from "./src/services/memory/context"; export * from "./src/services/memory/index";', resolveDir: root, loader: "ts"}} : {entryPoints: [path.join(root, "src/services", entry)]}
	await build({absWorkingDir: root, ...input,
		outfile: path.join(output, `${name}.mjs`), bundle: true, platform: "neutral", format: "esm", plugins: [raw]})
}
const files = new Map()
let failFile = "", interfere = null
const bridge = {
	readFile: name => files.get(name) ?? "",
	writeFile: (name, text) => { if (name === failFile) return "err:disk-full"; files.set(name, text); return "ok" },
	writeFileIfUnchanged: (name, expected, text) => {
		if (interfere) { const fn = interfere; interfere = null; fn() }
		if ((files.get(name) ?? "") !== expected) return "conflict"
		return bridge.writeFile(name, text)
	},
}
globalThis.window = {NoriChat: bridge}
let sequence = 0
const loaded = []
const module = async name => { const m = await import(`${pathToFileURL(path.join(output, `${name}.mjs`)).href}?instance=${sequence++}`); loaded.push(m); return m }
const core = await module("core")
const item = (id, content, over = {}) => ({id, content, type: "fact", importance: 0.8, confidence: 0.9,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: null, ...over})
const store = (memories = [], extra = {}) => ({schemaVersion: 2, memories, summaries: [], blocks: [], deletedBin: [],
	tombstones: [], summarizedMsgCount: 0, trimmedMsgCount: 0, ...extra})
const seed = data => files.set("memory.json", JSON.stringify(data))
const disk = () => JSON.parse(files.get("memory.json"))
const messages = text => Array.from({length: 45}, (_, i) => ({role: i % 2 ? "assistant" : "user", content: i === 0 ? text : `闲聊${i}`, ts: 1000 + i}))
const valid = (summary = "普通聊天。", items = []) => `${summary}\n===MEM===\n${JSON.stringify({topic: "聊天", items})}`
let passed = 0, failed = 0
const test = async (name, fn) => {
	files.clear(); failFile = ""; interfere = null
	try { await fn(); passed++; console.log(`PASS ${name}`) }
	catch (e) { failed++; console.error(`FAIL ${name}\n${e.stack}`) }
	finally { for (const m of loaded.splice(0)) m.__resetMemorySessionForTest?.() }
}

await test("主库读权限失败时暂停写入，恢复后合并旧库与未保存新增", async () => {
	seed(store([item("old", "我住在北京")]))
	const original = files.get("memory.json")
	let unavailable = true
	bridge.readFileState = name => JSON.stringify(unavailable
		? {status: "error", message: "permission denied"}
		: {status: files.has(name) ? "ok" : "missing", content: files.get(name) ?? ""})
	try {
		const m = await module("memory")
		m.mergeLlmMemories([item("new", "我在学习法语")]); await m.flushMemoryPersist()
		assert.equal(files.get("memory.json"), original)
		assert.equal(files.has("memory.json.bak"), false)
		assert.ok(m.memoryHealth().lastPersistError.includes("暂停保存"))
		unavailable = false; m.reloadMemory(); await m.flushMemoryPersist()
		assert.deepEqual(disk().memories.map(m => m.id).sort(), ["new", "old"])
		assert.equal(m.memoryHealth().lastPersistError, "")
	} finally {delete bridge.readFileState}
})
await test("主库缺失、备份读失败时不创建空库，权限恢复后保留备份", async () => {
	files.set("memory.json.bak", JSON.stringify(store([item("backup", "我在学习德语")])))
	let unavailable = true
	bridge.readFileState = name => JSON.stringify(name === "memory.json.bak" && unavailable
		? {status: "error", message: "io error"}
		: {status: files.has(name) ? "ok" : "missing", content: files.get(name) ?? ""})
	try {
		const m = await module("memory")
		m.mergeLlmMemories([item("new", "我在学习法语")]); await m.flushMemoryPersist()
		assert.equal(files.has("memory.json"), false)
		unavailable = false; m.reloadMemory(); await m.flushMemoryPersist()
		assert.deepEqual(disk().memories.map(m => m.id).sort(), ["backup", "new"])
	} finally {delete bridge.readFileState}
})
await test("永久删除的事实指纹阻止同义重学，不保存原文；新明确指令可恢复", async () => {
	seed(store([item("cat", "我喜欢猫")], {summaries: [core.makeSummary("用户喜欢猫。用户在学法语。", 2, "mixed")]}))
	const m = await module("memory")
	m.deleteMemory("cat"); m.deleteMemoryForever("cat"); await m.flushMemoryPersist()
	assert.equal(files.get("memory.json").includes("喜欢猫"), false)
	assert.ok(m.summaryBlock().includes("法语"))
	m.mergeLlmMemories([item("copy", "我喜欢猫咪")]); await m.flushMemoryPersist()
	assert.equal(m.listAll().memories.length, 0)
	m.addMemoriesFromText("记住我喜欢猫咪"); await m.flushMemoryPersist(); m.reloadMemory()
	assert.ok(m.listAll().memories.some(m => m.content.includes("猫咪")))
})
await test("永久删除后旧窗口写入也不能把已清除的摘要原文带回磁盘", async () => {
	seed(store([item("cat", "我喜欢猫")], {summaries: [core.makeSummary("用户喜欢猫。用户在学法语。", 2, "mixed")]}))
	const a = await module("memory"), b = await module("memory")
	a.listAll(); b.listAll()
	a.deleteMemory("cat"); a.deleteMemoryForever("cat"); await a.flushMemoryPersist()
	b.mergeLlmMemories([item("new", "我在学德语")]); await b.flushMemoryPersist()
	assert.equal(files.get("memory.json").includes("喜欢猫"), false)
	assert.ok(b.summaryBlock().includes("法语"))
})
await test("严格判重保留猫和猫毛、主体及否定差异", () => {
	assert.equal(core.isSameContent("我喜欢猫", "我喜欢猫毛"), false)
	assert.equal(core.isSameContent("我喜欢猫", "我不喜欢猫"), false)
	assert.equal(core.isSameContent("小明喜欢猫", "我喜欢猫"), false)
	assert.equal(core.isSameContent("我喜欢猫。", "喜欢猫"), true)
})
await test("单值纠正按证据时间，旧批次不能覆盖新陈述", () => {
	const list = core.reconcileSelfFacts([item("new", "我叫小红", {sourceTs: 200}), item("old", "我叫小明", {sourceTs: 100})])
	assert.equal(list.find(m => m.id === "old").supersededBy, "new")
	assert.equal(list.find(m => m.id === "new").invalidAt, undefined)
	assert.equal(core.selfFact("我的生日是13月32日"), null)
})
await test("他人、假设、老家、职业、不同兴趣不会被单值规则覆盖", () => {
	for (const s of ["朋友的名字是小红", "如果我叫小红", "我叫他去买菜", "我住在北京或者上海", "我老家在北京", "我是程序员", "我喜欢猫", "我喜欢狗", "我的名字叫小明，是个前端工程师", "我住在北京，在上海工作"]) assert.equal(core.selfFact(s), null)
	const list = core.reconcileSelfFacts([item("name", "我叫小明"), item("home", "我住在北京"), item("other", "朋友叫小红")])
	assert.equal(list.filter(m => m.invalidAt).length, 0)
	assert.equal(core.reconcileSelfFacts([item("a", "我叫小明", {sourceTs: 100}), item("b", "我叫小红", {sourceTs: 100})]).filter(m => m.invalidAt).length, 0)
})
await test("默认整理纠正姓名并停用含旧值的摘要，历史查询明确标记旧说法", async () => {
	seed(store([item("old", "我叫小明", {sourceTs: 500})], {summaries: [core.makeSummary("用户名叫小明。", 1, "s-old")]}))
	const m = await module("memory")
	assert.equal(await m.summarizeIfNeeded(messages("我叫小红"), async () => valid("用户更换了称呼。", [{content: "我叫小红", type: "fact", importance: 0.9}])), true)
	assert.equal(m.listInvalidMemories()[0].id, "old")
	assert.equal(m.summaryBlock().includes("小明"), false)
	assert.equal(m.recallForQuery("以前的名字叫什么").includes("仅供历史回顾"), true)
	await m.flushMemoryPersist()
})
await test("手动收起不会被新陈述或旧整理恢复，点击留下可恢复", async () => {
	seed(store([item("cat", "喜欢猫", {type: "preference"})], {summaries: [core.makeSummary("用户喜欢猫。", 1, "s-cat")]}))
	const m = await module("memory")
	assert.equal(m.fadeMemoryManually("cat"), true)
	m.addMemoriesFromText("我喜欢猫")
	await m.summarizeIfNeeded(messages("我喜欢猫"), async () => valid("用户喜欢猫。", [{content: "喜欢猫", type: "preference", importance: 0.9}]))
	assert.equal(m.listAll().memories.length, 0)
	assert.equal(m.summaryBlock().includes("喜欢猫"), false)
	assert.equal(m.restoreFadedMemory("cat"), true)
	assert.equal(m.listAll().memories.length, 1)
	await m.flushMemoryPersist()
})
await test("自动收起的新证据仍送给整理模型，手动收起的叙事可在留下后恢复", async () => {
	seed(store([item("cat", "我喜欢猫", {fadedAt: 100, fadedReason: "expired", type: "preference"})]))
	const m = await module("memory")
	await m.summarizeIfNeeded(messages("我喜欢猫"), async prompt => {
		assert.ok(prompt.includes("我喜欢猫"))
		return valid("用户喜欢猫。", [{content: "我喜欢猫", type: "preference", importance: 0.9}])
	})
	assert.equal(m.listAll().memories[0].id, "cat")
	m.fadeMemoryManually("cat")
	assert.equal(m.summaryBlock().includes("喜欢猫"), false)
	m.restoreFadedMemory("cat")
	assert.ok(m.summaryBlock().includes("喜欢猫"))
	await m.flushMemoryPersist()
})
await test("自动收起只因之后的新证据恢复", async () => {
	seed(store([item("cat", "喜欢猫", {fadedAt: 5000, fadedReason: "expired", type: "preference"})]))
	const m = await module("memory")
	await m.summarizeIfNeeded(messages("我喜欢猫"), async () => valid("闲聊。", [{content: "喜欢猫", type: "preference", importance: 0.8}]))
	assert.equal(m.listAll().memories.length, 0)
	m.addMemoriesFromText("我喜欢猫")
	assert.equal(m.listAll().memories[0].id, "cat")
	await m.flushMemoryPersist()
})
await test("删除阻止换 ID 重学；还原保留收起状态并持久化", async () => {
	seed(store([item("cat", "喜欢猫", {fadedAt: 100, fadedReason: "manual"})]))
	const m = await module("memory")
	m.deleteMemory("cat"); m.reloadMemory()
	m.mergeLlmMemories([item("copy", "喜欢猫")])
	assert.equal(m.listAll(true).memories.length, 0)
	assert.equal(m.restoreDeletedMemory("cat"), true)
	assert.equal(m.listFadedMemories()[0].id, "cat")
	await m.flushMemoryPersist()
	assert.equal((await module("memory")).listFadedMemories()[0].id, "cat")
})
await test("永久删除跨窗口和重启不复活，并停用关联摘要与归档", async () => {
	seed(store([item("cat", "喜欢猫")], {summaries: [core.makeSummary("用户喜欢猫。", 1, "s-cat")]}))
	const a = await module("memory"), b = await module("memory")
	b.listAll(); a.deleteMemory("cat"); await a.flushMemoryPersist()
	a.deleteMemoryForever("cat"); await a.flushMemoryPersist()
	b.mergeLlmMemories([item("new", "喜欢狗")]); await b.flushMemoryPersist()
	const restarted = await module("memory")
	assert.equal(restarted.listDeletedMemories().length, 0)
	assert.equal(restarted.listAll().memories.some(x => x.id === "cat"), false)
	assert.equal(restarted.summaryBlock().includes("喜欢猫"), false)
})
await test("用户明确重新记住可以撤销删除；普通提及仍受抑制", async () => {
	seed(store([item("cat", "喜欢猫")]))
	const m = await module("memory")
	m.deleteMemory("cat"); m.addMemoriesFromText("我喜欢猫")
	assert.equal(m.listAll().memories.length, 0)
	m.addMemoriesFromText("记住：喜欢猫")
	assert.equal(m.listAll().memories.length, 1)
	await m.flushMemoryPersist()
})
await test("实时 AI 仅改写时也落盘，单值改口保留旧条历史", async () => {
	seed(store([item("cat", "我喜欢猫")]))
	const m = await module("memory")
	await m.applyLlmMemoryDecision([item("new", "我喜欢猫也喜欢猫毛")], async () => '[{"id":"cat","event":"UPDATE","text":"我喜欢猫也喜欢猫毛"}]')
	await m.flushMemoryPersist()
	assert.equal(disk().memories[0].content, "我喜欢猫也喜欢猫毛")
	assert.equal(disk().memories[0].sourceKind, "llm")
	m.__resetMemorySessionForTest()
	seed(store([item("old", "我叫小明", {sourceTs: 100})]))
	await m.applyLlmMemoryDecision([item("new", "我叫小红", {sourceTs: 200})], async () => '[{"id":"old","event":"UPDATE","text":"我叫小红"}]')
	assert.equal(m.listInvalidMemories()[0].content, "我叫小明")
	assert.equal(m.listAll().memories[0].content, "我叫小红")
	await m.flushMemoryPersist()
})
await test("实时 AI 等待期间删除新内容，不能通过改写另一条绕过删除护栏", async () => {
	seed(store([item("cat", "我喜欢猫")]))
	const m = await module("memory")
	let resolve
	const waiting = m.applyLlmMemoryDecision([item("new", "我喜欢猫毛")], () => new Promise(r => { resolve = r }))
	m.mergeLlmMemories([item("fur", "我喜欢猫毛")]); m.deleteMemory("fur"); await m.flushMemoryPersist()
	resolve('[{"id":"cat","event":"UPDATE","text":"我喜欢猫毛"}]')
	await waiting
	assert.equal(m.listAll().memories[0].content, "我喜欢猫")
	assert.equal(m.listAll().memories.length, 1)
	await m.flushMemoryPersist()
	m.__resetMemorySessionForTest()
	seed(store([item("cat", "我喜欢猫"), item("fur", "我喜欢猫毛", {fadedAt: 100, fadedReason: "manual"})]))
	let calls = 0
	await m.applyLlmMemoryDecision([item("new", "我喜欢猫毛", {sourceTs: Date.now()})], async () => { calls++; return '[]' })
	assert.equal(calls, 0)
	assert.equal(m.listAll().memories[0].content, "我喜欢猫")
	await m.flushMemoryPersist()
})
await test("另一个窗口还原后，本地旧删除标记不再压过恢复", async () => {
	seed(store([item("cat", "喜欢猫")]))
	const a = await module("memory"), b = await module("memory")
	a.deleteMemory("cat"); await a.flushMemoryPersist()
	assert.equal(b.restoreDeletedMemory("cat"), true); await b.flushMemoryPersist()
	a.reloadMemory()
	assert.equal(a.listAll().memories[0].id, "cat")
	await a.flushMemoryPersist()
})
await test("清库代次胜过旧窗口和清库前的异步整理", async () => {
	seed(store([item("old", "旧信息")]))
	const a = await module("memory"), b = await module("memory")
	b.listAll()
	let resolve
	const waiting = a.summarizeIfNeeded(messages("旧信息"), () => new Promise(r => { resolve = r }))
	a.clearMemory(); await a.flushMemoryPersist()
	resolve(valid("旧信息。", [{content: "旧信息", type: "fact", importance: 0.9}]))
	assert.equal(await waiting, false)
	b.mergeLlmMemories([item("stale", "陈旧窗口写入")]); await b.flushMemoryPersist()
	assert.equal(disk().memories.length, 0)
	assert.equal(disk().summaries.length, 0)
})
await test("召回竞速只读，发送前排除作废条，提交按请求编号去重", async () => {
	seed(store([item("cat", "我喜欢猫")]))
	const m = await module("memory")
	let resolve
	const smart = m.selectRecallSmart("我喜欢猫", () => new Promise(r => { resolve = r }))
	const fast = m.selectRecall("我喜欢猫")
	assert.equal(m.listAll().memories[0].accessCount, 0)
	const ready = m.materializeRecall(fast)
	m.commitRecall(fast, "request-1", ready.ids); m.commitRecall(fast, "request-1", ready.ids)
	assert.equal(m.listAll().memories[0].accessCount, 1)
	m.invalidateMemory("cat"); resolve('[{"id":"cat"}]')
	assert.equal(m.materializeRecall(await smart).text, "")
	assert.equal(m.listAll(true).memories[0].accessCount, 1)
	await m.flushMemoryPersist()
})
await test("CAS 冲突重读合并，主文件与备份失败状态可恢复", async () => {
	seed(store([item("old", "旧信息")]))
	const m = await module("memory")
	m.mergeLlmMemories([item("local", "本地新增")])
	interfere = () => seed(store([item("old", "旧信息"), item("remote", "另一窗口新增")]))
	await m.flushMemoryPersist()
	assert.deepEqual(disk().memories.map(x => x.id).sort(), ["local", "old", "remote"])
	failFile = "memory.json.bak"
	m.addMemoriesFromText("我喜欢猫"); await m.flushMemoryPersist()
	assert.match(m.memoryHealth().lastPersistError, /备份/)
	failFile = ""; m.addMemoriesFromText("我喜欢狗"); await m.flushMemoryPersist()
	assert.equal(m.memoryHealth().lastPersistError, "")
})
await test("损坏元素被隔离，合法空提取与非法 JSON 分开", async () => {
	seed(store([null, {}, item("ok", "有效信息", {tags: "oops", kw: [null, "信息"]})], {summaries: [null, {}, core.makeSummary("有效摘要。", 1, "s")]}))
	const m = await module("memory")
	assert.equal(m.listAll().memories.length, 1)
	assert.ok(m.summaryBlock().includes("有效摘要"))
	assert.equal(core.parseBlockOutput(valid()).status, "valid")
	assert.equal(core.parseBlockOutput('摘要。\n===MEM===\n{"items":').status, "invalid")
})
await test("提取失败保留原文游标，自动重试有上限，手动成功后可裁剪", async () => {
	seed(store())
	const m = await module("memory"), msgs = messages("我叫小红")
	let calls = 0
	const bad = async () => { calls++; return '摘要已生成。\n===MEM===\n{"items":' }
	for (let i = 0; i < 4; i++) assert.equal(await m.summarizeIfNeeded(msgs, bad), false)
	assert.equal(calls, 3)
	assert.equal(m.safeTrimDrop(msgs.length), 0)
	assert.match(m.memoryHealth().lastOrganize.note, /部分完成/)
	assert.equal(await m.summarizeIfNeeded(msgs, async () => valid(), true, true), true)
	assert.equal(m.safeTrimDrop(msgs.length), 25)
	await m.flushMemoryPersist()
})
await test("空输出与调用失败也限制自动重试；原文和游标不丢", async () => {
	for (const throws of [false, true]) {
		seed(store())
		const m = await module("memory"), msgs = messages("我叫小红")
		let calls = 0
		const failed = async () => { calls++; if (throws) throw new Error("网络中断"); return "" }
		for (let i = 0; i < 4; i++) {
			try { assert.equal(await m.summarizeIfNeeded(msgs, failed), false) }
			catch (error) { assert.ok(throws); assert.match(error.message, /网络中断/) }
		}
		assert.equal(calls, 3)
		assert.equal(m.safeTrimDrop(msgs.length), 0)
		assert.match(m.memoryHealth().lastOrganize.note, /未完成/)
		await m.flushMemoryPersist()
		m.__resetMemorySessionForTest()
	}
})
await test("长消息末尾进入提示词；单条分段有界，不丢尾段", async () => {
	seed(store())
	const m = await module("memory"), seen = []
	const msgs = messages("闲聊".repeat(5100) + "我叫小红")
	assert.equal(await m.summarizeIfNeeded(msgs, async p => { seen.push(p); return valid() }), true)
	assert.equal(seen.length, 2)
	assert.ok(seen[1].includes("我叫小红"))
	assert.ok(seen.every(p => p.length < 12000))
	await m.flushMemoryPersist()
})
await test("同步远端游标后仍保留手动整理和规则模式参数", async () => {
	seed(store())
	const m = await module("memory")
	m.listAll()
	seed(store([], {summarizedMsgCount: 10}))
	let calls = 0
	const ok = await m.summarizeIfNeeded(messages("普通对话"), async prompt => {
		calls++; assert.equal(prompt.includes("===MEM==="), false); return "普通聊天摘要。"
	}, false, true)
	assert.equal(ok, true); assert.equal(calls, 1)
	await m.flushMemoryPersist()
})
await test("摘要和归档共用预算，召回次数不再永久豁免到期", () => {
	const summaries = [core.makeSummary("摘要。".repeat(80), 1, "s")]
	const metas = [core.makeSummary("归档。".repeat(80), 1, "a")]
	assert.ok(core.buildSummaryBlock(summaries, {metas, budget: 200}).length <= 200)
	const old = item("old", "一次性事件", {type: "event", decayDays: 30, accessCount: 20, createdAt: 1, updatedAt: 1})
	assert.equal(core.pickExpiredMemories([old]).length, 1)
})
await test("主界面与悬浮窗共用发送配置：排队期间删除，条目及摘要不发送", async () => {
	seed(store([item("cat", "我喜欢猫")], {summaries: [core.makeSummary("用户喜欢猫。", 1, "s-cat")]}))
	const m = await module("context"), chat = await module("chat")
	const selection = m.selectRecall("我喜欢猫")
	const sent = []
	bridge.chatStream = (_base, _key, _model, payload) => sent.push(JSON.parse(payload))
	const first = new Promise(resolve => chat.sendChatStream("https://example.com", "key", "model", [], {onDelta() {}, onError: resolve, onDone: resolve}))
	await new Promise(r => setTimeout(r, 0))
	const payload = [{role: "user", content: "当前问题"}]
	const second = new Promise(resolve => chat.sendChatStream("https://example.com", "key", "model", payload, {onDelta() {}, onError: resolve, onDone: resolve}, false, undefined, m.memoryChatOptions(selection, payload, false)))
	m.deleteMemory("cat"); await m.flushMemoryPersist()
	window.__noriChatDone('{"ok":true,"content":"done"}')
	await first; await new Promise(r => setTimeout(r, 0))
	assert.equal(JSON.stringify(sent[1]).includes("喜欢猫"), false)
	assert.equal(m.listDeletedMemories()[0].accessCount, 0)
	window.__noriChatDone('{"ok":true,"content":"done"}'); await second
	const abort = new AbortController(); abort.abort()
	const cancelled = await chat.sendChat("https://example.com", "key", "model", [], false, {signal: abort.signal})
	assert.equal(cancelled.ok, false)
	await m.flushMemoryPersist()
})
await test("共用配置只对实际发送的记忆计数，预算剔除和重复回调不强化", async () => {
	seed(store([item("cat", "我喜欢猫")]))
	const m = await module("context"), chat = await module("chat")
	const selection = m.selectRecall("我喜欢猫")
	const payload = [{role: "system", content: "人格"}, {role: "user", content: "当前问题"}]
	const sent = []
	bridge.chatStream = (_base, _key, _model, raw) => sent.push(JSON.parse(raw))
	const options = m.memoryChatOptions(selection, payload, false)
	const first = new Promise(resolve => chat.sendChatStream("https://example.com", "key", "model", payload, {onDelta() {}, onError: resolve, onDone: resolve}, false, undefined, options))
	await new Promise(r => setTimeout(r, 0))
	assert.ok(JSON.stringify(sent[0]).includes("我喜欢猫"))
	options.onDispatched(sent[0]); options.onDispatched(sent[0])
	assert.equal(m.listAll().memories[0].accessCount, 1)
	window.__noriChatDone('{"ok":true,"content":"done"}'); await first
	const limited = {...m.memoryChatOptions(selection, payload, false), inputCharBudget: 200}
	const second = new Promise(resolve => chat.sendChatStream("https://example.com", "key", "model", payload, {onDelta() {}, onError: resolve, onDone: resolve}, false, undefined, limited))
	await new Promise(r => setTimeout(r, 0))
	assert.equal(JSON.stringify(sent[1]).includes("喜欢猫"), false)
	assert.equal(m.listAll().memories[0].accessCount, 1)
	window.__noriChatDone('{"ok":true,"content":"done"}'); await second
	await m.flushMemoryPersist()
})
await test("共用召回竞速及时撤销定时器；超时取消在途原生调用且不计数", async () => {
	seed(store([item("cat", "我喜欢猫")]))
	const m = await module("context"), chat = await module("chat")
	const set = globalThis.setTimeout, clear = globalThis.clearTimeout, budgets = new Set()
	globalThis.setTimeout = (fn, delay, ...args) => { const t = set(fn, delay, ...args); if (delay === 12345) budgets.add(t); return t }
	globalThis.clearTimeout = t => { budgets.delete(t); return clear(t) }
	let smartSignal
	try {
		await m.selectRecallWithinBudget("我喜欢猫", async (_prompt, signal) => { smartSignal = signal; return '[{"id":"cat"}]' }, 12345)
		assert.equal(budgets.size, 0)
		assert.equal(smartSignal.aborted, true)
	} finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear }
	const requests = [], stops = []
	bridge.chatRequest = (id, _base, _key, _model, payload) => requests.push({id, payload})
	bridge.chatRequestStop = id => stops.push(id)
	try {
		const result = await m.selectRecallWithinBudget("我喜欢猫", async (prompt, signal) => {
			const r = await chat.sendChat("https://example.com", "key", "model", [{role: "system", content: prompt}], false, {signal})
			if (!r.ok) throw new Error(r.message)
			return r.content
		}, 20)
		assert.equal(result.ranked[0].item.id, "cat")
		assert.equal(requests.length, 1)
		assert.deepEqual(stops, [requests[0].id])
		assert.equal(m.listAll().memories[0].accessCount, 0)
	} finally { delete bridge.chatRequest; delete bridge.chatRequestStop }
	await m.flushMemoryPersist()
})
await test("普通删除、收起及旧版推断反例不会进入负反馈", async () => {
	const active = Array.from({length: 14}, (_, i) => item(`a${i}`, `我喜欢第${i}种点心`))
	seed(store([...active, item("faded", "喜欢猫", {fadedAt: 100, fadedReason: "manual"})], {
		deletedBin: [item("deleted", "喜欢狗", {deletedAt: 100})], exampleSet: {builtAt: 100, basedOn: 14, pos: [], neg: ["喜欢狗"]},
	}))
	const m = await module("memory")
	assert.equal(m.getMemoryExamples(), null)
	assert.equal(m.rebuildMemoryExamples(), true)
	assert.deepEqual(m.getMemoryExamples().neg, [])
	assert.equal(m.getMemoryExamples().pos.includes("喜欢猫"), false)
	await m.flushMemoryPersist()
	assert.equal(disk().exampleSet.policyVersion, 2)
})
await test("取消在途非流式请求可让出队列，迟到回包不串到新请求", async () => {
	const chat = await module("chat"), requests = [], stops = []
	bridge.chatRequest = (id, _base, _key, _model, payload) => requests.push({id, payload})
	bridge.chatRequestStop = id => stops.push(id)
	const abort = new AbortController()
	const first = chat.sendChat("https://example.com", "key", "model", [], false, {signal: abort.signal})
	await new Promise(r => setTimeout(r, 0))
	abort.abort(); assert.equal((await first).ok, false)
	assert.deepEqual(stops, [requests[0].id])
	let resolved = false
	const second = chat.sendChat("https://example.com", "key", "model", []).then(r => { resolved = true; return r })
	await new Promise(r => setTimeout(r, 0))
	window.__noriChatRes(JSON.stringify({requestId: requests[0].id, ok: true, content: "迟到"}))
	await new Promise(r => setTimeout(r, 0)); assert.equal(resolved, false)
	window.__noriChatRes(JSON.stringify({requestId: requests[1].id, ok: true, content: "新请求"}))
	assert.equal((await second).content, "新请求")
	delete bridge.chatRequest; delete bridge.chatRequestStop
})
await test("整体字符预算保留当前问题，单条过长明确失败", async () => {
	const chat = await module("chat")
	const fitted = chat.budgetChatMessages([{role: "system", content: "人格"}, {role: "user", content: "旧对话".repeat(100)}, {role: "user", content: "当前问题"}], 200)
	assert.equal(fitted.at(-1).content, "当前问题")
	assert.throws(() => chat.budgetChatMessages([{role: "user", content: "太长".repeat(100)}], 50), /分段发送/)
})
console.log(`${passed}/${passed + failed} passed`)
process.exit(failed ? 1 : 0)
