/* 自查(非门禁): 「停止生成」按钮的排版 —— 真界面量测 + 截图
 *
 * 为什么要专门做: 该按钮只在**流式进行中**才出现 (v-if="chatStreaming")，普通 E2E 跑得太快看不到它。
 * 这里注入一个"只发一次 delta、永不 done"的假模型, 把流挂住, 按钮就一直显示。
 *
 * 量测 (两个宽度: 360 手机窄屏 / 520):
 *   · 按钮宽度 > 32 (说明 .x.stop 的 auto 宽度生效)、高 32;
 *   · 按钮的 scrollWidth/scrollHeight 不超过自身 (说明文字没溢出边框);
 *   · 标题「对话 · 模型名」是否被挤到 (<100px 或换行) —— 再模拟"朗读中"多一个停止按钮看最坏情况。
 * 产物: tmp-memcheck/_shot-stop-360.png / _shot-stop-520.png
 *
 * 运行: cd web-src && node tmp-memcheck/shot-stop-button.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9422
const profile = mkdtempSync(join(tmpdir(), "nori-stopbtn-"))
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
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

/* 假模型: chatStream 只发一次 delta, **不调 done** ⇒ chatStreaming 一直为真, 停止按钮常驻 */
const HOLD_STREAM = `(() => {
	const nc = window.NoriChat || (window.NoriChat = {});
	nc.chat = function (b, k, m, payload) {
		setTimeout(() => { try { window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: "{}"})) } catch (e) {} }, 30);
	};
	nc.chatStream = function () { setTimeout(() => { try { window.__noriChatDelta && window.__noriChatDelta("正在说很多很多话") } catch (e) {} }, 30) };
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
	const S = Buffer.from(JSON.stringify({apiKey: "sk-shot", baseUrl: "https://api.shot.test", model: "deepseek-flash"})).toString("base64url")

	for (const width of [360, 520]) {
		await send("Emulation.setDeviceMetricsOverride", {width, height: 780, deviceScaleFactor: 2, mobile: true}, sessionId)
		await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
		await sleep(4200)
		await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
		for (let i = 0; i < 5; i += 1) {
			if (!(await evalJs(`!!document.querySelector(".intro-mask")`))) break
			await evalJs(`document.querySelector(".intro-next")?.click()`)
			await sleep(300)
		}
		await evalJs(`document.querySelector(".intro-mask")?.remove()`)
		await evalJs(HOLD_STREAM)
		/* 打开聊天并发一条, 让流挂住 */
		await evalJs(`(() => { const fab = [...document.querySelectorAll(".fab")].find(x => /聊天|对话/.test(x.textContent)); fab && fab.click(); return !!fab })()`)
		for (let i = 0; i < 12; i += 1) { if (await evalJs(`!!document.querySelector(".chat-input input")`)) break; await sleep(200) }
		await evalJs(`(() => { const inp = document.querySelector(".chat-input input"); inp.value = "在吗"; inp.dispatchEvent(new Event("input", {bubbles: true})); return true })()`)
		await sleep(300)
		await evalJs(`(() => { const b = document.querySelector(".chat-input .send"); if (b && !b.disabled) b.click(); return !!b })()`)
		await sleep(1200)

		const m1 = await evalJs(`(() => {
			const head = document.querySelector(".chat-head")
			const btn = head?.querySelector(".x.stop")
			const title = head?.querySelector(".chat-title")
			const r = (e) => { const b = e.getBoundingClientRect(); return {x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height)} }
			return {
				headW: head ? Math.round(head.getBoundingClientRect().width) : null,
				btnText: btn ? btn.textContent.trim() : null,
				btnRect: btn ? r(btn) : null,
				btnScroll: btn ? {sw: btn.scrollWidth, cw: btn.clientWidth, sh: btn.scrollHeight, ch: btn.clientHeight} : null,
				titleText: title ? title.textContent.trim() : null,
				titleRect: title ? r(title) : null,
				titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : null,
			}
		})()`)
		/* 最坏情况: 再模拟一个"朗读中"的停止按钮 (两个 .x.stop 同时在) */
		const m2 = await evalJs(`(() => {
			const head = document.querySelector(".chat-head")
			const btn = head?.querySelector(".x.stop")
			if (!btn) return null
			const clone = btn.cloneNode(true); clone.textContent = "■ 停止"
			head.insertBefore(clone, head.querySelector(".x:last-child"))
			const title = head.querySelector(".chat-title")
			const out = {
				titleW: Math.round(title.getBoundingClientRect().width),
				titleClipped: title.scrollWidth > title.clientWidth + 1,
				headScrollW: head.scrollWidth, headClientW: head.clientWidth,
				overflow: head.scrollWidth > head.clientWidth + 1,
			}
			clone.remove()
			return out
		})()`)
		console.log(`\n===== 宽度 ${width}px =====`)
		console.log(`  标题: ${JSON.stringify(m1.titleText)} rect=${JSON.stringify(m1.titleRect)} 被裁=${m1.titleClipped}`)
		console.log(`  停止按钮: ${JSON.stringify(m1.btnText)} rect=${JSON.stringify(m1.btnRect)}`)
		console.log(`    文字溢出? scrollW=${m1.btnScroll?.sw} clientW=${m1.btnScroll?.cw} · scrollH=${m1.btnScroll?.sh} clientH=${m1.btnScroll?.ch}`)
		console.log(`  【最坏情况】两个停止按钮同框: 标题宽=${m2?.titleW} 被裁=${m2?.titleClipped} 头部横向溢出=${m2?.overflow}`)

		/* 按量到的坐标裁聊天头那一条 (聊天面板在页面下半部, 整页截图会只剩模型) */
		const clip = await evalJs(`(() => {
			const head = document.querySelector(".chat-head")
			if (!head) return null
			const b = head.getBoundingClientRect()
			return {x: 0, y: Math.max(0, Math.round(b.top) - 8), width: ${width}, height: Math.round(b.height) + 16}
		})()`)
		const shot = await send("Page.captureScreenshot", {format: "png", ...(clip ? {clip: {...clip, scale: 2}} : {})}, sessionId)
		const out = resolve(import.meta.dirname, `_shot-stop-${width}.png`)
		writeFileSync(out, Buffer.from(shot.data, "base64"))
		console.log(`  截图: ${out} (裁剪 ${JSON.stringify(clip)})`)
	}
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}
