/* 探针: 主界面掉帧 —— 「两个 Live2D 同时在渲染」与「不可见时要停画」 (2026-10-02 用户报)
 *
 * 现象（用户）: 打开悬浮窗 → 退回主界面 → 待一会儿（或打开一次对话框）→ 再回主界面，主界面严重掉帧。
 *
 * 这条探针要回答的就是"到底谁在跟主界面抢帧"，全部用**实测数字**说话:
 *   ① 主界面单独跑: 有几条 rAF 循环 (Live2D + 数据海)、帧率多少、画了多少帧
 *   ② 走一遍用户流程（设置 / 聊天 / 回主界面）: 循环数**不许增长**（排除"重复注册/重复挂载"）
 *   ③ 悬浮窗**同时渲染**时主界面帧率掉多少 —— 这是"两个实例同时在画"的代价
 *   ④ 让悬浮窗停画 (`__noriSetPaused(true)`，原生 FloatService.ACTION_SET_PAUSED 走的就是它):
 *      悬浮窗一帧都不再画, 主界面帧率**恢复**
 *   ⑤ 恢复渲染后悬浮窗继续画 (暂停不是单向的)
 *   ⑥ 主界面 hidden 时两条循环都停 (回归护栏: 切后台/被盖住不许白跑)
 *   ⑦ "开过悬浮窗再回来"之后不残留: 循环数、DOM、堆都不许涨
 *
 * ⚠ 为什么用**两个 Edge 进程**: 同一个浏览器里后台 target 会被置成 hidden, 那样根本测不出
 *   "两个渲染器并存"的代价（一个进程里两个 target 必然有一个不画）。两个进程各自只有一个页面,
 *   都是 visible, 才等价于"主 App WebView + 悬浮窗 WebView 同时在画"。
 *
 * 运行: node tmp-memcheck/probe-main-fps.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** rAF 计量器: 谁在排程、每秒排多少次、交付了多少帧。必须在页面任何脚本之前注入 */
const RAF_METER = `(() => {
	window.__rafHist = {}; window.__rafSeq = 0; window.__rafIds = new WeakMap(); window.__rafTotal = 0;
	const orig = window.requestAnimationFrame.bind(window);
	window.requestAnimationFrame = function (cb) {
		window.__rafTotal += 1;
		let name = window.__rafIds.get(cb);
		if (!name) { name = (cb && cb.name ? cb.name : "anon") + "#" + (++window.__rafSeq); window.__rafIds.set(cb, name) }
		window.__rafHist[name] = (window.__rafHist[name] || 0) + 1;
		return orig(cb)
	};
	window.__rafReset = function () { window.__rafHist = {}; window.__rafSeq = 0; window.__rafIds = new WeakMap(); window.__rafTotal = 0; window.__fpsFrames = 0 };
	window.__fpsFrames = 0;
	(function tick() { window.__fpsFrames += 1; orig(tick) })();
})()`

class Browser {
	constructor(port, tag) { this.port = port; this.tag = tag }
	async open() {
		this.profile = mkdtempSync(join(tmpdir(), `nori-${this.tag}-`))
		this.proc = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`,
			"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
		for (let i = 0; i < 60; i += 1) {
			try { const j = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); if (j.webSocketDebuggerUrl) { this.ws = new WebSocket(j.webSocketDebuggerUrl); break } } catch { /* 未就绪 */ }
			await sleep(250)
		}
		if (!this.ws) throw new Error(`Edge(${this.tag}) CDP 未就绪`)
		await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
		this.id = 0
		this.pending = new Map()
		this.jsErrors = []
		this.ws.onmessage = (ev) => {
			const m = JSON.parse(ev.data)
			if (m.method === "Runtime.exceptionThrown") {
				this.jsErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?")
			}
			if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
		}
		const {targetId} = await this.send("Target.createTarget", {url: "about:blank"})
		this.targetId = targetId
		const {sessionId} = await this.send("Target.attachToTarget", {targetId, flatten: true})
		this.sessionId = sessionId
		await this.send("Runtime.enable", {}, sessionId)
		await this.send("Page.enable", {}, sessionId)
		await this.send("Page.addScriptToEvaluateOnNewDocument", {source: RAF_METER}, sessionId)
		return this
	}
	send(method, params = {}, sid) {
		const m = ++this.id
		this.ws.send(JSON.stringify({id: m, method, params, ...(sid ? {sessionId: sid} : {})}))
		return new Promise((res, rej) => {
			this.pending.set(m, {res, rej})
			setTimeout(() => { if (this.pending.has(m)) { this.pending.delete(m); rej(new Error("超时 " + method)) } }, 30000)
		})
	}
	async ev(expr) {
		const r = await this.send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, this.sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}
	kill() { try { this.proc.kill() } catch { /* 忽略 */ } }
}

const results = []
const check = (name, cond, detail = "") => {
	results.push({name, cond: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ← ${detail}`}`)
}

/** Δt 窗口内: 交付帧率 / rAF 排程率 / 活动循环数 / 真画帧数 / DOM / 堆 */
const measure = async (br, ms = 3000) => {
	await br.ev(`window.__rafReset()`)
	const t0 = Date.now()
	await sleep(ms)
	const r = await br.ev(`(() => {
		const dt = ${ms} / 1000;
		const hist = window.__rafHist || {};
		const loops = Object.entries(hist).filter(([, n]) => n >= 10).map(([k, n]) => [k, +(n / dt).toFixed(1)]);
		return {fps: +(window.__fpsFrames / dt).toFixed(1), schedPerSec: +(window.__rafTotal / dt).toFixed(1),
			nLoops: loops.length, loops: loops.sort((a, b) => b[1] - a[1]),
			draws: window.__noriL2dDraws || 0,
			vis: document.visibilityState,
			domNodes: document.getElementsByTagName("*").length,
			heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null};
	})()`)
	r.wallMs = Date.now() - t0
	return r
}
const seedUrl = (extra = {}) => {
	const seed = Buffer.from(JSON.stringify({
		apiKey: "sk-fps", baseUrl: "https://api.fps.test", model: "m",
		live2dModel: "ARGNori", dataseaBg: true, l2dFps: 60, ...extra,
	})).toString("base64url")
	return `http://127.0.0.1:8123/assets/web/index.html?seed=${seed}`
}
const bootMain = async (br) => {
	await br.send("Page.navigate", {url: seedUrl()}, br.sessionId)
	await sleep(6000)
	await br.ev(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	await br.ev(`document.querySelector(".intro-mask")?.remove()`)
}

const main = new Browser(9481, "fpsMain")
const flt = new Browser(9482, "fpsFloat")
try {
	await main.open()
	/* ================= ① 主界面基线 ================= */
	await bootMain(main)
	check("①-a Live2D 渲染钩子在 (补丁装上了)", await main.ev(`typeof window.__noriL2dTick === "function"`),
		await main.ev(`typeof window.__noriL2dTick`))
	check("①-b 数据海背景也在跑 (同一个帧率旋钮)", await main.ev(`typeof window.__noriDataseaMinInterval === "number"`),
		await main.ev(`typeof window.__noriDataseaMinInterval`))
	const base = await measure(main, 4000)
	console.log(`   ① 主界面单独: fps=${base.fps} 循环=${base.nLoops} ${JSON.stringify(base.loops)} 画帧=${base.draws} DOM=${base.domNodes} 堆=${base.heapMB}MB`)
	check("①-c 主界面上确有 2 条常驻 rAF 循环 (Live2D + 数据海)", base.nLoops === 2, JSON.stringify(base.loops))
	check(`①-d 主界面在画 (4s 内真画了 ${base.draws} 帧)`, base.draws > 50, `draws=${base.draws}`)
	check("①-e 交付帧率与循环速率一致 (没有被自己的循环拖死)", base.fps > 10, `fps=${base.fps}`)

	/* ================= ② 走一遍用户流程: 循环数不许涨 ================= */
	const openFab = async (re) => {
		await main.ev(`[...document.querySelectorAll(".fab")].find(x => /${re}/.test(x.textContent))?.click()`)
		await sleep(700)
	}
	await openFab("设置")
	await main.ev(`(() => {
		const row = [...document.querySelectorAll(".sheet .sheet-body .settings-row")].find(r => /退出后显示悬浮窗/.test(r.textContent))
		const cb = row ? row.querySelector("input[type=checkbox]") : null
		if (cb) cb.click()
		return cb ? "toggled:" + cb.checked : "no-cb"
	})()`)
	await main.ev(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(400)
	await openFab("聊天")
	await sleep(600)
	await main.ev(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(400)
	await openFab("聊天")
	await sleep(800)
	const afterFlow = await measure(main, 4000)
	console.log(`   ② 用户流程后: fps=${afterFlow.fps} 循环=${afterFlow.nLoops} ${JSON.stringify(afterFlow.loops)} DOM=${afterFlow.domNodes} 堆=${afterFlow.heapMB}MB`)
	check("②-a 来回开面板/回主界面**没有**多出 rAF 循环 (不是重复注册/重复挂载)",
		afterFlow.nLoops === base.nLoops, `基线 ${base.nLoops} → 流程后 ${afterFlow.nLoops} ${JSON.stringify(afterFlow.loops)}`)
	check("②-b DOM 节点没有爆炸式增长 (面板开关有回收)", afterFlow.domNodes < base.domNodes + 400,
		`${base.domNodes} → ${afterFlow.domNodes}`)
	check("②-c 帧率没有被拖垮 (>= 基线的 80%)", afterFlow.fps >= base.fps * 0.8, `${base.fps} → ${afterFlow.fps}`)

	/* ================= ③ 悬浮窗同时渲染 ⇒ 主界面掉帧 ================= */
	await flt.open()
	await flt.send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/float.html?shim=1"}, flt.sessionId)
	await sleep(6000)
	const fltBase = await measure(flt, 3000)
	console.log(`   ③ 悬浮窗: fps=${fltBase.fps} 循环=${fltBase.nLoops} 画帧=${fltBase.draws} vis=${fltBase.vis}`)
	check("③-a 悬浮窗页面自己在画 Live2D (1 条循环)", fltBase.nLoops === 1 && fltBase.draws > 30,
		JSON.stringify({nLoops: fltBase.nLoops, draws: fltBase.draws}))
	const withFloat = await measure(main, 4000)
	console.log(`   ③ 主界面(悬浮窗同时渲染): fps=${withFloat.fps} 循环=${withFloat.nLoops} 画帧=${withFloat.draws}`)
	check(`③-b 悬浮窗同时渲染时主界面帧率明显下降 (${base.fps} → ${withFloat.fps})`,
		withFloat.fps < base.fps * 0.8,
		`基线 ${base.fps} → 并存 ${withFloat.fps} (比值 ${(withFloat.fps / base.fps).toFixed(2)})`)

	/* ================= ④ 暂停悬浮窗渲染 ⇒ 主界面恢复 (原生 ACTION_SET_PAUSED 走的就是这个入口) ================= */
	check("④-a 悬浮窗页有 __noriSetPaused 钩子 (原生 FloatService 调的就是它)",
		await flt.ev(`typeof window.__noriSetPaused === "function"`), await flt.ev(`typeof window.__noriSetPaused`))
	const drawsBeforePause = await flt.ev(`window.__noriL2dDraws`)
	await flt.ev(`window.__noriSetPaused(true)`)
	await sleep(300)
	const drawsAtPause = await flt.ev(`window.__noriL2dDraws`)
	const paused = await measure(flt, 3000)
	const drawsAfterPause = await flt.ev(`window.__noriL2dDraws`)
	console.log(`   ④ 悬浮窗暂停: 画帧 ${drawsBeforePause} →(暂停) ${drawsAtPause} →(3s 后) ${drawsAfterPause}`)
	check("④-b 暂停后悬浮窗**一帧都不再画** (3 秒窗口内 0 帧)",
		drawsAfterPause === drawsAtPause,
		`暂停时 ${drawsAtPause} → 3 秒后 ${drawsAfterPause}`)
	const afterPause = await measure(main, 4000)
	const recovered = await measure(main, 4000)
	const best = Math.max(afterPause.fps, recovered.fps)
	console.log(`   ④ 主界面(悬浮窗已停画): fps=${afterPause.fps} / ${recovered.fps}`)
	check(`④-c 停掉悬浮窗渲染后主界面帧率**恢复** (并存 ${withFloat.fps} → 停画 ${best})`,
		best >= withFloat.fps * 1.5,
		`并存 ${withFloat.fps} → 停画 ${best} (基线 ${base.fps})`)
	check("④-d 主界面的循环数不变 (恢复不是靠多开循环)", recovered.nLoops === base.nLoops,
		`${base.nLoops} → ${recovered.nLoops}`)

	/* ================= ⑤ 恢复渲染 ⇒ 继续画 (暂停是双向的) ================= */
	const beforeResume = await flt.ev(`window.__noriL2dDraws`)
	await flt.ev(`window.__noriSetPaused(false)`)
	const resumed = await measure(flt, 3000)
	const afterResume = await flt.ev(`window.__noriL2dDraws`)
	console.log(`   ⑤ 悬浮窗恢复后: 画帧 ${beforeResume} → ${afterResume}`)
	check("⑤ 恢复渲染后悬浮窗继续画 (暂停不是单向的)", afterResume > beforeResume && resumed.draws > 20,
		`draws ${beforeResume} → ${afterResume} (窗口内 ${resumed.draws})`)

	/* ================= ⑥ 主界面 hidden ⇒ 两条循环都停 (回归护栏) ================= */
	const blankTarget = await main.send("Target.createTarget", {url: "about:blank"})
	await main.send("Target.activateTarget", {targetId: blankTarget.targetId})
	await sleep(1200)
	const drawsAtHide = await main.ev(`window.__noriL2dDraws`)   // 累计值, 只能比增量
	const hidden = await measure(main, 2500)
	const drawsAfterHide = await main.ev(`window.__noriL2dDraws`)
	console.log(`   ⑥ 主界面被切走: vis=${hidden.vis} fps=${hidden.fps} 排程=${hidden.schedPerSec} 画帧 ${drawsAtHide} → ${drawsAfterHide}`)
	check("⑥-a 主界面确实进入 hidden (测法成立)", hidden.vis === "hidden", `vis=${hidden.vis}`)
	check("⑥-b 隐藏期间主界面 rAF 排程为 0 (Live2D + 数据海都停了)",
		hidden.schedPerSec === 0 && hidden.nLoops === 0, JSON.stringify({sched: hidden.schedPerSec, loops: hidden.nLoops}))
	check("⑥-c 隐藏期间一帧都没画 (增量 0)", drawsAfterHide === drawsAtHide, `${drawsAtHide} → ${drawsAfterHide}`)
	await main.send("Target.activateTarget", {targetId: main.targetId})
	await sleep(1000)
	const drawsBeforeShow = await main.ev(`window.__noriL2dDraws`)
	const shown = await measure(main, 3000)
	const drawsAfterShow = await main.ev(`window.__noriL2dDraws`)
	console.log(`   ⑥ 回前台: vis=${shown.vis} fps=${shown.fps} 循环=${shown.nLoops} 画帧 ${drawsBeforeShow} → ${drawsAfterShow}`)
	check("⑥-d 回到前台后立即恢复画 (帧数在涨、循环数回到 2)",
		shown.vis === "visible" && drawsAfterShow > drawsBeforeShow && shown.nLoops === base.nLoops,
		JSON.stringify({vis: shown.vis, delta: drawsAfterShow - drawsBeforeShow, nLoops: shown.nLoops}))

	/* ================= ⑦ 关掉悬浮窗后不残留 ================= */
	flt.kill()
	await sleep(2500)
	const afterClose = await measure(main, 4000)
	console.log(`   ⑦ 关掉悬浮窗后主界面: fps=${afterClose.fps} 循环=${afterClose.nLoops} DOM=${afterClose.domNodes} 堆=${afterClose.heapMB}MB`)
	check("⑦-a 悬浮窗关掉后主界面帧率回到基线水平 (>= 基线的 85%)",
		afterClose.fps >= base.fps * 0.85, `基线 ${base.fps} → 关掉后 ${afterClose.fps}`)
	check("⑦-b 没有残留 rAF 循环 (仍是 2 条)", afterClose.nLoops === base.nLoops,
		`${base.nLoops} → ${afterClose.nLoops} ${JSON.stringify(afterClose.loops)}`)
	check("⑦-c 没有明显内存/句柄增长 (堆 <= 基线 +8MB, DOM <= 基线 +400)",
		afterClose.domNodes < base.domNodes + 400 && (afterClose.heapMB == null || base.heapMB == null || afterClose.heapMB < base.heapMB + 8),
		`堆 ${base.heapMB} → ${afterClose.heapMB}MB, DOM ${base.domNodes} → ${afterClose.domNodes}`)
	check("⑧ 全程无未捕获异常 (两个页面)", main.jsErrors.length === 0 && flt.jsErrors.length === 0,
		JSON.stringify([...main.jsErrors, ...flt.jsErrors].slice(0, 3)))
} catch (e) {
	check("执行过程未抛异常", false, String(e?.stack ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	main.kill()
	flt.kill()
}
