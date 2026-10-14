/* 探针: 「下载官方人设」前的**答题门**（2026-10-14 用户要求: 和「下载模型」同一套 —— 经过验证再下载）
 *
 * 入口认定: 设置 → 连接与人设 →「官方人设（下载）」行（就排在「人设文案（提示词）」正下方）里的
 *   那个按钮就是下载入口。门接在 openPersonaGate(): 先答题, **答对才真的去拉 .md**
 *   （答错/取消都不发请求, 与「下载模型」/「一键克隆」共用同一道题）。
 *
 * 断言分七组（对应任务书 ①~⑦）:
 *   ① 设置里那个行在「人设文案」正下方, 按钮可点, 而且**还没答题时 fetch 0 次**
 *   ② 点按钮 → 弹「人设授权验证」(同一道题 / 取消·验证并下载 / 说明写的是"人设文案"), 类名走 .persona-gate
 *   ③ 先**答错** → 提示答案不对、弹窗不关、**fetch 一次都没发出去**
 *   ④ 再**答对** → 弹窗收起、**fetch 恰好 1 次**、文本落盘成 persona.md、状态行变「当前：官方人设 · N 字」
 *   ⑤ 真的生效: 发一条消息, 截获 payload —— 第一条 system 就是**下载来的那份文本**
 *   ⑥ "重启"一次验取消/关闭: 取消、点✕ 都不下载（fetch 仍是 0）
 *   ⑦ 源站给出**错误页/不像人设的内容**时拒收: 分别回 HTML 与"没有 Nori 的文本" →
 *      报错、**不写 persona.md**、状态行仍是「未设置人设」（防"把错误页当人设存进去"）
 *
 * 运行: node tmp-memcheck/probe-persona-download-gate.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9471
const profile = mkdtempSync(join(tmpdir(), "nori-persona-dl-"))
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
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 30000)
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

/* 下载源回给页面的"人设": 带一个只可能出现在这份文本里的标记, 且过得了 services/chat 的三道校验
   （非空、≤200KB、"像 Nori 的人设"）。 */
const MARK = "测试标记-OFFICIAL-PERSONA-OK"
const GOOD_PERSONA = `# Nori System Prompt（探针临时版）\n${MARK}\n你是 Nori, 只在探针里存在。\n` + "陪用户玩。\n".repeat(40)
/** 错误页（第⑦组之一）: 源站 502/CF 那种 HTML —— 必须先被字符串判断拦下 */
const HTML_ERROR = "<!DOCTYPE html><html><head><title>502</title></head><body>bad gateway</body></html>"
/** 不像人设的文本（第⑦组之二）: 不空、不是 HTML, 但没有 "Nori" 这个词 */
const NOT_PERSONA = "这是一段普通的说明文字, 和角色没有关系。".repeat(20)

/**
 * 假桥:
 *   - window.fetch 只在请求 c8b197e2.pinme.dev 时被拦截（记一笔 + 回给定正文），其余照旧透传 ——
 *     这样"门到底有没有放行下载"是**可数**的：`window.__personaFetch` 就是真实请求次数
 *   - NoriChat.chat/chatStream 沿用 harness 的 readFile/writeFile, 只多记 payload（第⑤组要截真发出去的）
 */
const FAKE = (body) => `(() => {
	window.__personaFetch = [];
	const ORIG = window.fetch ? window.fetch.bind(window) : null;
	window.fetch = function (input, init) {
		const url = typeof input === "string" ? input : (input && input.url) || "";
		if (url.indexOf("c8b197e2.pinme.dev") >= 0) {
			window.__personaFetch.push(url);
			return Promise.resolve(new Response(${JSON.stringify(body)}, {status: 200, headers: {"content-type": "text/plain; charset=utf-8"}}));
		}
		return ORIG ? ORIG(input, init) : Promise.reject(new Error("no-fetch"));
	};
	window.__payloads = [];
	const nc = window.NoriChat || (window.NoriChat = {});
	const rec = function (p) { try { window.__payloads.push(JSON.parse(p)) } catch (e) { window.__payloads.push({__parseError: String(p).slice(0, 200)}) } };
	nc.chat = function (b, k, m, payload) {
		rec(payload);
		setTimeout(function () { try { window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: "嗯。"})) } catch (e) {} }, 20);
	};
	nc.chatStream = function (b, k, m, payload) {
		rec(payload);
		setTimeout(function () { try { window.__noriChatDelta && window.__noriChatDelta("嗯。") } catch (e) {} }, 20);
		setTimeout(function () { try { window.__noriChatDone && window.__noriChatDone(JSON.stringify({ok: true, content: "嗯。"})) } catch (e) {} }, 60);
	};
	nc.chatStop = function () {};
	return "ok";
})()`

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
	const seed = {apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m", ttsProvider: "cosyvoice", live2dModel: "ARGNori"}

	/** 开页 + 跳过引导 + 装假桥（每次"重启"都走一遍） */
	const boot = async (body) => {
		await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(seed)}`}, sessionId)
		await sleep(4300)
		await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
		await evalJs(`document.querySelector(".intro-mask")?.remove()`)
		return evalJs(FAKE(body))
	}
	const openSettings = async () => {
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(900)
	}
	const closeSheet = async () => {
		await evalJs(`document.querySelector(".sheet-head .x")?.click()`)
		await sleep(500)
	}
	/** 「人设文案」那一块 + 它正下方的「官方人设（下载）」那一块的现场 */
	const personaRows = () => evalJs(`(() => {
		const rows = [...document.querySelectorAll(".sheet .sheet-body .settings-row")]
		const i = rows.findIndex(r => /人设文案（提示词）/.test(r.textContent))
		if (i < 0) return {ok: false, rows: rows.length}
		const own = rows[i]
		const dl = rows[i + 1] || null
		const btn = dl ? [...dl.querySelectorAll("button")].find(b => /下载官方人设/.test(b.textContent)) : null
		return {ok: true, rows: rows.length, i: i,
			first: own.textContent.replace(/\\s+/g, " ").trim().slice(0, 40),
			dlText: dl ? dl.textContent.replace(/\\s+/g, " ").trim().slice(0, 80) : "",
			afterDl: rows[i + 2] ? rows[i + 2].textContent.replace(/\\s+/g, " ").trim().slice(0, 24) : "",
			hasBtn: !!btn, btnDisabled: btn ? !!btn.disabled : null,
			state: (() => { const h = own.querySelector(".hint"); return h ? h.textContent.trim() : "" })(),
			hints: dl ? [...dl.querySelectorAll(".hint")].map(h => h.textContent.trim()) : [],
			fetch: (window.__personaFetch || []).length,
			file: (() => { try { return String(window.NoriChat.readFile("persona.md")) } catch (e) { return "err:" + String(e) } })()}
	})()`)
	const clickDownload = () => evalJs(`(() => {
		const rows = [...document.querySelectorAll(".sheet .sheet-body .settings-row")]
		const dl = rows[rows.findIndex(r => /人设文案（提示词）/.test(r.textContent)) + 1]
		if (!dl) return "no-row"
		const b = [...dl.querySelectorAll("button")].find(x => /下载官方人设/.test(x.textContent))
		if (!b) return "no-btn"
		if (b.disabled) return "disabled"
		b.click(); return "clicked"
	})()`)
	const gateState = () => evalJs(`(() => {
		const g = document.querySelector(".gate")
		if (!g) return null
		return {cls: g.className, title: g.querySelector(".gate-title")?.textContent.trim(),
			q: g.querySelector(".gate-q")?.textContent.trim(), hasInput: !!g.querySelector(".gate-input"),
			desc: g.querySelector(".gate-desc")?.textContent.trim() || "",
			hint: g.querySelector(".gate-hint")?.textContent.trim() || "",
			btns: [...g.querySelectorAll("button")].map(b => b.textContent.trim()),
			fetch: (window.__personaFetch || []).length}
	})()`)
	const typeAnswer = (v) => evalJs(`(() => {
		const i = document.querySelector(".gate-input")
		if (!i) return "no-input"
		i.value = ${JSON.stringify(v)}
		i.dispatchEvent(new Event("input", {bubbles: true}))
		return "typed"
	})()`)
	const clickGateBtn = (pattern) => evalJs(`(() => {
		const b = [...document.querySelectorAll(".gate button")].find(b => /${pattern}/.test(b.textContent))
		if (!b) return "no-btn"
		b.click(); return "clicked"
	})()`)
	/** 发一条消息 (与 probe-persona-import 同一套操作) */
	const sendMain = async (text) => {
		await evalJs(`(() => { if (document.querySelector(".chat-input input")) return "already";
			const fab = [...document.querySelectorAll(".fab")].find(x => /聊天|对话/.test(x.textContent)); fab && fab.click(); return "clicked" })()`)
		for (let i = 0; i < 12; i += 1) { if (await evalJs(`!!document.querySelector(".chat-input input")`)) break; await sleep(200) }
		await evalJs(`(() => { const inp = document.querySelector(".chat-input input") || document.querySelector(".chat-input textarea");
			inp.value = ${JSON.stringify(text)}; inp.dispatchEvent(new Event("input", {bubbles: true})); return true })()`)
		await sleep(200)
		await evalJs(`(() => { const b = document.querySelector(".chat-input .send"); if (b && !b.disabled) { b.click(); return "SENT" } return "SKIP" })()`)
		await sleep(1800)
	}

	/* ================= ① 设置里那个下载入口（就排在「人设文案」下方） ================= */
	const fake1 = await boot(GOOD_PERSONA)
	check("⓪ 假桥就位（fetch 只在人设源被拦截 + payload 记录）", fake1 === "ok", String(fake1))
	await openSettings()
	const before = await personaRows()
	check("①-1 打开设置就找得到人设行与它下面的下载行", before.ok === true, JSON.stringify(before))
	check("①-2 **第一块还是「人设文案（提示词）」**（下载行没有把它挤走）",
		!!before.first && /人设文案（提示词）/.test(before.first), JSON.stringify(before.first))
	check("①-3 第二块就是「官方人设（下载）」+「下载官方人设」按钮可点",
		/官方人设/.test(before.dlText) && before.hasBtn === true && before.btnDisabled === false, JSON.stringify({dl: before.dlText, hasBtn: before.hasBtn, disabled: before.btnDisabled}))
	check("①-4 下载行的说明写了要过「人设授权验证」", (before.hints || []).some(h => /人设授权验证/.test(h)), JSON.stringify(before.hints))
	check("①-5 还没点按钮时 **fetch 一次都没发出去** + 状态行仍是「未设置人设」",
		before.fetch === 0 && /未设置人设/.test(before.state), JSON.stringify({fetch: before.fetch, state: before.state}))

	/* ================= ② 点「下载官方人设」→ 先弹验证题 ================= */
	const clicked = await clickDownload()
	check("②-1 点得动「下载官方人设」", clicked === "clicked", String(clicked))
	await sleep(500)
	const gate = await gateState()
	check("②-2 弹出「人设授权验证」弹窗（.persona-gate, 不复用另外两道门的类名）",
		gate && gate.title === "人设授权验证" && /persona-gate/.test(gate.cls || "") && !/model-gate|clone-gate/.test(gate.cls || ""), JSON.stringify(gate && {cls: gate.cls, title: gate.title}))
	check("②-3 还是同一道题（Nori 写的诗第一句？8 字）", gate && /Nori 写的诗第一句/.test(gate.q || "") && /8 字/.test(gate.q || ""), JSON.stringify(gate && gate.q))
	check("②-4 有输入框 + 取消/验证并下载",
		gate && gate.hasInput && (gate.btns || []).some(t => /取消/.test(t)) && (gate.btns || []).some(t => /验证并下载/.test(t)), JSON.stringify(gate && gate.btns))
	check("②-5 说明按动作换成「人设文案」（不再是模型/内置音色）",
		gate && /人设文案/.test(gate.desc || "") && !/该模型由|内置音色/.test(gate.desc || ""), JSON.stringify(gate && gate.desc))
	check("②-6 底部提示是人设那句（约 20KB + 直接成为本机人设）",
		gate && /20KB/.test(gate.hint || "") && /本机人设/.test(gate.hint || ""), JSON.stringify(gate && gate.hint))
	check("②-7 **开门时 fetch 一次都没发出去**（还没答题）", gate && gate.fetch === 0, `fetch=${gate && gate.fetch}`)

	/* ================= ③ 答错 → 不许下载 ================= */
	await typeAnswer("水母是月亮")
	await sleep(200)
	await clickGateBtn("验证并下载")
	await sleep(700)
	const wrong = await evalJs(`(() => ({fetch: (window.__personaFetch || []).length,
		msg: document.querySelector(".gate .hint")?.textContent.trim() || "",
		stillOpen: !!document.querySelector(".gate"),
		file: (() => { try { return String(window.NoriChat.readFile("persona.md")) } catch (e) { return "err" } })()}))()`)
	check("③-1 答错时明确报错（答案不对）", /不对|错误|再想/.test(wrong.msg), JSON.stringify(wrong.msg))
	check("③-2 **答错时 fetch 一次都没发出去**", wrong.fetch === 0, `fetch=${wrong.fetch}`)
	check("③-3 答错后弹窗不关（可以再试）", wrong.stillOpen === true, JSON.stringify(wrong))
	check("③-4 答错后**没写人设**（persona.md 仍是空）", wrong.file === "", JSON.stringify(String(wrong.file).slice(0, 40)))

	/* ================= ④ 答对 → 才开始下载并落盘生效 ================= */
	await typeAnswer(" 水母是水里的月亮。 ")
	await sleep(200)
	await clickGateBtn("验证并下载")
	await sleep(1200)
	const after = await personaRows()
	const gateGone = await evalJs(`!document.querySelector(".gate")`)
	check("④-1 答对后弹窗收起", gateGone === true, String(gateGone))
	check("④-2 答对后 **fetch 恰好 1 次**（只下一次）", after.fetch === 1, `fetch=${after.fetch}`)
	check("④-3 下载到的文本真的落盘成 persona.md（含下载内容里的标记）",
		typeof after.file === "string" && after.file.includes(MARK), JSON.stringify(String(after.file).slice(0, 60)))
	check("④-4 状态行变成「当前：官方人设 · N 字」",
		/当前：官方人设/.test(after.state) && /\d+ 字/.test(after.state), JSON.stringify(after.state))
	check("④-5 下载行给出成功反馈（已下载并启用官方人设）",
		(after.hints || []).some(h => /已下载并启用官方人设/.test(h)), JSON.stringify(after.hints))

	/* ================= ⑤ 生效证明: 真发出去的 payload 第一条 system 就是它 ================= */
	await closeSheet()
	const from1 = await evalJs(`(window.__payloads || []).length`)
	await sendMain("你好呀")
	const payloads = await evalJs(`(window.__payloads || []).slice(${from1})`)
	const sys = (() => { const l = (payloads || [])[0]; return Array.isArray(l) ? l.filter(m => m.role === "system") : null })()
	check("⑤-1 发消息后有请求真的发出去了", (payloads || []).length > 0, `新 payload=${(payloads || []).length}`)
	check("⑤-2 **第一条 system 就是下载来的那份人设**（含标记）",
		!!sys && sys.length > 0 && String(sys[0].content).includes(MARK), sys ? JSON.stringify(String(sys[0].content).slice(0, 60)) : "无 system")

	/* ================= ⑥ "重启"一次: 取消 / ✕ 都不下载 ================= */
	const fake2 = await boot(GOOD_PERSONA)
	check("⑥-0 重启后假桥复位（fetch 计数从 0 开始）", fake2 === "ok" && (await evalJs(`(window.__personaFetch || []).length`)) === 0, String(fake2))
	await openSettings()
	await clickDownload()
	await sleep(500)
	const reopened = await evalJs(`(() => ({open: !!document.querySelector(".gate"), fetch: (window.__personaFetch || []).length}))()`)
	check("⑥-1 再点一次 → 又弹题（每次下载都要过门）", reopened.open === true && reopened.fetch === 0, JSON.stringify(reopened))
	await clickGateBtn("取消")
	await sleep(600)
	const canceled = await evalJs(`(() => ({open: !!document.querySelector(".gate"), fetch: (window.__personaFetch || []).length,
		file: (() => { try { return String(window.NoriChat.readFile("persona.md")) } catch (e) { return "err" } })()}))()`)
	check("⑥-2 点「取消」能关掉弹窗", canceled.open === false, JSON.stringify(canceled))
	check("⑥-3 **取消后不下载**（fetch 0 次 + 没写盘）", canceled.fetch === 0 && canceled.file === "", JSON.stringify(canceled))
	await clickDownload()
	await sleep(500)
	const open2 = await evalJs(`!!document.querySelector(".gate")`)
	await evalJs(`document.querySelector(".gate .gate-head .x")?.click()`)
	await sleep(600)
	const closedX = await evalJs(`(() => ({open: !!document.querySelector(".gate"), fetch: (window.__personaFetch || []).length}))()`)
	check("⑥-4 点✕ 也能关（且同样不下载）", open2 === true && closedX.open === false && closedX.fetch === 0, JSON.stringify(closedX))

	/* ================= ⑦ 源站返回错误页 / 不像人设的内容 → 拒收、不写盘 ================= */
	await boot(HTML_ERROR)
	await openSettings()
	await clickDownload()
	await sleep(400)
	await typeAnswer("水母是水里的月亮")
	await sleep(200)
	await clickGateBtn("验证并下载")
	await sleep(1200)
	const badHtml = await personaRows()
	check("⑦-1 源站给 HTML 错误页时**拒收并报错**（提示里说明是网页）",
		(badHtml.hints || []).some(h => /网页而不是人设文案/.test(h)), JSON.stringify(badHtml.hints))
	check("⑦-2 错误页**没有被写成人设**（persona.md 仍为空 + 状态行仍是「未设置人设」）",
		badHtml.file === "" && /未设置人设/.test(badHtml.state), JSON.stringify({file: String(badHtml.file).slice(0, 40), state: badHtml.state}))

	await boot(NOT_PERSONA)
	await openSettings()
	await clickDownload()
	await sleep(400)
	await typeAnswer("水母是水里的月亮")
	await sleep(200)
	await clickGateBtn("验证并下载")
	await sleep(1200)
	const badText = await personaRows()
	check("⑦-3 内容不像人设（没有 Nori）时也**拒收并报错**",
		(badText.hints || []).some(h => /不像 Nori 的人设文案/.test(h)), JSON.stringify(badText.hints))
	check("⑦-4 同样**没有写盘**", badText.file === "" && /未设置人设/.test(badText.state), JSON.stringify({file: String(badText.file).slice(0, 40), state: badText.state}))
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
