/* E2E: 实时(逐句)记忆提取开关 (重构 P3, 2026-09-27)。
 *
 * 断言的是**真实 DOM + 真实持久化**, 而不是内部函数:
 *   ① 默认 (设置里没有该字段) → 实时通道**关**: 说「记住：X」当场不弹「记住了」、
 *      不产生"个人信息整理员"那次提取调用、memory.json 里也不落任何条目;
 *   ② 在设置里把开关点开 → 旧行为回来: 那次提取调用发生、条目入库、「记住了」气泡弹出。
 *
 * 运行: node tmp-memcheck/e2e-mem-realtime.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9414
const profile = mkdtempSync(join(tmpdir(), "nori-memrt-"))
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

/** 假模型: 记录每次收到的提示词, 按提示词种类作答 (实时提取 / 目标判定 / 其它) */
const FAKE_MODEL = `(() => {
	window.__llmCalls = [];
	const nc = window.NoriChat || (window.NoriChat = {});
	const promptOf = (payload) => { try { return JSON.parse(payload).map(m => m.content).join("\\n") } catch { return String(payload) } };
	nc.chat = function (baseUrl, apiKey, model, payload) {
		const prompt = promptOf(payload);
		window.__llmCalls.push(prompt.length > 2000 ? prompt.slice(0, 2000) : prompt);
		let answer = "{}";
		if (prompt.includes("个人信息整理员")) {
			answer = JSON.stringify({facts: [{content: "我喜欢下雨天", type: "preference", importance: 0.7, confidence: 0.9}]});
		} else if (prompt.includes("目标清单")) {
			answer = JSON.stringify({done: []});
		}
		setTimeout(() => { try { window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: answer})) } catch (e) {} }, 40);
	};
	nc.chatStream = function (baseUrl, apiKey, model, payload) {
		const prompt = promptOf(payload);
		window.__llmCalls.push(prompt.length > 2000 ? prompt.slice(0, 2000) : prompt);
		const reply = window.__reply || "好呀。";
		setTimeout(() => { try { window.__noriChatDelta && window.__noriChatDelta(reply) } catch (e) {} }, 30);
		setTimeout(() => { try { window.__noriChatDone && window.__noriChatDone(JSON.stringify({ok: true, content: reply})) } catch (e) {} }, 70);
	};
	nc.chatStop = function () {};
	return true;
})()`

try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	const jsErrors = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") jsErrors.push(m.params?.exceptionDetails?.exception?.description || "?")
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

	/* 开机设置: 只给 Key/模型 (**故意不带 memoryRealtimeExtract**, 模拟老设置文件) */
	const S = Buffer.from(JSON.stringify({
		apiKey: "sk-e2e", baseUrl: "https://api.e2e.test", model: "e2e-model",
		memoryLlmExtract: true, smartRecall: false,
	})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4300)
	await evalJs(FAKE_MODEL)
	check("假模型已注入", await evalJs(`typeof window.NoriChat.chatStream === "function" && !!window.__llmCalls`))

	const openChat = async () => {
		const r = await evalJs(`(() => {
			if (document.querySelector(".chat-input input")) return "already"
			const fab = [...document.querySelectorAll(".fab")].find(x => /聊天|对话/.test(x.textContent));
			if (!fab) return "NO_FAB"; fab.click(); return "CLICKED"
		})()`)
		for (let i = 0; i < 12; i += 1) {
			if (await evalJs(`!!document.querySelector(".chat-input input")`)) return r
			await sleep(250)
		}
		return "NO_INPUT"
	}
	const sendMsg = async (text) => {
		const typed = await evalJs(`(() => {
			const inp = document.querySelector(".chat-input input") || document.querySelector(".chat-input textarea");
			if (!inp) return false;
			inp.value = ${JSON.stringify(text)};
			inp.dispatchEvent(new Event("input", {bubbles: true}));
			return true
		})()`)
		if (!typed) return "NO_INPUT"
		await sleep(350)
		return evalJs(`(() => {
			const b = document.querySelector(".chat-input .send");
			if (!b) return "NO_BTN";
			if (b.disabled) return "DISABLED";
			b.click(); return "SENT"
		})()`)
	}
	const memFile = async () => {
		const raw = await evalJs(`window.NoriChat.readFile("memory.json")`)
		try { return JSON.parse(raw || "{}") } catch { return {} }
	}

	/* ============ ① 默认关: 说「记住：X」不当场入库、不弹气泡 ============ */
	const opened = await openChat()
	check("能打开聊天面板", opened !== "NO_FAB" && opened !== "NO_INPUT", opened)
	await evalJs(`window.__reply = "好呀。"`)
	const sent1 = await sendMsg("记住：我喜欢下雨天")
	check("消息已发出", sent1 === "SENT", `sent=${sent1}`)
	await sleep(2800)

	const calls1 = await evalJs(`window.__llmCalls`)
	const extractCalls1 = calls1.filter(c => c.includes("个人信息整理员"))
	const bubble1 = await evalJs(`(document.querySelector(".touch-bubble") || {}).innerText || ""`)
	const mem1 = await memFile()
	console.log(`   默认关: LLM 调用 ${calls1.length} 次 (其中实时提取 ${extractCalls1.length} 次) · 气泡=${JSON.stringify(bubble1)}`)
	check("①默认关: 没有再发起「实时提取」调用", extractCalls1.length === 0,
		JSON.stringify(calls1.map(c => c.slice(0, 24))))
	check("①默认关: 没有弹「记住了」气泡", !/记住了/.test(String(bubble1)), String(bubble1))
	check("①默认关: memory.json 里没有落任何条目", (mem1.memories ?? []).length === 0,
		`n=${(mem1.memories ?? []).length}`)

	/* ============ ② 把开关点开 → 旧行为回来 ============ */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(1000)
	const toggled = await evalJs(`(() => {
		const row = [...document.querySelectorAll(".row-inline")].find(r => /立即提取记忆/.test(r.textContent));
		if (!row) return "NO_ROW";
		const cb = row.querySelector("input");
		if (!cb) return "NO_CB";
		const before = cb.checked;
		cb.click();
		return (before ? "WAS_ON" : "") + (cb.checked ? "NOW_ON" : "NOW_OFF")
	})()`)
	check("②设置页有这个开关, 且默认是关的 (点开后变 ON)", toggled === "NOW_ON", String(toggled))
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(700)

	await evalJs(`window.__llmCalls = []`)
	await evalJs(`window.__reply = "好呀。"`)
	const sent2 = await sendMsg("记住：我喜欢钢琴")
	check("消息已发出 (开关打开后)", sent2 === "SENT", `sent=${sent2}`)
	await sleep(3200)
	const calls2 = await evalJs(`window.__llmCalls`)
	const extractCalls2 = calls2.filter(c => c.includes("个人信息整理员"))
	const bubble2 = await evalJs(`(document.querySelector(".touch-bubble") || {}).innerText || ""`)
	const mem2 = await memFile()
	console.log(`   开关打开: LLM 调用 ${calls2.length} 次 (其中实时提取 ${extractCalls2.length} 次) · 气泡=${JSON.stringify(bubble2)} · 条目=${JSON.stringify((mem2.memories ?? []).map(m => m.content))}`)
	check("②开关打开: 恢复「实时提取」调用", extractCalls2.length >= 1,
		JSON.stringify(calls2.map(c => c.slice(0, 24))))
	check("②开关打开: 弹回「记住了」气泡", /记住了/.test(String(bubble2)), String(bubble2))
	check("②开关打开: 条目真的落盘 (规则 + AI 提取都在)", (mem2.memories ?? []).length >= 1,
		JSON.stringify((mem2.memories ?? []).map(m => m.content)))

	check("全程无未捕获 JS 异常", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}

const failed = results.filter(r => !r.cond)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
	process.exitCode = 1
	console.log("FAILED:", failed.map(f => f.name).join(" | "))
}
