/* 探针: Nori 看不看得到时间（用户 2026-10-01 报："nori 没法看时间"）
 *
 * 验的是**真发出去的 payload**（不是"源码里有没有那行"）：
 *   ① 第一条 system 仍然必须是**人格**（加时间块不能把它挤到后面）
 *   ② payload 里必须有一条含「当前时间」的 system 块，且含 年-月-日 / 星期X / 时:分 / UTC 偏移
 *   ③ 它必须排在人格**之后** —— 放最前会破坏提示词缓存（见 交接-P3 §15）
 *   ④ 关掉设置项 timeAware 后，必须**没有**这条块
 *   ⑤ 悬浮窗的气泡聊天（bubble.html）走的是另一套拼装，必须同样带上
 *
 * 运行: node tmp-memcheck/probe-time-context.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9453
const profile = mkdtempSync(join(tmpdir(), "nori-time-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sid) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sid ? {sessionId: sid} : {})}))
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
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")

/* 假 LLM: 把每次真发出去的 payload 记下来, 再回一句 */
const FAKE_CHAT = `(() => {
	window.__payloads = [];
	const nc = window.NoriChat || (window.NoriChat = {});
	const rec = (payload) => { try { window.__payloads.push(JSON.parse(payload)) } catch (e) { window.__payloads.push({__parseError: String(payload).slice(0, 200)}) } };
	nc.chat = function (baseUrl, apiKey, model, payload) {
		rec(payload);
		setTimeout(() => { try { window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: "嗯嗯。"})) } catch (e) {} }, 30);
	};
	nc.chatStream = function (baseUrl, apiKey, model, payload) {
		rec(payload);
		setTimeout(() => { try { window.__noriChatDelta && window.__noriChatDelta("嗯嗯。") } catch (e) {} }, 20);
		setTimeout(() => { try { window.__noriChatDone && window.__noriChatDone(JSON.stringify({ok: true, content: "嗯嗯。"})) } catch (e) {} }, 60);
	};
	nc.chatStop = function () {};
	window.__noriPlayMarker = window.__noriPlayMarker || function () {};
	return true;
})()`

/** 今天的本地日期串（与实现同口径，用于断言） */
const now = new Date()
const p2 = (n) => String(n).padStart(2, "0")
const TODAY = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
const WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][now.getDay()]

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
	const settings = (timeAware) => ({apiKey: "sk-time", baseUrl: "https://api.time.test", model: "m", timeAware})

	/* ---------- 场景 1/2: 主界面聊天 ---------- */
	const openMain = async (timeAware) => {
		await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(settings(timeAware))}`}, sessionId)
		await sleep(4300)
		await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
		for (let i = 0; i < 5; i += 1) {
			if (!(await evalJs(`!!document.querySelector(".intro-mask")`))) break
			await evalJs(`document.querySelector(".intro-next")?.click()`)
			await sleep(250)
		}
		await evalJs(`document.querySelector(".intro-mask")?.remove()`)
		await evalJs(FAKE_CHAT)
	}
	const sendMain = async (text) => {
		await evalJs(`(() => { if (document.querySelector(".chat-input input")) return "already";
			const fab = [...document.querySelectorAll(".fab")].find(x => /聊天|对话/.test(x.textContent)); fab && fab.click(); return "clicked" })()`)
		for (let i = 0; i < 12; i += 1) { if (await evalJs(`!!document.querySelector(".chat-input input")`)) break; await sleep(200) }
		await evalJs(`(() => { const inp = document.querySelector(".chat-input input") || document.querySelector(".chat-input textarea");
			inp.value = ${JSON.stringify(text)}; inp.dispatchEvent(new Event("input", {bubbles: true})); return true })()`)
		await sleep(200)
		await evalJs(`(() => { const b = document.querySelector(".chat-input .send"); if (b && !b.disabled) { b.click(); return "SENT" } return "SKIP" })()`)
		await sleep(1200)
	}
	const timeBlock = (payload) => (payload || []).find(m => m && m.role === "system" && String(m.content).includes("当前时间"))

	await openMain(true)
	await sendMain("现在几点了？")
	const p1 = await evalJs(`window.__payloads || []`)
	check("① 真的发出了一次请求 (payload 抓到了)", Array.isArray(p1) && p1.length > 0, `payloads=${Array.isArray(p1) ? p1.length : "?"}`)
	const first1 = (p1 && p1[0]) || []
	check("② 时间块必须是**最后一条** system（人设/记忆都在它前面）",
		(() => {
			const sysIdx = first1.map((m, i) => (m.role === "system" ? i : -1)).filter(i => i >= 0)
			const ti = first1.findIndex(m => m.role === "system" && String(m.content).includes("当前时间"))
			return ti >= 0 && sysIdx.length > 0 && ti === sysIdx[sysIdx.length - 1]
		})(),
		JSON.stringify(first1.map(m => `${m.role}:${String(m.content).slice(0, 14)}`)))
	const tb1 = timeBlock(first1)
	check("③ payload 里有「当前时间」的 system 块", !!tb1, JSON.stringify(first1.map(m => `${m.role}:${String(m.content).slice(0, 18)}`)))
	if (tb1) {
		const idx = first1.indexOf(tb1)
		check("④ 没导入人设时不塞空的 system（空人设不该进 payload）",
			!first1.some(m => m.role === "system" && String(m.content).trim() === ""), `index=${idx}`)
		check("⑤ 含今天的日期", String(tb1.content).includes(TODAY), `${TODAY} ∉ ${JSON.stringify(String(tb1.content).slice(0, 120))}`)
		check("⑥ 含星期（否则算不了「下周三」）", String(tb1.content).includes(WEEK), WEEK)
		check("⑦ 含 时:分", /\d{1,2}:\d{2}/.test(String(tb1.content)), String(tb1.content).slice(0, 120))
		check("⑧ 含时区偏移（UTC±hh:mm）", /UTC[+-]\d{2}:\d{2}/.test(String(tb1.content)), String(tb1.content).slice(0, 120))
	} else {
		check("④ 时间块排在人格之后", false, "没有时间块")
		check("⑤ 含今天的日期", false, "没有时间块")
		check("⑥ 含星期", false, "没有时间块")
		check("⑦ 含 时:分", false, "没有时间块")
		check("⑧ 含时区偏移", false, "没有时间块")
	}

	/* 关掉开关 → 必须没有时间块 */
	await openMain(false)
	await sendMain("现在几点了？")
	const p2 = await evalJs(`window.__payloads || []`)
	const first2 = (p2 && p2[0]) || []
	check("⑨ 开关关掉后**没有**时间块", !timeBlock(first2) && first2.length > 0,
		JSON.stringify(first2.map(m => `${m.role}:${String(m.content).slice(0, 18)}`)))

	/* ---------- 场景 3: 悬浮窗的气泡聊天 ---------- */
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/bubble.html?shim=1&seed=${b64(settings(true))}`}, sessionId)
	await sleep(3000)
	await evalJs(FAKE_CHAT)
	const hasInput = await evalJs(`!!document.querySelector(".bubble-input")`)
	check("⑩ 气泡页有输入框（能测）", hasInput === true, String(hasInput))
	if (hasInput) {
		await evalJs(`(() => { const inp = document.querySelector(".bubble-input");
			inp.value = "现在几点了？"; inp.dispatchEvent(new Event("input", {bubbles: true})); return true })()`)
		await sleep(200)
		await evalJs(`document.querySelector(".bubble-send")?.click()`)
		await sleep(1500)
		const p3 = await evalJs(`window.__payloads || []`)
		const first3 = (p3 && p3[0]) || []
		const tb3 = timeBlock(first3)
		check("⑪ 悬浮窗发出去的 payload 也带时间块", !!tb3,
			JSON.stringify(first3.map(m => `${m.role}:${String(m.content).slice(0, 18)}`)))
		check("⑫ 悬浮窗 payload 里时间块也是最后一条 system、且没有空 system",
			(() => {
				const sysIdx = first3.map((m, i) => (m.role === "system" ? i : -1)).filter(i => i >= 0)
				const ti = first3.findIndex(m => m.role === "system" && String(m.content).includes("当前时间"))
				return ti >= 0 && ti === sysIdx[sysIdx.length - 1] && !first3.some(m => m.role === "system" && String(m.content).trim() === "")
			})(),
			JSON.stringify(first3.map(m => `${m.role}:${String(m.content).slice(0, 14)}`)))
	}
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
}
