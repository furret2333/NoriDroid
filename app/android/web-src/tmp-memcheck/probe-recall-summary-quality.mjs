/** 固定人工标注语料，测试当前源码的召回和摘要使用；不调用真实 API、不改业务代码。
 * --strict: 已知质量缺口也返回失败；默认报告模式只在测试工具运行失败时退出非零。
 * AI 路径使用模拟选择器，只测候选可达性和返回处理，不代表真实模型准确率。
 */
import {mkdtempSync, readFileSync, readdirSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {pathToFileURL} from "node:url"
import {createHash} from "node:crypto"

const root = path.resolve(import.meta.dirname, "..")
const output = mkdtempSync(path.join(tmpdir(), "nori-recall-summary-quality-"))
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(n => n.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")))
const raw = {name: "raw", setup(b) {
	b.onResolve({filter: /\?raw$/}, a => ({path: path.resolve(a.resolveDir, a.path.slice(0, -4)), namespace: "raw"}))
	b.onLoad({filter: /./, namespace: "raw"}, a => ({loader: "text", contents: readFileSync(a.path, "utf8")}))
}}
await build({absWorkingDir: root, stdin: {contents:
	'export * from "./src/services/memory/index"; export * from "./src/services/memory/context"; export {sendChat} from "./src/services/chat/index";',
	resolveDir: root, loader: "ts"}, outfile: path.join(output, "memory.mjs"),
	bundle: true, platform: "neutral", format: "esm", plugins: [raw]})

const files = new Map()
globalThis.window = {NoriChat: {
	readFile: name => files.get(name) ?? "",
	writeFile: (name, text) => {files.set(name, text); return "ok"},
	writeFileIfUnchanged: (name, expected, text) => {
		if ((files.get(name) ?? "") !== expected) return "conflict"
		files.set(name, text); return "ok"
	},
}}
const NOW = Date.parse("2026-10-11T00:20:00+08:00")
const realNow = Date.now
Date.now = () => NOW
const DAY = 86400000
const item = (id, content, over = {}) => ({id, content, type: "fact", importance: 0.7,
	confidence: 0.9, createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY,
	lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: null, ...over})
const summary = (id, content, over = {}) => ({id, content, createdAt: NOW - DAY,
	msgCount: 2, tokenCount: Math.ceil(content.length / 4), ...over})
const store = (memories = [], extra = {}) => ({schemaVersion: 2, memories, summaries: [],
	blocks: [], meta: [], deletedBin: [], tombstones: [], summarizedMsgCount: 0,
	trimmedMsgCount: 0, ...extra})
let serial = 0
const results = []
const run = async (data, fn) => {
	files.clear(); files.set("memory.json", JSON.stringify(data))
	const m = await import(`${pathToFileURL(path.join(output, "memory.mjs")).href}?i=${serial++}`)
	try {return await fn(m)} finally {await m.flushMemoryPersist(); m.__resetMemorySessionForTest()}
}
const record = (group, name, ok, detail = {}) => {
	const guard = !["召回/正文与别名", "召回/AI失败降级"].includes(group) || ["直接", "别名"].includes(detail.category)
	results.push({group, name, ok: !!ok, guard, ...detail})
	console.log(`${ok ? "PASS" : "GAP "} [${group}] ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`)
}
const prepared = (m, query = "你好") => m.memoryChatOptions(m.selectRecall(query),
	[{role: "system", content: "你是聊天助手。"}, {role: "user", content: query}], false).prepareMessages()
	.filter(msg => msg.role === "system").map(msg => msg.content).join("\n")
const candidateIds = prompt => (prompt.split("---记忆列表---\n")[1] ?? "").split("\n")
	.map(line => line.match(/^([^:]+): /)?.[1]).filter(Boolean)

const lib = [
	item("name", "我的名字是小明", {tags: ["identity"]}),
	item("home", "我住在杭州"), item("birthday", "我的生日是5月12日"),
	item("coffee", "我每天早上喝黑咖啡", {type: "preference", kw: ["饮料"]}),
	item("exam", "我在准备考研", {type: "project", kw: ["复习", "考试"]}),
	item("project", "我在开发NoriDroid", {type: "project", kw: ["项目", "桌宠"]}),
	item("movie", "我最喜欢的电影是星际穿越", {type: "preference", kw: ["科幻片"]}),
	item("pet", "我家养了一只猫", {kw: ["宠物"]}),
	item("sport", "我每天早上跑步", {type: "preference", kw: ["运动", "锻炼"]}),
	item("game", "我喜欢玩原神", {type: "preference", kw: ["游戏"]}),
	item("friend", "我有个朋友叫小林", {type: "relationship"}),
	item("allergy", "我对花生过敏"), item("music", "我喜欢听周杰伦的歌", {type: "preference"}),
	item("hobby", "我喜欢拍照", {type: "preference"}),
	item("diet", "我不吃香菜", {type: "preference"}), item("sleep", "我习惯晚上十一点睡觉", {type: "preference"}),
]
// 标注代表这次问题所需的个人信息；无关个人资料不应凭泛词被注入。
const cases = [
	["直接", "我的名字是什么", ["name"]], ["直接", "我现在住在哪座城市", ["home"]],
	["直接", "我的生日是几月几日", ["birthday"]], ["直接", "我每天喝的咖啡是什么", ["coffee"]],
	["直接", "我的考研准备如何安排", ["exam"]], ["直接", "NoriDroid现在进度怎么样", ["project"]],
	["直接", "再聊聊星际穿越这部电影", ["movie"]], ["直接", "你还记得我朋友小林吗", ["friend"]],
	["直接", "吃东西要注意什么过敏", ["allergy"]], ["直接", "我平时跑步怎么安排", ["sport"]],
	["别名", "推荐一部科幻片", ["movie"]], ["别名", "考前复习怎么安排", ["exam"]],
	["别名", "养宠物要花多少钱", ["pet"]], ["别名", "这个项目进度怎么样", ["project"]],
	["别名", "想锻炼身体", ["sport"]], ["别名", "那个开放世界游戏", ["game"]],
	["改写", "我叫什么", ["name"]], ["改写", "想看太空题材的影片", ["movie"]],
	["改写", "米哈游那个开放世界作品", ["game"]], ["改写", "我报考研究生的事", ["exam"]],
	["无关", "今天天气怎么样", []], ["无关", "你好呀", []], ["无关", "这道数学题怎么解", []],
	["无关", "我喜欢这个按钮的颜色", []], ["无关", "朋友问我天气怎么样", []],
	["无关", "帮我准备一份会议纪要模板", []], ["无关", "我的电脑怎么重装系统", []],
	["无关", "电影票丢了怎么补办", []],
].map(([category, query, required]) => ({category, query, required}))

try {
	for (const mode of ["正文与别名", "模拟AI选择", "AI失败降级"]) {
		for (const c of cases) await run(store(lib), async m => {
			let candidates = []
			const selection = mode === "正文与别名" ? m.selectRecall(c.query)
				: await m.selectRecallSmart(c.query, async prompt => {
					candidates = candidateIds(prompt)
					if (mode === "AI失败降级") throw new Error("模拟离线")
					return JSON.stringify(c.required.filter(id => candidates.includes(id)).map(id => ({id})))
				})
			const ids = m.materializeRecall(selection).ids
			const missing = c.required.filter(id => !ids.includes(id))
			const extra = ids.filter(id => !c.required.includes(id))
			record(`召回/${mode}`, `${c.category}：${c.query}`, !missing.length && !extra.length,
				{category: c.category, query: c.query, required: c.required, ids, missing, extra, candidates})
		})
	}

	const mixed = [item("target", "我在开发NoriDroid", {type: "project", kw: ["项目"]}),
		item("noise", "同事在筹备公司的项目大会", {type: "event"})]
	await run(store(mixed), async m => {
		const q = "我那个项目进度怎么样"
		const alone = await run(store([mixed[0]]), x => x.materializeRecall(x.selectRecall(q)).ids)
		// run() 是独立实例；恢复混合磁盘后复测，避免假磁盘被内部单条测试改变。
		files.set("memory.json", JSON.stringify(store(mixed)))
		m.reloadMemory()
		const together = m.materializeRecall(m.selectRecall(q)).ids
		record("召回/混合干扰", "无关正文命中是否挡住真实项目的别名", together.includes("target") && !together.includes("noise"), {alone, together})
	})
	for (const n of [20, 21, 100, 300]) await run(store([
		item("target", "我喜欢玩原神", {type: "preference", kw: ["游戏"], importance: 0.5, createdAt: NOW - 100 * DAY, updatedAt: NOW - 100 * DAY}),
		...Array.from({length: n - 1}, (_, i) => item(`noise-${i}`, `同事研究第${i}种机械零件`, {
			importance: 0.8 + i / (n * 10), createdAt: NOW - i * 1000, updatedAt: NOW - i * 1000})),
	]), async m => {
		let candidates = []
		const q = "那个开放世界游戏"
		const fast = m.materializeRecall(m.selectRecall(q)).ids
		const smart = await m.selectRecallSmart(q, async prompt => {
			candidates = candidateIds(prompt)
			return JSON.stringify(candidates.includes("target") ? [{id: "target"}] : [])
		})
		const ids = m.materializeRecall(smart).ids
		record("召回/候选规模", `${n}条库中的旧记忆仅靠别名相关`, ids.includes("target"), {n, fast, ids, candidates, targetShownToAI: candidates.includes("target")})
	})
	await run(store([item("target", "我家养了一只猫", {kw: ["宠物"]})]), async m => {
		const query = "宠物需要注意什么"
		const fast = m.materializeRecall(m.selectRecall(query)).ids
		const invalid = await m.selectRecallSmart(query, async () => "not valid JSON")
		record("召回/异常输出", "AI返回坏格式时是否保留可用的别名降级", m.materializeRecall(invalid).ids.includes("target"),
			{fast, ids: m.materializeRecall(invalid).ids, source: invalid.source})
	})
	await run(store([item("target", "我对花生过敏")]), async m => {
		const query = "先讲一些背景。".repeat(35) + "我对花生过敏，推荐食物时要避开什么？"
		let visible = ""
		const selection = await m.selectRecallSmart(query, async prompt => {
			visible = prompt.split("---用户发言---\n")[1].split("\n---记忆列表---")[0]
			return JSON.stringify(visible.includes("花生过敏") ? [{id: "target"}] : [])
		})
		record("召回/长问题", "200字之后的关键问题是否交给AI判断", visible.includes("花生过敏"),
			{queryLength: query.length, visibleLength: visible.length, visible, ids: m.materializeRecall(selection).ids})
	})

	const summaryCases = [
		{name: "偏好直接表述", fact: "我喜欢猫", text: "用户喜欢猫。", keep: false},
		{name: "偏好同义改写", fact: "我喜欢猫", text: "猫咪是用户最爱的动物。", keep: false},
		{name: "偏好分散表述", fact: "我喜欢猫", text: "用户谈起猫咪，说它是最喜欢的动物。", keep: false},
		{name: "他人相同偏好", fact: "我喜欢猫", text: "同事喜欢猫，用户喜欢狗。", keep: true},
		{name: "否定旧偏好", fact: "我喜欢猫", text: "用户不喜欢猫，偏爱狗。", keep: true},
		{name: "姓名直接表述", fact: "我的名字是小明", text: "用户的名字是小明。", keep: false},
		{name: "姓名同义改写", fact: "我的名字是小明", text: "主人平常用小明这个称谓。", keep: false},
		{name: "他人同名", fact: "我的名字是小明", text: "用户的朋友名字叫小明。", keep: true},
		{name: "住地直接表述", fact: "我住在北京", text: "用户住在北京。", keep: false},
		{name: "住地同义改写", fact: "我住在北京", text: "用户目前定居北京。", keep: false},
		{name: "他人住在同城", fact: "我住在北京", text: "朋友搬到北京，用户住在上海。", keep: true},
		{name: "生日直接表述", fact: "我的生日是5月12日", text: "用户的生日是5月12日。", keep: false},
		{name: "生日中文数字", fact: "我的生日是5月12日", text: "用户在五月十二日过生日。", keep: false},
	]
	for (const operation of ["收起", "删除", "永久删除"]) {
		for (const c of summaryCases) await run(store([item("target", c.fact)], {
			summaries: [summary("summary-target", c.text), summary("summary-safe", "用户正在学习法语。")],
			meta: [summary("meta-target", c.text)],
			blocks: [{id: "blk-target", fromTs: NOW - DAY, toTs: NOW - DAY + 1, msgCount: 2,
				topic: c.text.replace(/[。，]/g, ""), summary: c.text, itemIds: ["target"], createdAt: NOW - DAY}],
		}), async m => {
			if (operation === "收起") m.fadeMemoryManually("target")
			else {m.deleteMemory("target"); if (operation === "永久删除") m.deleteMemoryForever("target")}
			await m.flushMemoryPersist()
			m.reloadMemory()
			const text = prepared(m)
			const found = text.includes(c.text)
			record(`摘要/${operation}`, c.name, found === c.keep && text.includes("用户正在学习法语。"),
				{fact: c.fact, summary: c.text, shouldKeep: c.keep, injected: found, payload: text})
		})
		await run(store([item("target", "我喜欢猫")], {
			summaries: [summary("mixed", "用户喜欢猫。用户正在学习法语。")],
		}), async m => {
			if (operation === "收起") m.fadeMemoryManually("target")
			else {m.deleteMemory("target"); if (operation === "永久删除") m.deleteMemoryForever("target")}
			const text = prepared(m)
			record(`摘要/${operation}`, "同一摘要中的其他有效事实是否保留", !text.includes("喜欢猫") && text.includes("学习法语"), {payload: text})
		})
		await run(store([item("target", "我喜欢猫")], {
			summaries: [summary("mixed-clauses", "用户喜欢猫，用户正在学习法语。")],
		}), async m => {
			if (operation === "收起") m.fadeMemoryManually("target")
			else {m.deleteMemory("target"); if (operation === "永久删除") m.deleteMemoryForever("target")}
			const text = prepared(m)
			record(`摘要/${operation}`, "同一句中带明确主语的其他事实是否保留", !text.includes("喜欢猫") && text.includes("学习法语"), {payload: text})
		})
	}
	for (const c of [
		{fact: "我的名字是小明", next: "我的名字是小王", text: "主人平常用小明这个称谓。"},
		{fact: "我住在北京", next: "我住在上海", text: "用户目前定居北京。"},
	]) await run(store([item("old", c.fact, {sourceTs: NOW - DAY})], {
		summaries: [summary("old-summary", c.text)],
	}), async m => {
		m.mergeLlmMemories([item("new", c.next, {sourceTs: NOW, updatedAt: NOW})])
		const text = prepared(m, c.next.includes("名字") ? "我的名字是什么" : "我住在哪里")
		record("摘要/事实纠正", `${c.fact} → ${c.next}`, !text.includes(c.text) && text.includes(c.next), {payload: text, invalidated: m.listInvalidMemories().map(it => it.id)})
	})
	await run(store([item("target", "我喜欢猫")], {summaries: [summary("s-parent", "用户喜欢猫。")]}), async m => {
		m.deleteMemory("target"); m.deleteMemoryForever("target"); await m.flushMemoryPersist()
		const data = JSON.parse(files.get("memory.json"))
		data.meta = [summary("new-meta", "猫咪是用户最爱的动物。", {sourceIds: ["s-parent"]})]
		files.set("memory.json", JSON.stringify(data)); m.reloadMemory()
		record("摘要/归档继承", "永久删除后来源ID阻止改写归档重新注入", !prepared(m).includes("猫咪是用户最爱的动物。"))
	})
	for (const operation of ["删除", "永久删除"]) await run(store([item("target", "我喜欢猫")], {
		summaries: [summary("old", "用户喜欢猫。")],
	}), async m => {
		m.deleteMemory("target"); if (operation === "永久删除") m.deleteMemoryForever("target")
		await m.flushMemoryPersist()
		const messages = Array.from({length: 45}, (_, i) => ({role: i % 2 ? "assistant" : "user",
			content: i === 0 ? "我喜欢猫" : `这是普通闲聊${i}`, ts: NOW - DAY + i}))
		let prompt = ""
		await m.summarizeIfNeeded(messages, async p => {prompt = p; return '用户喜欢猫。\n===MEM===\n{"topic":"爱好","items":[]}'}, true)
		record("摘要/整理输入", `${operation}后旧原文中的删除事实不交给整理模型`, !prompt.includes("我喜欢猫"))
		await m.flushMemoryPersist(); m.reloadMemory()
		const text = prepared(m)
		record("摘要/后续整理", `${operation}后旧对话产生仅摘要、无记忆条目`, !text.includes("喜欢猫"), {payload: text})
	})
	for (const c of [
		{op: "删除", text: "用户喜欢猫。", shouldSend: false},
		{op: "删除", text: "猫咪是用户最爱的动物。", shouldSend: false},
		{op: "收起", text: "用户喜欢猫。", shouldSend: false},
		{op: "收起后留下", text: "用户喜欢猫。", shouldSend: true},
		{op: "删除后还原", text: "用户喜欢猫。", shouldSend: true},
	]) await run(store([item("target", "我喜欢猫")], {summaries: [summary("s", c.text)]}), async m => {
		if (c.op.startsWith("删除")) {m.deleteMemory("target"); if (c.op === "删除后还原") m.restoreDeletedMemory("target")}
		else {m.fadeMemoryManually("target"); if (c.op === "收起后留下") m.restoreFadedMemory("target")}
		let payload = []
		window.NoriChat.chatRequest = (id, _base, _key, _model, raw) => {
			payload = JSON.parse(raw)
			queueMicrotask(() => window.__noriChatRes(JSON.stringify({requestId: id, ok: true, content: "模拟回复"})))
		}
		try {
			const query = "你好"
			const messages = [{role: "system", content: "你是聊天助手。"}, {role: "user", content: query}]
			const r = await m.sendChat("https://example.invalid", "test-key", "test-model", messages, false,
				m.memoryChatOptions(m.selectRecall(query), messages, false))
			const text = payload.filter(x => x.role === "system").map(x => x.content).join("\n")
			record("实际桥请求/摘要", `${c.op}：${c.text}`, r.ok && text.includes(c.text) === c.shouldSend,
				{shouldSend: c.shouldSend, sent: text.includes(c.text), payload})
		} finally {delete window.NoriChat.chatRequest}
	})

	const grouped = Object.fromEntries([...new Set(results.map(r => r.group))].map(group => {
		const rows = results.filter(r => r.group === group)
		return [group, {total: rows.length, passed: rows.filter(r => r.ok).length, gaps: rows.filter(r => !r.ok).length}]
	}))
	const metrics = {}
	for (const mode of ["正文与别名", "模拟AI选择", "AI失败降级"]) {
		const rows = results.filter(r => r.group === `召回/${mode}`)
		const needed = rows.reduce((n, r) => n + r.required.length, 0)
		const missed = rows.reduce((n, r) => n + r.missing.length, 0)
		const extra = rows.reduce((n, r) => n + r.extra.length, 0)
		const injected = rows.reduce((n, r) => n + r.ids.length, 0)
		metrics[mode] = {queries: rows.length, needed, missed, unrelatedInjected: extra, injected,
			recall: (needed - missed) / needed, precision: injected ? (injected - extra) / injected : 1,
			exactQueries: rows.filter(r => r.ok).length}
	}
	const sourceHashes = Object.fromEntries(["memory/index.ts", "memory/core.ts", "memory/lifecycle.ts", "memory/context.ts", "chat/index.ts"]
		.map(file => [file, createHash("sha256").update(readFileSync(path.join(root, "src/services", file))).digest("hex")]))
	const report = {date: "2026-10-11", scope: "当前源码，固定人工标注语料，模拟公共文件原生桥；不调用真实模型。", sourceHashes,
		userReportedReinstallPassed: true, productionCodeChanged: true, grouped, metrics,
		guardScope: "结构护栏、摘要状态、直接/别名可达性必须通过；纯词面同义与噪音仍完整报告，不伪称实际模型准确率。",
		guards: {total: results.filter(r => r.guard).length, passed: results.filter(r => r.guard && r.ok).length}, results}
	const reportPath = process.argv.find(arg => arg.startsWith("--report="))?.slice("--report=".length)
		?? path.join(output, "report.json")
	writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
	console.log(JSON.stringify({grouped, metrics, total: results.length, gaps: results.filter(r => !r.ok).length, reportPath}, null, 2))
	process.exitCode = process.argv.includes("--strict") && results.some(r => r.guard && !r.ok) ? 1 : 0
} finally {Date.now = realNow}
