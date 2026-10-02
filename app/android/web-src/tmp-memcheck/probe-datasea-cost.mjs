/* 探针: 数据海背景到底吃多少 CPU (背景开 vs 关)。
 *
 * 用 CDP Performance.getMetrics 量 TaskDuration / ScriptDuration 在固定窗口内的增量,
 * 得到 **CPU 忙占比** —— 这是"性能消耗大不大"里**能在这里量**的那部分。
 * 量不到的（必须实机）: GPU 占用、发热、每小时耗电 %。
 * 注意: headless Edge 很可能没有真 GPU(走 SwiftShader), 所以 Canvas2D 的绝对开销
 *       会比真机偏高 —— 因此只看**开/关的相对差**, 不看绝对值。
 *
 * 运行: node tmp-memcheck/probe-datasea-cost.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9407
const profile = mkdtempSync(join(tmpdir(), "nori-perf-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
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

const KEYS = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "JSHeapUsedSize"]
const readMetrics = async (sessionId) => {
	const r = await send("Performance.getMetrics", {}, sessionId)
	const m = {}
	for (const it of r.metrics || []) if (KEYS.includes(it.name)) m[it.name] = it.value
	return m
}
const diff = (a, b) => {
	const o = {}
	for (const k of KEYS) o[k] = (b[k] ?? 0) - (a[k] ?? 0)
	return o
}

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
	await send("Performance.enable", {}, sessionId)
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4000)

	const setBg = async (on) => {
		const now = await evalJs(`(() => { const cb = [...document.querySelectorAll("input[type=checkbox]")].find((c) => { const r = c.closest(".settings-row"); return r && /动态背景/.test(r.textContent || "") }); return cb ? {found: true, checked: cb.checked} : {found: false} })()`)
		if (!now.found) return {found: false}
		if (now.checked !== on) {
			await evalJs(`[...document.querySelectorAll("input[type=checkbox]")].find((c) => { const r = c.closest(".settings-row"); return r && /动态背景/.test(r.textContent || "") }).click()`)
			await sleep(300)
		}
		return {found: true, checked: (await evalJs(`(() => { const cb = [...document.querySelectorAll("input[type=checkbox]")].find((c) => { const r = c.closest(".settings-row"); return r && /动态背景/.test(r.textContent || "") }); return cb.checked })()`))}
	}

	/* 需要先打开设置面板才能勾选 */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(800)
	const WINDOW_MS = 6000

	const measure = async (label, on) => {
		const st = await setBg(on)
		if (!st.found) { console.log(`!! 找不到「动态背景」勾选框 (${label})`); return null }
		await sleep(600)   // 让状态稳定
		const a = await readMetrics(sessionId)
		const t0 = Date.now()
		await sleep(WINDOW_MS)
		const b = await readMetrics(sessionId)
		const wall = (Date.now() - t0) / 1000
		const d = diff(a, b)
		const task = (d.TaskDuration / wall) * 100
		const script = (d.ScriptDuration / wall) * 100
		console.log(`[${label}] 背景=${st.checked ? "开" : "关"}  窗口 ${wall.toFixed(1)}s`)
		console.log(`   CPU 忙占比(TaskDuration/墙上时间) = ${task.toFixed(1)}%`)
		console.log(`   其中 JS(ScriptDuration)            = ${script.toFixed(1)}%`)
		console.log(`   布局/样式 = ${((d.LayoutDuration + d.RecalcStyleDuration) / wall * 100).toFixed(2)}%   JS 堆 = ${(d.JSHeapUsedSize / 1048576).toFixed(1)}MB(增量)`)
		return {task, script}
	}

	const on1 = await measure("A 未加载模型", true)
	const off = await measure("B 未加载模型", false)
	/* 再加载模型, 看"背景在 Live2D 之外的额外开销" */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(600)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
	await sleep(1500)
	await evalJs(`(() => { const c = [...document.querySelectorAll(".mc")].find(x => x.textContent.includes(${JSON.stringify(MODEL)})); if (c) c.click() })()`)
	await sleep(9000)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(1000)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(800)
	const on2 = await measure("C 已加载模型", true)
	const off2 = await measure("D 已加载模型", false)

	console.log("")
	if (on1 && off && on2 && off2) {
		console.log(`【隔离出来的背景开销 = A − B】(无 Live2D 干扰)`)
		console.log(`  CPU 忙占比: ${on1.task.toFixed(1)}% (开) − ${off.task.toFixed(1)}% (关) = ${(on1.task - off.task).toFixed(1)} 个百分点`)
		console.log(`  JS 占比  : ${on1.script.toFixed(1)}% (开) − ${off.script.toFixed(1)}% (关) = ${(on1.script - off.script).toFixed(1)} 个百分点`)
		console.log(`\n【有 Live2D 时背景的额外开销 = C − D】`)
		console.log(`  CPU 忙占比: ${on2.task.toFixed(1)}% (开) − ${off2.task.toFixed(1)}% (关) = ${(on2.task - off2.task).toFixed(1)} 个百分点`)
		console.log(`\n【Live2D 本身的量级 = C − A】(同 bg 开)`)
		console.log(`  CPU 忙占比: ${on2.task.toFixed(1)}% − ${on1.task.toFixed(1)}% = ${(on2.task - on1.task).toFixed(1)} 个百分点`)
		console.log(`\n注: headless 很可能无真 GPU(走 SwiftShader), Canvas2D/Live2D 的绝对开销都比真机偏高;`)
		console.log(`    这里只应看**差值**, 不能把百分比当实机耗电。GPU/发热/耗电必须实机量。`)
	}
	console.log(`\n场景: 视口 520x900; A/B 为未加载模型, C/D 为已加载 ${MODEL}`)
} catch (e) {
	console.log(`!! 探针异常: ${e?.message ?? e}`)
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
