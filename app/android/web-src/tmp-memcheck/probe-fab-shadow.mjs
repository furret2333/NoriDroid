import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9409
const profile = mkdtempSync(join(tmpdir(), "nori-dbg-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0; const pending = new Map(); let ws
const send = (m, p = {}, s) => { const n = ++id; ws.send(JSON.stringify({id: n, method: m, params: p, ...(s ? {sessionId: s} : {})})); return new Promise((res, rej) => { pending.set(n, {res, rej}); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error("t")) } }, 20000) }) }
let url = ""
for (let i = 0; i < 40 && !url; i += 1) { try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) url = j.webSocketDebuggerUrl } catch {} await sleep(250) }
ws = new WebSocket(url)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } }
const {targetId} = await send("Target.createTarget", {url: "about:blank"})
const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
await send("Runtime.enable", {}, sessionId); await send("Page.enable", {}, sessionId)
const ev = async (e) => { const r = await send("Runtime.evaluate", {expression: e, returnByValue: true, awaitPromise: true}, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
await sleep(4500)
await ev(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
await sleep(1200)
const out = await ev(`(() => {
	const cs = getComputedStyle(document.querySelector(".stage-root"))
	const g = (s,p) => { const el = document.querySelector(s); return el ? getComputedStyle(el)[p] : null }
	return {fab: g(".fab","boxShadow"), mini: g(".sheet .mini","boxShadow"), miniR: g(".sheet .mini","borderRadius"),
		vars: {hi: cs.getPropertyValue("--ui-hi").trim(), lo: cs.getPropertyValue("--ui-lo").trim(), lift: cs.getPropertyValue("--ui-lift").trim(), ctl: cs.getPropertyValue("--ui-radius-ctl").trim()}}
})()`)
console.log(JSON.stringify(out, null, 1))
ws.close(); edge.kill(); await sleep(300); try { rmSync(profile, {recursive:true, force:true}) } catch {}
