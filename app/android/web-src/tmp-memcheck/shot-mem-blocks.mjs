/* 截图: 记忆库「块视图」(自查排版用, 不是门禁)
 * 运行: node tmp-memcheck/shot-mem-blocks.mjs   (需 harness 在 8123)
 * 产物: tmp-memcheck/_shot-mem-blocks.png
 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9418
const profile = mkdtempSync(join(tmpdir(), "nori-shot-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,1000", "about:blank"], {stdio: "ignore"})
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
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
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
	/* 关掉新手引导 (首启会盖住面板下半部分): 先写标记再点掉, 保证块视图露出来 */
	await evalJs(`localStorage.setItem("intro_seen_v1", "1"); localStorage.setItem("storage_asked", "1")`)
	for (let i = 0; i < 5; i += 1) {
		const has = await evalJs(`!!document.querySelector(".intro-mask")`)
		if (!has) break
		await evalJs(`document.querySelector(".intro-next")?.click()`)
		await sleep(400)
	}
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await sleep(300)

	const ts0 = Date.now() - 3600_000
	await evalJs(`(() => {
		const mk = (id, content, type, over = {}) => ({id, content, type, importance:0.8, confidence:0.9,
			createdAt:${ts0}, updatedAt:${ts0}, lastAccessedAt:0, accessCount:0, tags:[], decayDays:null, ...over});
		window.NoriChat.writeFile("memory.json", JSON.stringify({
			memories: [
				mk("b1m1", "我叫小明", "fact", {tags:["explicit"]}),
				mk("b1m2", "我不喜欢下雨天", "preference", {tags:["llm"]}),
				mk("b1m3", "我想养猫", "project", {invalidAt: ${ts0} + 5000}),
				mk("b2m1", "我最近在准备考研", "project", {tags:["llm"]}),
				mk("b2m2", "主人叫小桧", "fact", {tags:["llm","pinned"]}),
				mk("u1", "我养了一只猫叫年年", "event", {tags:["llm"]}),
				mk("g1", "考雅思 7 分", "project", {tags:["goal"], importance:0.85})
			],
			summaries: [{id:"sum-1", content:"聊了养猫和天气。", createdAt:${ts0}, msgCount:25, tokenCount:20}],
			summarizedMsgCount: 50, tombstones: [], meta: [], schemaVersion: 2,
			blocks: [
				{id:"blk-a", fromTs:${ts0}, toTs:${ts0} + 24000, msgCount:25, topic:"养猫与天气", summary:"聊了养猫和天气。", createdAt:${ts0}, itemIds:["b1m1","b1m2","b1m3"]},
				{id:"blk-b", fromTs:${ts0} + 600000, toTs:${ts0} + 624000, msgCount:25, topic:"考研", summary:"聊了考研。", createdAt:${ts0} + 600000, itemIds:["b2m1","b2m2"]}
			]
		}));
		return true
	})()`)
	await sleep(300)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	for (let i = 0; i < 3; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(350) }
	await sleep(900)
	/* 滚到「块视图」那一段 (上面是目标/历史总结/搜索框) */
	await evalJs(`(() => {
		const el = document.querySelector(".sheet .mem-block")
		if (el) el.scrollIntoView({block: "start"})
		const sc = document.querySelector(".sheet .sheet-body") || document.querySelector(".sheet")
		if (sc) sc.scrollTop = Math.max(0, (el ? el.offsetTop : 0) - 90)
		return true
	})()`)
	await sleep(500)
	/* 只截设置面板那块 (整页会被 Live2D 占满) */
	const box = await evalJs(`(() => { const s = document.querySelector(".sheet"); if (!s) return null; const r = s.getBoundingClientRect(); return {x: Math.max(0, r.x), y: Math.max(0, r.y), w: r.width, h: r.height} })()`)
	const shot = await send("Page.captureScreenshot", {
		format: "png",
		...(box ? {clip: {x: box.x, y: box.y, width: box.w, height: Math.min(box.h, 1000), scale: 2}} : {}),
	}, sessionId)
	const out = resolve(import.meta.dirname, "_shot-mem-blocks.png")
	writeFileSync(out, Buffer.from(shot.data, "base64"))
	console.log("已保存:", out, box ? `(面板 ${Math.round(box.w)}x${Math.round(box.h)})` : "(整页)")
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}
