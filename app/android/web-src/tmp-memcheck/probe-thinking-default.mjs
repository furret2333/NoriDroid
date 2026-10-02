/* 探针: DeepSeek 思考模式的**默认值与开关口径** (2026-10-02 用户纠正: 默认**开**)
 *
 * 背景（官方文档）: 「思考模式**默认打开**，且 effort 默认为 `high`」
 *   —— https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/
 * 由此两条都必须成立才叫"开关真的有效":
 *   ① **默认开**: 新装 / 没存过这个字段的机器上, 勾选框是选中的, 且请求里带 `thinking:"enabled"`
 *      （旧代码只会在开关打开时传 enabled, 默认值是 false ⇒ 默认不开, 与用户要的相反）
 *   ② **能真的关掉**: 用户手动取消勾选并保存后, 请求里必须带 `thinking:"disabled"`
 *      （不传 = 服务端按默认"开"跑, 开关等于单向: 能开不能关）
 *   ③ 非 DeepSeek 端点：**一个字段都不许塞**（DeepSeek 专有扩展, 塞给 OpenAI 可能直接 400）
 *   ④ 老设置文件里那个 `deepseekThinking:false` 是**旧默认**写进去的 → 按 thinkDefaultV2 标记
 *      一次性迁移成"开", 且迁移后的关是永久的 (不会被再次翻回来)
 *
 * 假桥: `chatStream`/`chat` 记下第 5 个实参 (就是 resolveThinking 算出来的三态)。
 *
 * 运行: node tmp-memcheck/probe-thinking-default.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9468
const profile = mkdtempSync(join(tmpdir(), "nori-think-"))
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

/** 假 LLM 桥: 记下第 5 个实参 (= 思考模式三态), 并回一条回复让流程走完 */
const FAKE = `(() => {
	window.__thinkArgs = [];
	window.__savedSettings = null;
	const nc = window.NoriChat || (window.NoriChat = {});
	nc.chat = function (baseUrl, apiKey, model, payload, thinkingMode) {
		window.__thinkArgs.push({via: "chat", t: thinkingMode, baseUrl: baseUrl});
		setTimeout(function () { try { window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: "{}"})) } catch (e) {} }, 30);
	};
	nc.chatStream = function (baseUrl, apiKey, model, payload, thinkingMode) {
		window.__thinkArgs.push({via: "stream", t: thinkingMode, baseUrl: baseUrl});
		setTimeout(function () { try { window.__noriChatDelta && window.__noriChatDelta("好呀。") } catch (e) {} }, 30);
		setTimeout(function () { try { window.__noriChatDone && window.__noriChatDone(JSON.stringify({ok: true, content: "好呀。"})) } catch (e) {} }, 70);
	};
	nc.chatStop = function () {};
	const wf = nc.writeFile;
	nc.writeFile = function (name, content) {
		if (name === "settings.json") { try { window.__savedSettings = JSON.parse(content) } catch (e) {} }
		return typeof wf === "function" ? wf(name, content) : "ok";
	};
	return true
})()`

let evalJs = async () => { throw new Error("未初始化") }
try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	const jsErrors = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") {
			jsErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?")
		}
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}
	/** 开机 + 装假桥 + 打开聊天面板 + 发一条消息, 返回这次请求里带的思考模式三态 */
	const runScenario = async (seed) => {
		await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(seed)}`}, sessionId)
		await sleep(4300)
		await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
		await evalJs(`document.querySelector(".intro-mask")?.remove()`)
		await evalJs(FAKE)
		const opened = await evalJs(`(() => {
			if (document.querySelector(".chat-input input")) return "already"
			const fab = [...document.querySelectorAll(".fab")].find(x => /聊天|对话/.test(x.textContent));
			if (!fab) return "NO_FAB"; fab.click(); return "CLICKED"
		})()`)
		for (let i = 0; i < 12; i += 1) {
			if (await evalJs(`!!document.querySelector(".chat-input input")`)) break
			await sleep(250)
		}
		await evalJs(`(() => {
			const inp = document.querySelector(".chat-input input") || document.querySelector(".chat-input textarea");
			if (!inp) return false;
			inp.value = "在吗"; inp.dispatchEvent(new Event("input", {bubbles: true})); return true
		})()`)
		await sleep(350)
		await evalJs(`(() => { const b = document.querySelector(".chat-input .send"); if (b && !b.disabled) { b.click(); return "SENT" } return "SKIP" })()`)
		await sleep(1200)
		const args = await evalJs(`window.__thinkArgs`)
		const streamArg = (args || []).filter(a => a.via === "stream")
		return {opened, stream: streamArg.length ? streamArg[streamArg.length - 1].t : null, all: args}
	}
	/** 设置面板里「DeepSeek 思考模式」那两行的现场 */
	const thinkRow = async () => {
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(900)
		return await evalJs(`(() => {
			const body = document.querySelector(".sheet .sheet-body")
			if (!body) return {ok: false}
			const row = [...body.querySelectorAll(".settings-row")].find(r => /DeepSeek 思考模式/.test(r.textContent))
			if (!row) return {ok: false, why: "没找到那一行"}
			const cb = row.querySelector("input[type=checkbox]")
			const hint = row.querySelector(".hint")
			return {ok: true, checked: cb ? cb.checked === true : null, hint: hint ? hint.textContent.trim() : ""}
		})()`)
	}

	/* ============ ① 全新安装 (settings.json 里根本没有这两个字段) ============ */
	const a = await runScenario({apiKey: "sk-probe", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat"})
	check("①-a 默认(没存过) + DeepSeek 端点 ⇒ chatStream 带 thinking=\"enabled\"", a.stream === "enabled", JSON.stringify(a))
	const rowA = await thinkRow()
	check("①-b 设置里「DeepSeek 思考模式」默认就是**勾上**的", rowA.checked === true, JSON.stringify(rowA))
	check("①-c 界面文案写的是「默认开启」", /默认开启/.test(rowA.hint || ""), `hint=${rowA.hint}`)

	/* ============ ④ 老设置文件: deepseekThinking:false + 没有迁移标记 → 迁移成开 ============ */
	const b = await runScenario({apiKey: "sk-probe", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", deepseekThinking: false})
	check("④-a 老设置文件里的 false (旧默认) 被迁移: 仍然带 enabled", b.stream === "enabled", JSON.stringify(b))
	const rowB = await thinkRow()
	check("④-b 老机器上勾选框也是勾上的", rowB.checked === true, JSON.stringify(rowB))
	// 保存一次 → 迁移标记落盘
	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /保存设置/.test(b.textContent))?.click()`)
	await sleep(900)
	const saved = await evalJs(`window.__savedSettings`)
	check("④-c 保存后 settings.json 里 deepseekThinking=true 且写了迁移标记 thinkDefaultV2=true",
		!!saved && saved.deepseekThinking === true && saved.thinkDefaultV2 === true,
		JSON.stringify(saved && {deepseekThinking: saved.deepseekThinking, thinkDefaultV2: saved.thinkDefaultV2}))

	/* ============ ② 用户手动关掉 (标记已落盘 + false): 必须显式 disabled ============ */
	const c = await runScenario({apiKey: "sk-probe", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", deepseekThinking: false, thinkDefaultV2: true})
	check("②-a 用户手动关掉后 ⇒ chatStream 带 thinking=\"disabled\" (开关真的是双向的)",
		c.stream === "disabled", JSON.stringify(c))
	const rowC = await thinkRow()
	check("②-b 勾选框是**没勾**的 (用户的选择被尊重, 不会被迁移翻回来)", rowC.checked === false, JSON.stringify(rowC))
	// 反证: 旧实现关的时候传的是**布尔 false**（等于"不传字段"）⇒ 服务端按默认"开"跑
	check("②-c 反证: 关掉时传的是字符串三态 (不是旧实现的 false/不传)",
		typeof c.stream === "string" && c.stream.length > 0, JSON.stringify(c))

	/* ============ ③ 非 DeepSeek 端点: 一个字段都不许塞 ============ */
	const d = await runScenario({apiKey: "sk-probe", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", deepseekThinking: true})
	check("③-a 非 DeepSeek 端点 ⇒ 第 5 个实参是空串 (原生侧不写 thinking 字段)", d.stream === "", JSON.stringify(d))

	check("⑤ 全程无未捕获异常 (Runtime.exceptionThrown = 0)", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
}
