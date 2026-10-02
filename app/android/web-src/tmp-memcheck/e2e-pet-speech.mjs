/* E2E: 摸头台词 (TTS) 的真实浏览器验证。
 *
 * ## 客观证据在哪
 * 不看我们自己的变量（那是自证），而是看**交给 TTS 桥的文本**：
 * harness 的假桥 (`.harness/server.mjs` 的 `cosyTtsStream`) 会把最后一次请求记进
 * `window.__noriCosyLast` 再回一个显式错误 —— 于是"到底说了哪一句"是可以逐字读回来的，
 * 且**不会真的出声、不联网、不花 token**。
 * 所以本套用 `?seed=` 把设置预置成"千问 + 假 Key + 一个音色"，让 `isTtsReady(cfg)` 为真。
 *
 * ## 覆盖的接线行为（逐帧时序由门禁 `run-pet-speech-tests.mjs` 的 52 条精确断言守着）
 *   - 摸到头 → 真的向 TTS 桥发了**一句台词表里的话**
 *   - 气泡用的是 AI 那套 `.ai-bubble`（自带 `● Nori` 说话人标签）→ "像她亲口说的"
 *   - 气泡里的字 == 桥收到的字（屏幕上写的 = 嘴里说的）
 *   - **10s 内只说一次**（第 2 次摸头不产生新请求，且气泡不被重播）
 *   - 假桥必然失败 ⇒ 没有 audio playing ⇒ 气泡靠 **7s 兜底**收掉（不会永远挂着）
 *   - 摸**身体**不触发（放在窗口过期后才测 ⇒ 排除"其实是被 10s 窗口挡下"的假通过）
 *   - 窗口过期后再摸 → 新的一句，且与上一句不同（洗牌袋用真随机也成立）
 *   - 聊天面板开着 → 只出声、**不弹气泡**（否则 z58 的气泡会盖在 z12 的面板上）
 *
 * 运行: node tmp-memcheck/e2e-pet-speech.mjs [模型名]   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9398
const profile = mkdtempSync(join(tmpdir(), "nori-petspeech-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 台词表（与 `src/services/live2d/petSpeech.ts` 的 `PET_LINES` 一致；门禁会逐字对拍） */
const LINES = [
	"头发都被你揉乱啦。",
	"再摸就要收费啦。",
	"Nori不是小狗啦。",
	"为什么摸我的头呀。",
	"你摸Nori，Nori也不会掉毛的。",
	"好乖…啊，说反了，是你在摸我。",
	"只有Nori有摸头待遇吗？",
	"嘿嘿，摸摸头很舒服，感觉芯片都要开心得发热了。",
	"这算是表扬吗？那我记下来了。",
	"被摸头…有点想睡了。",
]

/** 预置设置：让 `isTtsReady(cfg)` 为真（千问 + 假 Key + 一个音色名） */
const SEED = {
	ttsEnabled: true,
	ttsProvider: "cosyvoice",
	cosyApiKey: "sk-fake-for-test",
	cosyModel: "cosyvoice-v3-flash",
	cosyVoice: "cosyvoice-v3-flash-myvoice-ab12cd",
	cosyCloneVoices: [{id: "cosyvoice-v3-flash-myvoice-ab12cd", model: "cosyvoice-v3-flash"}],
}
const SEED_PARAM = Buffer.from(JSON.stringify(SEED), "utf8").toString("base64url")

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
const results = []
const check = (name, cond, detail = "") => {
	results.push({name, cond: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${detail}`}`)
}
/** 已知失败白名单：空着就是最好的状态（理由与规则见 e2e-pet-effect.mjs 顶部注释） */
const KNOWN_FAILS = []
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

const J = (v) => JSON.stringify(v)

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
	const press = (type, x, y) => `document.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {clientX: ${x}, clientY: ${y}, pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true}))`

	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${SEED_PARAM}`}, sessionId)
	await sleep(4000)

	/* 加载模型 */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
	await sleep(1500)
	const card = await evalJs(`(() => {
		const c = [...document.querySelectorAll(".mc")].find(x => x.textContent.includes(${JSON.stringify(MODEL)}));
		if (!c) return "NO_CARD"; c.click(); return "CLICKED"
	})()`)
	await sleep(9000)
	/* 关掉面板 —— onStagePointerDown 在 panel !== "" 时会直接 return, 摸头会被忽略 */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(600)
	check("模型已加载且面板已关闭 (摸头前提)", card === "CLICKED", String(card))

	/* TTS 就绪前提: 设置确实按 seed 生效（否则后面所有"没触发"都可能是"TTS 没开"造成的假通过） */
	const ttsReady = await evalJs(`(() => { const raw = window.NoriChat.readFile("settings.json"); const s = JSON.parse(raw); return {enabled: s.ttsEnabled, provider: s.ttsProvider, key: !!s.cosyApiKey} })()`)
	check("预置设置里 TTS 已启用且有千问 Key", ttsReady?.enabled === true && ttsReady?.provider === "cosyvoice" && ttsReady?.key === true, J(ttsReady))

	/* ---- 探针/读数 ---- */
	const dbgInfo = `(window.__noriPetDebug ? window.__noriPetDebug() : null)`
	const speechOf = (d) => d ? {count: d.petSpeechCount, last: d.petSpeechLast, waitMs: d.petSpeechWaitMs, onHead: d.onHead} : null
	const speechInfo = `(() => { const d = ${dbgInfo}; return d ? {count: d.petSpeechCount, last: d.petSpeechLast, waitMs: d.petSpeechWaitMs, onHead: d.onHead} : null })()`
	/** 假桥收到的最后一次请求（文本就是"嘴里说的字"） */
	const bridgeInfo = `(() => { const v = window.__noriCosyLast; return v ? {text: v.text, voice: v.voice} : null })()`
	const clearBridge = `window.__noriCosyLast = null; "ok"`
	/** 气泡: 用哪一套、说话人标签、显示的字 */
	const bubbleInfo = `(() => {
		const el = document.querySelector(".ai-bubble")
		if (!el) return {exists: false, head: "", text: "", touchBubble: !!(document.querySelector(".touch-bubble"))}
		const h = el.querySelector(".ai-bubble-head")
		const t = el.querySelector(".ai-bubble-txt")
		return {exists: true, head: h ? h.textContent.trim() : "", text: t ? t.textContent.trim() : "",
			touchBubble: !!(document.querySelector(".touch-bubble"))}
	})()`

	const probe0 = await evalJs(dbgInfo)
	check("探针已暴露摸头台词字段 (petSpeechCount/petSpeechLast/petSpeechWaitMs)",
		probe0 && probe0.petSpeechCount !== undefined && probe0.petSpeechWaitMs !== undefined, J(probe0))

	/* 扫点: 头(上) 与 身体(下) 各一个"四周都是实体"的点, 避开轮廓边缘的呼吸抖动 */
	const rescan = async (fromExpr, toExpr, step) => evalJs(`(() => {
		const onUI = (el) => !!(el && el.closest && el.closest(".sheet, .dock, .topbar, .pet-fab, .chat-panel, .touch-editor, .touch-top, .pomo-widget"))
		const hit = window.__noriHitTest
		const solidAt = (x, y) => { const r = hit(x, y); return !!r && !r.err && r.hit }
		const solidEnough = (x, y) => {
			if (!solidAt(x, y)) return false
			const d = 8
			return solidAt(x - d, y) && solidAt(x + d, y) && solidAt(x, y - d) && solidAt(x, y + d)
		}
		const from = ${fromExpr}, to = ${toExpr}, dir = from <= to ? 1 : -1
		for (let y = from; dir > 0 ? y <= to : y >= to; y += dir * ${step}) {
			for (let x = 16; x < window.innerWidth - 16; x += 10) {
				if (onUI(document.elementFromPoint(x, y))) continue
				if (solidEnough(x, y)) return {x, y}
			}
		}
		return null
	})()`)
	const headPt = await rescan(170, 240, 10)
	const bodyPt = await rescan("window.innerHeight - 40", 60, 14)
	check("能扫到摸头点与摸身体点", !!headPt && !!bodyPt, `${J(headPt)} / ${J(bodyPt)}`)

	const H = headPt || {x: 260, y: 210}
	const B = bodyPt || {x: 260, y: 700}
	/** 按住 ms 毫秒 (抚摸在 260ms 才开始, 台词与音效同源) */
	const petHold = async (pt, ms) => {
		await evalJs(press("pointerdown", pt.x, pt.y))
		await sleep(ms)
		await evalJs(press("pointerup", pt.x, pt.y))
	}

	/* ============ A. 摸头 → 说一句 ============ */
	await evalJs(clearBridge)
	await evalJs(press("pointerdown", H.x, H.y))
	await sleep(900)
	const aBridge = await evalJs(bridgeInfo)
	const aBubble = await evalJs(bubbleInfo)
	const aSpeech = await evalJs(speechInfo)
	console.log(`   [A] 摸头: 桥收到 ${J(aBridge?.text ?? null)} / 气泡 ${J(aBubble)}`)
	check("A: 摸头点确实被判为「头上」(后续断言的前提)", aSpeech?.onHead === true, J(aSpeech))
	check("A: 摸头时真的向 TTS 桥发了一句台词", typeof aBridge?.text === "string" && aBridge.text.length > 0, J(aBridge))
	check("A: 说的就是台词表里的某一句（逐字）", LINES.includes(aBridge?.text), J(aBridge?.text))
	check("A: 气泡用的是「Nori 说话」那套 (.ai-bubble + ● Nori 说话人标签)",
		aBubble?.exists === true && aBubble?.head === "Nori", J(aBubble))
	check("A: 气泡里的字 == 桥收到的字（屏幕上写的 = 嘴里说的）",
		aBubble?.text === aBridge?.text, `${J(aBubble?.text)} vs ${J(aBridge?.text)}`)
	check("A: 计数 = 1, 最后一句 = 刚说的那句",
		aSpeech?.count === 1 && aSpeech?.last === aBridge?.text, J(aSpeech))
	await evalJs(press("pointerup", H.x, H.y))
	await sleep(100)

	/* ============ B. 10s 窗口内再摸 → 不再说（且不重播气泡） ============ */
	await evalJs(clearBridge)
	await evalJs(press("pointerdown", H.x, H.y))
	await sleep(900)
	const bBridge = await evalJs(bridgeInfo)
	const bBubble = await evalJs(bubbleInfo)
	const bSpeech = await evalJs(speechInfo)
	check("B: 10s 窗口内再摸头**不产生新的 TTS 请求**", bBridge === null, J(bBridge))
	check("B: 计数仍是 1", bSpeech?.count === 1, J(bSpeech))
	check("B: 最后一句没变", bSpeech?.last === aBridge?.text, J(bSpeech))
	check("B: 气泡保持原样（没有被重播/没有变成第二句）",
		bBubble?.exists === true && bBubble?.text === aBridge?.text, J(bBubble))
	await evalJs(press("pointerup", H.x, H.y))
	await sleep(100)

	/* ============ C. 无声(TTS 失败)时的气泡兜底: 7s 后收掉, 不能永远挂着 ============ */
	/* 假桥必然回错 ⇒ audio 永远不 playing ⇒ "说完即收"不会发生, 只能靠兜底。 */
	await sleep(5600)   // 距第一次开口约 7.6s
	const cBubble = await evalJs(bubbleInfo)
	check("C: 没有 audio playing 时, 气泡在 7s 兜底后收掉", cBubble?.exists === false, J(cBubble))

	/* ============ D. 窗口已过期 → 摸**身体**不触发（此时才排除"被窗口挡下"的假通过） ============ */
	await sleep(3900)   // 距第一次开口 > 11s
	const dSpeech0 = await evalJs(speechInfo)
	check("D: 此时窗口已过期（waitMs = 0 —— 身体用例才有效力）", dSpeech0?.waitMs === 0, J(dSpeech0))
	await evalJs(clearBridge)
	await evalJs(press("pointerdown", B.x, B.y))
	await sleep(900)
	const dBridge = await evalJs(bridgeInfo)
	const dSpeech = await evalJs(speechInfo)
	console.log(`   [D] 摸身体: onHead=${dSpeech?.onHead} 桥=${J(dBridge?.text ?? null)} count=${dSpeech?.count}`)
	check("D: 摸身体判为「头外」", dSpeech?.onHead === false, J(dSpeech))
	check("D: 摸身体**不**产生 TTS 请求（窗口已过期, 排除假通过）", dBridge === null, J(dBridge))
	check("D: 摸身体不增加计数", dSpeech?.count === 1, J(dSpeech))
	await evalJs(press("pointerup", B.x, B.y))
	await sleep(100)

	/* ============ E. 窗口过期后再摸头 → 新的一句, 且与上一句不同 ============ */
	await evalJs(clearBridge)
	await evalJs(press("pointerdown", H.x, H.y))
	await sleep(900)
	const eBridge = await evalJs(bridgeInfo)
	const eBubble = await evalJs(bubbleInfo)
	const eSpeech = await evalJs(speechInfo)
	console.log(`   [E] 再摸头: ${J(eBridge?.text ?? null)}（上一句 ${J(aBridge?.text ?? null)}）`)
	check("E: 窗口过后再摸头又说一句", LINES.includes(eBridge?.text), J(eBridge))
	check("E: 这一句与上一句不同（洗牌袋：先说完 10 句才重复）", eBridge?.text !== aBridge?.text, `${J(aBridge?.text)} vs ${J(eBridge?.text)}`)
	check("E: 计数 = 2", eSpeech?.count === 2, J(eSpeech))
	check("E: 气泡又出现且显示新的一句", eBubble?.exists === true && eBubble?.text === eBridge?.text, J(eBubble))
	await evalJs(press("pointerup", H.x, H.y))
	await sleep(300)

	/* ============ F. 聊天面板开着 → 只出声、不弹气泡 ============ */
	/* 等窗口再次过期（否则 F 会因"窗口"而假通过） */
	await sleep(10200)
	await evalJs(`[...document.querySelectorAll(".fab")].find(b => b.textContent.trim() === "对话")?.click()`)
	await sleep(700)
	check("F: 聊天面板已打开", (await evalJs(`!!document.querySelector(".chat-panel")`)) === true)
	await evalJs(clearBridge)
	await evalJs(press("pointerdown", H.x, H.y))
	await sleep(900)
	const fBridge = await evalJs(bridgeInfo)
	const fBubble = await evalJs(bubbleInfo)
	const fSpeech = await evalJs(speechInfo)
	console.log(`   [F] 聊天面板开着摸头: ${J(fBridge?.text ?? null)} / 气泡 exists=${fBubble?.exists}`)
	check("F: 聊天面板开着也照样出声（发到桥）", LINES.includes(fBridge?.text), J(fBridge))
	check("F: 计数 = 3", fSpeech?.count === 3, J(fSpeech))
	check("F: **不弹气泡**（.ai-bubble 不存在, 不会盖在面板上）", fBubble?.exists === false, J(fBubble))
	await evalJs(press("pointerup", H.x, H.y))
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const failed = results.filter((r) => !r.cond)
	const isKnown = (r) => KNOWN_FAILS.some((k) => r.name.includes(k.match))
	const known = failed.filter(isKnown)
	const unknown = failed.filter((r) => !isKnown(r))
	const stale = KNOWN_FAILS.filter((k) => !results.some((r) => r.name.includes(k.match) && !r.cond))
	const passed = results.length - failed.length
	console.log(`\n${passed}/${results.length} passed` + (known.length ? `  （含 ${known.length} 条白名单内的已知失败）` : ""))
	if (known.length) {
		console.log("已知失败（预期内，不算回归）:")
		for (const k of KNOWN_FAILS) console.log(`  · ${k.match}\n    └ ${k.why}`)
	}
	if (unknown.length) {
		console.log(`❗未知失败 ${unknown.length} 条（**这才是回归**）:`)
		for (const r of unknown) console.log(`  · ${r.name}`)
	}
	if (stale.length) {
		console.log(`⚠ 白名单已过期: ${stale.map((k) => k.match).join(" / ")} 现在**通过**了 —— 请从 KNOWN_FAILS 里删掉该条目`)
	}
	if (unknown.length || stale.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
