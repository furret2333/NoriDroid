/* 探针: 渲染分辨率的代价 —— renderScale 3 / 2 / 1 × 数据海背景 开/关 (报告型, 永不失败)
 *
 * 为什么需要它: 工程里原本**没有**任何"变 renderScale 测帧率"的探针。
 *   probe-datasea-cost.mjs 量的是 CPU 忙占比(能看背景吃多少 CPU), 但看不出**填充是否受限**;
 *   probe-main-fps.mjs 量的是"两个实例并存"的相对代价。两者都答不了
 *   "把分辨率拉低到底有没有用"这个问题 —— 而这正是唯一能区分 **填充受限** 与 **CPU 受限** 的判据。
 *
 * 两个必须知道的坑 (都踩过, 别再踩):
 *   ① headless 默认 devicePixelRatio = 1 ⇒ 分辨率拉高也跑得动, 帧率全被 60 上限压平
 *      (实测 rs=3 → 57.0fps, rs=1 → 59.6fps, 什么都看不出来)。
 *      必须加 `--force-device-scale-factor=3` 模拟真机 dpr, 让重档位真的掉到 60 以下。
 *   ② 找 Live2D 画布**不能**用 `document.querySelector("canvas")` —— 那抓到的是
 *      **数据海**画布(它在 DOM 里更靠前)。主界面还会把库画布 append 进 host 容器,
 *      所以它也不是 body 的直属子元素。正确做法: 所有 canvas 里**排除 .datasea-bg**。
 *
 * 另一个坑: 一定要把 l2dFps 设成 0(不限)。默认 60 的上限会把两个档位都压成 60。
 *   本探针通过 harness 的 `?seed=` 直接预置 settings.json 来做到这一点。
 *
 * 运行: node tmp-memcheck/probe-render-scale-ab.mjs    (需 harness 在 8123, 见下)
 *   harness: 双击 app/android/打开测试服务器.bat, 或 node .harness/server.mjs
 * 依赖: 本机 Edge + 一块真 GPU。走 SwiftShader 时绝对帧率不可信(见文末打印的判定)。
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const CDP_PORT = 9414
const BASE = "http://127.0.0.1:8123/assets/web/index.html"
const DPR = 3          // 模拟真机 (见坑①)
const WINDOW_MS = 6000 // 每个配置的测量窗口
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** harness 的 seed 参数: base64url(JSON) 直接当作 settings.json 内容 */
const seedUrl = (o) => `${BASE}?seed=${Buffer.from(JSON.stringify(o)).toString("base64url")}`

/* ---------------- CDP 最小封装 (与 probe-datasea-cost.mjs 同风格) ---------------- */
let ws, id = 0
const pending = new Map()
const send = (method, params = {}, sessionId) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sessionId ? {sessionId} : {})}))
	return new Promise((res, rej) => {
		pending.set(m, {res, rej})
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 30000)
	})
}
async function wsUrl(port) {
	for (let i = 0; i < 60; i += 1) {
		try {
			const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
			if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl
		} catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

const KEYS = ["TaskDuration", "ScriptDuration"]
let sessionId, evalJs
const readMetrics = async () => {
	const r = await send("Performance.getMetrics", {}, sessionId)
	const m = {}
	for (const it of r.metrics || []) if (KEYS.includes(it.name)) m[it.name] = it.value
	return m
}

/** 画布尺寸读取: Live2D = 排除 .datasea-bg 的那个 (见坑②) */
const PROBE = `(() => {
	const all = [...document.querySelectorAll("canvas")];
	const ds = document.querySelector(".datasea-bg");
	const l2d = all.find((c) => c !== ds);
	const mp = (c) => (c ? +(c.width * c.height / 1e6).toFixed(3) : 0);
	let gpu = "";
	try {
		const t = document.createElement("canvas");
		const gl = t.getContext("webgl2") || t.getContext("webgl");
		const e = gl && gl.getExtension("WEBGL_debug_renderer_info");
		gpu = String(gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
	} catch (_) {}
	return {
		l2d: l2d ? l2d.width + "x" + l2d.height : "none", l2dMP: mp(l2d),
		ds: ds ? ds.width + "x" + ds.height : "none", dsMP: mp(ds),
		rs: window.__noriRenderScale, l2dMinInt: window.__noriL2dMinInterval,
		gpu, dpr: window.devicePixelRatio, vw: window.innerWidth, vh: window.innerHeight,
		nCanvas: all.length,
	}
})()`

/** 等模型真的在出帧; 若 6s 还没出帧就走一次 UI 选模型 (harness 里模型可能需要手动选) */
const waitModel = async (limitMs) => {
	const t0 = Date.now()
	let poked = false
	while (Date.now() - t0 < limitMs) {
		if (await evalJs(`(window.__noriL2dDraws||0) > 0`)) return true
		if (!poked && Date.now() - t0 > 6000) {
			poked = true
			try {
				await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
				await sleep(1200)
				await evalJs(`(() => { const c=[...document.querySelectorAll(".mc")].find(x=>x.textContent.includes("ARGNori")); if(c) c.click() })()`)
				await sleep(4000)
			} catch { /* 忽略 */ }
		}
		await sleep(500)
	}
	return false
}

const measure = async (label, seed) => {
	await send("Page.navigate", {url: seedUrl(seed)}, sessionId)
	await sleep(3000)
	const loaded = await waitModel(24000)
	await evalJs(`window.__fpsFrames=0;(function t(){window.__fpsFrames++;requestAnimationFrame(t)})()`)
	await sleep(1500) // 让状态稳定
	const info = await evalJs(PROBE)
	const a = await readMetrics()
	const f0 = await evalJs(`({f: window.__fpsFrames, d: window.__noriL2dDraws||0})`)
	await sleep(WINDOW_MS)
	const f1 = await evalJs(`({f: window.__fpsFrames, d: window.__noriL2dDraws||0})`)
	const b = await readMetrics()
	const secs = WINDOW_MS / 1000
	const fps = (f1.f - f0.f) / secs
	const draws = (f1.d - f0.d) / secs
	const task = ((b.TaskDuration - a.TaskDuration) / secs) * 100
	const script = ((b.ScriptDuration - a.ScriptDuration) / secs) * 100
	console.log(`  [${label}] 模型=${loaded}  L2D=${info.l2d}(${info.l2dMP}MP)  数据海=${info.ds}(${info.dsMP}MP)`)
	console.log(`      帧率=${fps.toFixed(1)}  出帧=${draws.toFixed(1)}/s  CPU忙=${task.toFixed(1)}% (JS ${script.toFixed(1)}%)`)
	return {label, loaded, fps, draws, task, script, ...info}
}

/* ---------------- 主流程 ---------------- */
console.log("探针: 渲染分辨率代价 (renderScale × 数据海背景)")
try {
	const up = await fetch("http://127.0.0.1:8123/assets/web/index.html", {signal: AbortSignal.timeout(1500)}).then(() => true).catch(() => false)
	if (!up) {
		console.log("!! harness 不在 8123。先跑: 双击 app/android/打开测试服务器.bat  (或 node .harness/server.mjs)")
		process.exit(0)
	}
	const profile = mkdtempSync(join(tmpdir(), "nori-rsab-"))
	const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--window-size=520,900",
		`--force-device-scale-factor=${DPR}`, // 坑①
		"about:blank"], {stdio: "ignore"})
	try {
		ws = new WebSocket(await wsUrl(CDP_PORT))
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
		ws.onmessage = (ev) => {
			const m = JSON.parse(ev.data)
			if (m.id && pending.has(m.id)) {
				const p = pending.get(m.id)
				pending.delete(m.id)
				m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
			}
		}
		const {targetId} = await send("Target.createTarget", {url: "about:blank"})
		;({sessionId} = await send("Target.attachToTarget", {targetId, flatten: true}))
		await send("Runtime.enable", {}, sessionId)
		await send("Page.enable", {}, sessionId)
		await send("Performance.enable", {}, sessionId)
		evalJs = async (expr) => {
			const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
			if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
			return r.result.value
		}

		// l2dFps=0(不限) 是**必须**的: 默认 60 上限会把所有档位压平
		const R = []
		R.push(await measure("rs=3 背景开", {renderScale: 3, dataseaBg: true, l2dFps: 0}))
		R.push(await measure("rs=2 背景开", {renderScale: 2, dataseaBg: true, l2dFps: 0}))
		R.push(await measure("rs=1 背景开", {renderScale: 1, dataseaBg: true, l2dFps: 0}))
		R.push(await measure("rs=3 背景关", {renderScale: 3, dataseaBg: false, l2dFps: 0}))

		const first = R[0]
		const sw = /swiftshader|llvmpipe|software|basic render/i.test(first.gpu || "")
		console.log("\n================ 汇总 ================")
		console.log(`GPU = ${first.gpu}`)
		console.log(`视口 ${first.vw}x${first.vh} CSS, dpr=${first.dpr}, canvas 数=${first.nCanvas}`)
		console.log(sw ? ">>> 软件渲染: 只看相对差, 绝对帧率不可信" : ">>> 真 GPU: 数字可信度较高 (仍需真机复核)")
		console.log("")
		console.log("配置           L2D画布        MP      数据海画布      MP      rAF帧率  出帧/s  CPU忙%")
		for (const r of R) {
			console.log(`${r.label.padEnd(14)} ${String(r.l2d).padEnd(13)} ${String(r.l2dMP).padStart(6)} ${String(r.ds).padEnd(14)} ${String(r.dsMP).padStart(6)} ${r.fps.toFixed(1).padStart(8)} ${r.draws.toFixed(1).padStart(7)} ${r.task.toFixed(1).padStart(7)}`)
		}
		const g = (l) => R.find((r) => r.label === l)
		const a = g("rs=3 背景开"), b2 = g("rs=2 背景开"), c = g("rs=1 背景开"), d = g("rs=3 背景关")
		console.log("\n---- 结论 ----")
		if (a && b2) console.log(`默认降到 2: 像素 ${a.l2dMP}→${b2.l2dMP} MP (${((b2.l2dMP / a.l2dMP - 1) * 100).toFixed(0)}%)  帧率 ${a.fps.toFixed(1)}→${b2.fps.toFixed(1)} (${((b2.fps / a.fps - 1) * 100).toFixed(0)}%)`)
		if (a && c) console.log(`拉到 1    : 像素 ${a.l2dMP}→${c.l2dMP} MP (${((c.l2dMP / a.l2dMP - 1) * 100).toFixed(0)}%)  帧率 ${a.fps.toFixed(1)}→${c.fps.toFixed(1)} (${((c.fps / a.fps - 1) * 100).toFixed(0)}%)`)
		if (a && d) console.log(`关背景    : 帧率 ${a.fps.toFixed(1)}→${d.fps.toFixed(1)} (${((d.fps / a.fps - 1) * 100).toFixed(0)}%)  → 背景的代价`)
		// M1 回归判据: 数据海画布尺寸**不该**随 renderScale 变 (变=已修好)
		if (a && b2 && c) {
			const same = a.dsMP === b2.dsMP && b2.dsMP === c.dsMP
			console.log(`\n数据海画布: rs3=${a.dsMP} rs2=${b2.dsMP} rs1=${c.dsMP} MP → ${same ? "★ 仍不随 renderScale 变化 (M1 未修)" : "★ 已随 renderScale 变化 (M1 已修)"}`)
		}
		console.log("\n注: 这是桌面 + 集成显卡下的数字, 只用于判断**方向**(填充受限 or CPU 受限);")
		console.log("    真机绝对帧率请用 harness 的局域网地址在手机上开 (启动时会打印)。")
	} finally {
		try { ws?.close() } catch { /* 忽略 */ }
		edge.kill()
		await sleep(400)
		try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
	}
} catch (e) {
	console.log("!! 探针异常 (报告型探针, 不算门禁失败):", e?.message ?? e)
}
process.exit(0) // 报告型: 永不因测量结果让门禁失败
