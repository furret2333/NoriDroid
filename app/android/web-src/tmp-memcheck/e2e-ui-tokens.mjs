/* UI token 化后的**可见性验证**: 断言 token 真的解析成了颜色 (而不是 var() 落空 → 颜色异常)。
 * 这是"改样式"最容易踩的坑: token 没定义时浏览器会**静默丢弃**该声明, 页面看起来只是"变丑了",
 * 不会报错、不会红。所以必须读 computedStyle 核对具体色值。
 *
 * 运行: node tmp-memcheck/e2e-ui-tokens.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9407
const profile = mkdtempSync(join(tmpdir(), "nori-ui-"))
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

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4200)

	/* ① token 变量本身要能解析出具体颜色 */
	const tokens = await evalJs(`(() => {
		const root = document.querySelector(".stage-root")
		if (!root) return {err: "没有 .stage-root"}
		const cs = getComputedStyle(root)
		const names = ["--surface","--surface-raise","--line-strong","--line","--line-soft","--fg","--fg-2","--fg-3","--fg-dim","--accent","--accent-strong"]
		const out = {}
		for (const n of names) out[n] = cs.getPropertyValue(n).trim()
		return out
	})()`)
	console.log(`   token: ${JSON.stringify(tokens)}`)
	const empty = Object.entries(tokens).filter(([, v]) => !v).map(([k]) => k)
	check(`所有 token 都有定义 (${Object.keys(tokens).length} 个)`, empty.length === 0, `空: ${JSON.stringify(empty)}`)
	check("token 值是颜色而不是 var() 字面量",
		Object.values(tokens).every(v => /^(#|rgba?\()/.test(String(v))), JSON.stringify(tokens))

	/* ② 具体元素真的用上了 token (computedStyle 应等于 token 的解析值)。
	 * 注意: token 是 #hex、computedStyle 是 rgb(...) —— 必须先归一化成同一个形式再比,
	 * 直接比字符串会假红 (我第一次就踩了)。 */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	const applied = await evalJs(`(() => {
		const root = document.querySelector(".stage-root")
		const rootCs = getComputedStyle(root)
		const tokRaw = (n) => rootCs.getPropertyValue(n).trim()
		// 用浏览器自己把任意颜色串解析成 rgb() (借一个临时元素), 避免手写 hex→rgb 换算出错
		const probe = document.createElement("span")
		document.body.appendChild(probe)
		const toRgb = (v) => { probe.style.color = ""; probe.style.color = v; return getComputedStyle(probe).color }
		const sheet = document.querySelector(".sheet")
		const title = document.querySelector(".sheet-title")
		const x = document.querySelector(".sheet .x")
		const out = {
			titleColor: title ? getComputedStyle(title).color : null,
			xColor: x ? getComputedStyle(x).color : null,
			sheetBg: sheet ? getComputedStyle(sheet).backgroundColor : null,
			sheetBorder: sheet ? getComputedStyle(sheet).borderTopColor : null,
		}
		for (const n of ["--fg","--fg-2","--surface","--line-strong"]) out["tok" + n] = toRgb(tokRaw(n))
		probe.remove()
		return out
	})()`)
	console.log(`   应用到元素: ${JSON.stringify(applied)}`)
	check("面板标题用了 --fg (归一化后与 token 一致)",
		applied.titleColor === applied["tok--fg"], `${applied.titleColor} vs ${applied["tok--fg"]}`)
	check("关闭按钮 ✕ 用了 --fg-2",
		applied.xColor === applied["tok--fg-2"], `${applied.xColor} vs ${applied["tok--fg-2"]}`)
	check("面板底色 == --surface",
		applied.sheetBg === applied["tok--surface"], `${applied.sheetBg} vs ${applied["tok--surface"]}`)
	check("面板描边 == --line-strong (证明 token 真的被使用, 不是回落到默认色)",
		applied.sheetBorder === applied["tok--line-strong"], `${applied.sheetBorder} vs ${applied["tok--line-strong"]}`)

	/* ③ 全页扫一遍: 不该有元素因为 var() 落空而"颜色为空" */
	const broken = await evalJs(`(() => {
		const bad = []
		for (const el of document.querySelectorAll(".sheet *, .dock *")) {
			const cs = getComputedStyle(el)
			// 落空的 var() 会让 color/border-color 回到默认 (rgb(0,0,0)); 文本元素黑字在深底上就是"看不见"
			if (cs.color === "rgb(0, 0, 0)" && el.textContent && el.textContent.trim()) bad.push(el.className || el.tagName)
			if (bad.length > 8) break
		}
		return bad
	})()`)
	check("面板/底栏里没有\"文字变黑(变量落空)\"的元素", broken.length === 0, JSON.stringify(broken))

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
