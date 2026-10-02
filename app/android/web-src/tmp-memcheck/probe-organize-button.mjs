/* 门禁: 记忆库「立即整理」按钮 + A/B 反馈修复 (2026-09-27 深夜)
 *
 * 背景: 用户实机反馈"点立即整理没用"。实测定位到两件事:
 *   ① 语义: pending=0 时按设计空操作 (待整理只算"滑出最近 20 条之外、且未总结"的消息);
 *   ② 反馈渲染在面板最底部 (实测 776/808 ≈ 96%), 按钮在面板上部 ⇒ 看起来"没反应"。
 * 用户拍板 A+B: A = 反馈就地显示在按钮旁; B = pending=0 时按钮置灰 + 文案「暂无可整理」。
 *
 * 本门禁断言 (全部走真界面 + 真持久化, 不碰内部函数):
 *   B1 没有可整理内容时: 按钮**置灰**、文案「暂无可整理」、点击**零 LLM 调用**、库零变化;
 *   B2 有待整理内容时: 按钮可点、文案「立即整理」;
 *   A1 点击后**真的整理**: 1 次摘要调用 → 出块 + 条目 + 摘要;
 *   A2 反馈文字是 `.mem-org-msg` 且**紧贴按钮**(top - 按钮 bottom ≤ 80px) —— 这就是 A 的全部意义。
 *
 * 运行: cd web-src && node tmp-memcheck/probe-organize-button.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9420
const profile = mkdtempSync(join(tmpdir(), "nori-orgbtn-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0
const pendingMsgs = new Map()
let ws
const send = (method, params = {}, sessionId) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sessionId ? {sessionId} : {})}))
	return new Promise((res, rej) => {
		pendingMsgs.set(m, {res, rej})
		setTimeout(() => { if (pendingMsgs.has(m)) { pendingMsgs.delete(m); rej(new Error("超时 " + method)) } }, 25000)
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

/* 假模型: 摘要提示词回"摘要 + ===MEM=== + 记忆块"; 其它回 {} */
const FAKE_MODEL = `(() => {
	window.__llmCalls = [];
	const nc = window.NoriChat || (window.NoriChat = {});
	const promptOf = (p) => { try { return JSON.parse(p).map(m => m.content).join("\\n") } catch { return String(p) } };
	const answerFor = (prompt) => {
		if (prompt.includes("记忆整理助手") || prompt.includes("记忆压缩助手")) {
			return "这是探针摘要。\\n===MEM===\\n" + JSON.stringify({topic: "探针话题", items: [{content: "我喜欢探针", type: "preference", importance: 0.5}]});
		}
		if (prompt.includes("目标清单")) return JSON.stringify({done: []});
		return "{}";
	};
	nc.chat = function (baseUrl, apiKey, model, payload) {
		const prompt = promptOf(payload);
		window.__llmCalls.push(prompt.slice(0, 200));
		const answer = answerFor(prompt);
		setTimeout(() => { try { window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: answer})) } catch (e) {} }, 30);
	};
	nc.chatStream = function (baseUrl, apiKey, model, payload) {
		window.__llmCalls.push(promptOf(payload).slice(0, 200));
		const reply = window.__reply || "好呀。";
		setTimeout(() => { try { window.__noriChatDelta && window.__noriChatDelta(reply) } catch (e) {} }, 20);
		setTimeout(() => { try { window.__noriChatDone && window.__noriChatDone(JSON.stringify({ok: true, content: reply})) } catch (e) {} }, 50);
	};
	nc.chatStop = function () {};
	return true;
})()`

try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.id && pendingMsgs.has(m.id)) { const p = pendingMsgs.get(m.id); pendingMsgs.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
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
	const S = Buffer.from(JSON.stringify({
		apiKey: "sk-probe", baseUrl: "https://api.probe.test", model: "probe-model",
		memoryLlmExtract: true, smartRecall: false,
	})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4300)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	for (let i = 0; i < 5; i += 1) {
		if (!(await evalJs(`!!document.querySelector(".intro-mask")`))) break
		await evalJs(`document.querySelector(".intro-next")?.click()`)
		await sleep(300)
	}
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await evalJs(FAKE_MODEL)

	const openChat = async () => {
		await evalJs(`(() => { if (document.querySelector(".chat-input input")) return "already";
			const fab = [...document.querySelectorAll(".fab")].find(x => /聊天|对话/.test(x.textContent)); fab && fab.click(); return "clicked" })()`)
		for (let i = 0; i < 12; i += 1) { if (await evalJs(`!!document.querySelector(".chat-input input")`)) return true; await sleep(200) }
		return false
	}
	const closePanels = async () => { await evalJs(`document.querySelector(".sheet-mask")?.click()`); await sleep(400) }
	const sendOne = async (text) => {
		await evalJs(`(() => { const inp = document.querySelector(".chat-input input") || document.querySelector(".chat-input textarea");
			inp.value = ${JSON.stringify(text)}; inp.dispatchEvent(new Event("input", {bubbles: true})); return true })()`)
		await sleep(160)
		await evalJs(`(() => { const b = document.querySelector(".chat-input .send"); if (b && !b.disabled) { b.click(); return "SENT" } return "SKIP" })()`)
		await sleep(320)
	}
	/** 开记忆库 → 读按钮/待整理 → 点 → 读反馈(含位置) */
	const probeOrganize = async () => {
		await closePanels()
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(800)
		for (let i = 0; i < 3; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(300) }
		await sleep(700)
		const before = await evalJs(`(() => {
			const sheet = document.querySelector(".sheet")
			const row = sheet.querySelector(".mem-pending")
			const btn = sheet.querySelector(".mem-pending button")
			const bb = btn ? btn.getBoundingClientRect() : null
			return {
				pendingText: row ? row.innerText.replace(/\\n/g, " | ") : "(没有 .mem-pending 行)",
				btnText: btn ? btn.textContent.trim() : null,
				btnDisabled: btn ? !!btn.disabled : null,
				btnBottom: bb ? Math.round(bb.bottom) : null,
			}
		})()`)
		await evalJs(`window.__llmCalls = []`)
		/* 用真 click: disabled 的按钮 click 不会触发 handler (与用户手点一致) */
		const clicked = await evalJs(`(() => { const b = document.querySelector(".sheet .mem-pending button"); if (!b) return "NO_BTN"; b.click(); return b.disabled ? "DISABLED" : "CLICKED" })()`)
		await sleep(1500)
		const after = await evalJs(`(() => {
			const sheet = document.querySelector(".sheet")
			const msg = sheet.querySelector(".mem-org-msg")
			const btn = sheet.querySelector(".mem-pending button")
			const mr = msg ? msg.getBoundingClientRect() : null
			const mem = (() => { try { return JSON.parse(window.NoriChat.readFile("memory.json") || "{}") } catch { return {} } })()
			return {
				orgMsg: msg ? msg.innerText.trim() : null,
				orgMsgTop: mr ? Math.round(mr.top) : null,
				btnBottom: btn ? Math.round(btn.getBoundingClientRect().bottom) : null,
				calls: (window.__llmCalls || []).length,
				summaryCalls: (window.__llmCalls || []).filter(c => /记忆整理助手|记忆压缩助手/.test(c)).length,
				blocks: (mem.blocks || []).length,
				blockTopics: (mem.blocks || []).map(b => b.topic),
				memories: (mem.memories || []).length,
				summaries: (mem.summaries || []).length,
			}
		})()`)
		return {before, clicked, after}
	}

	const chatOpened = await openChat()
	check("聊天面板能打开 (前置)", chatOpened === true)
	await evalJs(`window.__reply = "好呀。"`)

	/* ===== 阶段1: 只聊 3 轮 (6 条消息, 没有可整理内容) ===== */
	for (let i = 1; i <= 3; i += 1) await sendOne(`探针短聊第${i}句`)
	const r1 = await probeOrganize()
	console.log(`   阶段1: 待整理行=${JSON.stringify(r1.before.pendingText)} 按钮=${JSON.stringify(r1.before.btnText)} disabled=${r1.before.btnDisabled} 点击=${r1.clicked}`)
	console.log(`          反馈=${JSON.stringify(r1.after.orgMsg)} 距按钮=${r1.after.orgMsgTop != null && r1.after.btnBottom != null ? r1.after.orgMsgTop - r1.after.btnBottom : null}px · LLM=${r1.after.calls} · 库=${JSON.stringify({b: r1.after.blocks, m: r1.after.memories, s: r1.after.summaries})}`)
	check("B1: 没有可整理内容时按钮**置灰**", r1.before.btnDisabled === true, `disabled=${r1.before.btnDisabled}`)
	check("B1: 没有可整理内容时文案是「暂无可整理」", r1.before.btnText === "暂无可整理", String(r1.before.btnText))
	check("B1: 没有可整理内容时点击**零 LLM 调用**、库零变化",
		r1.after.calls === 0 && r1.after.blocks === 0 && r1.after.memories === 0,
		`calls=${r1.after.calls} blocks=${r1.after.blocks} mem=${r1.after.memories}`)

	/* ===== 阶段2: 聊到越过近端 20 条 (有待整理内容) ===== */
	await closePanels()
	await openChat()
	for (let i = 4; i <= 12; i += 1) await sendOne(`探针长聊第${i}句`)
	const r2 = await probeOrganize()
	const gap = (r2.after.orgMsgTop != null && r2.after.btnBottom != null) ? r2.after.orgMsgTop - r2.after.btnBottom : null
	console.log(`   阶段2: 待整理行=${JSON.stringify(r2.before.pendingText)} 按钮=${JSON.stringify(r2.before.btnText)} disabled=${r2.before.btnDisabled} 点击=${r2.clicked}`)
	console.log(`          反馈=${JSON.stringify(r2.after.orgMsg)} 距按钮=${gap}px · 摘要调用=${r2.after.summaryCalls} · 库=${JSON.stringify({blocks: r2.after.blocks, topics: r2.after.blockTopics, memories: r2.after.memories, summaries: r2.after.summaries})}`)
	check("B2: 有待整理内容时按钮可点、文案「立即整理」",
		r2.before.btnDisabled === false && r2.before.btnText === "立即整理",
		`disabled=${r2.before.btnDisabled} text=${r2.before.btnText}`)
	check("A1: 点击后真的整理 (1 次摘要调用 → 出块+条目+摘要)",
		r2.after.summaryCalls === 1 && r2.after.blocks === 1 && r2.after.memories === 1 && r2.after.summaries === 1,
		JSON.stringify({calls: r2.after.summaryCalls, blocks: r2.after.blocks, mem: r2.after.memories, sums: r2.after.summaries}))
	check("A2: 反馈文字紧贴按钮 (距按钮底部 ≤ 80px, 不再跑到面板最底部)",
		r2.after.orgMsg != null && gap != null && gap >= 0 && gap <= 80 &&
		/已经整理|还剩|没能整理/.test(String(r2.after.orgMsg)),
		`orgMsg=${JSON.stringify(r2.after.orgMsg)} gap=${gap}`)
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
