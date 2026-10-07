/* 真 Vue 页面 + 可控、持久化的桥契约夹具；只验证 UI 联动。
 * 原生计时/跨天/账本算法由 PomodoroTest 验证，不能用本假桥证明 Android 后台通知。 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const profile = mkdtempSync(path.join(tmpdir(), "nori-pomo-"))
const port = 9454
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, label, timeout = 15000) => {
	const end = Date.now() + timeout
	while (Date.now() < end) { if (await fn()) return; await sleep(100) }
	throw new Error(`等待超时：${label}`)
}
let harness, edge, ws, seq = 0
const pending = new Map(), results = []
const check = (name, ok, detail = "") => {
	results.push({name, ok: !!ok})
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ← ${detail}`}`)
}
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
	const id = ++seq
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 15000)
	pending.set(id, {resolve, reject, timer})
	ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}))
})

function installFixture() {
	localStorage.setItem("intro_seen_v1", "1")
	localStorage.setItem("storage_asked", "1")
	const NativeDate = Date
	const initialWall = NativeDate.parse("2026-10-07T12:00:00+08:00")
	const idle = () => ({phase: "idle", paused: false, elapsed: 0, segment: 0, focusMin: 25, breakMin: 5, autoBreak: true})
	const db = JSON.parse(localStorage.getItem("pomo_probe_db") || "null") || {
		wall: initialWall, mono: 0, st: idle(), events: [], seq: 0, notify: true,
		stats: {v: 2, days: {}, total: {focusMin: 0, done: 0, countUpMin: 0}, best: {dayMin: 0, streak: 0}}, files: {},
	}
	const save = () => localStorage.setItem("pomo_probe_db", JSON.stringify(db))
	window.Date = class extends NativeDate {
		constructor(...args) { super(...(args.length ? args : [db.wall])) }
		static now() { return db.wall }
	}
	window.__pomoProbe = db
	window.__pomoCalls = {state: 0, stats: 0, notifyRequest: 0}
	window.__pomoAdvance = ms => { db.wall += ms; db.mono += ms; save() }
	window.__pomoWallShift = ms => { db.wall += ms; save() }
	window.__pomoStatsFixture = stats => { db.stats = stats; save() }
	const duration = () => (db.st.phase === "focus" ? db.st.focusMin : db.st.breakMin) * 60000
	const elapsed = () => db.st.elapsed + (db.st.phase === "idle" || db.st.paused ? 0 : db.mono - db.st.segment)
	const end = (reason, ms, endedAt = db.wall) => {
		const e = {seq: ++db.seq, type: "end", phase: db.st.phase, reason, elapsedMs: ms, endedAt}
		db.events.push(e)
		if (reason === "complete" && !window.__pomoSilent) setTimeout(() => window.__noriPomoEvent?.(JSON.stringify(e)), 0)
	}
	const complete = () => {
		for (let i = 0; i < 2; i++) {
			if (db.st.paused || !["focus", "break"].includes(db.st.phase) || elapsed() < duration()) return
			const d = duration(), extra = elapsed() - d, focus = db.st.phase === "focus"
			end("complete", d, db.wall - extra)
			db.st = focus && db.st.autoBreak ? {...db.st, phase: "break", elapsed: 0, segment: db.mono - extra} : idle()
			save()
		}
	}
	const snap = () => {
		const st = db.st, el = ["focus", "break"].includes(st.phase) ? Math.min(duration(), elapsed()) : elapsed()
		const remaining = ["focus", "break"].includes(st.phase) ? duration() - el : 0
		return JSON.stringify({...st, elapsedMs: el, remainingMs: remaining, remainMs: st.phase === "countUp" ? el : remaining,
			endAt: remaining ? db.wall + remaining : 0, startedAt: st.phase === "idle" ? 0 : db.wall - el})
	}
	const finish = reason => { complete(); if (db.st.phase !== "idle") end(reason, elapsed()) }
	let bridge
	Object.defineProperty(window, "NoriChat", {
		configurable: true, get: () => bridge, set: nc => {
			bridge = nc
			const originalRead = nc.readFile.bind(nc)
			nc.readFile = n => db.files[n] ?? originalRead(n)
			nc.writeFile = (n, content) => { db.files[n] = content; save(); return "ok" }
			nc.pomoState = () => { window.__pomoCalls.state++; complete(); return snap() }
			nc.pomoStart = (f, b, ab) => {
				finish("switch"); db.st = {phase: "focus", paused: false, elapsed: 0, segment: db.mono, focusMin: f, breakMin: b, autoBreak: ab}
				save(); return snap()
			}
			nc.pomoStartCountUp = () => {
				finish("switch"); db.st = {...idle(), phase: "countUp", segment: db.mono}; save(); return snap()
			}
			nc.pomoPause = () => { complete(); db.st.elapsed = elapsed(); db.st.paused = db.st.phase !== "idle"; save(); return snap() }
			nc.pomoResume = () => { db.st.paused = false; db.st.segment = db.mono; save(); return snap() }
			nc.pomoStop = () => {
				complete(); const phase = db.st.phase, ms = elapsed(); finish("stop"); db.st = idle(); save()
				return JSON.stringify({...JSON.parse(snap()), endedPhase: phase, elapsedMs: ms})
			}
			nc.pomoStats = () => { window.__pomoCalls.stats++; complete(); return JSON.stringify(db.stats) }
			nc.pomoMarkCelebrated = key => { db.stats.celebrated = {...db.stats.celebrated, [key]: db.wall}; save(); return JSON.stringify(db.stats) }
			nc.pomoSetNotify = enabled => { db.notify = enabled; save() }
			nc.pomoRequestNotify = () => { window.__pomoCalls.notifyRequest++ }
		}
	})
}

try {
	const serverReady = async () => { try { return (await fetch("http://127.0.0.1:8123/assets/web/index.html", {signal: AbortSignal.timeout(1000)})).ok } catch { return false } }
	if (!await serverReady()) {
		harness = spawn(process.execPath, [".harness/server.mjs"], {cwd: path.resolve(root, ".."), stdio: "ignore", windowsHide: true})
		await until(serverReady, "harness")
	}
	edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
		"--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=360,780", "about:blank",
	], {stdio: "ignore", windowsHide: true})
	let debuggerUrl
	await until(async () => { try { debuggerUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; return !!debuggerUrl } catch { return false } }, "Edge")
	ws = new WebSocket(debuggerUrl)
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
	ws.onmessage = event => {
		const msg = JSON.parse(event.data), p = pending.get(msg.id)
		if (!p) return
		clearTimeout(p.timer); pending.delete(msg.id)
		msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	await send("Emulation.setTimezoneOverride", {timezoneId: "Asia/Shanghai"}, sessionId)
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 780, deviceScaleFactor: 1, mobile: true}, sessionId)
	await send("Page.addScriptToEvaluateOnNewDocument", {source: `(${installFixture.toString()})()`}, sessionId)
	const evalJs = async expression => {
		const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}, sessionId)
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
		return result.result.value
	}
	const settings = {ambientEnabled: false, dataseaBg: false, bgmEnabled: false, ttsEnabled: false, quietMode: "off", quietOn: false}
	const url = `http://127.0.0.1:8123/assets/web/index.html?shim=1&seed=${Buffer.from(JSON.stringify(settings)).toString("base64url")}`
	const navigate = async () => {
		await send("Page.navigate", {url}, sessionId)
		await until(() => evalJs('!!document.querySelector(".chat-input input") && !!window.__pomoProbe'), "页面就绪")
	}
	const clickText = async text => {
		const ok = await evalJs(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
		if (!ok) throw new Error(`找不到按钮：${text}`)
		await sleep(60)
	}
	const openPomo = async () => {
		await clickText("番茄")
		await until(() => evalJs('!!document.querySelector(".pomo-act")'), "番茄面板")
	}
	const snapshot = () => evalJs('JSON.parse(localStorage.getItem("pomo_focus_mute_snapshot") || "null")')
	const quiet = () => evalJs('JSON.parse(window.NoriChat.readFile("settings.json"))')
	const tick = async ms => { await evalJs(`window.__pomoAdvance(${ms})`); await sleep(1150) }
	await navigate()
	await openPomo()
	const idleCalls = await evalJs('window.__pomoCalls.state')
	await sleep(1250)
	check("空闲状态不轮询原生计时", await evalJs('window.__pomoCalls.state') === idleCalls)
	await clickText("正向计时")
	check("正向没有加号、没有满格进度条且停止文案明确", await evalJs('!document.querySelector(".pw-time").textContent.includes("+") && !document.querySelector(".pw-bar") && document.querySelector(".pw-btns .warn").textContent === "停止并保存"'))
	check("正向开始保存原静音设置并进入整个周期静音", (await snapshot())?.mode === "off" && (await quiet()).quietOn === true)
	await tick(300000)
	check("正向运行五分钟展示05:00", await evalJs('document.querySelector(".pw-time").textContent') === "05:00")
	await clickText("暂停")
	const pausedCalls = await evalJs('window.__pomoCalls.state')
	await tick(120000)
	check("暂停冻结显示并停止轮询", await evalJs('document.querySelector(".pw-time").textContent === "05:00" && document.querySelector(".pw-head").textContent.includes("已暂停 · 正向计时")') && await evalJs('window.__pomoCalls.state') === pausedCalls)
	await navigate()
	check("暂停重开后保留显示和原静音快照", await evalJs('document.querySelector(".pw-time").textContent === "05:00"') && (await snapshot())?.mode === "off")
	await clickText("继续")
	await tick(180000)
	check("五分钟运行+两分钟暂停+三分钟运行展示08:00", await evalJs('document.querySelector(".pw-time").textContent') === "08:00")
	await openPomo()
	await clickText("保存并转倒计时")
	check("转倒计时先保存正向段且持续静音", await evalJs('window.__pomoProbe.events.at(-1).phase === "countUp" && window.__pomoProbe.events.at(-1).reason === "switch" && window.__pomoProbe.events.at(-1).elapsedMs === 480000') && (await quiet()).quietOn === true)
	await tick(60000)
	await clickText("保存并转正向")
	check("转正向先保存未完成专注段", await evalJs('window.__pomoProbe.events.at(-1).phase === "focus" && window.__pomoProbe.events.at(-1).reason === "switch" && window.__pomoProbe.events.at(-1).elapsedMs === 60000'))
	await clickText("停止正向")
	check("停止正向还原进入周期前的静音配置", (await quiet()).quietMode === "off" && (await quiet()).quietOn === false && await snapshot() === null)

	const day = (focusMin, done = 0, abort = 0) => ({focusMin, done, abort, countUpMin: 0})
	const stat = {v: 2, days: {"2026-10-07": {...day(45, 1, 1), completedCount: 1, completedFocusMin: 25}, "2026-09-17": day(20), "2026-03-21": day(30)}, total: {focusMin: 95, done: 1, countUpMin: 0}, best: {dayMin: 45, streak: 1}}
	await evalJs(`window.__pomoStatsFixture(${JSON.stringify(stat)}); window.dispatchEvent(new Event("focus"))`)
	await sleep(60)
	check("平均完成段排除中断部分", await evalJs('document.querySelector(".pomo-sub").textContent.includes("平均完成段 25 分钟")'))
	check("7天汇总45分钟", await evalJs('[...document.querySelectorAll(".pomo-today")][1].textContent.includes("45 分钟")'))
	await clickText("30 天")
	check("30天标签、柱数、汇总同时切换", await evalJs('document.querySelector(".pomo-bars").children.length === 30 && [...document.querySelectorAll("label")].some(l => l.textContent === "近 30 天") && [...document.querySelectorAll(".pomo-today")][1].textContent.includes("65 分钟")'))
	await clickText("全年")
	check("365天标签、柱数、汇总同时切换", await evalJs('document.querySelector(".pomo-bars").children.length === 365 && [...document.querySelectorAll(".pomo-today")][1].textContent.includes("95 分钟")'))
	await evalJs('(() => { const row = [...document.querySelectorAll(".settings-row")].find(r => r.textContent.includes("完成时发系统通知")); row.querySelector("input").click() })()')
	check("关闭通知立即同步给原生", await evalJs('window.__pomoProbe.notify === false'))
	const notifyRequests = await evalJs('window.__pomoCalls.notifyRequest')
	await clickText("开始专注 25 分钟")
	check("通知关闭时开始也不请求系统权限", await evalJs('window.__pomoProbe.notify === false') && await evalJs('window.__pomoCalls.notifyRequest') === notifyRequests)
	const completionStats = {v: 2, days: {"2026-10-07": {...day(25, 1), completedCount: 1, completedFocusMin: 25}}, total: {focusMin: 25, done: 1, countUpMin: 0}, best: {dayMin: 25, streak: 1}}
	await evalJs(`window.__pomoSilent = true; window.__pomoStatsFixture(${JSON.stringify(completionStats)})`)
	const beforeStats = await evalJs('window.__pomoCalls.stats')
	await tick(1500000)
	check("完成回调丢失时轮询仍转入休息并刷新统计", await evalJs('document.querySelector(".pw-head").textContent.includes("休息中") && window.__pomoCalls.stats > ' + beforeStats + ' && document.querySelector(".pomo-today").textContent.includes("完成 1")'))
	check("自动休息持续静音且保存原快照", (await quiet()).quietOn === true && (await snapshot())?.mode === "off")
	await tick(300000)
	check("休息结束自动还原静音", !await evalJs('!!document.querySelector(".pomo-widget")') && (await quiet()).quietMode === "off" && await snapshot() === null)
	await evalJs('window.__noriPomoEvent(JSON.stringify(window.__pomoProbe.events.at(-2))); window.__noriPomoEvent(JSON.stringify(window.__pomoProbe.events.at(-2)))')
	check("重复完成回调不把统计重复加一", await evalJs('document.querySelector(".pomo-today").textContent.includes("完成 1") && window.__pomoProbe.stats.total.done === 1'))

	await clickText("开始专注 25 分钟")
	await tick(60000)
	await clickText("放弃当前")
	check("放弃保存原快照并开始安静保持", (await snapshot())?.stage === "sulk" && (await quiet()).quietOn === true)
	await navigate()
	check("放弃后重开保持截止时间与原设置", (await snapshot())?.stage === "sulk" && (await snapshot())?.mode === "off" && (await quiet()).quietOn === true)
	await evalJs('window.__pomoAdvance(660000); window.dispatchEvent(new Event("focus"))')
	await sleep(60)
	check("重开后到期恢复放弃前的静音设置", (await quiet()).quietMode === "off" && (await quiet()).quietOn === false && await snapshot() === null)
	await openPomo()
	await clickText("开始专注 25 分钟")
	await clickText("设置")
	await evalJs('(() => { const s = [...document.querySelectorAll("select")].find(s => [...s.options].some(o => o.value === "manual") && [...s.options].some(o => o.value === "auto")); s.value = "off"; s.dispatchEvent(new Event("change", {bubbles: true})) })()')
	await sleep(60)
	check("手动改静音后保存用户接管标记", (await snapshot())?.stage === "user" && (await quiet()).quietMode === "off")
	await navigate()
	check("运行中重开尊重用户手动静音选择", (await snapshot())?.stage === "user" && (await quiet()).quietMode === "off")
	await clickText("放弃")
	check("用户接管后放弃也不覆盖静音选择", (await quiet()).quietMode === "off" && await snapshot() === null)

	await openPomo()
	await clickText("正向计时")
	await evalJs('window.__pomoWallShift(86400000)')
	await sleep(1150)
	check("只调整墙钟不让运行显示跳一天", await evalJs('document.querySelector(".pw-time").textContent === "00:00"'))
	await evalJs('window.dispatchEvent(new Event("focus"))')
	await sleep(60)
	check("回前台刷新日期，今日统计切到新的一天", await evalJs('document.querySelector(".pomo-today").textContent.includes("0 分钟 · 完成 0")'))
	await evalJs('Object.defineProperty(document, "hidden", {configurable: true, value: true}); document.dispatchEvent(new Event("visibilitychange"))')
	const hiddenCalls = await evalJs('window.__pomoCalls.state')
	await sleep(1200)
	check("后台停止计时轮询", await evalJs('window.__pomoCalls.state') === hiddenCalls)
	await evalJs('window.__pomoAdvance(120000); Object.defineProperty(document, "hidden", {configurable: true, value: false}); document.dispatchEvent(new Event("visibilitychange"))')
	await sleep(60)
	check("回前台立即显示后台经过的时长", await evalJs('document.querySelector(".pw-time").textContent === "02:00"'))
} catch (e) {
	check("探针执行", false, e.stack || String(e))
} finally {
	if (ws) ws.close()
	if (edge) spawn("taskkill", ["/PID", String(edge.pid), "/T", "/F"], {stdio: "ignore", windowsHide: true})
	if (harness) harness.kill()
}
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`)
if (results.some(r => !r.ok)) process.exitCode = 1
