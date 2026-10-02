/* 探针: 设置里导入「自定义文案人设」(2026-10-01 用户要求)
 *
 * 验的是**用户真正会走的那条路**（不是"源码里有没有那个函数"）：
 *   ① 设置面板顶部第一块就是人设行（用 DOM 顺序断言，不是"存在就行"）
 *   ② 点「导入文件」走原生桥，状态行从「未设置人设」变「自定义（文件名）· N 字」
 *   ③ **最关键**：导入后发一条消息，截获真发出去的 payload —— 第一条 system 必须是**自定义文本**，
 *      且**不含**内置人设字样（证明不是"两份都塞进去"）
 *   ④ 点「清除自定义」后再发一条：payload 里**不再有**人设那条 system（也不会塞空的 system）
 *      —— 内置人设已于 2026-10-01 从 App 删除，所以任何位置都不该再出现它的字样
 *   ⑤ 自定义内容确实落盘（`persona.md`），恢复内置后内容被清空
 *
 * 运行: node tmp-memcheck/probe-persona-import.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9455
const profile = mkdtempSync(join(tmpdir(), "nori-persona-"))
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

/* 自己编的人设: 带一个只可能出现在这份文本里的标记 */
const MARK = "测试标记-PERSONA-OK"
const CUSTOM = `# 自定义人设\n${MARK}\n你是探针里的临时人格, 说话只用一个字。`
const FAKE_NAME = "my-persona.md"
/* 内置人设里的独特字样 (见 services/chat/nori-prompt.md) */
const BUILTIN_MARK = "Nori System Prompt"

/* 假桥: 文件选择器直接回我们的文本; 聊天把真发出去的 payload 记下来 */
const FAKE = `(() => {
	window.__personaPickCalls = 0;
	window.__payloads = [];
	const TEXT = ${JSON.stringify(CUSTOM)};
	const nc = window.NoriChat || (window.NoriChat = {});
	nc.pickPersonaFile = function () {
		window.__personaPickCalls += 1;
		setTimeout(function () { try { window.__noriPersonaPickedRes && window.__noriPersonaPickedRes(JSON.stringify({ok: true, name: ${JSON.stringify(FAKE_NAME)}, size: TEXT.length, text: TEXT})) } catch (e) {} }, 40);
	};
	const rec = function (payload) { try { window.__payloads.push(JSON.parse(payload)) } catch (e) { window.__payloads.push({__parseError: String(payload).slice(0, 200)}) } };
	nc.chat = function (baseUrl, apiKey, model, payload) {
		rec(payload);
		setTimeout(function () { try { window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: "嗯。"})) } catch (e) {} }, 20);
	};
	nc.chatStream = function (baseUrl, apiKey, model, payload) {
		rec(payload);
		setTimeout(function () { try { window.__noriChatDelta && window.__noriChatDelta("嗯。") } catch (e) {} }, 20);
		setTimeout(function () { try { window.__noriChatDone && window.__noriChatDone(JSON.stringify({ok: true, content: "嗯。"})) } catch (e) {} }, 60);
	};
	nc.chatStop = function () {};
	return true;
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
	const seed = {apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m", ttsProvider: "cosyvoice"}

	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(seed)}`}, sessionId)
	await sleep(4300)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await evalJs(FAKE)

	const openSettings = async () => {
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(700)
	}
	const closeSheet = async () => {
		await evalJs(`document.querySelector(".sheet-head .x")?.click()`)
		await sleep(500)
	}
	/** 发一条消息 (与 probe-time-context 同一套操作) */
	const sendMain = async (text) => {
		await evalJs(`(() => { if (document.querySelector(".chat-input input")) return "already";
			const fab = [...document.querySelectorAll(".fab")].find(x => /聊天|对话/.test(x.textContent)); fab && fab.click(); return "clicked" })()`)
		for (let i = 0; i < 12; i += 1) { if (await evalJs(`!!document.querySelector(".chat-input input")`)) break; await sleep(200) }
		await evalJs(`(() => { const inp = document.querySelector(".chat-input input") || document.querySelector(".chat-input textarea");
			inp.value = ${JSON.stringify(text)}; inp.dispatchEvent(new Event("input", {bubbles: true})); return true })()`)
		await sleep(200)
		await evalJs(`(() => { const b = document.querySelector(".chat-input .send"); if (b && !b.disabled) { b.click(); return "SENT" } return "SKIP" })()`)
		await sleep(1500)
	}
	/** 取"这一轮新发出去的"payload 里第一条 system = 人设的那条 */
	const personaPayload = async (from, marker) => {
		const list = await evalJs(`(window.__payloads || []).slice(${from})`)
		const hit = (list || []).filter(p => Array.isArray(p) && p[0] && p[0].role === "system" && String(p[0].content).includes(marker))
		return {n: (list || []).length, p: hit.length ? hit[hit.length - 1] : null}
	}
	/* 设置面板顶部那块 (第一块 .settings-row) 的现场 */
	const topRow = () => evalJs(`(() => {
		const body = document.querySelector(".sheet .sheet-body")
		if (!body) return {ok: false}
		const rows = [...body.querySelectorAll(".settings-row")]
		const f = rows[0]
		const btn = (re) => f ? [...f.querySelectorAll("button")].find(b => re.test(b.textContent.trim())) : null
		const reset = btn(/清除自定义/)
		return {ok: true, rows: rows.length,
			first: f ? f.textContent.replace(/\\s+/g, " ").trim().slice(0, 90) : "",
			second: rows[1] ? rows[1].textContent.replace(/\\s+/g, " ").trim().slice(0, 30) : "",
			state: f && f.querySelector(".hint") ? f.querySelector(".hint").textContent.trim() : "",
			hasImport: !!btn(/导入文件/), resetDisabled: reset ? !!reset.disabled : null,
			file: (() => { try { return window.NoriChat.readFile("persona.md") } catch (e) { return "err:" + String(e) } })()}
	})()`)

	/* ================= ①~④ 设置面板最顶上那一块 ================= */
	await openSettings()
	const before = await topRow()
	check("① 设置面板打得开且有人设行", before.ok === true, JSON.stringify(before))
	check("② **第一块 .settings-row 就是人设行**（DOM 顺序，不是「存在就行」）",
		!!before.first && before.first.includes("人设文案（提示词）"), JSON.stringify(before.first))
	check("③ 第二块才是 API Base URL（确认它真的排在最前）",
		!!before.second && /API Base URL/i.test(before.second), JSON.stringify(before.second))
	check("④ 第一块里有「导入文件」按钮", before.hasImport === true, JSON.stringify(before))
	check("⑤ 没导入过时状态行写「未设置人设」且「清除自定义」置灰",
		/未设置人设/.test(before.state) && before.resetDisabled === true, JSON.stringify({state: before.state, disabled: before.resetDisabled}))

	/* ================= 导入 ================= */
	await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet .sheet-body button")].find(x => /导入文件/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(800)
	const after = await topRow()
	check("⑥ 点「导入文件」后假桥的 pickPersonaFile 被调用一次", after.file !== undefined && (await evalJs(`window.__personaPickCalls`)) === 1,
		`calls=${await evalJs(`window.__personaPickCalls`)}`)
	check("⑦ 状态行变成「自定义（文件名）· N 字」",
		/当前：自定义（my-persona\.md）/.test(after.state) && /\d+ 字/.test(after.state), JSON.stringify(after.state))
	check("⑧ 「清除自定义」变成可点（说明界面认得「有自定义」）", after.resetDisabled === false, JSON.stringify(after.resetDisabled))
	check("⑨ 自定义内容真的落盘到 persona.md", typeof after.file === "string" && after.file.includes(MARK),
		JSON.stringify(String(after.file).slice(0, 60)))

	/* ================= 最关键: 真发出去的 payload ================= */
	await closeSheet()
	const from1 = await evalJs(`(window.__payloads || []).length`)
	await sendMain("你好呀")
	const c1 = await personaPayload(from1, MARK)
	check("⑩ 发消息后有请求真的发出去了", c1.n > 0, `新 payload=${c1.n}`)
	check("⑪ **payload 第一条 system 是自定义人设文本**（含标记）",
		!!c1.p && String(c1.p[0].content).includes(MARK),
		JSON.stringify(c1.p ? String(c1.p[0].content).slice(0, 80) : null))
	check("⑫ 且**不含**内置人设字样（不是两份都塞进去）",
		!!c1.p && !String(c1.p[0].content).includes(BUILTIN_MARK),
		JSON.stringify(c1.p ? String(c1.p[0].content).slice(0, 80) : null))

	/* ================= 恢复内置 ================= */
	await openSettings()
	const resetClicked = await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet .sheet-body button")].find(x => /清除自定义/.test(x.textContent));
		if (!b) return "没找到按钮"; if (b.disabled) return "按钮是灰的"; b.click(); return "clicked" })()`)
	check("⑬ 「清除自定义」可点（导入后不再置灰）", resetClicked === "clicked", String(resetClicked))
	await sleep(600)
	const back = await topRow()
	check("⑭ 状态行回到「未设置人设」", /未设置人设/.test(back.state), JSON.stringify(back.state))
	check("⑮ persona.md 内容被清空（文件留着，内容为空）", back.file === "", JSON.stringify(String(back.file).slice(0, 40)))

	await closeSheet()
	const from2 = await evalJs(`(window.__payloads || []).length`)
	await sendMain("再说一句")
	const list2 = await evalJs(`(window.__payloads || []).slice(${from2})`)
	const c2 = await personaPayload(from2, MARK)
	/** 清除之后这一轮新发出去的 payload 里**所有** system 消息（不只看第一条） */
	const sysAll2 = (() => { const l = (list2 || [])[0]; return Array.isArray(l) ? l.filter(m => m.role === "system").map(m => String(m.content)) : null })()
	check("⑯ 清除后发消息：payload 里**没有**那条自定义人设 system（有人设才注入）",
		c2.n > 0 && !!sysAll2 && !sysAll2.some(c => c.includes(MARK)),
		sysAll2 ? JSON.stringify(sysAll2.map(c => c.slice(0, 40))) : `payload 数=${c2.n}`)
	check("⑰ 清除后**也不会塞一条空的 system**（空人设不该进 payload）",
		!!sysAll2 && !sysAll2.some(c => c.trim() === ""),
		sysAll2 ? JSON.stringify(sysAll2.map(c => JSON.stringify(c.slice(0, 24)))) : null)
	check("⑱ 任何位置都不含内置人设字样（内置已删，作回归护栏）",
		!!sysAll2 && !sysAll2.some(c => c.includes(BUILTIN_MARK)),
		sysAll2 ? JSON.stringify(sysAll2.map(c => c.slice(0, 40))) : null)
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
}
