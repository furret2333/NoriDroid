/* 悬浮窗（float.html）冒烟 —— 这条链路此前**零 E2E 覆盖**。
 *
 * 为什么值得单独一条：悬浮窗是独立入口，它自己也吃这轮改动的模块
 * （`FloatApp.vue:162` 直接调 `l2d.applyFrameCap(normalizeFps(st.l2dFps))`），
 * 而且主入口的 E2E 完全不会碰到它 —— 打包时"全绿"并不代表悬浮窗没坏。
 *
 * 需要 harness 支持：`/assets/web/float.html?shim=1` 才注入假桥（默认不注入，
 * 以免影响共用同一个 harness 的其它会话）。
 *
 * 运行: node tmp-memcheck/e2e-float.mjs   (需 harness 在 8123 跑着)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9358
const URL_FLOAT = "http://127.0.0.1:8123/assets/web/float.html?shim=1"

const profile = mkdtempSync(join(tmpdir(), "nori-float-"))
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
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 20000)
	})
}
const results = []
const check = (name, cond, detail = "") => {
	results.push({name, cond: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${detail}`}`)
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
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	/* 真·异常收集（订阅 CDP；不要用那个全项目都没定义过的 `__noriE2EErrors`） */
	const pageErrors = []
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params?.exceptionDetails?.exception?.description ?? "?")
	})
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}

	await send("Page.navigate", {url: URL_FLOAT}, sessionId)
	await sleep(5000)

	check("① 页面加载后无未捕获 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "))
	check("② 假桥已注入 (说明走的是 ?shim=1 那条路)", await evalJs(`typeof window.NoriChat === "object" && window.NoriChat !== null`))
	check("③ 有 canvas 元素 (渲染容器在)", await evalJs(`document.querySelectorAll("canvas").length > 0`))
	check("④ 帧率节流钩子已装上 (悬浮窗也吃 frameCap)", await evalJs(`typeof window.__noriL2dTick === "function"`))
	const iv = await evalJs(`window.__noriL2dMinInterval`)
	check(`⑤ 默认档 60 的门限 = 14.67ms (实测 ${iv})`, Math.abs(iv - 14.6667) < 0.01, String(iv))
	check("⑥ 悬浮窗**没有**接眨眼/低头 (用户决定不做) —— 槽位应保持未安装",
		await evalJs(`typeof window.__noriBeforeModelUpdate === "undefined"`),
		await evalJs(`typeof window.__noriBeforeModelUpdate`))
	check("⑦ 悬浮窗不加载数据海背景 (那是主界面专属)", await evalJs(`typeof window.__noriDataseaMinInterval === "undefined"`),
		await evalJs(`typeof window.__noriDataseaMinInterval`))
	await sleep(1200)
	check("⑧ 静置 1.2 秒后仍无异常 (不是「加载完才炸」)", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "))

	/* ---------------- 2026-10-02: 对话框初始落点修复 (用户报「对话框嵌在 Nori 里面」) ----------------
	 * 落点算法在原生侧 (Kotlin 的 placeBubble, 独立 Activity 窗口), 浏览器里拿不到 ——
	 * 这里验**喂给它的输入**: FloatApp 上报的模型几何必须是**物理像素**。
	 * 原生窗口坐标 (WindowManager.LayoutParams.x/y/width/height 与触摸 rawX/rawY) 全是物理像素,
	 * 而 getBoundingClientRect() 给的是 CSS 像素 ⇒ 必须乘 devicePixelRatio。
	 * 把 deviceScaleFactor 调成真机那种 2.75: 老代码 (漏乘 dpr) 会在这里变红。
	 * 三档视口 = 悬浮窗被捏合缩放前/放大后/缩小后 —— 缩放后必须仍然对。 */
	const DPR = 2.75
	const armRecorder = async () => {
		await evalJs(`(() => {
			window.__rec = {feet: [], rect: []};
			const c = window.NoriChat;
			c.setFloatModelFeet = (y) => { window.__rec.feet.push(y) };
			c.setFloatModelRect = (l, t, r, b) => { window.__rec.rect.push([l, t, r, b]) };
			return true
		})()`)
	}
	const measure = async () => await evalJs(`(() => {
		const cv = document.querySelector("canvas");
		const r = cv.getBoundingClientRect();
		const rec = window.__rec || {feet: [], rect: []};
		const ms = window.__noriModelCanvas || null;
		return {dpr: window.devicePixelRatio, iw: innerWidth, ih: innerHeight,
			canvas: {l: r.left, t: r.top, w: r.width, h: r.height},
			model: ms ? {w: ms.w, h: ms.h} : null,
			feet: rec.feet.length ? rec.feet[rec.feet.length - 1] : null,
			rect: rec.rect.length ? rec.rect[rec.rect.length - 1] : null,
			nFeet: rec.feet.length, nRect: rec.rect.length};
	})()`)
	/** 改视口 (模拟原生捏合缩放后 updateViewLayout → 页面 resize) 再等上报 (+100/+400ms 两次) */
	const rescale = async (w, h) => {
		await evalJs(`window.__rec ? (window.__rec.feet.length = 0, window.__rec.rect.length = 0) : 0`)
		await send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: DPR, mobile: true}, sessionId)
		await evalJs(`window.dispatchEvent(new Event("resize")); true`)
		await sleep(900)
		return measure()
	}
	const checkGeometry = (label, M) => {
		const feet = M.feet, rect = M.rect
		const cvR = M.canvas.l * DPR, cvB = (M.canvas.t + M.canvas.h) * DPR
		const cvW = M.canvas.w * DPR, cvH = M.canvas.h * DPR
		check(`${label}: dpr 被设成 ${DPR} (暴露单位错误的前提)`, Math.abs(M.dpr - DPR) < 0.01, String(M.dpr))
		check(`${label}: 缩放后仍重新上报了脚底与矩形 (feet=${M.nFeet} rect=${M.nRect})`, M.nFeet > 0 && M.nRect > 0, `${M.nFeet} vs ${M.nRect}`)
		check(`${label}: 脚底 == 模型矩形底边 (同一单位 ⇒ 物理像素) [feet=${feet} rect.b=${rect && rect[3]}]`,
			feet != null && rect != null && Math.abs(feet - rect[3]) <= 1, feet != null && rect != null ? `差 ${feet - rect[3]}` : "没上报")
		// 与 DOM 复算对照: 模型在画布内按 contain 摆 (至少一边贴满)、水平居中、比例等于模型自身比例
		const m = M.model
		let fit = null
		if (m && m.w > 0 && m.h > 0) {
			const S = Math.min(M.canvas.w / m.w, M.canvas.h / m.h)
			fit = {x: (M.canvas.w - m.w * S) / 2, y: (M.canvas.h - m.h * S) / 2, w: m.w * S, h: m.h * S}
		}
		check(`${label}: 脚底 == 模型在画布内 contain 定位后的底边 × dpr [${feet} vs ${fit ? ((fit.y + fit.h) * DPR).toFixed(1) : "?"}]`,
			!!fit && feet != null && Math.abs(feet - (fit.y + fit.h) * DPR) <= 2,
			fit ? `差 ${(feet - (fit.y + fit.h) * DPR).toFixed(1)} (模型画布 ${m.w}x${m.h}, 画布 ${cvW.toFixed(0)}x${cvH.toFixed(0)})` : "拿不到 __noriModelCanvas")
		const rw = rect ? rect[2] - rect[0] : 0, rh = rect ? rect[3] - rect[1] : 0
		check(`${label}: 矩形比例 == 模型比例 & 水平居中 & 至少一边贴满 (contain 特征)`,
			!!rect && !!m &&
			Math.abs(rw / rh - m.w / m.h) <= 0.01 &&
			Math.abs(rect[0] - (cvR + cvW - rect[2])) <= 2 &&
			Math.min(cvW - rw, cvH - rh) <= 2,
			rect ? `矩形 ${rw}x${rh} 比例 ${(rw / rh).toFixed(3)} vs ${m ? (m.w / m.h).toFixed(3) : "?"} 左${rect[0]} 右留白${(cvR + cvW - rect[2]).toFixed(0)}` : "没上报")
		check(`${label}: 模型矩形整个落在画布内 (画布自身裁剪 ⇒ 底边以下没有模型像素)`,
			!!rect && rect[0] >= cvR - 1 && rect[1] >= M.canvas.t * DPR - 1 && rect[2] <= cvR + cvW + 1 && rect[3] <= cvB + 1,
			rect ? JSON.stringify(rect) + ` 画布 x∈[${cvR},${(cvR + cvW).toFixed(0)}] y∈[${(M.canvas.t * DPR).toFixed(0)},${cvB.toFixed(0)}]` : "没上报")
		return {feet, rect}
	}

	await armRecorder()
	// 档位一: 默认悬浮窗 260x340 物理像素 (dpr 2.75 ⇒ CSS 94.5x123.6, 取整 95x124)
	const a = checkGeometry("⑨ 默认尺寸(物理 261x341)", await rescale(95, 124))
	// 档位二: 捏合放大到 600x900 物理像素 (CSS 218x327)
	const b = checkGeometry("⑩ 放大后(物理 600x899)", await rescale(218, 327))
	// 档位三: 捏合缩小到 160x200 物理像素 (CSS 58x73)
	const c = checkGeometry("⑪ 缩小后(物理 160x201)", await rescale(58, 73))

	// ⑫ 缩放真的改变了上报值 (否则三档对比没意义): 模型底边必须随窗口尺寸单调变化
	check("⑫ 三档上报的模型底边随尺寸变化 (缩放确实被感知)",
		!!a.feet && !!b.feet && !!c.feet && a.feet < b.feet && c.feet < a.feet,
		`默认 ${a.feet} / 放大 ${b.feet} / 缩小 ${c.feet}`)
	// ⑬ 反证 (防断言空转): 模型底边就在 rect.b (物理像素); 若像老代码那样把 CSS 像素当模型底边,
	//    顶边会比真实模型底边低 rect.b - rect.b/dpr 这么多 px —— 那就是"对话框嵌进模型"的深度
	const shortfall = (mx) => mx.rect[3] - mx.rect[3] / DPR
	check("⑬ 反证: 漏乘 dpr 时顶边会低于真实模型底边 N px (即嵌在模型里) —— 新断言不是空转",
		!!a.rect && !!b.rect && shortfall(a) >= 100 && shortfall(b) >= 300,
		`默认低 ${a.rect ? shortfall(a).toFixed(0) : "?"}px / 放大低 ${b.rect ? shortfall(b).toFixed(0) : "?"}px`)
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const failed = results.filter(r => !r.cond)
	const passed = results.length - failed.length
	console.log(`\n${passed}/${results.length} passed`)
	if (failed.length) {
		console.log("失败项:\n  " + failed.map(r => r.name).join("\n  "))
		process.exitCode = 1
	}
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
