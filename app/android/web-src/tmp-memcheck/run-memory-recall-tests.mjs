/** Fixed synthetic regression corpus. --baseline=<ref> reads Git objects without switching checkout.
 * Smart selection is an oracle/mock, not a measurement of actual model answer quality. */
import assert from "node:assert/strict"
import {mkdtempSync, readFileSync, readdirSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {spawnSync} from "node:child_process"
import path from "node:path"
import {pathToFileURL} from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const repo = path.resolve(root, "../../..")
const out = mkdtempSync(path.join(tmpdir(), "nori-recall-regression-"))
const baseline = process.argv.find(x => x.startsWith("--baseline="))?.slice(11)
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(x => x.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")))
const raw = {name: "sources", setup(b) {
	b.onResolve({filter: /\?raw$/}, a => ({path: path.resolve(a.resolveDir, a.path.slice(0, -4)), namespace: "raw"}))
	b.onLoad({filter: /./, namespace: "raw"}, a => ({loader: "text", contents: readFileSync(a.path, "utf8")}))
	if (baseline) b.onLoad({filter: /src[\\/]services[\\/]memory[\\/].*\.ts$/}, a => {
		const relative = path.relative(repo, a.path).replaceAll("\\", "/")
		const result = spawnSync("git", ["show", `${baseline}:${relative}`], {cwd: repo, encoding: "utf8"})
		if (result.status !== 0) throw new Error(result.stderr)
		return {loader: "ts", contents: result.stdout}
	})
}}
await build({absWorkingDir: root, stdin: {contents:
	'export * from "./src/services/memory/index"; export * from "./src/services/memory/context";',
	resolveDir: root, loader: "ts"}, outfile: path.join(out, "memory.mjs"), bundle: true,
	platform: "neutral", format: "esm", plugins: [raw]})
const files = new Map()
globalThis.window = {NoriChat: {
	readFile: name => files.get(name) ?? "",
	writeFile: (name, text) => {files.set(name, text); return "ok"},
	writeFileIfUnchanged: (name, expected, text) => {
		if ((files.get(name) ?? "") !== expected) return "conflict"
		files.set(name, text); return "ok"
	},
}}
const NOW = Date.now(), DAY = 86400000
const item = (id, content, more = {}) => ({id, content, type: "fact", importance: .7, confidence: .9,
	createdAt: NOW, updatedAt: NOW, lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: null, ...more})
const seed = memories => ({schemaVersion: 2, memories, summaries: [], blocks: [], meta: [],
	deletedBin: [], tombstones: [], summarizedMsgCount: 0, trimmedMsgCount: 0})
let seq = 0
const results = [], retrieval = [], sizes = []
const run = async (name, memories, fn) => {
	files.clear(); files.set("memory.json", JSON.stringify(seed(memories)))
	const m = await import(`${pathToFileURL(path.join(out, "memory.mjs")).href}?i=${seq++}`)
	try {await fn(m); results.push({name, ok: true}); console.log(`PASS ${name}`)}
	catch (e) {results.push({name, ok: false, error: e.message}); console.log(`GAP ${name}: ${e.message}`)}
	finally {await m.flushMemoryPersist(); m.__resetMemorySessionForTest()}
}
const ids = (m, selection) => m.materializeRecall(selection).ids.sort()
const candidateIds = prompt => (prompt.split("---记忆列表---\n")[1] ?? "").split("\n")
	.map(line => line.match(/^([^:]+): /)?.[1]).filter(Boolean)
const oracle = (required, capture = () => {}) => async prompt => {
	const candidates = candidateIds(prompt); capture(candidates, prompt)
	return JSON.stringify(required.filter(id => candidates.includes(id)).map(id => ({id})))
}

const people = [
	item("tea", "我喜欢喝茶", {type: "preference"}),
	item("friend", "朋友小林喜欢喝咖啡", {type: "preference"}),
	item("other-friend", "朋友小王喜欢喝牛奶", {type: "preference"}),
	item("mother", "妈妈对虾过敏"), item("allergy", "我对花生过敏"),
	item("cat", "我的猫叫小雪"), item("name", "我叫小明", {tags: ["identity"]}),
	item("movie", "我喜欢的电影叫星际穿越", {type: "preference"}),
]
const queries = [
	["我喜欢什么", ["tea", "movie"]], ["我的朋友小林喜欢什么", ["friend"]],
	["朋友小林喜欢什么", ["friend"]], ["小林喜欢什么", ["friend"]],
	["你还记得我朋友小林吗", ["friend"]], ["对了，我的朋友小林喜欢什么", ["friend"]],
	["我的妈妈对什么过敏", ["mother"]], ["妈妈对什么过敏", ["mother"]],
	["我对什么过敏", ["allergy"]], ["我和妈妈分别对什么过敏", ["allergy", "mother"]],
	["我的猫叫什么", ["cat"]], ["我的电影叫什么", ["movie"]],
	["我叫什么", ["name"]], ["我的名字是什么", ["name"]],
	["你记得我的名字吗", ["name"]],
	["喜欢什么", []], ["她呢", []], ["那个项目进展如何", []],
	["今天天气怎么样", []], ["朋友问我天气怎么样", []], ["电影票丢了怎么补办", []],
]
for (const mode of ["lexical", "oracle", "failure"]) for (const [query, expected] of queries) {
	await run(`${mode} subject: ${query}`, people, async m => {
		let shown = []
		const selection = mode === "lexical" ? m.selectRecall(query) : await m.selectRecallSmart(query,
			mode === "oracle" ? oracle(expected, c => {shown = c}) : async () => {throw new Error("offline")})
		const actual = ids(m, selection)
		retrieval.push({mode, query, expected, actual, shown,
			missing: expected.filter(id => !actual.includes(id)), extra: actual.filter(id => !expected.includes(id))})
		assert.deepEqual(actual, [...expected].sort())
	})
}
await run("malicious selector cannot cross subjects or guess bare pronouns", people, async m => {
	for (const query of ["我对什么过敏", "我的朋友小林喜欢什么", "她呢"]) {
		const wanted = query.startsWith("我对") ? ["allergy", "name", "tea", "movie"] : query.startsWith("我的朋友") ? ["friend"] : []
		const selection = await m.selectRecallSmart(query, oracle(people.map(x => x.id)))
		const actual = ids(m, selection)
		assert.ok(actual.every(id => wanted.includes(id)), `${query}: ${actual}`)
	}
})

const projects = [item("nori", "我在开发NoriDroid", {type: "project"}),
	item("atlas", "我在开发Atlas", {type: "project"}), item("mother", "妈妈对虾过敏"), item("father", "爸爸对牛奶过敏")]
const user = content => ({role: "user", content})
const refs = [
	["那个项目进展如何", [user("NoriDroid项目最近在开发")], ["nori"]],
	["那个项目进展如何", [user("NoriDroid项目最近在开发"), {role: "assistant", content: "Atlas也不错"}], ["nori"]],
	["那个项目进展如何", [user("NoriDroid项目最近在开发"), user("Atlas项目正在开发")], ["atlas"]],
	["再聊NoriDroid项目", [user("Atlas项目正在开发")], ["nori"]],
	["那个项目进展如何", [user("NoriDroid和Atlas两个项目")], []],
	["那个项目进展如何", [user("NoriDroid项目最近在开发"), user("换个话题，谈天气")], []],
	["那个项目进展如何", [{role: "assistant", content: "NoriDroid项目最近在开发"}], []],
	["她对什么过敏", [user("妈妈最近怎么样")], ["mother"]],
	["她对什么过敏", [user("妈妈和爸爸最近怎么样")], []],
	["那个项目进展如何", [user("NoriDroid项目"), ...Array.from({length: 20}, () => user("别的话题"))], []],
]
for (const [query, recent, expected] of refs) await run(`context: ${query} / ${recent.map(x => x.content).join(" / ").slice(-100)}`, projects, async m => {
	const selection = m.selectRecall(query, recent)
	assert.deepEqual(ids(m, selection), [...expected].sort())
	const smart = await m.selectRecallSmart(query, oracle(expected), 6, recent)
	assert.deepEqual(ids(m, smart), [...expected].sort())
})

for (const n of [19, 20, 21, 50, 100, 300]) for (const alias of [true, false]) {
	const target = item("target", "我在制作晨露", {type: "project", kw: alias ? ["自动化工具"] : undefined,
		importance: .3, createdAt: NOW - 400 * DAY, updatedAt: NOW - 400 * DAY, decayDays: 60})
	const lib = [target, ...Array.from({length: n - 1}, (_, i) => item(`noise-${i}`, `日常记录编号${i}`, {importance: .95}))]
	await run(`candidate size ${n}, ${alias ? "alias" : "no lexical overlap"}`, lib, async m => {
		let shown = []
		const selection = await m.selectRecallSmart("自动化工具进度如何", oracle(["target"], c => {shown = c}))
		const actual = ids(m, selection)
		sizes.push({n, alias, candidateCount: shown.length, candidateHit: shown.includes("target"), injected: actual,
			unrelated: actual.filter(id => id !== "target").length})
		assert.ok(shown.length <= 20); assert.ok(shown.includes("target")); assert.deepEqual(actual, ["target"])
		assert.deepEqual(ids(m, await m.selectRecallSmart("今天天气怎么样", oracle([]))), [])
	})
}

const unsafe = [
	"我只是开玩笑说我喜欢香菜", "如果我喜欢香菜，你会做什么", "假设我每天吃香菜",
	"朋友说我喜欢香菜", "他说：我喜欢香菜", "“我喜欢香菜”是台词", "我喜欢香菜吗？",
	"谁说我喜欢香菜", "不是说我喜欢香菜", "我以前喜欢香菜", "朋友小林最喜欢香菜",
]
for (const text of unsafe) await run(`rule production write: ${text}`, [], async m => {
	m.addMemoriesFromText(text)
	assert.equal(m.listAll().memories.length, 0)
	await m.extractMemoriesSmart(text, null)
	assert.equal(m.listAll().memories.length, 0)
})
for (const text of ["我只是开玩笑说我喜欢香菜", "如果我喜欢香菜，你会做什么", "他说：我喜欢香菜", "我喜欢香菜吗？", "朋友小林喜欢香菜"]) {
	await run(`mock LLM false self-fact blocked: ${text}`, [], async m => {
		await m.extractMemoriesSmart(text, async () => JSON.stringify({facts: [{content: "我喜欢香菜", type: "preference", importance: .8, confidence: .9}]}))
		assert.equal(m.listAll().memories.length, 0)
	})
}
for (const text of ["我喜欢香菜", "我不喜欢香菜", "我叫小明", "记住：我喜欢香菜", "请记住我对虾过敏", "我以前喜欢茶，现在我喜欢咖啡", "我喜欢猫，你呢？"]) {
	await run(`clear fact still writes: ${text}`, [], async m => {
		m.addMemoriesFromText(text)
		assert.ok(m.listAll().memories.length > 0)
		if (text.includes("以前")) assert.ok(m.listAll().memories.every(x => !x.content.includes("茶")))
	})
}
for (const withBlock of [true, false]) await run(`default summary write guard, memoryBlock=${withBlock}`, [], async m => {
	const history = Array.from({length: 45}, (_, i) => ({role: i % 2 ? "assistant" : "user",
		content: i === 0 ? "我只是开玩笑说我喜欢香菜" : "闲聊", ts: NOW + i}))
	const response = withBlock ? '用户喜欢香菜。聊了一个玩笑。\n===MEM===\n{"topic":"玩笑","items":[{"content":"我喜欢香菜","type":"preference","importance":0.8}]}' : "用户喜欢香菜。聊了一个玩笑。\n记忆要点：\n- 我喜欢香菜"
	await m.summarizeIfNeeded(history, async () => response, withBlock, true)
	assert.equal(m.listAll().memories.length, 0)
	assert.equal(m.summaryBlock().includes("喜欢香菜"), false)
})
await run("qualified past facts remain qualified in summary and memory", [], async m => {
	const history = Array.from({length: 45}, (_, i) => ({role: i % 2 ? "assistant" : "user",
		content: i === 0 ? "我以前喜欢茶" : "闲聊", ts: NOW + i}))
	await m.summarizeIfNeeded(history, async () => '用户以前喜欢茶。\n===MEM===\n{"topic":"过去","items":[{"content":"我以前喜欢茶","type":"preference","importance":0.8}]}', true, true)
	assert.ok(m.summaryBlock().includes("以前喜欢茶"))
	assert.ok(m.listAll().memories.some(x => x.content.includes("以前喜欢茶")))
})

for (const [reply, expected] of [['[{"id":"cat"}]', "success"], ["[]", "empty"], ["broken-json", "parse-error"], ["throw", "network-error"]]) {
	await run(`recall outcome ${expected}`, [item("cat", "我喜欢猫")], async m => {
		const selection = await m.selectRecallWithinBudget("我喜欢猫", async () => {
			if (reply === "throw") throw new Error("offline-secret-never-log")
			return reply
		}, 100)
		assert.equal(selection.metrics?.outcome, expected)
		assert.deepEqual(ids(m, selection), expected === "empty" ? [] : ["cat"])
	})
}
await run("inner smart timeout is distinct from outer budget timeout", [item("cat", "我喜欢猫")], async m => {
	const realSet = globalThis.setTimeout
	globalThis.setTimeout = (fn, delay, ...args) => realSet(fn, delay === 3000 ? 1 : delay, ...args)
	try {
		const selection = await m.selectRecallSmart("我喜欢猫", () => new Promise(() => {}))
		assert.equal(selection.metrics?.outcome, "inner-timeout")
		assert.deepEqual(ids(m, selection), ["cat"])
	} finally {globalThis.setTimeout = realSet}
})
await run("outer budget, immediate cancellation, late replies and diagnostic privacy", [item("cat", "我喜欢猫")], async m => {
	m.setDiagEnabled(true)
	let late, requestSignal
	const selection = await m.selectRecallWithinBudget("我喜欢猫", (_p, signal) => {
		requestSignal = signal; return new Promise(resolve => {late = resolve})
	}, 10)
	assert.equal(selection.metrics?.outcome, "budget-timeout"); assert.equal(requestSignal.aborted, true)
	const cancel = new AbortController()
	const pending = m.selectRecallWithinBudget("我喜欢猫", () => new Promise(() => {}), 1000, cancel.signal)
	cancel.abort()
	const cancelled = await pending
	assert.equal(cancelled.metrics?.outcome, "cancelled")
	late('[{"id":"cat"}]'); await new Promise(r => setTimeout(r, 0))
	assert.equal(m.listAll().memories[0].accessCount, 0)
	const header = JSON.parse(m.buildInjectJsonl().split("\n")[0])
	assert.ok(header.recalls.some(x => x.outcome === "budget-timeout"))
	assert.ok(header.recalls.some(x => x.outcome === "cancelled"))
	assert.ok(!JSON.stringify(header.recalls).includes("喜欢猫"))
	m.clearInjects(); m.setDiagEnabled(false)
	await m.selectRecallWithinBudget("我喜欢猫", null, 100)
	assert.equal(JSON.parse(m.buildInjectJsonl().split("\n")[0]).recalls.length, 0)
})
await run("send-time subject edits cannot cross owners", people, async m => {
	const selection = m.selectRecall("我对什么过敏")
	const data = JSON.parse(files.get("memory.json")); data.memories.find(x => x.id === "allergy").content = "妈妈对花生过敏"
	files.set("memory.json", JSON.stringify(data))
	assert.deepEqual(ids(m, selection), [])
})
await run("administrative question can recall factual device data", [item("device", "我的电脑装了Linux")], async m => {
	assert.deepEqual(ids(m, m.selectRecall("我的电脑怎么重装系统")), ["device"])
})
await run("pet and film names never use personal historical attributes", [item("home", "我住在杭州"), item("name", "我叫小明")], async m => {
	for (const q of ["我的猫叫什么", "我家的鸟叫什么", "我家的电影叫什么", "我以前的猫叫什么"]) {
		assert.deepEqual(ids(m, m.selectRecall(q)), [])
	}
})

const metrics = Object.fromEntries(["lexical", "oracle", "failure"].map(mode => {
	const rows = retrieval.filter(r => r.mode === mode), targets = rows.reduce((n, r) => n + r.expected.length, 0)
	return [mode, {queries: rows.length, targets, recalled: rows.reduce((n, r) => n + r.expected.length - r.missing.length, 0),
		unrelated: rows.reduce((n, r) => n + r.extra.length, 0)}]
}))
const report = {scope: "Synthetic fixtures and simulated LLM/native bridge; no actual model, Android latency, cost or answer quality measured.",
	baseline: baseline ?? null, results, metrics, retrieval, sizes}
const reportPath = process.argv.find(x => x.startsWith("--report="))?.slice(9) ?? path.join(out, "report.json")
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify({passed: results.filter(r => r.ok).length, total: results.length, metrics, reportPath}, null, 2))
process.exitCode = !baseline && results.some(r => !r.ok) ? 1 : 0
