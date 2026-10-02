/* E2E: 记忆库的「已作废」历史 + 来源标注 (B1/B2, 2026-09-27)。
 *
 * 断言的是**真实 DOM / 真实持久化**:
 *   ① 被作废的记忆 (invalidAt) 默认折叠在「已作废（N）」里 —— 折叠时不该出现在渲染文本里;
 *   ② 展开后能看到内容 + 作废时间 + 「还原」按钮;
 *   ③ 点「还原」→ 它回到"长期记忆"里, 作废区消失, 且**真的落盘** (memory.json 里 invalidAt 没了);
 *   ④ 长期记忆条目带来源标注: 「你声明」(explicit/身份) / 「我推断」(tag=llm);
 *   ⑤ 导出的 Markdown 里带「已作废的记忆」段落 (含作废时间戳)。
 *
 * 运行: node tmp-memcheck/e2e-mem-invalid.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9411
const profile = mkdtempSync(join(tmpdir(), "nori-meminv-"))
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
	/* 造数据: 覆盖分组/来源标注/固定/目标/已作废
	 *  - 你声明(偏好) / 我推断(项目) / 固定(事实) / 目标(项目+goal) / 已作废(事实·名字被改口) */
	await evalJs(`(async () => {
		const now = Date.now();
		const mk = (id, content, type, over = {}) => ({id, content, type, importance:0.8, confidence:0.9,
			createdAt:now, updatedAt:now, lastAccessedAt:0, accessCount:0, tags:[], decayDays:null, ...over});
		const s = JSON.stringify({memories: [
			mk("v1", "我喜欢下雨天", "preference", {tags:["explicit"]}),
			mk("v2", "我最近在准备考研", "project", {tags:["llm"]}),
			mk("v3", "我叫小明", "fact", {importance:0.9, tags:["identity"], invalidAt: now - 3600000}),
			mk("v4", "主人的名字叫小桧", "fact", {importance:0.85, tags:["llm","pinned"]}),
			mk("g1", "考雅思 7 分", "project", {tags:["goal"], importance:0.85})
		], summaries: [], summarizedMsgCount:0, tombstones:[], meta:[]});
		window.NoriChat.writeFile("memory.json", s);
		// 捕获导出内容 (导出走 writeFile)
		window.__exported = null;
		const orig = window.NoriChat.writeFile;
		window.NoriChat.writeFile = function (n, c) { if (String(n).endsWith(".md")) window.__exported = String(c); return orig.call(this, n, c) };
	})()`)
	await sleep(300)

	/* 打开设置 → **先在一级页导出** (导出按钮在「记忆系统」一级页, 进了记忆库二级页就没有了),
	 * 再进记忆库做 DOM 断言。导出内容含作废条 —— 这是 B2 的"历史可复盘"。 */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => b.textContent.trim() === "导出")?.click()`)
	await sleep(600)
	const md = await evalJs(`window.__exported || ""`)
	check("B2: 导出 Markdown 里有「已作废的记忆」段落", /## 已作废的记忆（1 条/.test(md), md.slice(0, 400))
	check("B2: 导出里带作废时间戳", /我叫小明.*作废于/.test(md), md.slice(0, 600))
	check("B2: 导出里带来源标注", /\[偏好·你声明\]/.test(md) && /\[项目·我推断\]/.test(md), md.slice(0, 600))

	/* 进记忆库 (入口要点三下, 见 e2e-mem-gate) */
	for (let i = 0; i < 3; i += 1) {
		await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`)
		await sleep(350)
	}
	await sleep(700)

	const collapsed = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		if (!sheet) return {err: "没有 .sheet"}
		const t = sheet.innerText || ""
		const d = sheet.querySelector(".mem-invalid")
		return {
			hasSection: !!d,
			open: d ? d.open : null,
			label: d ? (d.querySelector("summary") || {}).innerText || "" : "",
			textHasInvalidContent: t.includes("我叫小明"),
			activeHas: t.includes("我喜欢下雨天") && t.includes("我最近在准备考研"),
			provs: [...sheet.querySelectorAll(".mem-tag.src")].map(e => e.innerText.trim()),
			// B/分组: 按类型分小节 (类型不再挂在每行)
			groups: [...sheet.querySelectorAll(".mem-group .mem-sec-title")].map(e => e.innerText.trim()),
			groupRows: [...sheet.querySelectorAll(".mem-group")].map(g => g.querySelectorAll(".mem-item").length),
			rowTypeChips: sheet.querySelectorAll(".mem-item .mem-tag.fact, .mem-item .mem-tag.preference, .mem-item .mem-tag.project").length,
			goalIcon: [...sheet.querySelectorAll(".mem-item .mem-ico")].map(e => e.innerText.trim()),
			goalRowText: (sheet.querySelector(".mem-sec .mem-item .mem-text") || {}).innerText || "",
			// C/可发现性
			stats: (sheet.querySelector(".mem-stats") || {}).innerText || "",
			bottomBtns: [...sheet.querySelectorAll(".mem-btns-bottom button")].map(b => b.textContent.trim()),
		}
	})()`)
	console.log(`   折叠态: ${JSON.stringify(collapsed)}`)
	check("B1: 有「已作废」折叠区", collapsed.hasSection === true, JSON.stringify(collapsed))
	check("B1: 默认折叠 (折叠态渲染文本里看不到作废内容)", collapsed.open === false && collapsed.textHasInvalidContent === false,
		JSON.stringify(collapsed))
	check("B1: 折叠标题带条数", /已作废（1）/.test(collapsed.label), collapsed.label)
	check("B1: 仍然生效的记忆照常展示", collapsed.activeHas === true, JSON.stringify(collapsed))
	check("B2: 有来源标注 (你声明 / 我推断)",
		collapsed.provs.includes("你声明") && collapsed.provs.includes("我推断"), JSON.stringify(collapsed.provs))
	/* B: 分组断言 —— 事实/偏好/项目 各一节, 组内条数对得上, 行内**不再有类型标签** */
	check("B: 按类型分成小节 (事实/偏好/项目, 各自成节)",
		collapsed.groups.join("|") === "事实（1）|偏好（1）|项目（1）",
		JSON.stringify(collapsed.groups))
	check("B: 每组条数与标题一致", collapsed.groupRows.join(",") === "1,1,1", JSON.stringify(collapsed.groupRows))
	check("B: 行内不再挂类型标签 (类型进小节标题)", collapsed.rowTypeChips === 0, `rowTypeChips=${collapsed.rowTypeChips}`)
	check("B: 固定用图标贴在正文行首 (不再占标签位)",
		collapsed.goalIcon.includes("📌"), JSON.stringify(collapsed.goalIcon))
	check("B: 目标小节的行首带 🎯 (目标不在长期记忆里重复, 图标跟着走)",
		collapsed.goalRowText.includes("🎯") && collapsed.goalRowText.includes("考雅思"), collapsed.goalRowText)
	check("C: 顶部有统计行 (长期/目标/已作废)",
		/长期\s*3/.test(collapsed.stats) && /目标\s*1/.test(collapsed.stats) && /已作废\s*1/.test(collapsed.stats),
		collapsed.stats)
	check("C: 记忆库页底部有操作按钮 (导出/清理/撤销)",
		collapsed.bottomBtns.includes("导出") && collapsed.bottomBtns.some(b => /清理低频/.test(b)) && collapsed.bottomBtns.some(b => /撤销/.test(b)),
		JSON.stringify(collapsed.bottomBtns))

	const opened = await evalJs(`(() => {
		const d = document.querySelector(".sheet .mem-invalid")
		if (!d) return {err: "没有 .mem-invalid"}
		d.open = true
		const item = d.querySelector(".mem-item")
		return {
			content: item ? (item.querySelector(".mem-text") || {}).innerText || "" : "",
			sub: item ? (item.querySelector(".mem-sub") || {}).innerText || "" : "",
			hasRestore: !!(item && [...item.querySelectorAll("button")].find(b => /还原/.test(b.textContent))),
		}
	})()`)
	console.log(`   展开态: ${JSON.stringify(opened)}`)
	check("B1: 展开后能看到被作废的旧说法", opened.content.includes("我叫小明"), JSON.stringify(opened))
	check("B1: 显示作废时间", /作废于/.test(opened.sub), opened.sub)
	check("B1: 有「还原」按钮", opened.hasRestore === true, JSON.stringify(opened))

	/* 还原 */
	await evalJs(`(() => { const d = document.querySelector(".sheet .mem-invalid"); if (d) d.open = true; const b = d && [...d.querySelectorAll("button")].find(x => /还原/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(900)
	const after = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const t = sheet.innerText || ""
		const d = sheet.querySelector(".mem-invalid")
		const items = [...sheet.querySelectorAll(".mem-item")].map(e => (e.querySelector(".mem-text") || {}).innerText || "")
		const disk = JSON.parse(window.NoriChat.readFile("memory.json") || "{}").memories || []
		const v3 = disk.find(m => m.id === "v3") || {}
		return {stillHasSection: !!d, tHasName: t.includes("我叫小明"), items, diskInvalidAt: v3.invalidAt ?? null}
	})()`)
	console.log(`   还原后: ${JSON.stringify(after)}`)
	check("B1: 还原后回到长期记忆列表", after.items.some(c => c.includes("我叫小明")), JSON.stringify(after.items))
	check("B1: 还原后作废区消失 (没有作废条了)", after.stillHasSection === false, JSON.stringify(after))
	check("B1: 还原**真的落盘**了 (memory.json 里 invalidAt 已清除)", after.diskInvalidAt === null,
		`invalidAt=${after.diskInvalidAt}`)
	/* C: 空态提示 (没有作废条目时也要让功能可见) + 底部导出按钮真的能用 */
	const emptyState = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const hint = sheet.querySelector(".mem-invalid-empty")
		const stats = (sheet.querySelector(".mem-stats") || {}).innerText || ""
		return {hasHint: !!hint, hint: hint ? hint.innerText : "", stats}
	})()`)
	console.log(`   空态: ${JSON.stringify(emptyState)}`)
	check("C: 无作废条目时显示灰色提示行 (功能可见)",
		emptyState.hasHint === true && /已作废（0）/.test(emptyState.hint), JSON.stringify(emptyState))
	check("C: 统计行同步归零 (已作废 0)", /已作废\s*0/.test(emptyState.stats), emptyState.stats)
	await evalJs(`window.__exported = null; [...document.querySelectorAll(".sheet .mem-btns-bottom button")].find(b => b.textContent.trim() === "导出")?.click()`)
	await sleep(700)
	const md2 = await evalJs(`window.__exported || ""`)
	check("C: 记忆库页底部的「导出」按钮真的能导出 (不用退回一级页)",
		/## 长期记忆（\d+ 条）/.test(md2) && md2.includes("我叫小明"), md2.slice(0, 200))
	/* B/去重: 目标条不应在长期记忆里再列一遍 (它上面已有「陪着你的事」小节) */
	const dupCheck = await evalJs(`(() => {
		const groups = [...document.querySelectorAll(".sheet .mem-group")]
		const goalInGroups = groups.some(g => [...g.querySelectorAll(".mem-text")].some(e => /考雅思/.test(e.innerText)))
		return {goalInGroups}
	})()`)
	check("B: 目标条不在长期记忆里重复出现 (只在自己那一节)", dupCheck.goalInGroups === false, JSON.stringify(dupCheck))
	await evalJs(`(() => { const i = document.querySelector(".sheet .mem-search-input"); if (!i) return false; i.value = "雅思"; i.dispatchEvent(new Event("input", {bubbles: true})); return true })()`)
	await sleep(500)
	const searchGoal = await evalJs(`(() => { const s = document.querySelector(".sheet"); return {txt: (s||{}).innerText || ""} })()`)
	check("B: 搜索时仍能找到目标内容 (搜「雅思」出结果)", searchGoal.txt.includes("考雅思"), searchGoal.txt.slice(0, 200))

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
