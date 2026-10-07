/* 真实 Vue 页面 + 假原生桥：横竖屏布局、画布锁定、图片/排队与戳戳，不调用真实聊天模型。 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const profile = mkdtempSync(path.join(tmpdir(), "nori-chat-tools-"))
const port = 9477
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
// 时间开关默认开启；只剥离发送层的标准时间行，仍严格比较用户正文。
const messageBody = text => typeof text === "string"
	? text.replace(/^【消息发送时间】\d{4}-\d{2}-\d{2} \d{2}:\d{2}（UTC[+-]\d{2}:\d{2}）\n/, "") : text
const check = (name, ok, detail = "") => {
	results.push({name, ok: !!ok})
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ← ${detail}`}`)
}
let harness, edge, ws, seq = 0
const pending = new Map()
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
	const id = ++seq
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) }, 15000)
	pending.set(id, {resolve, reject, timer})
	ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}))
})
const until = async (fn, label, timeout = 12000) => {
	const end = Date.now() + timeout
	while (Date.now() < end) { if (await fn()) return; await sleep(100) }
	throw new Error(`等待超时: ${label}`)
}

try {
	const serverReady = async () => { try { return (await fetch("http://127.0.0.1:8123/assets/web/index.html", {signal: AbortSignal.timeout(1000)})).ok } catch { return false } }
	if (!await serverReady()) {
		harness = spawn(process.execPath, [".harness/server.mjs"], {cwd: path.resolve(root, ".."), stdio: "ignore", windowsHide: true})
		await until(serverReady, "harness")
	}
	edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
		"--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=360,780", "about:blank",
	], {stdio: "ignore", windowsHide: true})
	let debuggerUrl
	await until(async () => {
		try { debuggerUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; return !!debuggerUrl } catch { return false }
	}, "Edge")
	ws = new WebSocket(debuggerUrl)
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data)
		const p = pending.get(msg.id)
		if (!p) return
		clearTimeout(p.timer); pending.delete(msg.id)
		msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
	await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 2}, sessionId)
	const evalJs = async (expression) => {
		const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}, sessionId)
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
		return result.result.value
	}
	const seed = {apiKey: "fake-test-key", baseUrl: "https://api.probe.test", model: "fake-vision", smartRecall: false, memoryLlmExtract: false, emotionLlm: false, ambientEnabled: false, dataseaBg: false}
	await send("Page.addScriptToEvaluateOnNewDocument", {source: 'localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")'}, sessionId)
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${Buffer.from(JSON.stringify(seed)).toString("base64url")}`}, sessionId)
	await until(() => evalJs('!!document.querySelector(".fab") && !!window.NoriChat'), "Vue 页面")
	await until(() => evalJs('!!document.querySelector(".l2d-host canvas") && !document.querySelector(".topbar .loading")'), "Live2D 加载")
	check("竖屏默认常驻输入栏，历史与底部 Dock 收起", await evalJs('!!document.querySelector(".stage-root.portrait") && !!document.querySelector(".chat-input input") && !document.querySelector(".chat-history").offsetHeight && !document.querySelector(".dock").offsetHeight'))
	check("右侧默认只露把手", await evalJs('!!document.querySelector(".side-rail-handle") && !document.querySelector(".side-rail-items").offsetHeight'))
	await evalJs('document.querySelector(".side-rail-handle").click()')
	check("展开侧栏显示五个原功能入口", await evalJs('document.querySelector(".side-rail-items").offsetHeight > 0 && [...document.querySelectorAll(".side-action")].map(b => b.textContent.trim()).join(",") === "日记,模型,触摸,番茄,设置"'))
	await evalJs('document.querySelector(".side-rail-mask").dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}))')
	check("点外部收起侧栏", await evalJs('!document.querySelector(".side-rail-items").offsetHeight'))
	await evalJs('document.querySelector(".side-rail-handle").click(); [...document.querySelectorAll(".side-action")].find(b => b.textContent.includes("设置")).click()')
	await until(() => evalJs('!!document.querySelector(".sheet")'), "侧栏设置")
	// v-show 的退场动画结束后才会设置 display:none。
	await until(() => evalJs('!document.querySelector(".chat-panel").offsetHeight'), "聊天栏退场结束")
	check("侧栏设置打开原面板并隐藏常驻聊天栏", await evalJs('!!document.querySelector(".sheet") && !document.querySelector(".chat-panel").offsetHeight && !document.querySelector(".side-rail")'))
	await evalJs('document.querySelector("#settings-connection").open = true; document.querySelector("#settings-connection input").focus()')
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 280, screenWidth: 360, screenHeight: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
	await sleep(300)
	await evalJs('document.querySelector(".sheet-head .x").click()')
	await until(() => evalJs('!document.querySelector(".sheet")'), "关闭设置")
	await evalJs('document.querySelector(".chat-input input").focus()')
	await until(() => evalJs('!!document.querySelector(".stage-root.portrait.keyboard-open")'), "设置键盘返回聊天")
	check("设置页唤起键盘后回聊天仍保持竖屏并识别键盘", await evalJs('!!document.querySelector(".stage-root.portrait.keyboard-open") && document.querySelector(".chat-input input").getBoundingClientRect().bottom <= innerHeight'))
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
	await until(() => evalJs('!document.querySelector(".stage-root.keyboard-open")'), "收起设置键盘")
	await evalJs('document.querySelector(".chat-input input").blur()')
	const touch = (type, points) => send("Input.dispatchTouchEvent", {type, touchPoints: points}, sessionId)
	const pressTag = async (ms, move = false) => {
		const point = await evalJs('(() => { const r = document.querySelector(".tag").getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1} })()')
		await touch("touchStart", [point])
		if (move) await touch("touchMove", [{...point, x: point.x + 40}])
		await sleep(ms)
		await touch("touchEnd", [])
		await sleep(120)
	}
	const pinch = async (uiFinger = false) => {
		const a = {x: 100, y: 350, id: 1}, b = {x: 200, y: 350, id: 2}
		if (uiFinger) { b.x = 40; b.y = 28 }
		await touch("touchStart", [a, b])
		await touch("touchMove", [{...a, x: 80, y: 380}, {...b, x: b.x + 50, y: b.y + 30}])
		await touch("touchEnd", [])
		await sleep(120)
	}
	const view = () => evalJs('window.__noriCanvasView()')
	const sameView = (a, b) => a.scale === b.scale && a.offsetX === b.offsetX && a.offsetY === b.offsetY
	check("左上角提示独立第二行且字号弱于模型名", await evalJs('(() => { const tag = document.querySelector(".tag"), hint = tag.querySelector(".tag-hint"); return hint.textContent === "长按锁定画布" && hint.getBoundingClientRect().top > tag.firstElementChild.getBoundingClientRect().top && parseFloat(getComputedStyle(hint).fontSize) < parseFloat(getComputedStyle(tag).fontSize) })()'))
	await pressTag(50)
	check("左上角短按仍打开模型菜单", await evalJs('!!document.querySelector(".sheet") && !document.querySelector(".tag.locked")'))
	await pressTag(50)
	const before = await view()
	await pinch(true)
	check("画布和 UI 混合触点不触发捏合", sameView(before, await view()))
	await pinch()
	check("未锁定时双指仍可缩放和平移", !sameView(before, await view()))
	await pressTag(850)
	check("长按锁定画布，不误开模型菜单且保存状态", await evalJs('!!document.querySelector(".tag.locked") && document.querySelector(".tag-hint").textContent.includes("长按解锁") && !document.querySelector(".sheet") && localStorage.getItem("l2d_canvas_locked") === "1"'))
	const lockedView = await view()
	await pinch()
	check("锁定时双指不能缩放或平移", sameView(lockedView, await view()))
	await evalJs('window.__probeReloadPending = true')
	await send("Page.reload", {}, sessionId)
	await until(() => evalJs('!window.__probeReloadPending && !!document.querySelector(".l2d-host canvas") && !document.querySelector(".topbar .loading")'), "锁定重启")
	check("页面重启后记住画布锁定", await evalJs('!!document.querySelector(".tag.locked")'))
	await pressTag(850, true)
	check("按住后滑走不误解锁", await evalJs('!!document.querySelector(".tag.locked") && !document.querySelector(".sheet")'))
	await pressTag(850)
	const unlockedView = await view()
	await pinch()
	check("再次长按解锁并恢复双指手势", await evalJs('!document.querySelector(".tag.locked") && localStorage.getItem("l2d_canvas_locked") === "0"') && !sameView(unlockedView, await view()))
	await evalJs(`(() => {
		const canvas = document.createElement("canvas"); canvas.width = 20; canvas.height = 40;
		canvas.getContext("2d").fillRect(0, 0, 20, 40);
		window.__imageData = canvas.toDataURL("image/png");
		window.__toolPayloads = []; window.__pickerCalls = []; window.__holdReply = false;
		const nc = window.NoriChat;
		for (const method of ["pickImageFile", "captureImage"]) nc[method] = function (requestId) {
			window.__pickerCalls.push(method);
			const cancelled = window.__cancelPick; window.__cancelPick = false;
			setTimeout(() => window.__noriImagePickedRes?.(JSON.stringify(cancelled
				? {ok: false, requestId, message: "未选择图片"}
				: {ok: true, requestId, dataUrl: window.__imageData, mime: "image/png", width: 20, height: 40, size: 100})), 30);
		};
		nc.chat = function () {
			setTimeout(() => window.__noriChatRes?.(JSON.stringify({ok: true, content: "{}"})), 10);
		};
		nc.chatStream = function (_url, _key, _model, json) {
			window.__toolPayloads.push(JSON.parse(json));
			if (!window.__holdReply) setTimeout(() => {
				window.__noriChatDelta?.("测试回复。");
				window.__noriChatDone?.(JSON.stringify({ok: true, content: "测试回复。"}));
			}, 150);
		};
		nc.chatStop = function () {};
		document.querySelector(".history-toggle").click();
	})()`)
	await until(() => evalJs('!!document.querySelector(".composer-more") && !!document.querySelector(".chat-history").offsetHeight'), "聊天入口")
	check("箭头展开的历史不超过屏高28%及260px", await evalJs('(() => { const r = document.querySelector(".chat-history").getBoundingClientRect(); return r.height > 100 && r.height <= Math.min(innerHeight * .28, 260) + 2 })()'))
	const choose = async (source) => {
		await evalJs('document.querySelector(".image-entry > button").click()')
		await until(() => evalJs('!!document.querySelector(".image-menu").offsetHeight'), "图片菜单")
		await evalJs(`document.querySelectorAll(".image-menu button")[${source === "album" ? 0 : 1}].click()`)
		await until(() => evalJs('!document.querySelector(".image-menu button").disabled'), "选择结束")
	}
	const draft = async (text) => evalJs(`(() => { const input = document.querySelector(".chat-input input"); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event("input", {bubbles: true})) })()`)
	// 生成中按钮承担停止；输入框 Enter 仍走原排队路径。
	const sendText = async (text) => { await draft(text); await evalJs('document.querySelector(".chat-input input").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}))') }
	const idle = () => until(() => evalJs('!document.querySelector(".poke").disabled'), "生成结束")
	const payloads = () => evalJs("window.__toolPayloads")
	const layout = async () => evalJs(`(() => { const panel = document.querySelector(".chat-panel"); const input = panel.querySelector("input").getBoundingClientRect(); return panel.scrollWidth <= panel.clientWidth + 1 && input.width >= 150 && [...panel.querySelectorAll(".chat-tools button, .composer-more > button, .send")].every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }) })()`)
	await idle()
	check("360px 窄屏输入与工具按钮不溢出", await layout())
	await choose("album")
	check("图片菜单走相册桥", await evalJs('window.__pickerCalls[0] === "pickImageFile"'))
	check("仅图片也能发送", await evalJs('!!document.querySelector(".image-preview") && !document.querySelector(".send").disabled'))
	await draft("保留草稿")
	await evalJs('document.querySelector(".image-remove").click()')
	check("移除图片保留草稿", await evalJs('!document.querySelector(".image-preview") && document.querySelector(".chat-input input").value === "保留草稿"'))
	await evalJs("window.__cancelPick = true")
	await choose("album")
	check("取消相册不添加图片", await evalJs('!document.querySelector(".image-preview")'))
	await choose("camera")
	check("直接拍摄走相机桥并预览", await evalJs('window.__pickerCalls.at(-1) === "captureImage" && !!document.querySelector(".image-preview")'))
	await evalJs("window.__cancelPick = true")
	await choose("camera")
	check("取消重新拍摄保留原待发送图", await evalJs('!!document.querySelector(".image-preview")'))
	await sendText("")
	await idle()
	let all = await payloads()
	check("真实发送 payload 携带图片和默认提问", Array.isArray(all[0].at(-1).content) && messageBody(all[0].at(-1).content[0].text) === "请看看这张图片" && all[0].at(-1).content[1].image_url.url.startsWith("data:image/png;base64,"))
	check("已发送图显示缩略预览", await evalJs('document.querySelector(".message-image")?.naturalWidth === 20 && !document.querySelector(".image-preview")'))
	check("纯图片只有预览，默认提问不显示在对话", await evalJs('!!document.querySelector(".bubble-wrap.user .message-image") && !document.querySelector(".bubble-wrap.user .bubble") && !document.querySelector(".chat-msgs").textContent.includes("请看看这张图片")'))
	await until(() => evalJs('!!window.NoriChat.readFile("chat.json")'), "聊天防抖落盘")
	check("图片不写入 chat.json", await evalJs('!window.NoriChat.readFile("chat.json").includes("base64") && window.NoriChat.readFile("chat.json").includes("[图片]")'))
	check("纯图片默认提问不写入聊天历史", await evalJs('!window.NoriChat.readFile("chat.json").includes("请看看这张图片")'))
	await sendText("再聊一句")
	await idle()
	all = await payloads()
	check("后续文字对话不重复发送旧图", all[1].every(m => typeof m.content === "string"))
	check("展开历史时不重复显示浮动回复", await evalJs('!document.querySelector(".portrait-reply")'))
	await choose("album")
	await draft("旋转保留草稿")
	await evalJs('window.__layoutCanvas = document.querySelector(".l2d-host canvas")')
	await send("Emulation.setDeviceMetricsOverride", {width: 780, height: 360, deviceScaleFactor: 1, mobile: true}, sessionId)
	await until(() => evalJs('!document.querySelector(".stage-root.portrait") && !!document.querySelector(".chat-tools")'), "横屏布局")
	check("横屏保持底部六入口和原聊天工具栏", await evalJs('!!document.querySelector(".dock").offsetHeight && document.querySelectorAll(".fab").length === 6 && !document.querySelector(".side-rail") && !document.querySelector(".history-toggle")'))
	check("切换横屏保留草稿和图片，不重挂模型", await evalJs('document.querySelector(".chat-input input").value === "旋转保留草稿" && !!document.querySelector(".image-preview") && document.querySelector(".l2d-host canvas") === window.__layoutCanvas'))
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
	await until(() => evalJs('!!document.querySelector(".stage-root.portrait") && !!document.querySelector(".composer-more")'), "返回竖屏")
	check("返回竖屏保留历史展开、草稿、图片和画布", await evalJs('!!document.querySelector(".chat-history").offsetHeight && document.querySelector(".chat-input input").value === "旋转保留草稿" && !!document.querySelector(".image-preview") && document.querySelector(".l2d-host canvas") === window.__layoutCanvas'))
	await evalJs('document.querySelector(".image-remove").click(); document.querySelector(".history-toggle").click()')
	check("收起历史后只剩输入栏和最新回复气泡", await evalJs('!document.querySelector(".chat-history").offsetHeight && !!document.querySelector(".chat-input input") && !!document.querySelector(".portrait-reply")'))
	check("回复气泡透明底且最多显示三行", await evalJs('(() => { const b = document.querySelector(".portrait-reply"); return getComputedStyle(b).backgroundColor.endsWith("0.3)") && getComputedStyle(b.firstElementChild).webkitLineClamp === "3" })()'))
	await evalJs('document.querySelector(".portrait-reply").click()')
	check("点击回复气泡可打开完整记录", await evalJs('!!document.querySelector(".chat-history").offsetHeight && document.querySelector(".chat-msgs").textContent.includes("测试回复")'))
	await evalJs('document.querySelector(".history-toggle").click()')
	await evalJs("window.__holdReply = true")
	await sendText("占住生成")
	await until(() => evalJs("window.__toolPayloads.length === 3"), "在途生成")
	await evalJs('window.__noriChatDelta("生成中的第一句。"); window.__streamBubble = document.querySelector(".portrait-reply")')
	await until(() => evalJs('document.querySelector(".portrait-reply")?.textContent.includes("第一句")'), "流式气泡")
	await sleep(9200)
	check("生成超过9秒时回复气泡仍保留，发送按钮变停止", await evalJs('document.querySelector(".portrait-reply")?.textContent.includes("第一句") && document.querySelector(".send").textContent === "停止" && !document.querySelector(".send").disabled'))
	await evalJs('window.__noriChatDelta("接着第二句。");')
	await until(() => evalJs('document.querySelector(".portrait-reply")?.textContent.includes("第二句")'), "流式更新")
	check("流式增量更新同一个气泡，不反复重建", await evalJs('document.querySelector(".portrait-reply") === window.__streamBubble'))
	await choose("album")
	await sendText("这张排队")
	check("图片随自己的消息排队", await evalJs('document.querySelector(".queue-hint")?.textContent.includes("1") && document.querySelector(".poke").disabled && !document.querySelector(".image-preview")'))
	await evalJs('window.__holdReply = false; document.querySelector(".send").click()')
	await idle()
	all = await payloads()
	check("停止后队列继续且附图对应正确文字", all.length === 4 && messageBody(all[3].at(-1).content[0].text) === "这张排队" && all[3].filter(m => Array.isArray(m.content)).length === 1)
	check("带图发送保留用户文字", await evalJs('[...document.querySelectorAll(".bubble-wrap.user .bubble")].some(b => b.textContent === "这张排队")'))
	await evalJs('window.__holdReply = true; document.querySelector(".poke").click(); document.querySelector(".poke").click()')
	await until(() => evalJs("window.__toolPayloads.length === 5"), "戳戳请求")
	all = await payloads()
	const poke = all[4]
	check("戳戳明确告诉模型动作并注入简短灵活指令", poke.at(-1).content.includes("戳戳") && poke.some(m => m.role === "system" && m.content.includes("自然闲聊 1～3 句")))
	check("戳戳复用时间和文字历史，未带旧图", poke.every(m => typeof m.content === "string") && poke.some(m => m.content.includes("当前时间")))
	check("连续戳戳只触发一次生成", await evalJs('window.__toolPayloads.length === 5 && document.querySelector(".poke").disabled'))
	await evalJs('window.__noriChatDelta("戳戳测试回复。"); window.__noriChatDone(JSON.stringify({ok: true, content: "戳戳测试回复。"}))')
	await idle()
	check("戳戳回复进入对话且按钮恢复", await evalJs('document.querySelector(".chat-msgs").textContent.includes("戳戳测试回复") && !document.querySelector(".poke").disabled'))
	await evalJs('document.querySelector(".chat-input input").focus(); document.querySelector(".history-toggle").click()')
	for (let height = 740; height >= 300; height -= 40) {
		await send("Emulation.setDeviceMetricsOverride", {width: 360, height, screenWidth: 360, screenHeight: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
		await sleep(40)
	}
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 280, screenWidth: 360, screenHeight: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
	await sleep(300)
	check("键盘缩小视口后输入按钮仍可用", await layout())
	check("键盘缩到高度小于宽度时仍为竖屏，历史不超过120px", await evalJs('!!document.querySelector(".stage-root.portrait.keyboard-open") && !document.querySelector(".dock").offsetHeight && document.querySelector(".chat-history").getBoundingClientRect().height <= 122'))
	await send("Emulation.setDeviceMetricsOverride", {width: 780, height: 200, screenWidth: 780, screenHeight: 360, deviceScaleFactor: 1, mobile: true}, sessionId)
	await until(() => evalJs('!document.querySelector(".stage-root.portrait")'), "键盘期间横屏")
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 280, screenWidth: 360, screenHeight: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
	await until(() => evalJs('!!document.querySelector(".stage-root.portrait")'), "键盘期间返回竖屏")
	check("键盘未收起时旋转回来仍识别竖屏并保留画布", await evalJs('!!document.querySelector(".stage-root.portrait.keyboard-open") && document.querySelector(".l2d-host canvas") === window.__layoutCanvas'))
	// 用默认画布位置截图，避免前面的捏合测试放大模型影响外观审查。
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
	await evalJs('["l2d_scale_ARGNori", "l2d_offset_x_ARGNori", "l2d_offset_y_ARGNori"].forEach(key => localStorage.removeItem(key))')
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${Buffer.from(JSON.stringify(seed)).toString("base64url")}`}, sessionId)
	await until(() => evalJs('!!document.querySelector(".l2d-host canvas") && !document.querySelector(".topbar .loading") && !!document.querySelector(".composer-more")'), "默认画布截图页")
	check("外观截图使用默认模型位置和缩放", sameView({scale: 1.12, offsetX: 0, offsetY: 0}, await view()))
	await evalJs(`(() => {
		window.NoriChat.chat = () => setTimeout(() => window.__noriChatRes?.(JSON.stringify({ok: true, content: "{}"})), 10);
		window.NoriChat.chatStream = () => setTimeout(() => {
			const content = "你忙你的就好，我在这里陪着你。想说话的时候，戳戳我也可以呀。";
			window.__noriChatDelta?.(content);
			window.__noriChatDone?.(JSON.stringify({ok: true, content}));
		}, 100);
	})()`)
	await sendText("陪我待一会儿吧")
	await idle()
	await evalJs('document.querySelector(".composer-more > button").click()')
	await until(() => evalJs('!!document.querySelector(".image-menu").offsetHeight'), "截图工具菜单")
	await sleep(300)
	const screenshot = await send("Page.captureScreenshot", {format: "png"}, sessionId)
	writeFileSync(path.join(root, "tmp-memcheck/_chat-tools-360.png"), Buffer.from(screenshot.data, "base64"))
	await evalJs('document.querySelector(".composer-more > button").click(); document.querySelector(".side-rail-handle").click()')
	await until(() => evalJs('[...document.querySelectorAll(".side-action img")].every(img => img.complete && img.naturalWidth > 0)'), "侧栏图标加载")
	check("侧栏复用的五个图标全部正常显示", await evalJs('document.querySelectorAll(".side-action img").length === 5 && [...document.querySelectorAll(".side-action img")].every(img => img.naturalWidth > 0)'))
	const sideScreenshot = await send("Page.captureScreenshot", {format: "png"}, sessionId)
	writeFileSync(path.join(root, "tmp-memcheck/_portrait-side-rail.png"), Buffer.from(sideScreenshot.data, "base64"))
	await evalJs('document.querySelector(".side-rail-handle").click(); document.querySelector(".history-toggle").click()')
	await sleep(300)
	const historyScreenshot = await send("Page.captureScreenshot", {format: "png"}, sessionId)
	writeFileSync(path.join(root, "tmp-memcheck/_portrait-history.png"), Buffer.from(historyScreenshot.data, "base64"))
} catch (error) {
	check("执行过程", false, String(error.stack || error))
} finally {
	for (const p of pending.values()) clearTimeout(p.timer)
	try { ws?.close() } catch { /* 已关闭 */ }
	edge?.kill()
	harness?.kill()
	const passed = results.filter(r => r.ok).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
}
