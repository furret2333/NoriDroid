/* E2E: 真实浏览器里验证模型面板 —— 列表是否渲染、封面是否真的加载出来。
   验的是"UI 实际表现", 源码正确不等于跑起来正确。
   运行: node tmp-memcheck/e2e-models.mjs  (需 harness 在 8123) */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9366
const profile = mkdtempSync(join(tmpdir(), "nori-models-"))
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
	const reqs = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return }
		if (m.method === "Network.responseReceived") reqs.push({url: m.params.response.url, status: m.params.response.status})
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

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4000)

	/* 打开模型面板 */
	await evalJs(`(() => {
		const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "选择模型");
		if (b) { b.click(); return true }
		const b2 = [...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent));
		if (b2) { b2.click(); return true }
		return false
	})()`)
	await sleep(1200)

	const names = await evalJs(`[...document.querySelectorAll(".mc .mname")].map(e => e.textContent.trim())`)
	check("模型面板渲染出模型卡片", Array.isArray(names) && names.length > 0, JSON.stringify(names))
	check("列表含 ARGNori 与 Nori (静态清单生效, 无需联网)",
		Array.isArray(names) && names.includes("ARGNori") && names.includes("Nori"), JSON.stringify(names))

	const coverSrcs = await evalJs(`[...document.querySelectorAll(".mc .thumb img")].map(i => i.src)`)
	check("封面 img 指向新主机", Array.isArray(coverSrcs) && coverSrcs.length > 0 && coverSrcs.every(s => s.includes("fc39e5fc.pinme.dev")), JSON.stringify(coverSrcs))

	/* 封面是否真的加载成功 (naturalWidth > 0 表示解码成功; hideThumb 会移除失败元素) */
	await sleep(2500)
	const coverOk = await evalJs(`[...document.querySelectorAll(".mc .thumb img")].map(i => ({src: i.src, w: i.naturalWidth}))`)
	const anyLoaded = Array.isArray(coverOk) && coverOk.some(c => c.w > 0)
	check("至少一张封面图实际解码成功", anyLoaded, JSON.stringify(coverOk))
	const coverHttp = reqs.filter(r => r.url.includes("cover.webp"))
	check("封面请求返回 200", coverHttp.length > 0 && coverHttp.every(r => r.status === 200), JSON.stringify(coverHttp))

	/* 不应再请求旧网关 */
	const oldReq = reqs.filter(r => /elake/.test(r.url))
	check("运行期未再请求旧网关 (api.elake.top)", oldReq.length === 0, JSON.stringify(oldReq.map(r => r.url)))
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
