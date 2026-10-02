/* 摸头"低头"诊断 ②—— **通道组合复核 + 截图**（只读诊断，不改产品代码）
 *
 * ⚠ 本探针对应的功能（摸头"低头"）**已被用户永久删除**（2026-09-24，原因是"头部角度跳变"）。
 *   探针仍可用，留着是为了"以后想捡回来时不用重写"。
 *
 * 前一步（probe-bow-params.mjs）已实测：
 *   - 噪声门槛 0.0040（待机动作自己会抖）
 *   - **单个参数**把头顶压低的上限约 -0.018 模型单位（ParamBodyAngleY -10 / ParamAngleYYDown +10 /
 *     ParamAngleY -30 都在 -0.012 ~ -0.018），**都到不了 E2E 用例 D 要求的 0.02**
 *   - `最大部件位移` 这个指标被物理摆动的部件（Part67 常见 0.30）污染，**不可用作判据**
 *   ⇒ 结论：必须把多条通道**叠加**。本脚本就是去量"叠加到底能压多少"，并留截图供肉眼判断。
 *
 * E2E 用例 D 的口径（`e2e-pet-effect.mjs:431`）：`delta = (Part3.top − allBox.bottom) 不低头 − 低头 > 0.02`
 *
 * 写入时机：补丁钩子 `__noriBeforeModelUpdate`（顶点计算之前），链式包装，不覆盖 App 的 petBow。
 *
 * 运行: node tmp-memcheck/probe-bow-combos.mjs [模型名]   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9403
const SHOT_DIR = "D:/norios/tmp-webarch-audit/bow-shots"
const APPLY_MS = 420
const CLEAR_MS = 260

/* 候选通道：单参数用上一步实测出的最优方向；再逐条叠加 */
const COMBOS = [
	{tag: "00-基线", ps: []},
	{tag: "01-现状-AngleY-12.5", ps: [["ParamAngleY", -12.5]]},
	{tag: "02-AngleY-30", ps: [["ParamAngleY", -30]]},
	{tag: "03-BodyAngleY-10", ps: [["ParamBodyAngleY", -10]]},
	{tag: "04-BodyAngleY-10_YYDown+10", ps: [["ParamBodyAngleY", -10], ["ParamBodyAngleYYDown", 10]]},
	{tag: "05-04+YYDown7-10", ps: [["ParamBodyAngleY", -10], ["ParamBodyAngleYYDown", 10], ["ParamBodyAngleYYDown7", -10]]},
	{tag: "06-05+AngleY-12.5", ps: [["ParamBodyAngleY", -10], ["ParamBodyAngleYYDown", 10], ["ParamBodyAngleYYDown7", -10], ["ParamAngleY", -12.5]]},
	{tag: "07-05+AngleY-30", ps: [["ParamBodyAngleY", -10], ["ParamBodyAngleYYDown", 10], ["ParamBodyAngleYYDown7", -10], ["ParamAngleY", -30]]},
	{tag: "08-AngleY-30_YYDown+10_YYDown7-10", ps: [["ParamAngleY", -30], ["ParamBodyAngleYYDown", 10], ["ParamBodyAngleYYDown7", -10]]},
	{tag: "09-05+BodyAngleZ-10", ps: [["ParamBodyAngleY", -10], ["ParamBodyAngleYYDown", 10], ["ParamBodyAngleYYDown7", -10], ["ParamBodyAngleZ", -10]]},
]

mkdirSync(SHOT_DIR, {recursive: true})
const profile = mkdtempSync(join(tmpdir(), "nori-combo-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fx = (n) => (Number.isFinite(n) ? (n >= 0 ? " " : "") + n.toFixed(4) : String(n))

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
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

/** 多参数版本：每帧把整个列表相加一次（相加，不覆盖库写的值） */
const HELPERS = `(() => {
  window.__pbGeom = () => {
    const m = window.__noriPartProbe ? window.__noriPartProbe() : null
    if (!m || !m.ok) return {err: (m && m.err) || "no __noriPartProbe"}
    const names = m.names || [], parts = m.parts || []
    const byName = (nm) => { const i = names.indexOf(nm); if (i < 0) return null; const p = parts.find((x) => x.i === i); return p ? p.box : null }
    return {part3: byName("Part3"), part61: byName("Part61"), allBox: m.allBox,
            head: byName("Part3")}
  }
  window.__pbSetMany = (list) => { window.__probeAddList = (list || []).map(([id, v]) => ({id, v})); window.__pbApplied = 0 }
  window.__pbApplied = 0
  window.__probeAddList = []
  const hook = () => {
    const L = window.__probeAddList
    if (!L || !L.length || typeof window.__noriAddParam !== "function") return
    for (const a of L) window.__noriAddParam(a.id, a.v)
    window.__pbApplied += 1 }
  // 正规入口（槽位不可写, 直接赋值会抛错）；老产物没有它就退回链式包装
  if (typeof window.__noriRegisterBeforeUpdate === "function") window.__noriRegisterBeforeUpdate(hook)
  else { const prev = window.__noriBeforeModelUpdate; window.__noriBeforeModelUpdate = () => { try { if (typeof prev === "function") prev() } catch (e) {} hook() } }
  return "helpers-ok"
})()`

const metric = (g) => ({
	// 与 E2E 用例 D 完全同口径
	rel: g.part3 && g.allBox ? g.part3.top - g.allBox.bottom : null,
	headTop: g.part3 ? g.part3.top : null,
	headBottom: g.part3 ? g.part3.bottom : null,
	modelTop: g.allBox ? g.allBox.top : null,
	modelBottom: g.allBox ? g.allBox.bottom : null,
	p61Top: g.part61 ? g.part61.top : null,
	p61Bottom: g.part61 ? g.part61.bottom : null,
})

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
	const shot = async (tag) => {
		const clip = {x: 90, y: 40, width: 340, height: 380, scale: 2}
		const r = await send("Page.captureScreenshot", {format: "png", clip, captureBeyondViewport: false}, sessionId)
		const p = join(SHOT_DIR, `${tag}.png`)
		writeFileSync(p, Buffer.from(r.data, "base64"))
		return p
	}

	/* 挂模型 */
	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4000)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
	await sleep(1500)
	const card = await evalJs(`(() => { const c = [...document.querySelectorAll(".mc")].find(x => x.textContent.includes(${JSON.stringify(MODEL)})); if (!c) return "NO_CARD"; c.click(); return "CLICKED" })()`)
	await sleep(9000)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(900)
	console.log(`模型加载: ${card}`)
	if (card === "NO_CARD") throw new Error("卡没找到 —— harness 没在跑?")

	const ok = await evalJs(HELPERS)
	if (ok !== "helpers-ok") throw new Error("页内辅助装载失败: " + ok)
	console.log("钩子链式包装完成（不覆盖 App 的 petBow）\n")

	const out = []
	console.log("序号                        推值组合                                       Δrel(头-脚)   ΔheadTop   ΔheadBot   ΔmodelTop  施加 截图")
	for (const c of COMBOS) {
		await evalJs(`window.__pbSetMany(${JSON.stringify(c.ps)})`)
		await sleep(APPLY_MS)
		const g = await evalJs("window.__pbGeom()")
		const applied = await evalJs("window.__pbApplied")
		const m = metric(g)
		const p = await shot(c.tag)
		await evalJs("window.__pbSetMany([])")
		await sleep(CLEAR_MS)
		out.push({tag: c.tag, ps: c.ps, ...m, applied, shot: p})
	}
	/* 基线是第一条，位移都相对它算 */
	const b = out[0]
	console.log()
	for (const r of out) {
		const d = {rel: r.rel - b.rel, headTop: r.headTop - b.headTop, headBottom: r.headBottom - b.headBottom, modelTop: r.modelTop - b.modelTop}
		const psTxt = r.ps.length ? r.ps.map(([k, v]) => `${k.replace(/^Param/, "")}=${v}`).join(" ") : "（不推）"
		console.log(`${r.tag.padEnd(38)} ${psTxt.padEnd(62)} ${fx(d.rel).padStart(10)} ${fx(d.headTop).padStart(10)} ${fx(d.headBottom).padStart(10)} ${fx(d.modelTop).padStart(11)} ${String(r.applied).padStart(4)} ${r.shot.split(/[\\/]/).pop()}`)
	}
	/* 平移 vs 转动：头顶与头底是否同步下沉 */
	console.log("\n平移 / 转动判读（ΔheadTop 与 ΔheadBottom 越接近 ⇒ 越是整体下沉=平移，越不像转动）：")
	for (const r of out) {
		const dt = r.headTop - b.headTop, db = r.headBottom - b.headBottom
		if (!Number.isFinite(dt)) continue
		console.log(`   ${r.tag.padEnd(38)} Δtop=${fx(dt)} Δbot=${fx(db)} 差=${fx(dt - db)}  ⇒ ${Math.abs(dt - db) < Math.abs(dt) * 0.45 ? "接近平移（头整体下沉，眼珠方向相对头不变 ⇒ 无需补偿）" : "含明显转动（头在俯仰 ⇒ 眼珠需要反向补偿）"}`)
	}
	const pass = out.filter((r) => Number.isFinite(r.rel) && (b.rel - r.rel) > 0.02)
	console.log(`\n达到 E2E 用例 D 阈值(>0.02)的组合: ${pass.length ? pass.map((r) => r.tag).join(" / ") : "无"}`)
	writeFileSync(join(SHOT_DIR, "summary.json"), JSON.stringify({model: MODEL, base: b, rows: out}, null, 1))
	console.log(`截图与数据: ${SHOT_DIR}`)
} catch (e) {
	console.log(`!! 执行异常: ${e?.message ?? e}`)
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
