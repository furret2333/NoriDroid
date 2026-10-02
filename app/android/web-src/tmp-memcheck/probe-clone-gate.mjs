/* 探针: 一键克隆的「模型授权验证」+ 引导里的 Steam 愿望单（2026-10-01 用户要求）
 *
 * A. 一键克隆
 *   ① TTS 页有「一键克隆预设音色」按钮 → 点开弹窗（音频改为联网下载，不再打进包）
 *   ② 弹窗里有题面（Nori 写的诗第一句？8 字）+ 输入框 + 取消/验证并克隆
 *   ③ **答错不许克隆**：点验证后必须报错，且 createBundledCloneVoice **一次都没被调用**
 *   ④ 答对（水母是水里的月亮，故意带标点空格）→ 调用原生桥，参数 = (key, 模型, 前缀)
 *   ⑤ 审核通过后音色被选中并持久化到 settings.json（cosyVoice + cosyCloneVoices 绑模型）
 * B. 引导最后一步的「加入 Steam 愿望单」
 *   ⑥ 按钮存在 ⑦ 点击后走原生 openExternal 且 URL 正确
 *
 * 运行: node tmp-memcheck/probe-clone-gate.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9454
const STEAM = "https://store.steampowered.com/app/4996280/I_NORI/?beta=0"
const REPO = "https://github.com/furret2333/NoriDroid"
const profile = mkdtempSync(join(tmpdir(), "nori-gate-"))
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

/* 假桥: 记下克隆调用与审核查询, 并直接回"审核通过"; 另外记 openExternal */
const FAKE = `(() => {
	window.__cloneCalls = []; window.__queryCalls = []; window.__opened = [];
	const nc = window.NoriChat || (window.NoriChat = {});
	nc.createPresetCloneVoice = function (apiKey, model, prefix) {
		window.__cloneCalls.push([apiKey, model, prefix]);
		const n = window.__cloneCalls.length;
		const vid = n === 1 ? "nori-probe-voice" : "nori-probe-voice" + n;
		setTimeout(() => { try { window.__noriClonePresetRes && window.__noriClonePresetRes(JSON.stringify({ok: true, voice_id: vid})) } catch (e) {} }, 40);
	};
	nc.queryCloneVoice = function (apiKey, voiceId) {
		window.__queryCalls.push([apiKey, voiceId]);
		setTimeout(() => { try { window.__noriCloneQueryRes && window.__noriCloneQueryRes(JSON.stringify({ok: true, status: "OK", target_model: "cosyvoice-v3.5-flash"})) } catch (e) {} }, 40);
	};
	nc.openExternal = function (url) { window.__opened.push(url) };
	nc.chat = function (b, k, m, p) { setTimeout(() => { try { window.__noriChatRes && window.__noriChatRes(JSON.stringify({ok: true, content: "嗯。"})) } catch (e) {} }, 20) };
	nc.chatStream = function (b, k, m, p) { setTimeout(() => { try { window.__noriChatDone && window.__noriChatDone(JSON.stringify({ok: true, content: "嗯。"})) } catch (e) {} }, 30) };
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
	const seed = {apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m",
		// ⚠ 必须显式选千问：TTS 页默认是 fish，声音克隆那一整段在 cosyvoice 分支里（v-if）
		ttsProvider: "cosyvoice", cosyApiKey: "sk-cosy-probe", cosyModel: "cosyvoice-v3.5-flash"}

	/* ================= A. 一键克隆 + 答题门 ================= */
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(seed)}`}, sessionId)
	await sleep(4300)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await evalJs(FAKE)

	// 设置 → 语音合成（TTS）
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	await evalJs(`[...document.querySelectorAll("button")].find(x => /语音合成/.test(x.textContent))?.click()`)
	await sleep(1200)
	const hasTtsPage = await evalJs(`!!document.querySelector(".tts-page")`)
	check("① 进得了「语音合成」页", hasTtsPage === true, String(hasTtsPage))

	const clicked = await evalJs(`(() => {
		const b = [...document.querySelectorAll(".tts-page button")].find(x => /一键克隆|内置音频/.test(x.textContent))
		if (!b) return "没找到按钮"
		b.click(); return "clicked"
	})()`)
	check("② 有「一键克隆预设音色」按钮且能点开", clicked === "clicked", String(clicked))
	await sleep(500)
	const gate = await evalJs(`(() => {
		const g = document.querySelector(".clone-gate")
		if (!g) return null
		return {title: g.querySelector(".gate-title")?.textContent.trim(), q: g.querySelector(".gate-q")?.textContent.trim(),
			hasInput: !!g.querySelector(".gate-input"), btns: [...g.querySelectorAll("button")].map(b => b.textContent.trim())}
	})()`)
	check("③ 弹窗标题是「模型授权验证」", gate && gate.title === "模型授权验证", JSON.stringify(gate))
	check("④ 题面是「Nori 写的诗第一句？（8 字）」", gate && /Nori 写的诗第一句/.test(gate.q || "") && /8 字/.test(gate.q || ""), JSON.stringify(gate && gate.q))
	check("⑤ 有输入框 + 取消/验证并克隆", gate && gate.hasInput && (gate.btns || []).some(t => /取消/.test(t)) && (gate.btns || []).some(t => /验证/.test(t)), JSON.stringify(gate && gate.btns))

	// 答错 → 不许克隆
	await evalJs(`(() => { const i = document.querySelector(".gate-input"); i.value = "水母是月亮"; i.dispatchEvent(new Event("input", {bubbles: true})) })()`)
	await sleep(200)
	await evalJs(`[...document.querySelectorAll(".clone-gate button")].find(b => /验证/.test(b.textContent))?.click()`)
	await sleep(600)
	const wrong = await evalJs(`(() => ({calls: (window.__cloneCalls || []).length,
		msg: document.querySelector(".clone-gate .hint")?.textContent.trim() || "",
		stillOpen: !!document.querySelector(".clone-gate")}))()`)
	check("⑥ 答错时明确报错", /不对|错误|再想/.test(wrong.msg), JSON.stringify(wrong))
	check("⑦ **答错时一次都没调用克隆桥**", wrong.calls === 0, `calls=${wrong.calls}`)
	check("⑧ 答错后弹窗不关（可以再试）", wrong.stillOpen === true)

	// 答对（故意带空格和标点，验证归一化）
	await evalJs(`(() => { const i = document.querySelector(".gate-input"); i.value = " 水母是水里的月亮。 "; i.dispatchEvent(new Event("input", {bubbles: true})) })()`)
	await sleep(200)
	await evalJs(`[...document.querySelectorAll(".clone-gate button")].find(b => /验证/.test(b.textContent))?.click()`)
	await sleep(1200)
	const calls = await evalJs(`window.__cloneCalls || []`)
	check("⑨ 答对后调用原生桥（带标点空格也能过）", calls.length === 1, JSON.stringify(calls))
	check("⑩ 参数 = (千问 Key, 当前模型, 前缀)", calls[0] && calls[0][0] === "sk-cosy-probe" && calls[0][1] === "cosyvoice-v3.5-flash" && !!calls[0][2], JSON.stringify(calls[0]))
	// 轮询是 5 秒一次，等它跑完一轮
	await sleep(6500)
	const saved = await evalJs(`(() => {
		const s = (() => { try { return JSON.parse(window.NoriChat.readFile("settings.json") || "{}") } catch { return {} } })()
		return {voice: s.cosyVoice || "", list: (s.cosyCloneVoices || []).map(v => v.id + "@" + v.model),
			msg: document.querySelector(".clone-gate .hint")?.textContent.trim() || "", open: !!document.querySelector(".clone-gate")}
	})()`)
	check("⑪ 审核通过后音色被选为当前音色", saved.voice === "nori-probe-voice", JSON.stringify(saved))
	check("⑫ 音色↔模型绑定被持久化（防跨模型用错音色）", (saved.list || []).some(x => x === "nori-probe-voice@cosyvoice-v3.5-flash"), JSON.stringify(saved.list))
	check("⑬ 成功后给出反馈（提示或自动收起）", /通过|准备好|✅/.test(saved.msg) || saved.open === false, JSON.stringify(saved))

	/* ---- 参考音频改为**联网下载**（2026-10-01 用户要求：不许打进包）---- */
	check("⑯ 桥收到的参数只有 3 个（key/model/prefix，不再有 variant）", calls[0] && calls[0].length === 3, JSON.stringify(calls[0]))
	const uiState = await evalJs(`(() => {
		const sel = [...document.querySelectorAll(".tts-page select")].some(x => [...x.options].some(o => /原版保真/.test(o.textContent)))
		const hint = [...document.querySelectorAll(".tts-page .hint")].map(h => h.textContent).join(" | ")
		const btn = [...document.querySelectorAll(".tts-page button")].some(b => /一键克隆预设音色/.test(b.textContent))
		return {hasRefSelect: sel, btn, netHint: /联网下载/.test(hint), magicHint: /魔法/.test(hint)}
	})()`)
	check("⑰ 界面上不再有「参考音频」切换器（只剩单一预设源）", uiState.hasRefSelect === false, JSON.stringify(uiState))
	check("⑱ 按钮与提示写明联网下载 + 可能需要魔法", uiState.btn === true && uiState.netHint === true && uiState.magicHint === true, JSON.stringify(uiState))
	const goneAsset = await evalJs(`(() => { try { return window.NoriChat.readFile("assets/voice/nori-ref.wav") } catch (e) { return "err" } })()`)
	check("⑲ 前端不再引用包内音频文件（读不到才对）", !goneAsset || goneAsset === "err" || goneAsset === "", String(goneAsset).slice(0, 40))
	/* ================= B. 引导里的 Steam 愿望单 ================= */
	await evalJs(`localStorage.removeItem("intro_seen_v1")`)
	await send("Page.reload", {}, sessionId)
	await sleep(4300)
	await evalJs(FAKE)
	// 翻到最后一步
	for (let i = 0; i < 10; i += 1) {
		const done = await evalJs(`(() => { const b = [...document.querySelectorAll(".intro-btns button")].find(x => /开始使用/.test(x.textContent)); return !!b })()`)
		if (done) break
		await evalJs(`document.querySelector(".intro-btns .intro-next")?.click()`)
		await sleep(320)
	}
	const steamBtn = await evalJs(`(() => { const b = document.querySelector(".intro-steam"); return b ? b.textContent.trim() : null })()`)
	check("⑭ 引导最后一步有「加入 Steam 愿望单」", steamBtn !== null && /Steam/.test(steamBtn), String(steamBtn))
	await evalJs(`document.querySelector(".intro-steam")?.click()`)
	await sleep(400)
	const opened = await evalJs(`window.__opened || []`)
	check("⑮ 点击后走原生 openExternal 且 URL 正确", opened[0] === STEAM, JSON.stringify(opened))
	/* 项目仓库：与愿望单同款的一键跳转（2026-10-02 用户要求） */
	const repoBtn = await evalJs(`(() => { const b = document.querySelector(".intro-repo"); return b ? b.textContent.trim() : null })()`)
	check("⑳ 引导最后一步有「项目仓库」一键跳转按钮", repoBtn !== null && /仓库/.test(repoBtn), String(repoBtn))
	await evalJs(`document.querySelector(".intro-repo")?.click()`)
	await sleep(400)
	const opened2 = await evalJs(`window.__opened || []`)
	check("㉑ 点击后走原生 openExternal 且 URL = 公开仓库", opened2[1] === REPO, JSON.stringify(opened2))
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
}
