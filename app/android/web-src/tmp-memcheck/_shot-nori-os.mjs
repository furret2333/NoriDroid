/* 截图: 把跑在 8199 的网页版 NoriOS 截几张 (对照用, 只读)
 * 运行: 先 node tmp-memcheck/_serve-nori-os.mjs 8199, 再 node tmp-memcheck/_shot-nori-os.mjs
 * 产物: tmp-memcheck/_shot-webver-*.png
 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9444
const profile = mkdtempSync(join(tmpdir(), "nori-webver-"))
const W = Number(process.argv[2]) || 1280
const H = Number(process.argv[3]) || 900
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", `--window-size=${W},${H}`, "about:blank"], {stdio: "ignore"})
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
	const errs = []
	const failed = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") errs.push(String(m.params?.exceptionDetails?.exception?.description || "?").slice(0, 200))
		if (m.method === "Network.loadingFailed") failed.push(`${m.params?.type} ${String(m.params?.errorText).slice(0, 60)}`)
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	await send("Network.enable", {}, sessionId)
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}
	const shot = async (name) => {
		const s = await send("Page.captureScreenshot", {format: "png"}, sessionId)
		const out = resolve(import.meta.dirname, `_shot-webver-${name}.png`)
		writeFileSync(out, Buffer.from(s.data, "base64"))
		const info = await evalJs(`(() => ({title: document.title, url: location.pathname,
			text: (document.body.innerText || "").replace(/\\n{2,}/g, "\\n").slice(0, 600),
			nodes: document.querySelectorAll("*").length}))()`)
		console.log(`  已存 _shot-webver-${name}.png · ${info.nodes} 节点 · ${info.url}`)
		console.log(`    可见文字: ${JSON.stringify(info.text.slice(0, 400))}`)
	}

	await send("Page.navigate", {url: "http://127.0.0.1:8199/"}, sessionId)
	await sleep(6000)
	await shot("entry")
	/* 试着点一下 (冷开场/落地页可能需要点击进入) */
	await evalJs(`(() => { const el = document.querySelector("button, [role=button], a"); if (el) el.click(); return !!el })()`)
	await sleep(3500)
	await shot("after-click")
	/* 把页面上的按钮/链接名字打印出来, 便于知道有哪些入口 */
	const nav = await evalJs(`(() => [...document.querySelectorAll("button, a, [role=button]")]
		.map(x => (x.innerText || x.getAttribute("aria-label") || "").trim()).filter(Boolean).slice(0, 40))()`)
	console.log("  可点元素:", JSON.stringify(nav))
	console.log(`  运行期异常 ${errs.length} 条${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`)
	console.log(`  资源加载失败 ${failed.length} 条${failed.length ? ": " + [...new Set(failed)].slice(0, 6).join(" | ") : ""}`)
} catch (e) {
	console.log("截图失败:", e.message)
	process.exitCode = 1
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}
