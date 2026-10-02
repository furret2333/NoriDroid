/* E2E: 记忆库「块视图」(重构 P4, 2026-09-27)。
 *
 * 断言的是**真实 DOM**:
 *   ① 浏览态按**块**排时间线 (标题 = 主题 · 时间段 · N 条对话), 块内**再按类型分小节**;
 *   ② 没挂进任何块的条目进「未归类」(否则"在库里但界面看不到");
 *   ③ 块里不重复出现已作废的条目 (它在下面「已作废」里);
 *   ④ 顶部有「待整理 N 条」+「立即整理」按钮, 点了有反馈;
 *   ⑤ 搜索时退回按类型平铺 (找东西时时间线是干扰)。
 *
 * 运行: node tmp-memcheck/e2e-mem-blocks.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9416
const profile = mkdtempSync(join(tmpdir(), "nori-memblocks-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sessionId) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sessionId ? {sessionId} : {})}))
	return new Promise((res, rej) => {
		pending.set(m, {res, rej})
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 25000)
	})
}
const results = []
const check = (name, cond, detail = "") => {
	results.push({name, cond: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ← ${detail}`}`)
}
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	const jsErrors = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") jsErrors.push(m.params?.exceptionDetails?.exception?.description || "?")
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}

	const S = Buffer.from(JSON.stringify({
		apiKey: "sk-e2e", baseUrl: "https://api.e2e.test", model: "e2e-model",
		memoryLlmExtract: true, smartRecall: false,
	})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4300)

	/* 造数据: 两个块 + 一条未归类 + 一条已作废 (第 1 块里也挂着那条作废的) */
	const ts0 = 1790000000000
	await evalJs(`(() => {
		const mk = (id, content, type, over = {}) => ({id, content, type, importance:0.8, confidence:0.9,
			createdAt:${ts0}, updatedAt:${ts0}, lastAccessedAt:0, accessCount:0, tags:[], decayDays:null, ...over});
		const s = JSON.stringify({
			memories: [
				mk("b1m1", "我叫小明", "fact", {tags:["explicit"]}),
				mk("b1m2", "我不喜欢下雨天", "preference", {tags:["llm"]}),
				mk("b1m3", "我想养猫", "project", {invalidAt: ${ts0} + 5000}),
				mk("b2m1", "我最近在准备考研", "project", {tags:["llm"]}),
				mk("u1", "我养了一只猫叫年年", "event", {tags:["llm"]})
			],
			summaries: [
				{id:"sum-1", content:"聊了养猫和天气。", createdAt:${ts0}, msgCount:25, tokenCount:20},
				{id:"sum-2", content:"聊了考研。", createdAt:${ts0} + 600000, msgCount:25, tokenCount:20}
			],
			summarizedMsgCount: 50, tombstones: [], meta: [], schemaVersion: 2,
			blocks: [
				{id:"blk-a", fromTs:${ts0}, toTs:${ts0} + 24000, msgCount:25, topic:"养猫与天气",
				 summary:"聊了养猫和天气。", createdAt:${ts0}, itemIds:["b1m1","b1m2","b1m3"]},
				{id:"blk-b", fromTs:${ts0} + 600000, toTs:${ts0} + 624000, msgCount:25, topic:"考研",
				 summary:"聊了考研。", createdAt:${ts0} + 600000, itemIds:["b2m1"]}
			]
		});
		window.NoriChat.writeFile("memory.json", s);
		return true
	})()`)
	await sleep(300)

	/* 打开记忆库 (点三下) */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	for (let i = 0; i < 3; i += 1) {
		await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`)
		await sleep(350)
	}
	await sleep(800)

	const view = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		if (!sheet) return {err: "没有 .sheet"}
		const blocks = [...sheet.querySelectorAll(".mem-block")]
		return {
			blockCount: blocks.length,
			titles: blocks.map(b => (b.querySelector(":scope > .mem-sec-title") || {}).innerText || ""),
			subTitles: blocks.map(b => [...b.querySelectorAll(".mem-group .mem-sec-title")].map(e => e.innerText.trim())),
			itemsByBlock: blocks.map(b => [...b.querySelectorAll(".mem-item .mem-text")].map(e => e.innerText.trim())),
			pending: (sheet.querySelector(".mem-pending") || {}).innerText || "",
			pendingBtns: [...sheet.querySelectorAll(".mem-pending button")].map(b => b.textContent.trim()),
			groupTitlesFlat: [...sheet.querySelectorAll(".mem-group .mem-sec-title")].map(e => e.innerText.trim()),
		}
	})()`)
	console.log(`   块视图: ${JSON.stringify(view, null, 0).slice(0, 900)}`)
	check("①有三个块节 (两个记忆块 + 未归类)", view.blockCount === 3, JSON.stringify(view.titles))
	check("①块标题 = 主题 · 时间段 · N 条对话",
		new RegExp("^养猫与天气 · .+ · 25 条对话$").test(String(view.titles[0])) &&
		/^考研 · /.test(String(view.titles[1])),
		JSON.stringify(view.titles))
	check("①块内按类型分小节 (第 1 块: 事实 + 偏好)",
		(view.subTitles[0] || []).join("|") === "事实（1）|偏好（1）",
		JSON.stringify(view.subTitles[0]))
	check("①第 2 块内: 项目（1）", (view.subTitles[1] || []).join("|") === "项目（1）", JSON.stringify(view.subTitles[1]))
	check("②未归类节标题正确", String(view.titles[2]) === "未归类", String(view.titles[2]))
	check("②没挂块的条目进了未归类 (事件)",
		(view.subTitles[2] || []).join("|") === "事件（1）" &&
		(view.itemsByBlock[2] || []).some(t => t.includes("年年")),
		JSON.stringify(view.itemsByBlock[2]))
	check("③块里不出现已作废的条目 (它在下面「已作废」里)",
		!(view.itemsByBlock[0] || []).some(t => t.includes("我想养猫")),
		JSON.stringify(view.itemsByBlock[0]))
	check("④有「待整理 N 条」行", /待整理/.test(String(view.pending)), String(view.pending))
	check("④有整理按钮 (无可整理内容时置灰并写「暂无可整理」)",
		(view.pendingBtns || []).some(t => t === "立即整理" || t === "暂无可整理"),
		JSON.stringify(view.pendingBtns))

	/* ④ (A+B, 2026-09-27 深夜): 没有可整理内容时按钮置灰 + 文案说清, 且不再"点了没反应" ——
	 * 具体行为(反馈就地显示、有待整理时真整理)由 probe-organize-button.mjs 走真聊天验证 */
	const btnState = await evalJs(`(() => {
		const b = document.querySelector(".sheet .mem-pending button")
		return b ? {text: b.textContent.trim(), disabled: !!b.disabled} : null
	})()`)
	console.log(`   整理按钮: ${JSON.stringify(btnState)}`)
	check("④无待整理内容时按钮置灰 (不再'可点但无事发生')",
		!!btnState && btnState.disabled === true && btnState.text === "暂无可整理",
		JSON.stringify(btnState))

	/* ⑤ 搜索时退回按类型平铺 (不再显示块标题) */
	await evalJs(`(() => { const i = document.querySelector(".sheet .mem-search-input"); i.value = "下雨"; i.dispatchEvent(new Event("input", {bubbles: true})); return true })()`)
	await sleep(600)
	const searched = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		return {
			blockCount: sheet.querySelectorAll(".mem-block").length,
			groupTitles: [...sheet.querySelectorAll(".mem-group .mem-sec-title")].map(e => e.innerText.trim()),
			txt: sheet.innerText || "",
		}
	})()`)
	console.log(`   搜索态: ${JSON.stringify(searched).slice(0, 300)}`)
	check("⑤搜索时退回按类型平铺 (没有块节)", searched.blockCount === 0, `blocks=${searched.blockCount}`)
	check("⑤搜索能命中块内条目",
		searched.txt.includes("我不喜欢下雨天") && searched.groupTitles.join("|") === "偏好（1）",
		JSON.stringify(searched.groupTitles))

	check("全程无未捕获 JS 异常", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}

const failed = results.filter(r => !r.cond)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
	process.exitCode = 1
	console.log("FAILED:", failed.map(f => f.name).join(" | "))
}
