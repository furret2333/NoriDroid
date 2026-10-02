/* 截图巡览: 把当前 App 的每个界面各截一张 (自查 UI 用, 不是门禁)
 * 运行: node tmp-memcheck/shot-ui-tour.mjs   (需 harness 在 8123)
 * 产物: tmp-memcheck/_shot-ui-<名字>.png
 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9443
const profile = mkdtempSync(join(tmpdir(), "nori-uitour-"))
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
const shots = []
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
	const capture = async (name, clipToSheet = true) => {
		let box = null
		if (clipToSheet) {
			box = await evalJs(`(() => { const s = document.querySelector(".sheet"); if (!s) return null; const r = s.getBoundingClientRect();
				return {x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(r.width, 520), h: Math.min(r.height, 1000)} })()`)
		}
		const shot = await send("Page.captureScreenshot", {
			format: "png",
			...(box ? {clip: {x: box.x, y: box.y, width: box.w, height: box.h, scale: 2}} : {}),
		}, sessionId)
		const out = resolve(import.meta.dirname, `_shot-ui-${name}.png`)
		writeFileSync(out, Buffer.from(shot.data, "base64"))
		shots.push(name)
		console.log(`  已存 _shot-ui-${name}.png${box ? ` (sheet ${Math.round(box.w)}x${Math.round(box.h)})` : " (整页)"}`)
	}
	const clickFab = async (label) => {
		const ok = await evalJs(`(() => { const b = [...document.querySelectorAll(".fab")].find(x => new RegExp(${JSON.stringify(label)}).test(x.textContent)); if (!b) return false; b.click(); return true })()`)
		await sleep(900)
		return ok
	}
	const closeSheet = async () => { await evalJs(`document.querySelector(".sheet-mask")?.click()`); await sleep(500) }

	const S = Buffer.from(JSON.stringify({
		apiKey: "sk-tour", baseUrl: "https://api.tour.test", model: "gpt-4o-mini",
		ttsEnabled: true, ttsProvider: "fish", ttsReferenceId: "ref-demo", bgmEnabled: true,
	})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4500)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	for (let i = 0; i < 5; i += 1) {
		if (!(await evalJs(`!!document.querySelector(".intro-mask")`))) break
		await evalJs(`document.querySelector(".intro-next")?.click()`)
		await sleep(350)
	}
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await sleep(400)

	/* 造一点数据, 免得每个面板都是空的 (看不出结构) */
	const ts0 = Date.now() - 7200_000
	await evalJs(`(() => {
		const mk = (id, content, type, over = {}) => ({id, content, type, importance:0.8, confidence:0.9,
			createdAt:${ts0}, updatedAt:${ts0}, lastAccessedAt:0, accessCount:0, tags:[], decayDays:null, ...over});
		window.NoriChat.writeFile("memory.json", JSON.stringify({
			memories: [
				mk("m1", "我叫小桧", "fact", {tags:["explicit"]}),
				mk("m2", "我不喜欢下雨天", "preference", {tags:["llm"]}),
				mk("m3", "我最近在准备考研", "project", {tags:["llm"], decayDays:60}),
				mk("m4", "我养了一只叫团子的猫", "relationship", {tags:["llm"], decayDays:180}),
				mk("m5", "我想养狗", "project", {tags:["llm"], invalidAt: ${ts0} + 5000}),
				mk("m6", "我有点困，准备去睡觉", "event", {tags:["llm"], fadedAt: ${ts0} + 9000, fadedReason:"lowvalue", decayDays:30}),
				mk("g1", "考雅思 7 分", "project", {tags:["goal"], importance:0.85})
			],
			summaries: [{id:"sum-1", content:"聊了养猫、天气与考研。", createdAt:${ts0}, msgCount:25, tokenCount:20}],
			summarizedMsgCount: 50, tombstones: [], meta: [], schemaVersion: 2,
			blocks: [
				{id:"blk-a", fromTs:${ts0}, toTs:${ts0} + 24000, msgCount:25, topic:"养猫与天气", summary:"聊了养猫和天气。", createdAt:${ts0}, itemIds:["m1","m2"]},
				{id:"blk-b", fromTs:${ts0} + 600000, toTs:${ts0} + 624000, msgCount:25, topic:"考研", summary:"聊了考研。", createdAt:${ts0} + 600000, itemIds:["m3","m4"]}
			],
			deletedBin: [mk("d1", "我养过一只叫年年的猫", "event", {deletedAt: ${ts0} + 9000})]
		}));
		return true
	})()`)
	await sleep(300)

	/* ① 主界面 (整页: 桌宠 + fab 按钮群) */
	await capture("main", false)
	/* ② 对话 */
	if (await clickFab("对话|聊天")) await capture("chat")
	await closeSheet()
	/* ③ 设置 (顶部 / 中部 / 底部) */
	if (await clickFab("设置")) {
		await capture("settings-top")
		await evalJs(`(() => { const b = document.querySelector(".sheet .sheet-body") || document.querySelector(".sheet"); if (b) b.scrollTop = 700; return true })()`)
		await sleep(400); await capture("settings-mid")
		await evalJs(`(() => { const b = document.querySelector(".sheet .sheet-body") || document.querySelector(".sheet"); if (b) b.scrollTop = 99999; return true })()`)
		await sleep(400); await capture("settings-bottom")
		/* ④ 记忆库 (点三下) */
		for (let i = 0; i < 3; i += 1) {
			const okEnter = await evalJs(`(() => { const b = document.querySelector(".sheet .mem-enter"); if (!b) return false;
				if (b.getBoundingClientRect().height === 0) return false; b.click(); return true })()`)
			if (!okEnter) { await evalJs(`(() => { const b = document.querySelector(".sheet .sheet-body") || document.querySelector(".sheet"); if (b) b.scrollTop = 0; return true })()`); await sleep(300); await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); }
			await sleep(400)
		}
		await sleep(800)
		await capture("memories-top")
		await evalJs(`(() => { const b = document.querySelector(".sheet .sheet-body") || document.querySelector(".sheet"); if (b) b.scrollTop = 900; return true })()`)
		await sleep(400); await capture("memories-mid")
		await evalJs(`(() => { const b = document.querySelector(".sheet .sheet-body") || document.querySelector(".sheet"); if (b) b.scrollTop = 99999; return true })()`)
		await sleep(400); await capture("memories-bottom")
	}
	await closeSheet()
	/* ⑤ 其它面板 */
	if (await clickFab("日记")) await capture("diary")
	await closeSheet()
	if (await clickFab("番茄")) await capture("pomo")
	await closeSheet()
	if (await clickFab("模型")) await capture("model")
	await closeSheet()
	if (await clickFab("触摸")) await capture("touch")
	await closeSheet()

	/* ⑥ 悬浮窗 */
	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/float.html"}, sessionId)
	await sleep(2500)
	await capture("float", false)
	console.log(`\n共 ${shots.length} 张: ${shots.join(", ")}`)
} catch (e) {
	console.log("截图失败:", e.message)
	process.exitCode = 1
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}
