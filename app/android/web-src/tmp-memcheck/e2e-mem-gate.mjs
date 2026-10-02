/* E2E: 记忆库入口的"害羞拦门" (2026-09-27 用户要求)。
 *
 * 用户要求: 点记忆库先弹气泡 + TTS 说「这样子看的话，nori 会害羞的。」,**点三下才进去**, 要有引导。
 *
 * 这个门禁守四件事 (每一条都对应一个真实会出问题的地方):
 *   ① 前两下**不进门**, 但要有气泡 + 引导文案 (告诉用户还差几下);
 *   ② 第三下才真的打开记忆库;
 *   ③ 计数会复位 (打开别的面板 → 归零; 否则"点两次+逛一圈+点一次"就进去了);
 *   ④ 朗读走三道闸: 正在生成/打字时**不打断** (与摸头台词同规矩)。
 *
 * 运行: node tmp-memcheck/e2e-mem-gate.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9410
const profile = mkdtempSync(join(tmpdir(), "nori-gate-"))
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
	const openSettings = async () => {
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		let ok = false
		for (let i = 0; i < 12 && !ok; i += 1) { await sleep(250); ok = await evalJs(`!!document.querySelector(".sheet .mem-enter")`) }
		return ok
	}
	const state = async () => evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const title = (document.querySelector(".sheet-title") || {}).innerText || ""
		// 小气泡(.touch-bubble, 与「记住了」同一套) 与 Nori 气泡(.ai-bubble) 分开取 —— 用户要求统一成小气泡
		return {
			panelTitle: title,
			hasMemList: !!sheet?.querySelector(".mem-search-input"),
			bubble: (document.querySelector(".touch-bubble") || {}).innerText || "",
			aiBubble: (document.querySelector(".ai-bubble") || {}).innerText || "",
			hasEnter: !!sheet?.querySelector(".mem-enter"),
			enterLabel: (sheet?.querySelector(".mem-enter") || {}).innerText || "",
		}
	})()`)

	/* 音效/TTS 桥: 记录被朗读的台词 (speakTTS 走桥 → 能看到有没有真的念) */
	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4300)
	await evalJs(`(() => {
		window.__spoken = [];
		const nc = window.NoriChat;
		if (nc) {
			// 记录任何 TTS 相关调用 (桥上的方法名由实现决定, 这里全量记)
			const orig = {};
			for (const k of Object.keys(nc)) {
				if (typeof nc[k] !== "function") continue;
				orig[k] = nc[k].bind(nc);
				nc[k] = (...a) => { if (/tts|speak|voice/i.test(k)) window.__spoken.push([k, String(a[a.length - 1] || "").slice(0, 60)]); return orig[k](...a) };
			}
		}
		return true
	})()`)

	check("设置页有记忆库入口按钮", await openSettings(), "没找到 .mem-enter")

	/* ① 第一下: 不进门 + 气泡引导 */
	await evalJs(`document.querySelector(".sheet .mem-enter").click()`)
	await sleep(700)
	const s1 = await state()
	console.log(`   第1下: ${JSON.stringify(s1)}`)
	check("第 1 下**不**打开记忆库", s1.hasMemList === false, JSON.stringify(s1))
	check("用的是小气泡 (.touch-bubble, 与「记住了」同一套), **不是** Nori 气泡",
		s1.bubble.includes("害羞") && s1.aiBubble.includes("害羞") === false, JSON.stringify(s1))
	check("第 1 下弹出气泡且带引导 (还差几下)", s1.bubble.includes("害羞") && /还差\s*2\s*下/.test(s1.bubble), s1.bubble)
	check("气泡文案与用户指定一致", s1.bubble.includes("这样子看的话，nori 会害羞的。"), s1.bubble)

	/* ② 第二下: 仍不进门, 引导变 1 */
	await evalJs(`document.querySelector(".sheet .mem-enter").click()`)
	await sleep(600)
	const s2 = await state()
	console.log(`   第2下: ${JSON.stringify(s2)}`)
	check("第 2 下仍不打开记忆库", s2.hasMemList === false, JSON.stringify(s2))
	check("引导更新为「还差 1 下」", /还差\s*1\s*下/.test(s2.bubble), s2.bubble)

	/* ③ 第三下: 真的进去 */
	await evalJs(`document.querySelector(".sheet .mem-enter").click()`)
	await sleep(800)
	const s3 = await state()
	console.log(`   第3下: ${JSON.stringify(s3)}`)
	check("第 3 下**才**打开记忆库 (看到记忆列表)", s3.hasMemList === true, JSON.stringify(s3))
	check("面板标题切到「记忆库」", s3.panelTitle.includes("记忆库"), s3.panelTitle)

	/* ④ 计数复位: 关掉面板 → 重点两下不该直接进 */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(600)
	await openSettings()
	await evalJs(`document.querySelector(".sheet .mem-enter").click()`)
	await sleep(500)
	await evalJs(`document.querySelector(".sheet .mem-enter").click()`)
	await sleep(500)
	const s4 = await state()
	check("计数已复位: 重开后点两下**仍不**进 (需要重新数三下)", s4.hasMemList === false, JSON.stringify(s4))

	/* ⑤ 逛别的面板也会复位 */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(500)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /日记/.test(x.textContent))?.click()`)
	await sleep(700)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(500)
	await openSettings()
	await evalJs(`document.querySelector(".sheet .mem-enter").click()`)
	await sleep(500)
	const s5 = await state()
	check("逛过别的面板后计数也归零 (点一下仍是第 1 下)",
		s5.hasMemList === false && /还差\s*2\s*下/.test(s5.bubble), JSON.stringify(s5))

	/* ⑥ 兜底: 4 秒不点自动归零 (防"点两次、过一会点一次"直接进)。
	 * 注意: 每步先确认面板与入口还在 —— 否则 `.mem-enter` 取到 null 会直接抛错,
	 * 报出来的却是"探针异常", 让人以为是产品坏了 (第一次就这么误导了我)。 */
	const tapEnter = async () => {
		const ok = await evalJs(`(() => { const b = document.querySelector(".sheet .mem-enter"); if (!b) return false; b.click(); return true })()`)
		if (!ok) throw new Error("入口按钮不在了 (面板被关了?)")
	}
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(500)
	check("准备第 6 项: 重新打开设置", await openSettings(), "设置没打开")
	await tapEnter()
	await sleep(300)
	await tapEnter()
	await sleep(300)
	const beforeIdle = await state()
	await sleep(4200)   // 超过 MEM_ENTRY_LEAVE_MS
	check("闲置前仍是第 2 下 (不算进)", beforeIdle.hasMemList === false && /还差\s*1\s*下/.test(beforeIdle.bubble), JSON.stringify(beforeIdle))
	await tapEnter()
	await sleep(600)
	const s6 = await state()
	check("闲置 4 秒后计数自动归零 (那一下变成第 1 下)",
		s6.hasMemList === false && /还差\s*2\s*下/.test(s6.bubble), JSON.stringify(s6))

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
