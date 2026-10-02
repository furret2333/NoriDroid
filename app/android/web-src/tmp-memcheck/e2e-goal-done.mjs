/* E2E: 目标收尾判定 —— 走**真实接线路径** (发消息 → sendChatStream → analyzeAfterReply → pruneDoneGoals)。
 *
 * 为什么这个测试有份量: T28 测的是**服务层**(假 llmCall 直接调 pruneDoneGoals);
 * 这里测的是**接线**——回复完成后到底有没有去判定、判定结果有没有落到库里、气泡有没有弹。
 * 用假桥 + CDP 注入一个"会撒谎的假模型": 它在 __noriChatRes 里检查提示词,
 *   · 看到「目标清单」→ 返回我们指定的 done JSON (可切换成"不删"/"编造 id")
 *   · 其它 (记忆提取/总结) → 返回空
 * 这样跑通的是真代码路径, 只有"模型怎么答"是假的。
 *
 * 运行: node tmp-memcheck/e2e-goal-done.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9411
const profile = mkdtempSync(join(tmpdir(), "nori-goal-"))
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

/** 注入假模型: 换掉 NoriChat.chat/chatStream, 记录每一次收到的提示词, 并按规则作答 */
const FAKE_MODEL = `(() => {
	window.__llmCalls = [];            // 收到的提示词 (截断保存)
	window.__goalMode = "deleteAll";   // deleteAll | none | fakeId
	const nc = window.NoriChat || (window.NoriChat = {});
	const origChat = nc.chat;
	nc.chat = function (baseUrl, apiKey, model, payload, thinking) {
		let prompt = "";
		try { prompt = JSON.parse(payload).map(m => m.content).join("\\n") } catch { prompt = String(payload) }
		window.__llmCalls.push(prompt.length > 4000 ? prompt.slice(0, 4000) : prompt);   // 清单在提示词靠后位置, 截短会看不到
		let answer = "{}";
		if (prompt.includes("目标清单")) {
			const ids = [...prompt.matchAll(/^([A-Za-z0-9_]+) \\| /gm)].map(m => m[1]);
			if (window.__goalMode === "none") answer = JSON.stringify({done: []});
			else if (window.__goalMode === "fakeId") answer = JSON.stringify({done: [{id: "编造的id"}]});
			else answer = JSON.stringify({done: ids.map(i => ({id: i, reason: "e2e"}))});
		}
		setTimeout(() => { try { window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: answer})) } catch (e) {} }, 40);
	};
	nc.chatStream = function (baseUrl, apiKey, model, payload, thinking) {
		let prompt = "";
		try { prompt = JSON.parse(payload).map(m => m.content).join("\\n") } catch { prompt = String(payload) }
		window.__llmCalls.push(prompt.length > 4000 ? prompt.slice(0, 4000) : prompt);   // 清单在提示词靠后位置, 截短会看不到
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

	/* 用 ?seed= 让 settings.json 开机就带上 API Key / 模型 (否则 analyzeAfterReply 的 llmOk 为 false) */
	const S = Buffer.from(JSON.stringify({apiKey: "sk-e2e", baseUrl: "https://api.e2e.test", model: "e2e-model", memoryLlmExtract: true})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4300)
	await evalJs(FAKE_MODEL)
	check("假模型已注入 (chat/chatStream 被替换)", await evalJs(`typeof window.NoriChat.chatStream === "function" && !!window.__llmCalls`))

	/* 造一个目标 */
	const added = await evalJs(`(() => { const g = window.__noriAddGoal; return typeof g })()`)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	for (let i = 0; i < 3; i += 1) { await evalJs(`(() => { const b = document.querySelector(".sheet .mem-enter"); if (b) b.click(); return true })()`); await sleep(350) }
	await sleep(600)
	const goalInput = await evalJs(`(() => { const i = document.querySelector(".goal-add input"); if (!i) return false; i.value = "考雅思"; i.dispatchEvent(new Event("input", {bubbles: true})); return true })()`)
	check("二级记忆库页有目标输入框", goalInput === true, `addGoal 钩子=${added}`)
	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /记下目标/.test(b.textContent))?.click()`)
	await sleep(600)
	const goalsNow = await evalJs(`(document.querySelector(".sheet") || {}).innerText || ""`)
	check("目标已记下 (二级页能看到「考雅思」)", goalsNow.includes("考雅思"), goalsNow.slice(0, 80))

	/* 关面板, 发一条"已完成"的消息 */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(600)
	await evalJs(`window.__reply = "辛苦啦，那就好好休息一下。"`)

	/* 打开聊天面板并发送。
	 * ⚠ 两个坑 (我第一版就踩了, 结果是"发出去什么都没发生"):
	 *   ① 直接 `inp.value = x` 不会更新 Vue 的 `v-model` 绑定的 draft —— 必须先派发 input 事件,
	 *      且**等一拍**再点发送 (按钮 `:disabled="!draft.trim()"` 在同步点击时还是禁用态,
	 *      click 落在禁用按钮上 = 静默无事发生);
	 *   ② 发送后要等回复走完 (chatStreaming 期间不注入)。 */
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
		await sleep(350)   // 等 Vue 把 draft 更新完、按钮解禁
		const clicked = await evalJs(`(() => {
			const b = document.querySelector(".chat-input .send");
			if (!b) return "NO_BTN";
			if (b.disabled) return "DISABLED";
			b.click(); return "SENT"
		})()`)
		return clicked
	}

	const opened = await openChat()
	check("能打开聊天面板", opened !== "NO_FAB" && opened !== "NO_INPUT", opened)
	await evalJs(`window.__reply = "辛苦啦，那就好好休息一下。"`)
	const sent = await sendMsg("我雅思不考了，放弃了")
	console.log(`   打开=${opened} 发送=${sent}`)
	check("消息已发出 (按钮非禁用且点击成功)", sent === "SENT", `sent=${sent}`)
	await sleep(2600)

	/* ① 目标判定确实被调用, 且用的是"目标清单"提示词 */
	const calls = await evalJs(`window.__llmCalls`)
	const goalCalls = calls.filter(c => c.includes("目标清单"))
	console.log(`   LLM 调用 ${calls.length} 次, 其中目标判定 ${goalCalls.length} 次`)
	check("回复后真的发起了「目标清单」判定调用", goalCalls.length >= 1, JSON.stringify(calls.map(c => c.slice(0, 30))))
	check("判定提示词里带上了目标内容", goalCalls.some(c => c.includes("考雅思")), JSON.stringify(goalCalls.map(c => c.slice(0, 120))))

	/* ② 目标被删 + 气泡提示。
	 * 用**真界面**取证: 重新打开记忆库(点三下)看「陪着你的事」里还在不在 ——
	 * 不依赖任何测试专用钩子 (我第一版臆造了 __noriListGoals, 那是错的)。 */
	const bubbleNow = await evalJs(`(document.querySelector(".touch-bubble") || {}).innerText || ""`)
	console.log(`   气泡: ${JSON.stringify(bubbleNow)}`)
	check("弹出了\"收起来啦\"气泡", /收起来/.test(String(bubbleNow)), String(bubbleNow))

	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	for (let i = 0; i < 3; i += 1) { await evalJs(`(() => { const b = document.querySelector(".sheet .mem-enter"); if (b) b.click(); return true })()`); await sleep(350) }
	await sleep(700)
	const memPage = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const txt = (sheet || {}).innerText || ""
		return {txt: txt.slice(0, 200), hasGoalSection: txt.includes("陪着你的事"), stillHasGoal: txt.includes("考雅思"), goalItems: sheet ? sheet.querySelectorAll(".goal-add").length : 0}
	})()`)
	console.log(`   记忆库页: ${JSON.stringify(memPage)}`)
	check("记忆库页已打开 (取证前提)", memPage.hasGoalSection === true, JSON.stringify(memPage))
	check("★ 目标已从「陪着你的事」移除", memPage.stillHasGoal === false, JSON.stringify(memPage))

	/* ③ 反例: 换"什么都不删"的模型, 目标必须还在 (防误删) */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(500)
	await evalJs(`window.__goalMode = "none"`)
	// 再造一个目标
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	for (let i = 0; i < 3; i += 1) { await evalJs(`(() => { const b = document.querySelector(".sheet .mem-enter"); if (b) b.click(); return true })()`); await sleep(350) }
	await sleep(600)
	await evalJs(`(() => { const i = document.querySelector(".goal-add input"); if (i) { i.value = "学吉他"; i.dispatchEvent(new Event("input", {bubbles: true})) } })()`)
	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /记下目标/.test(b.textContent))?.click()`)
	await sleep(500)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(500)
	await evalJs(`window.__reply = "还在练呀，慢慢来。"`)
	await openChat()
	const sent2 = await sendMsg("吉他还在练，有点难")
	check("反例: 消息已发出", sent2 === "SENT", `sent=${sent2}`)
	await sleep(2600)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	for (let i = 0; i < 3; i += 1) { await evalJs(`(() => { const b = document.querySelector(".sheet .mem-enter"); if (b) b.click(); return true })()`); await sleep(350) }
	await sleep(700)
	const keepPage = await evalJs(`(() => { const t = (document.querySelector(".sheet") || {}).innerText || ""; return {stillHasGoal: t.includes("学吉他")} })()`)
	check("反例: 模型说不删时, 目标保留 (不误删)", keepPage.stillHasGoal === true, JSON.stringify(keepPage))

	check("全程无未捕获 JS 异常", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))

	const failed = results.filter(r => !r.cond)
	console.log(`\n${results.length - failed.length}/${results.length} passed`)
	if (failed.length) { process.exitCode = 1; console.log("FAILED:", failed.map(f => f.name).join(" | ")) }
} catch (e) {
	console.error("探针异常:", e?.message || e)
	process.exitCode = 2
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(400)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
