import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9412
const profile = mkdtempSync(join(tmpdir(), "nori-dbg2-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0; const pending = new Map(); let ws
const send = (m, p = {}, s) => { const n = ++id; ws.send(JSON.stringify({id: n, method: m, params: p, ...(s ? {sessionId: s} : {})})); return new Promise((res, rej) => { pending.set(n, {res, rej}); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error("t")) } }, 25000) }) }
let url = ""
for (let i = 0; i < 40 && !url; i += 1) { try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) url = j.webSocketDebuggerUrl } catch {} await sleep(250) }
ws = new WebSocket(url)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const errs = []
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.method === "Runtime.exceptionThrown") errs.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } }
const {targetId} = await send("Target.createTarget", {url: "about:blank"})
const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
await send("Runtime.enable", {}, sessionId); await send("Page.enable", {}, sessionId)
const ev = async (e) => { const r = await send("Runtime.evaluate", {expression: e, returnByValue: true, awaitPromise: true}, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const S = Buffer.from(JSON.stringify({apiKey: "sk-e2e", baseUrl: "https://api.e2e.test", model: "e2e-model", memoryLlmExtract: true})).toString("base64url")
await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
await sleep(4300)
console.log("1) 配置探针:", JSON.stringify(await ev(`window.__noriDiagChat ? window.__noriDiagChat() : "无探针"`)))
// 注入假模型
await ev(`(() => {
  window.__llmCalls = []; window.__streamCalls = 0;
  const nc = window.NoriChat || (window.NoriChat = {});
  nc.chat = function (b, k, m, payload, t) { window.__llmCalls.push(String(payload).slice(0, 80)); setTimeout(() => window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: "{}"})), 30) };
  nc.chatStream = function (b, k, m, payload, t) { window.__streamCalls += 1; window.__llmCalls.push("STREAM"); setTimeout(() => window.__noriChatDelta && window.__noriChatDelta("好呀。"), 30); setTimeout(() => window.__noriChatDone && window.__noriChatDone(JSON.stringify({ok: true, content: "好呀。"})), 70) };
  nc.chatStop = function () {};
  return true })()`)
console.log("2) 假模型注入后:", JSON.stringify(await ev(`window.__noriDiagChat()`)))
// 打开聊天并发送
await ev(`[...document.querySelectorAll(".fab")].find(x => /聊天|对话/.test(x.textContent))?.click()`)
await sleep(900)
console.log("3) 打开聊天后:", JSON.stringify(await ev(`({diag: window.__noriDiagChat(), hasInput: !!document.querySelector(".chat-input input")})`)))
const sent = await ev(`(() => { const i = document.querySelector(".chat-input input"); if (!i) return "NO_INPUT"; i.value = "我雅思不考了"; i.dispatchEvent(new Event("input", {bubbles: true})); const b = document.querySelector(".chat-input .send"); if (b) { b.click(); return "SENT" } return "NO_BTN" })()`)
console.log("4) 发送:", sent)
await sleep(2500)
console.log("5) 发送后 LLM 调用:", JSON.stringify(await ev(`({calls: window.__llmCalls, stream: window.__streamCalls, diag: window.__noriDiagChat()})`)))
console.log("6) JS 异常:", JSON.stringify(errs.slice(0, 4)))
ws.close(); edge.kill(); await sleep(300); try { rmSync(profile, {recursive: true, force: true}) } catch {}
