/** 假桥浏览器回归；只验证前端交互，不代替 Android WindowManager/IME 真机验收。
 * 先启动 app/android/.harness/server.mjs，再运行本文件。 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const profile = mkdtempSync(join(tmpdir(), "nori-float-controls-"))
const edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
	"--headless=new", "--remote-debugging-port=9361", `--user-data-dir=${profile}`,
	"--no-first-run", "--disable-gpu", "--window-size=520,900", "about:blank",
], {stdio: "ignore", windowsHide: true})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let ws, id = 0, sessionId
const pending = new Map(), results = [], errors = []
const check = (label, ok, detail = "") => {
	results.push(!!ok)
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `: ${detail}`}`)
}
const send = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
	const next = ++id
	const timer = setTimeout(() => { pending.delete(next); reject(new Error(method + " timeout")) }, 15000)
	pending.set(next, {resolve, reject, timer})
	ws.send(JSON.stringify({id: next, method, params, ...(session ? {sessionId: session} : {})}))
})
const evaluate = async expression => {
	const r = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true})
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
	return r.result.value
}
const waitFor = async expression => {
	for (let i = 0; i < 50; i++) {
		if (await evaluate(expression)) return
		await sleep(150)
	}
	throw new Error("not ready: " + expression)
}
try {
	let endpoint
	for (let i = 0; i < 40 && !endpoint; i++) {
		try { endpoint = (await (await fetch("http://127.0.0.1:9361/json/version")).json()).webSocketDebuggerUrl } catch {}
		if (!endpoint) await sleep(200)
	}
	ws = new WebSocket(endpoint)
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
	ws.onmessage = event => {
		const message = JSON.parse(event.data)
		if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text)
		const p = pending.get(message.id)
		if (!p) return
		clearTimeout(p.timer); pending.delete(message.id)
		message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result)
	}
	const target = await send("Target.createTarget", {url: "about:blank"})
	sessionId = (await send("Target.attachToTarget", {targetId: target.targetId, flatten: true})).sessionId
	await send("Runtime.enable")
	await send("Page.enable")
	await send("Page.addScriptToEvaluateOnNewDocument", {source: `
		window.__floatTest = {locked: false, closes: 0, handles: [], permitted: false, enabled: false, requests: 0, resets: 0};
		window.BubbleWindow = {
			isLocked: () => window.__floatTest.locked,
			setLocked: value => { window.__floatTest.locked = value },
			setHandleRect: (...r) => { window.__floatTest.handles.push(r) }
		};
		addEventListener('DOMContentLoaded', () => {
			Object.assign(window.NoriChat, {
				closeFloatBubble: () => { window.__floatTest.closes++ },
				canFloat: () => window.__floatTest.permitted,
				setFloatEnabled: value => { window.__floatTest.enabled = value },
				requestFloatPermission: () => { window.__floatTest.requests++ },
				resetFloatWindow: () => { window.__floatTest.resets++ },
				hideFloat: () => {}
			});
		});`})
	await send("Emulation.setDeviceMetricsOverride", {width: 320, height: 300, deviceScaleFactor: 2.75, mobile: true})
	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/bubble.html?shim=1"})
	await waitFor("!!document.querySelector('.bubble-close')")
	await sleep(200)
	check("打开聊天不自动聚焦输入", await evaluate("document.activeElement !== document.querySelector('input')"))
	await evaluate("document.querySelector('.bubble-reply').click()")
	check("点击回复不聚焦输入", await evaluate("document.activeElement !== document.querySelector('input')"))
	await evaluate("document.querySelector('.bubble-lock').click()")
	await sleep(50)
	check("锁定独立生效且不关闭", await evaluate("__floatTest.locked && __floatTest.closes === 0 && document.querySelector('.bubble-lock').getAttribute('aria-label') === '解锁聊天窗口' && document.querySelector('.bubble-lock').getAttribute('aria-pressed') === 'true'"))
	await evaluate("document.querySelector('.bubble-close').click()")
	check("锁定后仍可单击关闭", await evaluate("__floatTest.closes === 1 && __floatTest.locked"))
	await evaluate("document.querySelector('.bubble-lock').click()")
	await sleep(50)
	check("再次点击解锁", await evaluate("!__floatTest.locked && document.querySelector('.bubble-lock').getAttribute('aria-pressed') === 'false'"))
	check("把手上报为物理像素", await evaluate(`(() => {
		const r = document.querySelector('.bubble-handle').getBoundingClientRect();
		const a = __floatTest.handles.at(-1); const d = devicePixelRatio;
		return a && a.every((v, i) => Math.abs(v - [r.left, r.top, r.right, r.bottom][i] * d) <= 1);
	})()`))
	for (const height of [160, 300]) {
		await send("Emulation.setDeviceMetricsOverride", {width: 280, height, deviceScaleFactor: 2.75, mobile: true})
		await sleep(200)
		check(`${height}px 高窗口保留输入及发送按钮`, await evaluate(`(() => {
			const input = document.querySelector('input').getBoundingClientRect();
			const send = document.querySelector('.bubble-send').getBoundingClientRect();
			return input.width > 80 && send.bottom <= innerHeight && send.right <= innerWidth;
		})()`))
	}
	// Drive the real BubbleApp send/TTS pipeline with local bridge responses only.
	await evaluate(`(() => {
		window.__replyTest = {spoken: [], snapshots: [], mode: 'stream', done: false};
		const read = NoriChat.readFile;
		NoriChat.readFile = name => name === 'settings.json' ? JSON.stringify({
			apiKey: 'local-test', model: 'local-test', smartRecall: false, memoryLlmExtract: false,
			memoryRealtimeExtract: false, ttsEnabled: true, ttsProvider: 'fish', ttsApiKey: 'local-test'
		}) : read(name);
		NoriChat.ttsStream = (...args) => {
			__replyTest.spoken.push(args.at(-1));
			queueMicrotask(() => window.__noriTtsDone?.('{"ok":true}'));
		};
		NoriChat.chatStream = () => setTimeout(async () => {
			const content = '【消息发送时间】2026-10-2100:58\\n(UTC+08:00)\\n' + (__replyTest.mode === 'metadata' ? '' : '你好。明天 08:00 见。');
			if (__replyTest.mode !== 'done') for (const char of content) {
				window.__noriChatDelta?.(char);
				await new Promise(resolve => setTimeout(resolve, 0));
				__replyTest.snapshots.push(document.querySelector('.bubble-text')?.textContent || '');
			}
			window.__noriChatDone?.(JSON.stringify({ok: true, content}));
			__replyTest.done = true;
		}, 0);
	})()`)
	for (const mode of ['stream', 'done', 'metadata']) {
		await evaluate(`(() => {
			Object.assign(__replyTest, {mode: ${JSON.stringify(mode)}, spoken: [], snapshots: [], done: false});
			const input = document.querySelector('input'); input.value = '本地测试'; input.dispatchEvent(new Event('input', {bubbles: true}));
		})()`)
		await sleep(20)
		await evaluate("document.querySelector('.bubble-send').click()")
		await waitFor("__replyTest.done && !document.querySelector('input').disabled")
		await sleep(120)
		const expected = mode === 'metadata' ? '' : '你好。明天 08:00 见。'
		check(`${mode}: 悬浮回复和朗读仅含正文`, await evaluate(`
			(document.querySelector('.bubble-text')?.textContent || '') === ${JSON.stringify(expected)} &&
			__replyTest.spoken.join('') === ${JSON.stringify(expected)} &&
			__replyTest.snapshots.every(text => !/消息发送时间|2026|UTC|00:58/.test(text))`),
			JSON.stringify(await evaluate("({text: document.querySelector('.bubble-text')?.textContent || '', spoken: __replyTest.spoken})")))
	}
	await send("Emulation.setDeviceMetricsOverride", {width: 520, height: 900, deviceScaleFactor: 1, mobile: false})
	const seed = Buffer.from(JSON.stringify({dataseaBg: true, floatEnabled: false})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${seed}`})
	await waitFor("!!document.querySelector('.fab-label')")
	await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.querySelector('.fab-label')?.textContent === '设置').click()")
	await waitFor("!!document.querySelector('.settings-basic-group-float input[type=checkbox]')")
	await evaluate("Array.from(document.querySelectorAll('.settings-basic-group-float button')).find(b => b.textContent.includes('重置悬浮窗位置和大小')).click()")
	await sleep(50)
	check("重置按钮调用原生并反馈结果", await evaluate("__floatTest.resets === 1 && document.body.textContent.includes('已重置，离开应用后可查看悬浮窗')"))
	await evaluate("document.querySelector('.settings-basic-group-float input[type=checkbox]').click()")
	await sleep(50)
	check("未授权时开关关闭并等待授权", await evaluate("!document.querySelector('.settings-basic-group-float input[type=checkbox]').checked && !__floatTest.enabled && __floatTest.requests === 1 && document.querySelector('.settings-basic-group-float').textContent.includes('等待系统授权')"))
	await evaluate("window.dispatchEvent(new Event('nori-app-resume'))")
	await sleep(50)
	check("拒绝授权后仍关闭", await evaluate("!document.querySelector('.settings-basic-group-float input[type=checkbox]').checked && !__floatTest.enabled && document.querySelector('.settings-basic-group-float').textContent.includes('尚未获得')"))
	await evaluate("document.querySelector('.settings-basic-group-float input[type=checkbox]').click(); __floatTest.permitted = true; window.dispatchEvent(new Event('nori-app-resume'))")
	await sleep(50)
	check("授权返回后自动开启并同步原生", await evaluate("document.querySelector('.settings-basic-group-float input[type=checkbox]').checked && __floatTest.enabled"))
	await evaluate("__floatTest.permitted = false; window.dispatchEvent(new Event('nori-app-resume'))")
	await sleep(50)
	check("撤销权限后自动关闭并说明原因", await evaluate("!document.querySelector('.settings-basic-group-float input[type=checkbox]').checked && !__floatTest.enabled && document.querySelector('.settings-basic-group-float').textContent.includes('已被撤销')"))
	await waitFor('window.__noriL2dDraws > 2')
	await evaluate("window.__noriAppPaused = true; window.dispatchEvent(new Event('nori-app-pause')); document.dispatchEvent(new Event('visibilitychange')); __floatTest.draws = window.__noriL2dDraws; __floatTest.particles = JSON.stringify(window.__noriDataseaDebug().px)")
	await sleep(500)
	check("主 Activity 暂停但文档仍可见时，模型和动态背景都停画", await evaluate("!document.hidden && __noriL2dPaused && __floatTest.draws === window.__noriL2dDraws && __floatTest.particles === JSON.stringify(window.__noriDataseaDebug().px)"))
	await evaluate("window.__noriAppPaused = false; window.dispatchEvent(new Event('nori-app-resume'))")
	await waitFor('window.__noriL2dDraws > __floatTest.draws')
	await sleep(100)
	check("回主界面后同一模型和动态背景恢复绘制", await evaluate("!window.__noriL2dPaused && __floatTest.particles !== JSON.stringify(window.__noriDataseaDebug().px)"))
	check("无未捕获前端异常", errors.length === 0, errors.join(", "))
} catch (error) {
	check("测试执行", false, error.stack)
} finally {
	console.log(`${results.filter(Boolean).length}/${results.length} passed`)
	if (results.some(result => !result)) process.exitCode = 1
	for (const p of pending.values()) clearTimeout(p.timer)
	ws?.close(); edge.kill()
	await sleep(400)
	try { rmSync(profile, {recursive: true, force: true}) } catch {}
}
