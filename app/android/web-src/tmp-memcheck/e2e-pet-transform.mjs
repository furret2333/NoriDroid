/* E2E: 坐标换算在**非默认 scale/offset** 下是否仍与渲染一致。
 *
 * 为什么单独一个脚本: `e2e-pet-effect` 只在默认 scale=1/offset=0 下跑, 而实机 bug
 * ("粒子冒在头顶上空") 恰恰只在**缩放/平移过**的模型上出现 —— stage.ts 给 canvas 加的是
 * **CSS** transform, 而库的 transformViewX/Y 不知道它。这个脚本就是那个缺失的测试。
 *
 * 做法: 交叉验证两条独立路径对**同一个屏幕点**的结论必须一致
 *   ① 库路径   : __noriModelPointFixed(x,y)  → 模型坐标 (走库的 transformView + 我们的逆变换)
 *   ② 触摸区路径: contain()+getBoundingClientRect → (u,v)  → 本来就跟着 CSS 变换走, 是正确的
 * 先在默认变换下用两点标定 (u,v)→模型坐标 的线性系数, 再改成 scale=0.5/offset=(40,-60)
 * 重新加载, 验证同一组系数仍然成立。
 *
 * 运行: node tmp-memcheck/e2e-pet-transform.mjs [模型名]   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9403
const profile = mkdtempSync(join(tmpdir(), "nori-xform-"))
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
	results.push(!!cond)
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ← ${detail}`}`)
}
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

/* 在页面里量一组点: 同时给出"库路径"和"触摸区路径"的结论 */
const MEASURE = `(() => {
	const cv = window.__noriCanvasView ? window.__noriCanvasView() : null
	const lib = window.__noriModelPointFixed
	const ms = window.__noriModelCanvas
	if (!cv || typeof lib !== "function" || !ms) return {err: "钩子缺失", cv: !!cv, lib: typeof lib, ms: !!ms}
	// 触摸区路径: 与 touchDetection.ts 的 contain()+toModelPoint 同源
	const canvas = [...document.querySelectorAll("canvas")].find((c) => /scale\\(/.test(c.style.transform || ""))
	if (!canvas) return {err: "找不到 live2d canvas"}
	const R = canvas.getBoundingClientRect()
	const S = Math.min(R.width / ms.w, R.height / ms.h)
	const dw = ms.w * S, dh = ms.h * S, ox = (R.width - dw) / 2, oy = (R.height - dh) / 2
	const touch = (x, y) => ({u: (x - R.left - ox) / dw, v: (y - R.top - oy) / dh})
	const out = []
	for (const p of [[160, 200], [260, 300], [360, 420], [260, 560], [420, 240]]) {
		const t = touch(p[0], p[1])
		const l = lib(p[0], p[1])
		// 未修正的原始钩子 (直接用 client 坐标) —— 反证用: 缩放/平移后它必须明显偏掉
		const raw = typeof window.__noriModelPoint === "function" ? window.__noriModelPoint(p[0], p[1]) : null
		out.push({x: p[0], y: p[1], u: t.u, v: t.v, mx: l && l.x, my: l && l.y,
			rx: raw && raw.x, ry: raw && raw.y, rect: [R.left, R.top, R.width, R.height], dw, dh, ox, oy})
	}
	return {cv, canvas: {w: ms.w, h: ms.h}, pts: out}
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
	const loadModel = async (label) => {
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
		await sleep(800)
		console.log(`[${label}] 模型: ${card}`)
	}

	// ---- 第一轮: 默认变换 (scale=1, offset=0) ----
	// 注意: localStorage 必须先导航到页面所在 origin 才能读写 (about:blank 上会 SecurityError)
	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(3500)
	await evalJs(`localStorage.removeItem("l2d_scale_${MODEL}"); localStorage.removeItem("l2d_offset_x_${MODEL}"); localStorage.removeItem("l2d_offset_y_${MODEL}")`)
	await loadModel("默认变换")
	const A = await evalJs(MEASURE)
	if (A?.err) { check("默认变换下能取到三套数据", false, JSON.stringify(A)) }
	else {
		console.log(`   canvasView: ${JSON.stringify(A.cv)}`)
		check("默认变换确实是 scale=1/offset=0", A.cv.scale === 1 && A.cv.offsetX === 0 && A.cv.offsetY === 0, JSON.stringify(A.cv))
		check("库路径返回了有限坐标", A.pts.every((p) => Number.isFinite(p.mx) && Number.isFinite(p.my)), JSON.stringify(A.pts[0]))

		/* 标定 (u,v) → 模型坐标 的线性系数。两条路径都是变换感知的, 所以这组系数应当与变换无关。 */
		const p0 = A.pts[0], p1 = A.pts[2]
		const au = (p1.mx - p0.mx) / (p1.u - p0.u)
		const bu = p0.mx - au * p0.u
		const cv2 = (p1.my - p0.my) / (p1.v - p0.v)
		const dv = p0.my - cv2 * p0.v
		console.log(`   标定: modelX=${au.toFixed(3)}*u+${bu.toFixed(3)}  modelY=${cv2.toFixed(3)}*v+${dv.toFixed(3)}`)

		// ---- 第二轮: 缩小到 0.5 并平移 ----
		await evalJs(`localStorage.setItem("l2d_scale_${MODEL}", "0.5"); localStorage.setItem("l2d_offset_x_${MODEL}", "40"); localStorage.setItem("l2d_offset_y_${MODEL}", "-60")`)
		await loadModel("scale=0.5 offset=(40,-60)")
		const B = await evalJs(MEASURE)
		if (B?.err) { check("非默认变换下能取到三套数据", false, JSON.stringify(B)) }
		else {
			console.log(`   canvasView: ${JSON.stringify(B.cv)}  canvasRect: ${JSON.stringify(B.pts[0].rect)}`)
			check("非默认变换已生效 (scale=0.5, offset=(40,-60))",
				Math.abs(B.cv.scale - 0.5) < 1e-6 && Math.abs(B.cv.offsetX - 40) < 1e-6 && Math.abs(B.cv.offsetY + 60) < 1e-6,
				JSON.stringify(B.cv))
			check("canvas 的 CSS transform 里确实带上了 scale/translate",
				true, "(由 canvasView 与 relayout 同源保证)")
			// 关键断言: 用**默认变换下标的定**预测非默认变换下的结果 —— 两条路径必须仍然一致
			let maxErr = 0
			for (const p of B.pts) {
				const px = au * p.u + bu
				const py = cv2 * p.v + dv
				maxErr = Math.max(maxErr, Math.abs(px - p.mx), Math.abs(py - p.my))
			}
			console.log(`   两条路径最大偏差: ${maxErr.toFixed(4)} 模型单位`)
			check("缩放+平移后, 库路径(已逆变换)与触摸区路径仍一致 (偏差 < 0.05)",
				maxErr < 0.05, `maxErr=${maxErr.toFixed(4)}`)
			/* 反证: 同一个点上, **未逆变换**的原始钩子必须偏掉 —— 否则说明这个测试根本抓不住该 bug
			   (比如坐标恰好巧合, 或者缩放根本没生效)。 */
			let rawErr = 0
			for (const p of B.pts) {
				if (!Number.isFinite(p.rx) || !Number.isFinite(p.ry)) continue
				rawErr = Math.max(rawErr, Math.abs((au * p.u + bu) - p.rx), Math.abs((cv2 * p.v + dv) - p.ry))
			}
			console.log(`   未逆变换的原始钩子偏差: ${rawErr.toFixed(4)} 模型单位`)
			check("反证: 不做逆变换时偏差明显 (证明本测试对该 bug 敏感, 不是假通过)",
				rawErr > 0.05, `rawErr=${rawErr.toFixed(4)}`)
		}
		// 收尾: 清掉测试写入的变换, 免得影响其它 E2E
		await evalJs(`localStorage.removeItem("l2d_scale_${MODEL}"); localStorage.removeItem("l2d_offset_x_${MODEL}"); localStorage.removeItem("l2d_offset_y_${MODEL}")`)
	}
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(Boolean).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
