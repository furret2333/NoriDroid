/* 真 Vue 页面 + 可控、持久化的桥契约夹具；只验证 UI 联动。
 * 原生计时/跨天/账本算法由 PomodoroTest 验证，不能用本假桥证明 Android 后台通知。 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync, mkdirSync} from "node:fs"
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
	const idle = () => ({sessionId: crypto.randomUUID(), phase: "idle", paused: false, elapsed: 0, segment: 0, focusMin: 25, breakMin: 5, autoBreak: true})
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
			db.st = focus && db.st.autoBreak ? {...db.st, sessionId: crypto.randomUUID(), phase: "break", elapsed: 0, segment: db.mono - extra} : idle()
			save()
		}
	}
	const snap = () => {
		const st = db.st, el = ["focus", "break"].includes(st.phase) ? Math.min(duration(), elapsed()) : elapsed()
		const remaining = ["focus", "break"].includes(st.phase) ? duration() - el : 0
		return JSON.stringify({...st, now: db.wall, days: ["focus", "countUp"].includes(st.phase) ? {"2026-10-07": el} : {}, eventSeq: db.seq, elapsedMs: el, remainingMs: remaining, remainMs: st.phase === "countUp" ? el : remaining,
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
				finish("switch"); db.st = {...idle(), phase: "focus", paused: false, elapsed: 0, segment: db.mono, focusMin: f, breakMin: b, autoBreak: ab}
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
            nc.pomoStopSession = session => {
                if (window.__pomoStopAdvance) { window.__pomoAdvance(window.__pomoStopAdvance); window.__pomoStopAdvance = 0 }
                complete()
                if (session !== db.st.sessionId || db.st.phase === "idle") return JSON.stringify({ok: false, message: "计时阶段已变化"})
                return nc.pomoStop()
            }
			nc.pomoMarkCelebrated = key => { db.stats.celebrated = {...db.stats.celebrated, [key]: db.wall}; save(); return JSON.stringify(db.stats) }
            nc.pomoDashboard = () => {
                window.__pomoCalls.stats++; complete()
                if (window.__pomoReadError) return JSON.stringify({ok: false, message: "测试读取失败"})
                db.stats.lastEventSeq = db.seq
                return JSON.stringify({ok: true, state: window.__pomoBadState ? {phase: "broken"} : JSON.parse(snap()), stats: db.stats,
                    syncStatus: window.__pomoSyncPending ? "pending" : "ok", syncedAt: db.wall,
                    reminder: {permission: false, channel: true, exact: false}})
            }
            nc.pomoStartPlan = options => {
                const o = JSON.parse(options); window.__pomoPlan = o
                const result = nc.pomoStart(o.focusMin, o.breakMin, o.autoBreak)
                db.st = {...db.st, ...o}; save(); return snap()
            }
            nc.pomoStartFree = goal => { nc.pomoStartCountUp(); db.st.goal = goal; return snap() }
            nc.pickPomoBackup = () => window.__noriPomoPickedRes?.(JSON.stringify({ok: true, content: window.__pomoBackup}))
            nc.pomoRestoreBackup = raw => { const o = JSON.parse(raw); db.stats = o.stats; save(); return nc.pomoDashboard() }
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
		const ok = await evalJs(`(() => { const b = [...document.querySelectorAll("button,summary")].find(b => b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute("aria-label") === ${JSON.stringify(text)} || b.matches("summary") && b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true })()`)
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

    const refresh = async () => { await evalJs('window.dispatchEvent(new Event("focus"))'); await sleep(80) }
    const advance = async ms => { await evalJs(`window.__pomoAdvance(${ms})`); await refresh() }
    const press = async text => { await clickText(text); await sleep(300) }
    const metric = async index => evalJs(`document.querySelectorAll(".focus-metrics strong")[${index}].textContent.trim()`)
    const settingsFile = () => evalJs('JSON.parse(window.NoriChat.readFile("settings.json"))')
    await navigate()
    await openPomo()
    check("计时卡片和暂停操作优先，默认25:00", await evalJs('document.querySelector(".focus-time").textContent === "25:00" && !!document.querySelector(".focus-clock .focus-actions")'))
    check("手机360宽无横向溢出", await evalJs('document.querySelector(".focus-sheet").getBoundingClientRect().right <= innerWidth && document.querySelector(".focus-panel").scrollWidth <= document.querySelector(".focus-panel").clientWidth + 1'))
    const idleCalls = await evalJs('window.__pomoCalls.state')
    await sleep(1200)
    check("空闲不轮询", await evalJs('window.__pomoCalls.state') === idleCalls)
    await evalJs('document.querySelector(".focus-goal-input input").value="阅读一章";document.querySelector(".focus-goal-input input").dispatchEvent(new Event("input",{bubbles:true}))')
    await sleep(650)
    check("专注配置进入统一settings.json", (await settingsFile()).pomo?.goal === "阅读一章" && (await settingsFile()).pomo?.dailyGoal === 60)
    await press("正向计时 ↗")
    check("面板内运行，隐藏重复小挂件并保留目标", await evalJs('!document.querySelector(".pomo-widget") && document.querySelector(".focus-current-goal").textContent === "阅读一章"'))
    check("临时安静策略不改全局设置", (await settingsFile()).quietMode === "off" && (await settingsFile()).quietOn === false && (await snapshot())?.v === 2)
    await advance(300000)
    check("正向运行5分钟且今日进行中显示5", await evalJs('document.querySelector(".focus-time").textContent === "05:00"') && (await metric(1)).startsWith("5"))
    await press("Ⅱ 暂停")
    const pausedCalls = await evalJs('window.__pomoCalls.state')
    await evalJs('window.__pomoAdvance(120000)'); await sleep(1200)
    check("暂停冻结时间并停轮询", await evalJs('document.querySelector(".focus-time").textContent === "05:00"') && await evalJs('window.__pomoCalls.state') === pausedCalls)
    await navigate(); await openPomo()
    check("暂停重开保留时间和安静快照", await evalJs('document.querySelector(".focus-time").textContent === "05:00"') && (await snapshot())?.v === 2)
    await press("▶ 继续"); await advance(180000)
    check("恢复后只累计实际运行8分钟", await evalJs('document.querySelector(".focus-time").textContent === "08:00"'))
    await press("保存本段，转倒计时 ↗")
    check("切换先保存正向段并传完整计划", await evalJs('window.__pomoProbe.events.at(-1).phase === "countUp" && window.__pomoProbe.events.at(-1).elapsedMs === 480000 && window.__pomoPlan.goal === "阅读一章" && window.__pomoPlan.autoFocus === false'))
    await advance(60000)
    const count = await evalJs('window.__pomoProbe.events.length')
    await press("结束并保存")
    check("提前结束先确认，未提前落事件", await evalJs('!!document.querySelector("[role=alertdialog]") && window.__pomoProbe.events.length === ' + count))
    await press("继续专注")
    check("取消结束继续当前会话", await evalJs('window.__pomoProbe.st.phase === "focus"'))
    await press("结束并保存"); await press("确认结束并保存")
    check("确认结束只结算一次，保留原全局安静选择", await evalJs('window.__pomoProbe.events.length === ' + (count + 1) + ' && window.__pomoProbe.events.at(-1).elapsedMs === 60000') && (await settingsFile()).quietMode === "off")
    await press("▶ 开始专注")
    await press("关闭")
    check("退出面板显示展开挂件", await evalJs('!!document.querySelector(".pomo-widget .pw-time")'))
    await send("Emulation.setDeviceMetricsOverride", {width:280,height:500,deviceScaleFactor:1,mobile:true},sessionId); await sleep(80)
    check("窄屏缩放后挂件仍在可视范围", await evalJs('(()=>{const r=document.querySelector(".pomo-widget").getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()'))
    await send("Emulation.setDeviceMetricsOverride", {width:360,height:780,deviceScaleFactor:1,mobile:true},sessionId); await sleep(80)
    await press("—")
    check("收起显示阶段和暂停入口", await evalJs('document.querySelector(".pw-pill small").textContent === "专注中" && !!document.querySelector(".pw-mini-control")'))
    await evalJs('document.querySelector(".pw-mini-control").click()'); await sleep(300)
    check("收起态直接暂停", await evalJs('window.__pomoProbe.st.paused && document.querySelector(".pw-pill small").textContent.includes("已暂停")'))
    await evalJs('document.querySelector(".pw-pill").click()'); await sleep(80)
    await openPomo()
    check("打开面板挂件不遮挡", !await evalJs('!!document.querySelector(".pomo-widget")'))
    await press("结束并保存"); await press("确认结束并保存")
    const day = (focusMin, done=0, countUpMin=0) => ({focusMin,done,abort:0,countUpMin})
    const stats = {v:2,days:{"2026-10-07":day(30,1,5),"2026-09-17":day(120,4),"2026-08-17":day(240,8)},total:{focusMin:390,countUpMin:5,done:13},best:{dayMin:240,streak:1}}
    await evalJs(`window.__pomoStatsFixture(${JSON.stringify(stats)})`); await refresh()
    check("今日已记录包含两种计时", (await metric(0)).startsWith("35"))
    await press("查看统计 ↗")
    check("累计包含倒计时和正向", await evalJs('document.querySelector(".pomo-today").textContent.includes("6 小时 35 分")'))
    check("月度历史柱比例不会都变满格", await evalJs('Math.round(parseFloat(document.querySelectorAll(".pm-bar i")[0].style.width)) === 15 && parseFloat(document.querySelectorAll(".pm-bar i")[1].style.width) === 50 && parseFloat(document.querySelectorAll(".pm-bar i")[2].style.width) === 100'))
    await press("近 30 天")
    check("30天汇总和点选日期", await evalJs('document.querySelectorAll(".pomo-selectable-bars button").length === 30'))
    await evalJs('document.querySelector(".pomo-selectable-bars button:last-child").click()'); await sleep(50)
    check("点选显示日期明细", await evalJs('document.querySelector(".pomo-daybox").textContent.includes("2026-10-07")'))
    await press("近一年")
    check("近一年使用热力图不挤365根柱", await evalJs('!!document.querySelector(".pomo-heat") && !document.querySelector(".pomo-selectable-bars")'))
    await press("‹ 返回计时")
    await evalJs('window.__pomoReadError=true'); await refresh()
    check("读取失败保留旧数字并显示错误", (await metric(0)).startsWith("35") && await evalJs('document.querySelector(".focus-notice.is-error").textContent.includes("暂未更新")'))
    await evalJs('window.__pomoReadError=false;window.__pomoSyncPending=true'); await press("重试")
    await press("记录与备份")
    check("副本同步失败与本机保存分开显示", await evalJs('document.querySelector(".focus-panel").textContent.includes("本机已保存，公共副本待同步")'))
    await press("导出 JSON 备份")
    check("JSON导出有版本和专注记录", await evalJs('Object.entries(window.__pomoProbe.files).some(([k,v])=>k.startsWith("nori-focus-") && k.endsWith(".json") && JSON.parse(v).kind === "nori-pomodoro")'))
    const backup = JSON.stringify({kind:"nori-pomodoro",version:1,stats:{v:2,days:{"2001-01-01":day(10,1)},total:{focusMin:10,countUpMin:0,done:1},best:{dayMin:10,streak:1}}})
    await evalJs(`window.__pomoBackup=${JSON.stringify(backup)}`)
    await press("从 JSON 备份恢复 ↗")
    check("恢复先预览而不直接覆盖", await evalJs('document.querySelector(".focus-confirm").textContent.includes("备份中有 1 天、10 分钟") && window.__pomoProbe.stats.total.focusMin===390'))
    await press("确认替换记录")
    await press("从 JSON 备份恢复 ↗"); await press("确认替换记录")
    check("重复替换恢复不叠加", await evalJs('window.__pomoProbe.stats.total.focusMin === 10 && Object.keys(window.__pomoProbe.stats.days).length === 1'))
    await press("正向计时 ↗")
    await evalJs('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))')
    const hiddenCalls = await evalJs('window.__pomoCalls.state'); await sleep(1200)
    check("隐藏页面不轮询", await evalJs('window.__pomoCalls.state') === hiddenCalls)
    await evalJs('window.__pomoAdvance(120000);Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"))'); await sleep(100)
    check("恢复可见立即校准时间", await evalJs('document.querySelector(".focus-time").textContent === "02:00"'))
    await press("结束并保存")
    await press("▶ 开始专注"); await press("结束并保存")
    await evalJs('window.NoriChat.pomoStartPlan(JSON.stringify(window.__pomoPlan))'); await refresh()
    check("新会话即使同为专注也清除旧结束确认", await evalJs('window.__pomoProbe.st.phase === "focus" && !document.querySelector("[role=alertdialog]")'))
    await press("结束并保存")
    await evalJs('window.__pomoSilent=true;window.__pomoStopAdvance=window.__pomoProbe.st.focusMin*60000')
    const beforeBoundary = await evalJs('window.__pomoProbe.events.length')
    await press("确认结束并保存")
    check("到点瞬间的旧结束请求不会停止新休息", await evalJs('window.__pomoProbe.st.phase === "break" && window.__pomoProbe.events.length === ' + (beforeBoundary + 1) + ' && document.querySelector(".focus-notice.is-error").textContent.includes("结束未确认")'))
    await press("结束休息")
    await press("正向计时 ↗"); await advance(50000)
    await evalJs('window.__pomoAdvance(20000)'); await press("结束并保存")
    check("结束摘要使用原生最终时长而非旧快照", await evalJs('window.__pomoProbe.events.at(-1).elapsedMs === 70000 && document.querySelector(".focus-notice:not(.is-error)").textContent.includes("本段 1 分钟")'))
    const savedBeforeInvalid = await metric(0)
    await evalJs('window.__pomoBadState=true'); await refresh()
    check("异常仪表盘状态保留错误与上次统计", (await metric(0)) === savedBeforeInvalid && await evalJs('document.querySelector(".focus-notice.is-error").textContent.includes("计时状态格式异常")'))
    await evalJs('window.__pomoBadState=false'); await refresh()
    const shotDir = path.join(root,"tmp-memcheck/pomodoro-ui"); mkdirSync(shotDir,{recursive:true})
    await evalJs('document.querySelector(".sheet-body").scrollTop=0')
    const image = await send("Page.captureScreenshot",{format:"png"},sessionId)
    writeFileSync(path.join(shotDir,"focus-mobile.png"),Buffer.from(image.data,"base64"))
    console.log("Screenshot: " + path.join(shotDir,"focus-mobile.png"))

} catch (e) {
	check("探针执行", false, e.stack || String(e))
} finally {
	if (ws) ws.close()
	if (edge) spawn("taskkill", ["/PID", String(edge.pid), "/T", "/F"], {stdio: "ignore", windowsHide: true})
	if (harness) harness.kill()
}
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`)
if (results.some(r => !r.ok)) process.exitCode = 1
