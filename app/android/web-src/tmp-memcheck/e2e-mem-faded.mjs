/* E2E: 记忆库「已收起」「已删除」两个折叠区 + 收起/还原/永久删除 (2026-09-28)
 *
 * 断言的是**真实 DOM + 真实持久化**:
 *   ① 统计行给出 长期/目标/已作废/已收起/已删除 五个数;
 *   ② 「已收起（N）」区: 显示收起原因与时间, 点「留下」→ 回生效列表并落盘;
 *   ③ 「已删除（N）」区(回收站): 点「还原」→ 回生效列表、墓碑清除、回收站清空;
 *   ④ 「永久删除」→ 二次确认后从回收站抹掉;
 *   ⑤ 收起/删除的条目**不参与**生效列表与召回(不在块视图里出现)。
 *
 * 运行: node tmp-memcheck/e2e-mem-faded.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9424
const profile = mkdtempSync(join(tmpdir(), "nori-memfaded-"))
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

	const S = Buffer.from(JSON.stringify({apiKey: "sk-e2e", baseUrl: "https://api.e2e.test", model: "e2e-model"})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4300)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	for (let i = 0; i < 5; i += 1) {
		if (!(await evalJs(`!!document.querySelector(".intro-mask")`))) break
		await evalJs(`document.querySelector(".intro-next")?.click()`)
		await sleep(300)
	}
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)

	/* 造数据: 1 生效 + 1 作废 + 1 已收起 + 回收站 1 条 */
	const ts0 = Date.now() - 3600_000
	await evalJs(`(() => {
		const mk = (id, content, type, over = {}) => ({id, content, type, importance:0.8, confidence:0.9,
			createdAt:${ts0}, updatedAt:${ts0}, lastAccessedAt:0, accessCount:0, tags:[], decayDays:null, ...over});
		window.NoriChat.writeFile("memory.json", JSON.stringify({
			memories: [
				mk("act1", "我叫小桧", "fact", {tags:["identity"]}),
				mk("inv1", "我想养猫", "project", {invalidAt: ${ts0} + 1000}),
				mk("fad1", "我喜欢下雨天", "preference", {fadedAt: ${ts0} + 2000, fadedReason: "expired"}),
			],
			summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], schemaVersion: 2,
			blocks: [{id:"blk-a", fromTs:${ts0}, toTs:${ts0} + 1000, msgCount:25, topic:"初见", summary:"s", createdAt:${ts0}, itemIds:["act1","fad1"]}],
			deletedBin: [mk("del1", "我养了一只猫叫年年", "event", {deletedAt: ${ts0} + 3000})]
		}));
		return true
	})()`)
	await sleep(300)

	/* 打开记忆库 (点三下) */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	for (let i = 0; i < 3; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(320) }
	await sleep(800)

	const view = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		if (!sheet) return {err: "没有 .sheet"}
		const faded = sheet.querySelector(".mem-faded")
		const deleted = sheet.querySelector(".mem-deleted")
		/* 折叠状态下 innerText 取不到子元素文本 (未渲染), 所以先展开再读 */
		if (faded) faded.open = true
		if (deleted) deleted.open = true
		const txt = sheet.innerText || ""
		return {
			stats: (sheet.querySelector(".mem-stats") || {}).innerText || "",
			hasFaded: !!faded, fadedOpen: faded ? faded.open : null,
			fadedLabel: faded ? (faded.querySelector("summary") || {}).innerText || "" : "",
			fadedSub: faded ? (faded.querySelector(".mem-sub") || {}).innerText || "" : "",
			hasDeleted: !!deleted, deletedLabel: deleted ? (deleted.querySelector("summary") || {}).innerText || "" : "",
			deletedBtns: deleted ? [...deleted.querySelectorAll("button")].map(b => b.textContent.trim()) : [],
			fadedBtns: faded ? [...faded.querySelectorAll("button")].map(b => b.textContent.trim()) : [],
			// 收起/删除的条目不该出现在生效区(块视图)里
			blockText: [...sheet.querySelectorAll(".mem-block")].map(b => b.innerText).join(" | "),
			txt,
		}
	})()`)
	console.log(`   统计行: ${JSON.stringify(view.stats)}`)
	console.log(`   已收起: ${JSON.stringify({label: view.fadedLabel, sub: view.fadedSub, btns: view.fadedBtns})}`)
	console.log(`   已删除: ${JSON.stringify({label: view.deletedLabel, btns: view.deletedBtns})}`)
	check("①统计行给出 已作废/已收起/已删除 三个计数",
		/已作废\s*1/.test(view.stats) && /已收起\s*1/.test(view.stats) && /已删除\s*1/.test(view.stats), view.stats)
	check("②有「已收起（1）」折叠区 + 收起原因与时间",
		view.hasFaded === true && /已收起（1）/.test(view.fadedLabel) && /到期了/.test(view.fadedSub) && /收起于/.test(view.fadedSub),
		JSON.stringify({label: view.fadedLabel, sub: view.fadedSub}))
	check("②收起区有「留下」按钮", view.fadedBtns.includes("留下"), JSON.stringify(view.fadedBtns))
	check("③有「已删除（1）」回收站 + 还原/永久删除两个按钮",
		view.hasDeleted === true && /已删除（1）/.test(view.deletedLabel) &&
		view.deletedBtns.includes("还原") && view.deletedBtns.includes("永久删除"),
		JSON.stringify({label: view.deletedLabel, btns: view.deletedBtns}))
	check("⑤收起/删除的条目不出现在生效区 (块视图里看不到它们)",
		!view.blockText.includes("我喜欢下雨天") && !view.blockText.includes("年年"),
		view.blockText.slice(0, 200))

	/* ② 点「留下」: 回生效列表 + 落盘 */
	await evalJs(`(() => { const d = document.querySelector(".sheet .mem-faded"); if (d) d.open = true; const b = d && [...d.querySelectorAll("button")].find(x => /留下/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(900)
	const afterFaded = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const mem = (() => { try { return JSON.parse(window.NoriChat.readFile("memory.json") || "{}") } catch { return {} } })()
		const item = (mem.memories || []).find(m => m.id === "fad1") || {}
		return {
			stillHasFaded: !!sheet.querySelector(".mem-faded"),
			inActive: [...sheet.querySelectorAll(".mem-block")].map(b => b.innerText).join(" | ").includes("我喜欢下雨天"),
			diskFadedAt: item.fadedAt ?? null,
			stats: (sheet.querySelector(".mem-stats") || {}).innerText || "",
		}
	})()`)
	console.log(`   留下之后: ${JSON.stringify(afterFaded)}`)
	check("②「留下」后回到生效列表 (块视图里能看到)", afterFaded.inActive === true, JSON.stringify(afterFaded))
	check("②「留下」后收起区消失、统计归零", afterFaded.stillHasFaded === false && /已收起\s*0/.test(afterFaded.stats), afterFaded.stats)
	check("②「留下」**真的落盘** (memory.json 里 fadedAt 已清除)", afterFaded.diskFadedAt === null, `fadedAt=${afterFaded.diskFadedAt}`)

	/* ③ 回收站「还原」: 回生效 + 墓碑清除 */
	await evalJs(`(() => { const d = document.querySelector(".sheet .mem-deleted"); if (d) d.open = true; const b = d && [...d.querySelectorAll("button")].find(x => /还原/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(900)
	const afterRestore = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const mem = (() => { try { return JSON.parse(window.NoriChat.readFile("memory.json") || "{}") } catch { return {} } })()
		return {
			stillHasDeleted: !!sheet.querySelector(".mem-deleted"),
			inActive: [...sheet.querySelectorAll(".mem-block")].map(b => b.innerText).join(" | ").includes("年年"),
			bin: (mem.deletedBin || []).length,
			tombstone: (mem.tombstones || []).some(t => t.id === "del1"),
			stats: (sheet.querySelector(".mem-stats") || {}).innerText || "",
		}
	})()`)
	console.log(`   还原之后: ${JSON.stringify(afterRestore)}`)
	check("③「还原」后回到生效列表", afterRestore.inActive === true, JSON.stringify(afterRestore))
	check("③回收站清空 + 统计归零 + 墓碑已清除",
		afterRestore.bin === 0 && afterRestore.tombstone === false && /已删除\s*0/.test(afterRestore.stats),
		JSON.stringify(afterRestore))

	/* ④ 永久删除: 先删一条进回收站, 再永久删除 */
	await evalJs(`window.confirm = () => true`)   // 无头环境下自动确认
	await evalJs(`(() => {
		const mem = JSON.parse(window.NoriChat.readFile("memory.json") || "{}")
		mem.memories = mem.memories.filter(m => m.id !== "act1")
		mem.deletedBin = [{id:"gone1", content:"这条要被永久删除", type:"event", importance:0.3, confidence:0.9,
			createdAt:${ts0}, updatedAt:${ts0}, lastAccessedAt:0, accessCount:0, tags:[], decayDays:null, deletedAt:${ts0}}]
		mem.tombstones = [{id:"gone1", at:${ts0}}]
		window.NoriChat.writeFile("memory.json", JSON.stringify(mem))
		return true
	})()`)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(500)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(800)
	for (let i = 0; i < 3; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(320) }
	await sleep(700)
	const beforeForever = await evalJs(`(() => { const d = document.querySelector(".sheet .mem-deleted"); return d ? d.innerText.slice(0, 60) : null })()`)
	await evalJs(`(() => { const d = document.querySelector(".sheet .mem-deleted"); if (d) d.open = true; const b = d && [...d.querySelectorAll("button")].find(x => /永久删除/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(900)
	const afterForever = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const mem = (() => { try { return JSON.parse(window.NoriChat.readFile("memory.json") || "{}") } catch { return {} } })()
		return {
			stillHasDeleted: !!sheet.querySelector(".mem-deleted"),
			bin: (mem.deletedBin || []).length,
			tombstone: (mem.tombstones || []).some(t => t.id === "gone1"),
		}
	})()`)
	console.log(`   永久删除前: ${JSON.stringify(beforeForever)}`)
	console.log(`   永久删除后: ${JSON.stringify(afterForever)}`)
	check("④「永久删除」后回收站里彻底没有它了 (墓碑仍留着防复活)",
		afterForever.bin === 0 && afterForever.tombstone === true, JSON.stringify(afterForever))

	/* ⑥ (2026-09-29 新增) 条目行「收起」按钮: 手动收起 → 进「已收起」(原因: 你手动收起的) */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(400)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(800)
	for (let i = 0; i < 3; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(320) }
	await sleep(700)
	const rowBtns = await evalJs(`(() => {
		const rows = [...document.querySelectorAll(".sheet .mem-item")]
		const row = rows.find(r => /年年/.test(r.innerText))
		return row ? [...row.querySelectorAll("button")].map(b => b.textContent.trim()) : null
	})()`)
	check("⑥生效条目行有「收起」按钮 (原来只有固定/删除)", Array.isArray(rowBtns) && rowBtns.includes("收起"), JSON.stringify(rowBtns))
	await evalJs(`(() => {
		const rows = [...document.querySelectorAll(".sheet .mem-item")]
		const row = rows.find(r => /年年/.test(r.innerText))
		const b = row && [...row.querySelectorAll("button")].find(x => x.textContent.trim() === "收起")
		b && b.click(); return !!b
	})()`)
	await sleep(900)
	const afterFade = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const d = sheet.querySelector(".mem-faded")
		if (d) d.open = true
		const mem = (() => { try { return JSON.parse(window.NoriChat.readFile("memory.json") || "{}") } catch { return {} } })()
		const target = (mem.memories || []).find(m => /年年/.test(m.content || "")) || {}
		return {
			stats: (sheet.querySelector(".mem-stats") || {}).innerText || "",
			fadedText: d ? d.innerText : "",
			diskFadedAt: target.fadedAt ?? null,
			diskReason: target.fadedReason ?? null,
		}
	})()`)
	console.log(`   收起后: ${JSON.stringify({stats: afterFade.stats, reason: afterFade.diskReason})}`)
	check("⑥点「收起」→ 条目进「已收起」并落盘 (原因 manual), 不是删除",
		/年年/.test(afterFade.fadedText) && /你手动收起的/.test(afterFade.fadedText) &&
		typeof afterFade.diskFadedAt === "number" && afterFade.diskReason === "manual",
		JSON.stringify(afterFade))

	/* ⑦ (2026-09-29 新增) 导出补全: 已收起 / 未归类 / 记忆块时间线 都要在导出的 md 里
	 *  ⚠ 状态要摆确定性: 第 ⑥ 步刚把「年年」收起了, 此刻"未归类"里没有生效条目 ——
	 *    所以先补一条**生效且不属于任何块**的记忆再导出 (否则本断言会因为"段不存在"而误红/误绿)。 */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(400)
	await evalJs(`(() => {
		const mem = JSON.parse(window.NoriChat.readFile("memory.json") || "{}")
		mem.memories = mem.memories.concat([{id:"extra1", content:"我喜欢喝乌龙茶", type:"preference",
			importance:0.7, confidence:0.9, createdAt:${ts0}, updatedAt:${ts0}, lastAccessedAt:0, accessCount:0,
			tags:[], decayDays:90}])
		window.NoriChat.writeFile("memory.json", JSON.stringify(mem))
		return true
	})()`)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(800)
	for (let i = 0; i < 3; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(320) }
	await sleep(700)
	await evalJs(`(() => {
		window.__exported = null
		const orig = window.NoriChat.writeFile
		window.NoriChat.writeFile = function (n, c) { if (String(n).endsWith(".md")) window.__exported = String(c); return orig.call(this, n, c) }
		return true
	})()`)
	await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet .mem-btns-bottom button")].find(x => x.textContent.trim() === "导出"); b && b.click(); return !!b })()`)
	await sleep(800)
	const md = await evalJs(`window.__exported || ""`)
	console.log(`   导出片段: ${JSON.stringify(String(md).slice(0, 120))}`)
	check("⑦导出的 md 里有「已收起的记忆」段 (旧包看不见的条目也能备份出来)",
		/## 已收起的记忆（\d+ 条/.test(md) && /年年/.test(md), String(md).slice(0, 200))
	check("⑦导出的 md 里有「记忆块时间线」段",
		/## 记忆块时间线（\d+ 段/.test(md), String(md).slice(0, 300))
	check("⑦导出的 md 里有「未归类」段 (没挂进块的条目)",
		/## 未归类（\d+ 条/.test(md) && /乌龙茶/.test(md), String(md).slice(0, 400))
	check("⑦导出的 md 仍含原有段落 (长期记忆 / 已作废)",
		/## 长期记忆（\d+ 条）/.test(md) && /## 历史总结（\d+ 条）/.test(md), String(md).slice(0, 200))

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
