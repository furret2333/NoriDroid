/* 读取网页版 Dock 图标的**真实顺序**与图标文件 (只读)
 * 前置: node tmp-memcheck/_serve-nori-os.mjs 8199
 * 运行: node tmp-memcheck/_probe-webver-dock.mjs
 * 输出: 从左到右第 N 个图标的名字与 src
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9446
const profile = mkdtempSync(join(tmpdir(), "nori-dock-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sid) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sid ? {sessionId: sid} : {})}))
	return new Promise((res, rej) => {
		pending.set(m, {res, rej})
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 30000)
	})
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
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}
	await send("Page.navigate", {url: "http://127.0.0.1:8199/"}, sessionId)
	await sleep(5000)
	await evalJs(`(() => { const b = [...document.querySelectorAll("button")].find(x => /仍要进入/.test(x.textContent)); b && b.click(); return !!b })()`)
	/* 等桌面出现 (最多 4 分钟) */
	let ok = false
	for (let i = 0; i < 80; i += 1) {
		await sleep(3000)
		const ready = await evalJs(`document.querySelectorAll('img[src*="app-icons"]').length`)
		if (ready > 0) { ok = true; console.log(`桌面就绪 (${i * 3}s), 发现 ${ready} 个 app 图标`); break }
		if (i % 5 === 0) process.stdout.write(`  ${i * 3}s… `)
	}
	if (!ok) console.log("超时: 没等到桌面")
	const icons = await evalJs(`(() => [...document.querySelectorAll('img[src*="app-icons"], img[src*="/icons/"]')].map(img => {
		const r = img.getBoundingClientRect();
		const holder = img.closest("[title], [aria-label], button, a");
		return {src: img.getAttribute("src"), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
			title: (holder && (holder.getAttribute("title") || holder.getAttribute("aria-label"))) || img.getAttribute("alt") || ""};
	}).filter(o => o.w > 0).sort((a, b) => (a.y - b.y) || (a.x - b.x)))()`)
	console.log("\n从左到右 (同一行内按 x 排序):")
	icons.forEach((o, i) => console.log(`  ${String(i + 1).padStart(2)}. ${o.src}  · ${o.title}  @(${o.x},${o.y}) ${o.w}px`))
	const dockRect = await evalJs(`(() => { const im = document.querySelector('img[src*="app-icons"]'); if (!im) return null;
		const row = im.parentElement.parentElement; const r = row.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height)} })()`)
	console.log("dock 行区域:", JSON.stringify(dockRect))
} catch (e) {
	console.log("失败:", e.message)
	process.exitCode = 1
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}
