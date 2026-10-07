/* 真 Vue 页面 + 假原生桥，检查实际发送的时间上下文，不评价真实模型回复。 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const profile = mkdtempSync(path.join(tmpdir(), "nori-time-"))
const port = 9453
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, label, timeout = 15000) => {
	const end = Date.now() + timeout
	while (Date.now() < end) { if (await fn()) return; await sleep(100) }
	throw new Error(`等待超时：${label}`)
}
let harness, edge, ws, seq = 0
const pending = new Map(), results = []
const check = (name, ok, detail = "") => {
	results.push({name, ok: !!ok})
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ← ${detail}`}`)
}
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
	const id = ++seq
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 15000)
	pending.set(id, {resolve, reject, timer})
	ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}))
})

// 模块加载前安装时钟及历史，保证 UI 内存和假磁盘一致。
const INIT = `(() => {
	localStorage.setItem("intro_seen_v1", "1"); localStorage.setItem("storage_asked", "1");
	const NativeDate = Date;
	window.__clockTs = NativeDate.parse("2026-10-07T09:12:00+08:00");
	window.Date = class extends NativeDate {
		constructor(...args) { super(...(args.length ? args : [window.__clockTs])); }
		static now() { return window.__clockTs; }
	};
	window.__payloads = [];
	const ts = s => NativeDate.parse(s);
	const history = [
		{role: "user", content: "晚安，准备睡了", ts: ts("2026-10-06T23:30:00+08:00")},
		{role: "assistant", content: "已经很晚啦，晚安", ts: ts("2026-10-06T23:31:00+08:00")}
	];
	let bridge;
	Object.defineProperty(window, "NoriChat", {
		configurable: true, get: () => bridge, set: nc => {
			bridge = nc;
			nc.writeFile("chat.json", JSON.stringify(history));
			nc.writeFile("persona.md", "你是 Nori，温和自然地和用户聊天。");
			nc.writeFile("memory.json", JSON.stringify({memories: [], summaries: [
				{id: "known", content: "用户昨晚准备早睡。", createdAt: ts("2026-10-07T08:00:00+08:00"), msgCount: 2, tokenCount: 10,
					fromTs: ts("2026-10-06T22:00:00+08:00"), toTs: ts("2026-10-06T23:00:00+08:00")},
				{id: "old", content: "之前聊过游戏。", createdAt: ts("2026-10-05T10:00:00+08:00"), msgCount: 2, tokenCount: 10}
			], summarizedMsgCount: 2, tombstones: [], meta: [], blocks: []}));
			nc.chatStream = (_u, _k, _m, raw) => {
				window.__payloads.push(JSON.parse(raw));
				const finish = () => {
					window.__noriChatDelta?.("嗯嗯。");
					window.__noriChatDone?.(JSON.stringify({ok: true, content: "嗯嗯。"}));
				};
				if (window.__holdReply) window.__finishReply = finish;
				else setTimeout(finish, 40);
			};
			nc.chat = () => setTimeout(() => window.__noriChatRes?.(JSON.stringify({ok: true, content: "{}"})), 10);
			nc.chatStop = () => {};
		}
	});
})()`

const timeBlock = payload => payload.find(m => m.role === "system" && String(m.content).startsWith("【当前时间】"))?.content ?? ""
const validOrder = payload => {
	const systems = payload.filter(m => m.role === "system")
	return payload[0]?.content === "你是 Nori，温和自然地和用户聊天。" && systems.at(-1)?.content === timeBlock(payload)
		&& systems.filter(m => String(m.content).startsWith("【当前时间】")).length === 1 && systems.every(m => String(m.content).trim())
}
try {
	const serverReady = async () => { try { return (await fetch("http://127.0.0.1:8123/assets/web/index.html", {signal: AbortSignal.timeout(1000)})).ok } catch { return false } }
	if (!await serverReady()) {
		harness = spawn(process.execPath, [".harness/server.mjs"], {cwd: path.resolve(root, ".."), stdio: "ignore", windowsHide: true})
		await until(serverReady, "harness")
	}
	edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
		"--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=360,780", "about:blank"
	], {stdio: "ignore", windowsHide: true})
	let debuggerUrl
	await until(async () => { try { debuggerUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; return !!debuggerUrl } catch { return false } }, "Edge")
	ws = new WebSocket(debuggerUrl)
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
	ws.onmessage = event => {
		const msg = JSON.parse(event.data), p = pending.get(msg.id)
		if (!p) return
		clearTimeout(p.timer); pending.delete(msg.id)
		msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	await send("Emulation.setTimezoneOverride", {timezoneId: "Asia/Shanghai"}, sessionId)
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
	await send("Page.addScriptToEvaluateOnNewDocument", {source: INIT}, sessionId)
	const evalJs = async expression => {
		const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}, sessionId)
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
		return result.result.value
	}
	const open = async (timeAware, bubble = false) => {
		const seed = {apiKey: "fake-time-test", baseUrl: "https://api.probe.test", model: "fake", timeAware, smartRecall: false, memoryLlmExtract: false, emotionLlm: false, ambientEnabled: false, dataseaBg: false}
		await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/${bubble ? "bubble" : "index"}.html?shim=1&seed=${Buffer.from(JSON.stringify(seed)).toString("base64url")}`}, sessionId)
		await until(() => evalJs(`!!document.querySelector(${JSON.stringify(bubble ? ".bubble-input" : ".chat-input input")}) && !!window.NoriChat`), "页面输入框")
	}
	const sendText = async (text, bubble = false, beforeReply) => {
		const count = await evalJs("window.__payloads.length")
		const input = bubble ? ".bubble-input" : ".chat-input input", button = bubble ? ".bubble-send" : ".chat-input .send"
		await evalJs(`(() => { const input = document.querySelector(${JSON.stringify(input)}); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event("input", {bubbles: true})); })()`)
		await until(() => evalJs(`!document.querySelector(${JSON.stringify(button)}).disabled`), "发送按钮")
		await evalJs(`document.querySelector(${JSON.stringify(button)}).click()`)
		await until(() => evalJs(`window.__payloads.length > ${count}`), "聊天请求")
		if (beforeReply) await beforeReply()
		// 悬浮窗生成中按钮是可点击的“停止”，以输入框恢复可用判断完成。
		await until(() => evalJs(`!document.querySelector(${JSON.stringify(bubble ? ".bubble-input" : ".poke")}).disabled`), "回复完成")
		return evalJs("window.__payloads.at(-1)")
	}
	await open(true)
	const morning = await sendText("我回来啦")
	check("普通闲聊不问时间也注入当前上午时间", timeBlock(morning).includes("2026-10-07 09:12（UTC+08:00） 星期三") && timeBlock(morning).includes("当前时段：上午"))
	check("人格保留在最前，时间块只出现一次且为最后前置 system", validOrder(morning))
	check("昨晚的晚安保留真实发送日期", morning.some(m => m.role === "assistant" && m.content.includes("2026-10-06 23:31") && m.content.includes("已经很晚")))
	check("请求包含历史时间隔离和不随困倦认定深夜的规则", timeBlock(morning).includes("不能当作现在") && timeBlock(morning).includes("困了、累了"))
	const summary = morning.find(m => m.role === "system" && m.content.startsWith("【历史总结】"))?.content ?? ""
	check("摘要使用原对话范围，不用当天创建时间冒充", summary.includes("2026-10-06 22:00") && summary.includes("2026-10-06 23:00") && !summary.includes("2026-10-07 08:00"))
	check("旧摘要明确标为时间未记录", summary.includes("【原对话时间未记录】\n之前聊过游戏。"))
	await evalJs('window.__clockTs = Date.parse("2026-10-07T15:30:00+08:00")')
	const afternoon = await sendText("有点困")
	check("同页面续聊会刷新为下午时段", timeBlock(afternoon).includes("15:30") && timeBlock(afternoon).includes("当前时段：下午"))
	check("当前消息也保留发送时间", afternoon.at(-1).content.includes("2026-10-07 15:30") && afternoon.at(-1).content.endsWith("有点困"))
	await evalJs('window.__clockTs = Date.parse("2026-10-08T00:01:00+08:00")')
	const midnight = await sendText("还在吗")
	check("连续聊天跨午夜刷新日期、星期和时段", timeBlock(midnight).includes("2026-10-08 00:01") && timeBlock(midnight).includes("星期四") && timeBlock(midnight).includes("当前时段：凌晨"))
	await evalJs('document.querySelector(".poke").click()')
	await until(() => evalJs("window.__payloads.length === 4 && !document.querySelector('.poke').disabled"), "戳戳请求完成")
	const poke = await evalJs("window.__payloads.at(-1)")
	check("戳戳共用最新时间和正确 system 顺序", validOrder(poke) && timeBlock(poke).includes("2026-10-08 00:01") && poke.at(-1).content.includes("戳戳"))
	check("戳戳历史没有丢掉发送时间", poke.some(m => m.role === "assistant" && m.content.includes("2026-10-06 23:31") && m.content.includes("已经很晚")))
	check("时间标记没有污染聊天 UI 或落盘正文", await evalJs('!document.querySelector(".chat-msgs").textContent.includes("消息发送时间") && !window.NoriChat.readFile("chat.json").includes("消息发送时间")'))
	await open(false)
	const disabled = await sendText("我回来啦")
	check("主聊天关闭后不发送时间块、历史或摘要时间标签", disabled.length > 0 && !timeBlock(disabled) && !JSON.stringify(disabled).includes("消息发送时间") && !JSON.stringify(disabled).includes("原对话发送时间"))
	await evalJs('document.querySelector(".poke").click()')
	await until(() => evalJs("window.__payloads.length === 2 && !document.querySelector('.poke').disabled"), "关闭时戳戳")
	check("戳戳也遵守关闭开关", await evalJs('!JSON.stringify(window.__payloads.at(-1)).includes("当前时间") && !JSON.stringify(window.__payloads.at(-1)).includes("消息发送时间")'))
	await open(true, true)
	const bubbleMorning = await sendText("我回来啦", true)
	check("悬浮聊天共用上午时间和 system 顺序", validOrder(bubbleMorning) && timeBlock(bubbleMorning).includes("当前时段：上午"))
	check("悬浮聊天保留昨晚历史时间", bubbleMorning.some(m => m.role === "assistant" && m.content.includes("2026-10-06 23:31")))
	await evalJs('window.__clockTs = Date.parse("2026-10-07T15:30:00+08:00"); window.__holdReply = true')
	const bubbleSentTs = await evalJs("Date.now()")
	const bubbleAfternoon = await sendText("有点困", true, () => evalJs('window.__clockTs += 120000; window.__holdReply = false; window.__finishReply()'))
	check("悬浮聊天连续发送刷新为下午", timeBlock(bubbleAfternoon).includes("15:30") && timeBlock(bubbleAfternoon).includes("当前时段：下午"))
	const savedBubbleUser = () => evalJs('(() => { const data = JSON.parse(window.NoriChat.readFile("chat.json") || "[]"); return (Array.isArray(data) ? data : data.msgs ?? []).find(m => m.role === "user" && m.content === "有点困"); })()')
	await until(savedBubbleUser, "悬浮聊天落盘")
	check("悬浮聊天延迟回复仍保存用户提交时间", (await savedBubbleUser()).ts === bubbleSentTs && await evalJs("Date.now()") === bubbleSentTs + 120000)
	await open(false, true)
	const bubbleDisabled = await sendText("我回来啦", true)
	check("悬浮聊天关闭时没有时间注入", !timeBlock(bubbleDisabled) && !JSON.stringify(bubbleDisabled).includes("消息发送时间"))
} catch (error) {
	check("执行过程", false, String(error.stack || error))
} finally {
	for (const p of pending.values()) clearTimeout(p.timer)
	try { if (ws?.readyState === WebSocket.OPEN) await send("Browser.close") } catch { /* 可能先关闭连接 */ }
	try { ws?.close() } catch { /* 忽略 */ }
	edge?.kill(); harness?.kill()
	const passed = results.filter(r => r.ok).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
}
