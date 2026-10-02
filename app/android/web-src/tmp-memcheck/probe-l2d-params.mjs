/* 诊断: 问出某个模型**实际有哪些可驱动的参数** (ParamXxx)。
 *
 * 为什么需要: 反馈强度只能靠"表情 / 动作 / 参数"三样里有的东西来堆。
 * 表情和动作可以读 model3.json 拿到, 但**参数只能问运行中的模型** ——
 * 补丁暴露了 `window.__noriHasParam(id)`, 于是可以逐个候选名探测。
 *
 * 运行: node tmp-memcheck/probe-l2d-params.mjs [模型id]   (需 harness 在 8123, 默认 ARGNori)
 * 注意: 这是**只读探针**, 不改任何状态。
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9388
const profile = mkdtempSync(join(tmpdir(), "nori-probe-"))
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

/** 候选参数名: Cubism 官方标准名 + 常见自定义名 + Param1..Param120 兜底 */
const CANDIDATES = [
	// 角度/身体
	"ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ",
	"ParamBreath", "ParamShadowOpacity",
	// 眼
	"ParamEyeLOpen", "ParamEyeROpen", "ParamEyeLSmile", "ParamEyeRSmile", "ParamEyeBallX", "ParamEyeBallY",
	"ParamEyeBallForm", "ParamEyeLForm", "ParamEyeRForm", "ParamEyeForm", "ParamTear", "ParamTearData",
	// 眉
	"ParamBrowLY", "ParamBrowRY", "ParamBrowLX", "ParamBrowRX", "ParamBrowLAngle", "ParamBrowRAngle",
	"ParamBrowLForm", "ParamBrowRForm",
	// 口
	"ParamMouthOpenY", "ParamMouthForm", "ParamMouthUp", "ParamMouthDown", "ParamMouthX",
	// 脸颊/情绪
	"ParamCheek", "ParamCheek1", "ParamCheek2", "ParamBlush", "ParamShy", "ParamAngry", "ParamSad",
	// 手/臂
	"ParamArmLA", "ParamArmRA", "ParamArmLB", "ParamArmRB", "ParamHandL", "ParamHandR",
	// 头发/配件
	"ParamHairFront", "ParamHairSide", "ParamHairBack", "ParamHairAhoge", "ParamRibbon",
	// 通用兜底
	...Array.from({length: 120}, (_, i) => `Param${i + 1}`),
]

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

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4000)

	/* 打开模型面板并点选目标模型 */
	const opened = await evalJs(`(() => {
		const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "选择模型");
		if (b) { b.click(); return "选择模型" }
		const b2 = [...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent));
		if (b2) { b2.click(); return "fab" }
		return "NO"
	})()`)
	await sleep(1500)
	const card = await evalJs(`(() => {
		const c = [...document.querySelectorAll(".mc")].find(x => x.textContent.includes(${JSON.stringify(MODEL)}));
		if (!c) return "NO_CARD";
		c.click(); return "CLICKED"
	})()`)
	console.log(`面板入口=${opened}  卡片=${card}  等待模型加载…`)
	await sleep(9000)

	const ready = await evalJs(`typeof window.__noriHasParam === "function"`)
	console.log(`__noriHasParam 可用: ${ready}`)
	if (!ready) { console.log("模型没加载起来或补丁未生效, 无法探测"); process.exit(1) }

	/* 先做**可信度自检**: 拿几个绝不可能存在的 id 去问。
	   若这些也返回 true, 说明该钩子恒真 (Cubism 的 getParameterIndex 找不到时会自动新增参数),
	   那么"探测参数是否存在"这条路走不通, 必须让补丁暴露 getParameterIds()。 */
	const bogus = await evalJs(`(() => {
		const ids = ["ParamThisIsNotReal", "hello_world", "ParamZZZ999", "not_a_param_at_all"]
		return ids.map(i => ({id: i, has: (() => { try { return window.__noriHasParam(i) } catch { return "throw" } })()}))
	})()`)
	const bogusTrue = bogus.filter(b => b.has === true).length
	console.log(`\n-- 可信度自检 (拿 4 个绝不可能存在的 id 去问) --`)
	for (const b of bogus) console.log(`  ${b.id} -> ${b.has}`)
	console.log(`  判定: ${bogusTrue > 0 ? "★ 钩子恒真, 无法用来判断参数是否存在" : "钩子可用"}`)

	const found = await evalJs(`(() => {
		const out = []
		for (const p of ${JSON.stringify(CANDIDATES)}) { try { if (window.__noriHasParam(p)) out.push(p) } catch {} }
		return out
	})()`)

	console.log(`\n===== ${MODEL} 探测结果 =====`)
	if (bogusTrue > 0) {
		console.log("  钩子恒真 → 上面这份命中列表**没有意义**, 不能据此断定模型有这些参数。")
		console.log("  要拿到真实参数表, 需要让 patch-live2d 暴露 `window.__noriParamIds = () => this._model.getParameterIds()`")
		console.log(`  (库里确实有 getParameterIds(), 见 live2dEasyControl.js 的 CubismModel 定义)`)
	} else {
		console.log(`命中候选: ${found.length} 个`)
		for (const p of found) console.log(`  ${p}`)
	}
} catch (e) {
	console.log("探针失败:", String(e?.message ?? e))
	process.exitCode = 1
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
