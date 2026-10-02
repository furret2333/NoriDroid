/* E2E: 设置一级菜单里的记忆条已收进「记忆库」二级菜单 (2026-09-26 用户要求)。
 *
 * 断言的是**真实 DOM**:
 *   ① 打开设置 → 一级页里**不再**有"陪着你的事(目标) / 历史总结"这些裸露列表, 但要有「记忆库」入口;
 *   ② 点入口 → 切到记忆库二级页, 目标 / 历史总结 / 长期记忆 三份都在;
 *   ③ 一级页里那些开关与操作按钮**必须还在** (别把设置项一起搬走了);
 *   ④ 全程无未捕获 JS 异常。
 *
 * 运行: node tmp-memcheck/e2e-mem-menu.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9403
const profile = mkdtempSync(join(tmpdir(), "nori-memmenu-"))
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
		if (m.method === "Runtime.exceptionThrown") {
			jsErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?")
		}
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

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4500)
	/* 先造点数据: 一条目标 + 一条长期记忆, 这样三份列表都有内容可断言 */
	await evalJs(`(async () => {
		const s = JSON.stringify({memories: [
			{id:"t1", content:"考雅思 7 分", type:"project", importance:0.8, confidence:0.9, createdAt:Date.now(), updatedAt:Date.now(), lastAccessedAt:0, accessCount:0, tags:["goal"], decayDays:null},
			{id:"t2", content:"我喜欢下雨天", type:"preference", importance:0.7, confidence:0.9, createdAt:Date.now(), updatedAt:Date.now(), lastAccessedAt:0, accessCount:0, tags:[], decayDays:90}
		], summaries: [{id:"sum-1-2", content:"聊了天气和考试。", createdAt:Date.now(), msgCount:25, tokenCount:10}], summarizedMsgCount:25, tombstones:[], meta:[]});
		window.NoriChat.writeFile("memory.json", s);
	})()`)
	await sleep(300)

	/* 打开设置 */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	const lv1 = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		if (!sheet) return {err: "没有 .sheet"}
		const txt = sheet.innerText || ""
		// 用可靠选择器判断"裸露的列表还在不在": 总结条目 .mem-summary / 目标的添加框 .goal-add /
		// 记忆条目 .mem-item —— 不要用 innerText 搜词, 因为入口按钮的文字里就写着"历史总结"。
		return {
			hasTitle: txt.includes("记忆系统"),
			goalItems: sheet.querySelectorAll(".goal-add").length,
			summaryItems: sheet.querySelectorAll(".mem-summary").length,
			memItems: sheet.querySelectorAll(".mem-item").length,
			hasEnter: !!([...sheet.querySelectorAll("button")].find(b => /记忆库/.test(b.textContent))),
			enterText: ([...sheet.querySelectorAll("button")].find(b => /记忆库/.test(b.textContent)) || {}).textContent || "",
			hasTrimToggle: txt.includes("摘要后自动裁剪旧聊天记录"),
			hasLlmToggle: txt.includes("用 AI 提取与整理记忆"),
			hasRecallToggle: txt.includes("用 AI 语义召回记忆"),
			hasPrune: txt.includes("清理低频记忆"),
			hasClear: txt.includes("清空全部记忆"),
			hasExport: !!([...sheet.querySelectorAll("button")].find(b => b.textContent.trim() === "导出")),
			panelTitle: (document.querySelector(".sheet-title, .panel-title") || {}).textContent || "",
		}
	})()`)
	console.log(`   一级页: ${JSON.stringify(lv1)}`)
	check("一级页不再裸露「陪着你的事（目标）」区块 (无 .goal-add)", lv1.goalItems === 0, JSON.stringify(lv1))
	check("一级页不再裸露「历史总结」列表 (无 .mem-summary)", lv1.summaryItems === 0, JSON.stringify(lv1))
	check("一级页不再裸露长期记忆列表 (无 .mem-item)", lv1.memItems === 0, JSON.stringify(lv1))
	check("一级页有「记忆库」入口按钮", lv1.hasEnter === true, JSON.stringify(lv1))
	check("入口按钮带上条数", /\d+\s*条/.test(lv1.enterText), lv1.enterText)
	check("一级页保留了记忆设置开关 (裁剪/AI 提取/AI 召回)", lv1.hasTrimToggle && lv1.hasLlmToggle && lv1.hasRecallToggle, JSON.stringify(lv1))
	check("一级页保留了记忆操作按钮 (清理/清空/导出)", lv1.hasPrune && lv1.hasClear && lv1.hasExport, JSON.stringify(lv1))

	/* 点入口 → 二级记忆库。
	 * ⚠ 2026-09-27 起入口有"害羞拦门": **要点三下才进** (前两下只弹气泡, 见 e2e-mem-gate)。
	 * 这里必须点满三下, 否则本测试会假红 —— 第一次改完就踩到过 (13/13 → 8/13)。 */
	const tapEnter3 = async () => {
		for (let i = 0; i < 3; i += 1) {
			const ok = await evalJs(`(() => { const b = document.querySelector(".sheet .mem-enter") || [...document.querySelectorAll(".sheet button")].find(x => /记忆库/.test(x.textContent)); if (!b) return false; b.click(); return true })()`)
			if (!ok) throw new Error("入口按钮不在了")
			await sleep(350)
		}
	}
	await tapEnter3()
	await sleep(700)
	const lv2 = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		if (!sheet) return {err: "没有 .sheet"}
		const txt = sheet.innerText || ""
		// 总结内容在 <details> 里默认折叠 ⇒ 断言"条目存在 + 展开后内容正确", 而不是直接搜 innerText
		const d = sheet.querySelector(".mem-summary")
		if (d) d.open = true
		const opened = d ? (d.querySelector(".mem-summary-content") || {}).innerText || "" : ""
		return {
			goalItems: sheet.querySelectorAll(".goal-add").length,
			goalContent: txt.includes("考雅思 7 分"),
			summaryItems: sheet.querySelectorAll(".mem-summary").length,
			summaryContent: (d ? ((d.querySelector(".mem-summary-content") || {}).innerText || "") : "") !== "" || opened !== "",
			summaryText: opened,
			hasLongTermLabel: txt.includes("长期记忆"),
			memContent: txt.includes("我喜欢下雨天"),
			memItems: sheet.querySelectorAll(".mem-item").length,
			hasSearch: !!sheet.querySelector(".mem-search-input"),
			hasFilter: !!sheet.querySelector(".mem-search-sel"),
		}
	})()`)
	console.log(`   二级页: ${JSON.stringify(lv2)}`)
	check("二级页有「陪着你的事（目标）」且显示目标内容", lv2.goalItems === 1 && lv2.goalContent === true, JSON.stringify(lv2))
	check("二级页有「历史总结」条目且展开后内容正确", lv2.summaryItems === 1 && lv2.summaryText.includes("聊了天气和考试"), JSON.stringify(lv2))
	check("二级页有「长期记忆」且显示记忆内容", lv2.hasLongTermLabel === true && lv2.memContent === true, JSON.stringify(lv2))
	check("二级页保留搜索与类型筛选", lv2.hasSearch && lv2.hasFilter, JSON.stringify(lv2))

	/* 从其它面板进入也要能到二级页 (panel 切换不能互相抵消) */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(500)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /日记/.test(x.textContent))?.click()`)
	await sleep(700)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(500)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(800)
	await tapEnter3()          // 同样要点三下 (拦门)
	await sleep(700)
	const lv2b = await evalJs(`(() => { const t = (document.querySelector(".sheet")||{}).innerText || ""; return {hasGoal: t.includes("陪着你的事"), hasSummary: t.includes("历史总结")} })()`)
	check("从其它面板切换后仍能进入二级记忆库页", lv2b.hasGoal === true && lv2b.hasSummary === true, JSON.stringify(lv2b))

	check("全程无未捕获 JS 异常", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))

	const failed = results.filter(r => !r.cond)
	console.log(`\n${results.length - failed.length}/${results.length} passed`)
	if (failed.length) { process.exitCode = 1; console.log("FAILED:", failed.map(f => f.name).join(" | ")) }
} catch (e) {
	console.error("探针异常:", e?.message || e)
	process.exitCode = 2
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
