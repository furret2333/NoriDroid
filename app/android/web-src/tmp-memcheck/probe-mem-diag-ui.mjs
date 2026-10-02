/* 探针: 记忆诊断日志的界面与端到端行为 (P1「观测闭环」, 2026-09-30; 需 harness 在 8123)
 *
 * 验的是**真界面 + 真整理 + 真落盘**:
 *   ① 记忆库里有「记忆诊断（排查用）」小节: 开关默认关、导出/清空按钮在 0 条时置灰;
 *   ② 用真点击打开开关 → 模块侧开关跟着变 (关着时零开销的约定靠它保证);
 *   ③ 点「立即整理」真跑一次整理 (假模型) → 面板显示"已记录 1 次"、导出按钮变可点;
 *   ④ 点「导出记忆诊断」→ Download 侧真出现 mem-diag-*.jsonl:
 *      首行是环境头, 第二条是记录, 且含**提示词 / 模型原始输出(带哨兵) / 门槛挡下的条目 / 库状态**。
 *
 * 运行: node tmp-memcheck/probe-mem-diag-ui.mjs   (harness 需在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9442
const profile = mkdtempSync(join(tmpdir(), "nori-memdiag-"))
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

/* 假模型: 摘要提示词回「摘要 + ===MEM=== + 两条(一条该记、一条该被门槛挡下)」 */
const FAKE_MODEL = `(() => {
	window.__llmCalls = [];
	const nc = window.NoriChat || (window.NoriChat = {});
	const promptOf = (p) => { try { return JSON.parse(p).map(m => m.content).join("\\n") } catch { return String(p) } };
	const answerFor = (prompt) => {
		if (prompt.includes("记忆整理助手") || prompt.includes("记忆压缩助手")) {
			return "主人这一段在聊备考的事。\\n===MEM===\\n" + JSON.stringify({topic: "备考", items: [
				{content: "我在准备考试", type: "project", importance: 0.8},
				{content: "我有点困，准备去睡觉", type: "event", importance: 0.4}
			]});
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

	/* 设置里**不写** memoryDiagnostics ⇒ 走默认关 (③ 才能验"开关默认关") */
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
	await evalJs(`window.__reply = "好呀。"`)

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
		await sleep(300)
	}
	const openMemPanel = async () => {
		await closePanels()
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(800)
		for (let i = 0; i < 3; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(300) }
		await sleep(700)
	}

	const chatOpened = await openChat()
	check("前置: 聊天面板能打开", chatOpened === true)

	/* 先聊到"有待整理内容"但**不要**触发自动整理: 22 轮 ≈ 44 条 < 阈值 45 */
	for (let i = 1; i <= 22; i += 1) await sendOne(`探针诊断第${i}句`)
	await openMemPanel()

	/* ① 小节存在 + 开关默认关 + 按钮置灰 */
	const ui0 = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const sec = sheet.querySelector(".mem-diag")
		const box = sec ? sec.querySelector("input[type=checkbox]") : null
		const btns = sec ? [...sec.querySelectorAll("button")] : []
		return {
			title: sec ? (sec.querySelector(".mem-sec-title") || {}).innerText : null,
			checked: box ? !!box.checked : null,
			hint: sec ? (sec.querySelector(".hint") || {}).innerText.replace(/\\n/g, " ") : "",
			btns: btns.map(b => ({t: b.textContent.trim(), d: !!b.disabled})),
		}
	})()`)
	console.log(`   小节: ${JSON.stringify(ui0.title)} 开关=${ui0.checked} 按钮=${JSON.stringify(ui0.btns)}`)
	check("① 记忆库里有「记忆诊断（排查用）」小节", /记忆诊断/.test(String(ui0.title)), String(ui0.title))
	check("① 开关**默认关**", ui0.checked === false, `checked=${ui0.checked}`)
	check("① 0 条记录时导出/清空都置灰",
		ui0.btns.length >= 2 && ui0.btns.every(b => b.d === true), JSON.stringify(ui0.btns))

	/* ② 真点击打开开关 */
	await evalJs(`(() => { const b = document.querySelector(".sheet .mem-diag input[type=checkbox]"); b && b.click(); return !!b })()`)
	await sleep(400)
	const onNow = await evalJs(`(() => { const b = document.querySelector(".sheet .mem-diag input[type=checkbox]"); return b ? !!b.checked : null })()`)
	check("② 点一下开关就打开 (界面状态已变)", onNow === true, `checked=${onNow}`)

	/* ③ 立即整理一次 → 应该记下 1 条 */
	const clicked = await evalJs(`(() => { const b = document.querySelector(".sheet .mem-pending button"); if (!b) return "NO_BTN"; b.click(); return b.disabled ? "DISABLED" : "CLICKED" })()`)
	await sleep(1600)
	const ui1 = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const sec = sheet.querySelector(".mem-diag")
		const btns = sec ? [...sec.querySelectorAll("button")] : []
		return {
			clicked: ${JSON.stringify(clicked)},
			hint: sec ? (sec.querySelectorAll(".hint")[0] || {}).innerText.replace(/\\n/g, " ") : "",
			btns: btns.map(b => ({t: b.textContent.trim(), d: !!b.disabled})),
			blocks: (() => { try { return (JSON.parse(window.NoriChat.readFile("memory.json") || "{}").blocks || []).length } catch { return -1 } })(),
		}
	})()`)
	console.log(`   整理: 点击=${ui1.clicked} 块=${ui1.blocks} 提示=${JSON.stringify(ui1.hint)} 按钮=${JSON.stringify(ui1.btns)}`)
	check("③ 「立即整理」真的跑了一次 (出块)", ui1.clicked === "CLICKED" && ui1.blocks === 1, JSON.stringify({clicked: ui1.clicked, blocks: ui1.blocks}))
	check("③ 面板显示「已记录 1 次」", /已记录\s*1\s*次/.test(String(ui1.hint)), String(ui1.hint))
	check("③ 有记录后导出按钮变可点",
		ui1.btns.some(b => /导出记忆诊断/.test(b.t) && b.d === false), JSON.stringify(ui1.btns))

	/* ④ 导出 → 真落盘 + 内容齐 (先装 hook: 桥没有枚举接口, 只能截住那次写入) */
	await evalJs(`(() => {
		const nc = window.NoriChat;
		if (nc.__diagHooked) return true;
		nc.__diagHooked = true;
		nc.__lastDiag = null;
		const orig = nc.writeFile;
		nc.writeFile = function (n, c) { const r = orig.apply(this, arguments); if (/^mem-diag-/.test(n)) nc.__lastDiag = {n, c, r}; return r };
		return true;
	})()`)
	await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet .mem-diag button")].find(x => /导出记忆诊断/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(900)
	const file = await evalJs(`(() => {
		const d = window.NoriChat.__lastDiag;
		if (!d) return null;
		const rows = String(d.c).trim().split("\\n");
		let bad = 0;
		for (const l of rows) { try { JSON.parse(l) } catch { bad += 1 } }
		const rec = rows.length > 1 ? JSON.parse(rows[1]) : null;
		return {
			name: d.n, ok: d.r === "ok", lines: rows.length, bad,
			head: JSON.parse(rows[0]),
			hasSentinel: !!(rec && rec.raw && rec.raw.includes("===MEM===")),
			promptChars: rec ? rec.promptChars : 0,
			gated: rec ? (rec.gated || []).map(g => g.c) : [],
			items: rec ? (rec.items || []).map(g => g.c) : [],
			lib: rec ? rec.lib : null,
			blockId: rec ? rec.blockId : null,
		}
	})()`)
	console.log(`   导出: ${JSON.stringify(file)}`)
	check("④ 真的落盘了一个 mem-diag-*.jsonl", !!file && file.ok === true && /^mem-diag-\d{8}-\d{6}\.jsonl$/.test(String(file?.name)), JSON.stringify(file?.name))
	check("④ 内容是 JSONL: 首行环境头 + 每行都能解析",
		!!file && file.lines === 2 && file.bad === 0 && file.head?.kind === "header" && file.head?.records === 1,
		JSON.stringify({lines: file?.lines, bad: file?.bad, head: file?.head}))
	check("④ 记录里有提示词字数与带哨兵的模型原始输出",
		!!file && file.promptChars > 200 && file.hasSentinel === true, JSON.stringify({promptChars: file?.promptChars, sentinel: file?.hasSentinel}))
	check("④ 记录里有「被门槛挡下的那条」与库状态",
		!!file && file.gated.some(t => /准备去睡觉/.test(t)) && (file.lib?.total ?? 0) >= 1,
		JSON.stringify({gated: file?.gated, lib: file?.lib}))
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
