/* 截图: 面板标题栏在「像素风 / 柔和风」两种主题下的样子 (自查用, 非门禁)
 * 运行: node tmp-memcheck/_shot-sheet-head.mjs   (需 harness 在 8123)
 * 产物: tmp-memcheck/_shot-sheet-head-pixel.png · _shot-sheet-head-soft.png
 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9451
const profile = mkdtempSync(join(tmpdir(), "nori-head-"))
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
	const S = Buffer.from(JSON.stringify({apiKey: "sk-head", baseUrl: "https://api.head.test", model: "m"})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4300)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await sleep(400)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(1200)
	console.log("DOM 诊断:", await evalJs(`(() => {
		const cls = (s) => { const e = document.querySelector(s); return e ? "有" : "无" };
		return {sheet: cls(".sheet"), head: cls(".sheet-head"), panel: cls(".sheet-body") || cls(".sheet .sheet-body"),
			heads: [...document.querySelectorAll("div")].filter(d => /head/i.test(d.className || "")).map(d => d.className).slice(0, 5)};
	})()`))
	/* 只截标题栏那一条 (含面板左右边缘, 便于看圆角/描边) */
	const shoot = async (name) => {
		const box = await evalJs(`(() => { const h = document.querySelector(".sheet-head"); const s = document.querySelector(".sheet");
			if (!h || !s) return null; const rh = h.getBoundingClientRect(), rs = s.getBoundingClientRect();
			return {x: Math.max(0, rs.x), y: Math.max(0, rh.y - 10), w: Math.min(rs.width, 520), h: Math.ceil(rh.height) + 20} })()`)
		/* ⚠ CDP 的 clip 要 {x,y,width,height,scale} —— 不能把 {w,h} 直接展开进去 */
		const shot = await send("Page.captureScreenshot", {
			format: "png",
			...(box ? {clip: {x: box.x, y: box.y, width: box.w, height: box.h, scale: 3}} : {}),
		}, sessionId)
		if (!box) { console.log(`[${name}] 找不到标题栏, 跳过截图`); return }
		writeFileSync(resolve(import.meta.dirname, `_shot-sheet-head-${name}.png`), Buffer.from(shot.data, "base64"))
		console.log(`已存 _shot-sheet-head-${name}.png (${JSON.stringify(box)})`)
	}
	await shoot("pixel")
	/* 切到柔和风 (按钮在设置页底部) */
	await evalJs(`(() => { const b = document.querySelector(".sheet .sheet-body") || document.querySelector(".sheet"); if (b) b.scrollTop = 99999; return true })()`)
	await sleep(500)
	const clicked = await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet button")].find(x => /外观风格/.test(x.textContent)); if (b) { b.click(); return b.textContent.trim() } return null })()`)
	console.log("点了:", clicked)
	await sleep(600)
	await evalJs(`(() => { const b = document.querySelector(".sheet .sheet-body") || document.querySelector(".sheet"); if (b) b.scrollTop = 0; return true })()`)
	await sleep(500)
	await shoot("soft")
} catch (e) {
	console.log("失败:", e.message)
	process.exitCode = 1
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
}
