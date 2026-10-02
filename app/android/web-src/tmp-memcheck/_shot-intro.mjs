/* 截图: 新手引导的 4 步 (自查/对照用, 非门禁)
 * 运行: node tmp-memcheck/_shot-intro.mjs   (需 harness 在 8123)
 * 产物: tmp-memcheck/_shot-intro-1..4.png
 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9452
const profile = mkdtempSync(join(tmpdir(), "nori-intro-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,1000", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sid) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sid ? {sessionId: sid} : {})}))
	return new Promise((res, rej) => { pending.set(m, {res, rej}); setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 25000) })
}
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* wait */ }
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
	const S = Buffer.from(JSON.stringify({apiKey: "sk-intro", baseUrl: "https://api.intro.test", model: "m"})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4500)
	/* 引导应当自动弹出; 若没弹, 从设置页按钮打开 */
	let on = await evalJs(`!!document.querySelector(".intro-mask")`)
	if (!on) {
		await evalJs(`localStorage.removeItem("intro_seen_v1")`)
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(900)
		await evalJs(`document.querySelector(".sheet .intro-open")?.click()`)
		await sleep(700)
		on = await evalJs(`!!document.querySelector(".intro-mask")`)
	}
	console.log("引导已打开:", on)
	for (let step = 1; step <= 4; step += 1) {
		await sleep(400)
		const shot = await send("Page.captureScreenshot", {format: "png"}, sessionId)
		writeFileSync(resolve(import.meta.dirname, `_shot-intro-${step}.png`), Buffer.from(shot.data, "base64"))
		const title = await evalJs(`(document.querySelector(".intro-title")?.textContent || "").trim()`)
		console.log(`  第 ${step} 步: ${title}`)
		await evalJs(`document.querySelector(".intro-next")?.click()`)
	}
} catch (e) {
	console.log("失败:", e.message)
	process.exitCode = 1
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
}
