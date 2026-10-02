/* 探查: 跑起来的网页版 NoriOS/FUTURUM 有哪些界面 (只读)
 * 前置: node tmp-memcheck/_serve-nori-os.mjs 8199
 * 运行: node tmp-memcheck/_probe-webver-ui.mjs [等待秒数=90]
 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9445
const WAIT = Number(process.argv[2]) || 90
const profile = mkdtempSync(join(tmpdir(), "nori-webver2-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sessionId) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sessionId ? {sessionId} : {})}))
	return new Promise((res, rej) => {
		pending.set(m, {res, rej})
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 30000)
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
	await send("Page.enable", {}, sessionId)
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}
	const text = () => evalJs(`(document.body.innerText || "").replace(/\\n{2,}/g, "\\n").trim()`)
	/** 截图前重新挂载一次: 这个 app 会自己刷新/换文档, 旧会话上的 Page 域会失效 (-32601) */
	const shot = async (name) => {
		try {
			const {targetInfos} = await send("Target.getTargets")
			const page = targetInfos.find(t => t.type === "page" && /8199/.test(t.url)) ?? targetInfos.find(t => t.type === "page")
			const {sessionId: sid} = await send("Target.attachToTarget", {targetId: page.targetId, flatten: true})
			await send("Page.enable", {}, sid)
			const s = await send("Page.captureScreenshot", {format: "png"}, sid)
			writeFileSync(resolve(import.meta.dirname, `_shot-webver-${name}.png`), Buffer.from(s.data, "base64"))
			console.log(`  [图] _shot-webver-${name}.png`)
		} catch (e) {
			console.log(`  [图失败] ${name}: ${String(e.message).slice(0, 120)}`)
		}
	}
	const clickText = async (re) => evalJs(`(() => {
		const els = [...document.querySelectorAll("button, a, [role=button], [role=tab], [role=menuitem], li, div")]
			.filter(x => x.children.length === 0 || x.tagName === "BUTTON");
		const el = els.find(x => ${re}.test((x.innerText || "").trim()));
		if (!el) return false;
		el.click(); return (el.innerText || "").trim().slice(0, 40);
	})()`)

	await send("Page.navigate", {url: "http://127.0.0.1:8199/"}, sessionId)
	await sleep(5000)
	/* ① 硬件加速警告 → 仍要进入 */
	console.log("① 点「仍要进入」:", await clickText("/仍要进入/"))
	await sleep(2500)
	/* ② 等资源同步结束 (进度文字消失或不再变化) */
	let last = ""
	for (let i = 0; i < Math.ceil(WAIT / 3); i += 1) {
		const t = await text()
		const m = t.match(/正在同步资源[\s\S]{0,30}/)
		if (i % 5 === 0) console.log(`   等待中(${i * 3}s): ${JSON.stringify((m ? m[0] : t).slice(0, 120))}`)
		if (!m && t === last) break
		last = t
		await sleep(3000)
	}
	console.log("\n② 加载完成后的可见文字:")
	const t1 = await text()
	console.log(t1.slice(0, 2500))
	await shot("loaded")
	/* ③ 列出可点元素 */
	const clickables = await evalJs(`(() => [...document.querySelectorAll("button, a, [role=button], [role=tab], [role=menuitem]")]
		.map(x => (x.innerText || x.getAttribute("aria-label") || x.title || "").trim()).filter(Boolean).slice(0, 60))()`)
	console.log("③ 可点元素:", JSON.stringify(clickables))
	/* ④ 逐个点几个主要入口, 每次记文字 + 截图 */
	for (const label of clickables.slice(0, 8)) {
		const ok = await clickText(new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"))
		if (!ok) continue
		await sleep(2500)
		const t = await text()
		console.log(`④ 点「${label}」后: ${JSON.stringify(t.slice(0, 300))}`)
		await shot("click-" + label.replace(/[^\w\u4e00-\u9fa5]/g, "").slice(0, 12))
	}
} catch (e) {
	console.log("探查失败:", e.message)
	process.exitCode = 1
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}
