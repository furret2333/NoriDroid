/* 诊断: 打开页面并把控制台报错/异常原样打出来 (页面启动就炸时用)。
 * 运行: node tmp-memcheck/diag-page-errors.mjs */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9405
const profile = mkdtempSync(join(tmpdir(), "nori-diag-"))
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
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 20000)
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
	const logs = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return }
		if (m.method === "Runtime.exceptionThrown") {
			const d = m.params?.exceptionDetails
			logs.push(`[异常] ${d?.exception?.description || d?.text}  @${d?.url ?? ""}:${d?.lineNumber ?? ""}`)
		}
		if (m.method === "Runtime.consoleAPICalled") {
			const t = m.params?.type
			if (t === "error" || t === "warning") {
				const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ")
				logs.push(`[console.${t}] ${txt}`)
			}
		}
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(7000)
	const probe = await send("Runtime.evaluate", {
		expression: `JSON.stringify({fabs: document.querySelectorAll(".fab").length, hit: typeof window.__noriHitTest, root: !!document.querySelector("#app, .stage, .dock")})`,
		returnByValue: true,
	}, sessionId)
	console.log(`页面状态: ${probe?.result?.value}`)
	console.log(`\n--- 报错/异常 (${logs.length} 条) ---`)
	for (const l of logs.slice(0, 25)) console.log(l)
} catch (e) {
	console.log(`诊断本身失败: ${e?.message ?? e}`)
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
