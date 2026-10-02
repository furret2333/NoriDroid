import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9404
const profile = mkdtempSync(join(tmpdir(), "nori-dbg-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const {writeFileSync} = await import("node:fs")
let id = 0; const pending = new Map(); let ws
const send = (m, p = {}, s) => { const n = ++id; ws.send(JSON.stringify({id: n, method: m, params: p, ...(s ? {sessionId: s} : {})})); return new Promise((res, rej) => { pending.set(n, {res, rej}); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error("timeout " + m)) } }, 20000) }) }
let wsUrl = ""
for (let i = 0; i < 40 && !wsUrl; i += 1) { try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) wsUrl = j.webSocketDebuggerUrl } catch {} await sleep(250) }
ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } }
const {targetId} = await send("Target.createTarget", {url: "about:blank"})
const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
await send("Runtime.enable", {}, sessionId)
await send("Page.enable", {}, sessionId)
const ev = async (expr) => { const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
await sleep(4500)
await ev(`window.NoriChat.writeFile("memory.json", JSON.stringify({memories:[{id:"t1",content:"考雅思 7 分",type:"project",importance:0.8,confidence:0.9,createdAt:Date.now(),updatedAt:Date.now(),lastAccessedAt:0,accessCount:0,tags:["goal"],decayDays:null},{id:"t2",content:"我喜欢下雨天",type:"preference",importance:0.7,confidence:0.9,createdAt:Date.now(),updatedAt:Date.now(),lastAccessedAt:0,accessCount:0,tags:[],decayDays:90}],summaries:[{id:"sum-1-2",content:"聊了天气和考试。",createdAt:Date.now(),msgCount:25,tokenCount:10}],summarizedMsgCount:25,tombstones:[],meta:[]}))`)
await sleep(300)
await ev(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
await sleep(900)
await ev(`[...document.querySelectorAll(".sheet button")].find(b => /记忆库/.test(b.textContent))?.click()`)
await sleep(900)
const dbg = await ev(`(() => {
	const sheet = document.querySelector(".sheet")
	const secs = [...sheet.querySelectorAll(".mem-sec")].map(s => ({title: (s.querySelector(".mem-sec-title")||{}).innerText, details: s.querySelectorAll("details").length, summaryText: [...s.querySelectorAll("details summary")].map(d => d.innerText)}))
	const sumEls = [...sheet.querySelectorAll(".mem-summary")].map(d => ({sum: d.querySelector("summary")?.innerText, open: d.open, content: d.querySelector(".mem-summary-content")?.innerText}))
	return {secs, sumEls, memViewSummaries: (window.__noriPetDebug ? "n/a" : "n/a")}
})()`)
console.log(JSON.stringify(dbg, null, 1))
ws.close(); edge.kill(); await sleep(200); rmSync(profile, {recursive: true, force: true})
