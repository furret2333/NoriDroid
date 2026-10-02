/* Phase 3a 探针: 读 Cubism Core 真实的部位/顶点几何。
 *
 * **只读诊断, 不做判定**。目的: 摸头现在只能判"实体/留白", 判不出"头"。
 * 网页版是用**部件**做的(getPartsBounds(["Part9"]) + skullTopBand 带), 要在安卓端复刻,
 * 得先确认: 这套 Core 给不给这些 API、部件名怎么读、部件盒与命中点是不是同一坐标系。
 *
 * 运行: node tmp-memcheck/probe-part-bounds.mjs [模型名]   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9401
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
const J = (v) => JSON.stringify(v)
const fx = (n) => (Number.isFinite(n) ? n.toFixed(3) : String(n))

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
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
	await sleep(1500)
	const card = await evalJs(`(() => {
		const c = [...document.querySelectorAll(".mc")].find(x => x.textContent.includes(${JSON.stringify(MODEL)}));
		if (!c) return "NO_CARD"; c.click(); return "CLICKED"
	})()`)
	await sleep(9000)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(600)
	console.log(`模型加载: ${card}\n`)

	const P = await evalJs(`window.__noriPartProbe ? window.__noriPartProbe() : {missing: true}`)
	if (P?.missing) { console.log("!! __noriPartProbe 不存在 —— 补丁没打进包"); }
	else if (!P?.ok) { console.log(`!! 探针抛错: ${P?.err}`) }
	else {
		console.log(`画布: ${J(P.canvas)}`)
		console.log(`ID 形态样本: ${J(P.idSample)}`)
		console.log(`partCount=${P.partCount}  drawableCount=${P.drawableCount}`)
		console.log(`可见性标记为 true 的 drawable 数: ${P.flagTrue}/${P.drawableCount}  样本: ${J(P.flagSample)}`)
		console.log(`前 6 个 drawable 名: ${J(P.drawableNames)}`)
		console.log(`全模型盒 allBox: ${J(P.allBox)} (高 ${fx(P.allBox.top - P.allBox.bottom)})`)
		console.log(`参数数: ${(P.params || []).length}`)
		console.log(`含 Angle/EyeBall/Body 的参数: ${J((P.params || []).filter((n) => /angle|eyeball|body/i.test(n)))}`)
		console.log(`面部相关参数 (eye/mouth/brow/cheek/hair/hand): ${J((P.params || []).filter((n) => /eye|mouth|brow|cheek|hair|hand|breath/i.test(n)))}`)
		const rows = (P.parts || []).map((p) => ({
			i: p.i, name: P.names ? P.names[p.i] : null, n: p.drawables,
			top: p.box.top, bottom: p.box.bottom, left: p.box.left, right: p.box.right,
		}))
		rows.sort((a, b) => b.top - a.top)
		console.log(`\n部件表(按 top 降序, 共 ${rows.length} 个):`)
		for (const r of rows) {
			console.log(`  #${String(r.i).padStart(2)}  ${String(r.name).padEnd(10)} y[${fx(r.bottom)}, ${fx(r.top)}] x[${fx(r.left)}, ${fx(r.right)}]  高=${fx(r.top - r.bottom)}  drawables=${r.n}`)
		}
	}

	/* 空间校验: __noriHitTest 判"命中"的点, 它的 __noriModelPoint 是否落在 allBox 里?
	   如果不在, 说明 transformView 与顶点不在同一坐标系, 后面还得另做换算。 */
	const space = await evalJs(`(() => {
		const onUI = (el) => !!(el && el.closest && el.closest(".sheet, .dock, .topbar, .pet-fab, .chat-panel, .touch-editor, .touch-top, .pomo-widget"))
		const hit = window.__noriHitTest, mp = window.__noriModelPoint
		if (typeof hit !== "function" || typeof mp !== "function") return {err: "钩子缺失"}
		let solid = null, blank = null
		for (let y = 60; y < window.innerHeight - 40 && !(solid && blank); y += 14) {
			for (let x = 16; x < window.innerWidth - 16 && !(solid && blank); x += 14) {
				if (onUI(document.elementFromPoint(x, y))) continue
				const r = hit(x, y)
				if (!r || r.err) continue
				if (r.hit) { if (!solid) solid = {x, y} } else if (!blank) blank = {x, y}
			}
		}
		return {solid, blank, solidPt: solid ? mp(solid.x, solid.y) : null, blankPt: blank ? mp(blank.x, blank.y) : null}
	})()`)
	console.log(`\n命中点: ${J(space.solid)} → 模型坐标 ${J(space.solidPt)}`)
	console.log(`留白点: ${J(space.blank)} → 模型坐标 ${J(space.blankPt)}`)

	/* 网页版摸头判定: 命中该部件 & y >= top - (top-bottom)*band */
	const testBand = async (name, band) => {
		const b = await evalJs(`window.__noriPartBounds ? window.__noriPartBounds([${J(name)}]) : {missing: true}`)
		let verdict = "部件没匹配到"
		if (b?.ok && b.box && space.solidPt && Number.isFinite(space.solidPt.y)) {
			const line = b.box.top - (b.box.top - b.box.bottom) * band
			verdict = `分界线 y=${fx(line)}  命中点 y=${fx(space.solidPt.y)} → ${space.solidPt.y >= line ? "在头带内" : "在头带外"}`
		}
		console.log(`__noriPartBounds([${J(name)}]): matched=${b?.matched} visible=${b?.visible} box=${J(b?.box)}  ${verdict}`)
	}
	console.log("")
	for (const nm of ["Part3", "Part61", "15"]) await testBand(nm, 0.6)
} catch (e) {
	console.log(`!! 执行异常: ${e?.message ?? e}`)
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
