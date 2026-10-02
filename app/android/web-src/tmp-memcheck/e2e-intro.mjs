/* E2E: 首次打开的新手引导弹窗 + 设置页「新手引导」按钮 (2026-09-26 用户要求)。
 *
 * 断言真实 DOM + 真实 localStorage + 真实音效调用:
 *   ① 首次打开 (未建立目录 / 无 intro_seen 标记) → 自动弹出, 停在「第 1 / 4 步」;
 *   ② 分步内容与文档一致 (同人二创 / 小桧重构 / 洱海·亓才孑 / API 需付费 / 白夜Tira·I_Nori / 反馈 bug);
 *   ③ 下一步/上一步能走完 4 步, 结束时弹窗关闭并写下 intro_seen 标记;
 *   ④ 每一步切换都调用了按键音 (监听 Audio 构造与 play);
 *   ⑤ 再看一次不会自动弹; 设置页底部「新手引导」按钮能重新打开 (且「更新记录」已删除)。
 *
 * 运行: node tmp-memcheck/e2e-intro.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9405
const profile = mkdtempSync(join(tmpdir(), "nori-intro-"))
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

/** 在页面里钩住 Audio: 记录被播放的音效路径与次数 (用来证明"真的调了音效") */
const HOOK_AUDIO = `(() => {
	window.__sfxLog = [];
	const Orig = window.Audio;
	window.Audio = function (src) {
		const a = new Orig(src);
		const op = a.play.bind(a);
		a.play = function () { window.__sfxLog.push(String(src)); return op().catch(() => {}); };
		return a;
	};
	window.Audio.prototype = Orig.prototype;
	return true;
})()`

try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	const jsErrors = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") jsErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?")
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
	const nav = async () => {
		await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
		await sleep(4200)
		await evalJs(HOOK_AUDIO)   // 页面内钩子 (导航后要重装)
	}

	/* ---- 首次打开: 清掉标记, 让它像新装一样 ---- */
	await nav()
	await evalJs(`localStorage.removeItem("intro_seen_v1"); localStorage.removeItem("storage_asked"); "ok"`)
	await nav()
	// 自动弹出有 1.6s 延迟
	await sleep(2200)
	const step1 = await evalJs(`(() => {
		const m = document.querySelector(".intro-mask")
		if (!m) return {shown: false}
		return {
			shown: true,
			step: (m.querySelector(".intro-step") || {}).innerText || "",
			emoji: (m.querySelector(".intro-emoji") || {}).innerText || "",
			title: (m.querySelector(".intro-title") || {}).innerText || "",
			body: (m.querySelector(".intro-body") || {}).innerText || "",
			dots: m.querySelectorAll(".intro-dots i").length,
			nextLabel: (m.querySelector(".intro-next") || {}).innerText || "",
			hasPrev: !!m.querySelector(".intro-prev"),
			zIndex: getComputedStyle(m).zIndex,
		}
	})()`)
	console.log(`   第1屏: ${JSON.stringify(step1)}`)
	check("首次打开自动弹出新手引导", step1.shown === true, JSON.stringify(step1))
	check("显示为多步 (第 1 / 4 步, 4 个圆点)", step1.step.includes("1 / 4") && step1.dots === 4, JSON.stringify(step1))
	check("第 1 步含「同人二创」与免责说明", step1.body.includes("同人二创") && step1.body.includes("与原作无关"), step1.body)
	check("第 1 步没有「上一步」按钮", step1.hasPrev === false)
	check("弹窗层级在面板之上 (z-index ≥ 80)", Number(step1.zIndex) >= 80, step1.zIndex)

	/* ---- 逐步走完, 收集每步正文 + 音效 ---- */
	const seen = []
	const walk = [
		["第2步 作者", ["小桧", "471419518", "洱海", "亓才孑", "DeepEr", "可共存"]],
		["第3步 API", ["LLM", "DeepSeek", "TTS", "Fish Audio", "千问", "Audio 3.1", "群里自行截取"]],
		["第4步 致谢", ["白夜", "Tira", "I_Nori", "反馈 bug", "越来越好"]],
	]
	for (const [label, keys] of walk) {
		await evalJs(`document.querySelector(".intro-next")?.click()`)
		await sleep(400)
		const s = await evalJs(`(() => {
			const m = document.querySelector(".intro-mask")
			if (!m) return {shown: false}
			return {shown: true, step: (m.querySelector(".intro-step")||{}).innerText||"",
				body: (m.querySelector(".intro-body")||{}).innerText||"",
				nextLabel: (m.querySelector(".intro-next")||{}).innerText||"",
				hasPrev: !!m.querySelector(".intro-prev")}
		})()`)
		seen.push({label, s})
		const missing = keys.filter(k => !s.body.includes(k))
		check(`${label}: 弹窗仍在且内容完整`, s.shown === true && missing.length === 0, `缺 ${JSON.stringify(missing)} | ${s.body.slice(0, 120)}`)
	}
	const last = seen[seen.length - 1].s
	check("最后一步按钮变成「开始使用」", last.nextLabel.includes("开始使用"), last.nextLabel)
	check("第 2 步起出现「上一步」", seen[0].s.hasPrev === true)

	/* ---- 最后一步的**按钮排版**: 四个按钮必须完整落在弹窗与视口内 ----
	 * 2026-10-02 用户截图: 加了「项目仓库」之后, 四个按钮(项目仓库 / 加入 Steam 愿望单 /
	 * 上一步 / 开始使用)挤在同一行 ≈525px, 而 360px 屏的弹窗内容宽只有 294px,
	 * 整行溢出到屏幕右边, 右侧两个按钮被裁掉(截图里只看得到半个「加入 Steam 愿…」)。
	 * 这里量 getBoundingClientRect(): 每个按钮 left ≥ 0 且 right ≤ 视口宽, 并且不超出弹窗本身。
	 * 反向验证: 把布局改回"一行挤爆"的样子, 这一条必须红。 */
	const INTRO_BTNS = ["intro-repo", "intro-steam", "intro-prev", "intro-next"]
	const measureIntroBtns = () => evalJs(`(() => {
		const panel = document.querySelector(".intro")
		const mask = document.querySelector(".intro-mask")
		if (!panel || !mask) return {ok: false, why: "弹窗不在"}
		const pr = panel.getBoundingClientRect()
		const list = ${JSON.stringify(INTRO_BTNS)}.map(cls => {
			const el = document.querySelector("." + cls)
			if (!el) return {cls, missing: true}
			const r = el.getBoundingClientRect()
			return {cls, text: (el.innerText || "").replace(/\\s+/g, " ").trim(),
				left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width}
		})
		return {ok: true, vw: innerWidth, vh: innerHeight,
			panel: {left: pr.left, right: pr.right},
			maskScrollW: mask.scrollWidth, maskClientW: mask.clientWidth, list}
	})()`)
	/** 逐个按钮断言: 完整落在视口内 + 不超出弹窗左右缘 (容差 1px, 弹窗有 -0.45° 旋转) */
	const checkIntroBtnsInside = (tag, m) => {
		const bad = []
		for (const b of (m.list || [])) {
			if (b.missing) { bad.push(`${b.cls}: 按钮不存在`); continue }
			const why = []
			if (b.left < -0.5) why.push(`left=${b.left.toFixed(1)} < 0`)
			if (b.right > m.vw + 0.5) why.push(`right=${b.right.toFixed(1)} > 视口宽 ${m.vw}`)
			if (b.top < -0.5) why.push(`top=${b.top.toFixed(1)} < 0`)
			if (b.bottom > m.vh + 0.5) why.push(`bottom=${b.bottom.toFixed(1)} > 视口高 ${m.vh}`)
			if (b.right > m.panel.right + 1) why.push(`right=${b.right.toFixed(1)} 超出弹窗右缘 ${m.panel.right.toFixed(1)}`)
			if (b.left < m.panel.left - 1) why.push(`left=${b.left.toFixed(1)} 超出弹窗左缘 ${m.panel.left.toFixed(1)}`)
			if (why.length) bad.push(`${b.cls}(${b.text || "?"}): ${why.join(" / ")}`)
		}
		const brief = (m.list || []).map(b => `${b.cls}=[${b.missing ? "缺" : `${Math.round(b.left)}→${Math.round(b.right)}`}]`).join(" ")
		check(`${tag}: 四个按钮完整落在弹窗与视口内  ${brief}`, m.ok === true && bad.length === 0,
			`视口 ${m.vw}×${m.vh} | ${bad.join(" ; ")}`)
	}

	const wide = await measureIntroBtns()
	console.log(`   最后一步按钮实测 (默认视口 ${wide.vw}×${wide.vh}): ${JSON.stringify(wide.list)}`)
	checkIntroBtnsInside("引导最后一步按钮排版 (默认视口)", wide)
	check("弹窗自身没有横向溢出 (mask.scrollWidth ≤ 视口宽)",
		wide.ok === true && Number(wide.maskScrollW) <= Number(wide.maskClientW) + 1,
		JSON.stringify({scrollW: wide.maskScrollW, clientW: wide.maskClientW}))

	/* 窄视口 360×760: 最容易挤爆的那种手机宽度, 四个按钮同样必须完整可见 */
	await send("Emulation.setDeviceMetricsOverride", {width: 360, height: 760, deviceScaleFactor: 1, mobile: true}, sessionId)
	await sleep(600)
	const narrow = await measureIntroBtns()
	console.log(`   最后一步按钮实测 (窄视口 ${narrow.vw}×${narrow.vh}): ${JSON.stringify(narrow.list)}`)
	checkIntroBtnsInside("引导最后一步按钮排版 (窄视口 360×760)", narrow)
	check("窄视口下弹窗也不横向溢出 (mask.scrollWidth ≤ 360)",
		narrow.ok === true && Number(narrow.maskScrollW) <= Number(narrow.maskClientW) + 1,
		JSON.stringify({scrollW: narrow.maskScrollW, clientW: narrow.maskClientW}))
	await send("Emulation.clearDeviceMetricsOverride", {}, sessionId)
	await sleep(500)
	const sfxLog = await evalJs(`(window.__sfxLog || [])`)
	console.log(`   当前按键音调用明细: ${JSON.stringify(sfxLog)}`)
	check("切换步骤时调用了按键音效 (每步一记)", sfxLog.filter(s => /button_click/.test(s)).length >= 3,
		`count=${sfxLog.filter(s => /button_click/.test(s)).length}`)

	/* ---- 点「开始使用」: 关闭 + 写标记 ---- */
	const beforeFinish = await evalJs(`({log: (window.__sfxLog||[]).length, step: (document.querySelector(".intro-step")||{}).innerText||"", label: (document.querySelector(".intro-next")||{}).innerText||""})`)
	console.log(`   点开始使用前: ${JSON.stringify(beforeFinish)}`)
	await evalJs(`document.querySelector(".intro-next")?.click()`)
	await sleep(800)
	const afterClose = await evalJs(`({mask: !!document.querySelector(".intro-mask"), seen: localStorage.getItem("intro_seen_v1"), log: (window.__sfxLog||[]).length})`)
	console.log(`   点开始使用后: ${JSON.stringify(afterClose)}`)
	check("点「开始使用」后弹窗关闭", afterClose.mask === false, JSON.stringify(afterClose))
	check(`关闭时也响了按键音 (关闭前 log=${beforeFinish.log} → 关闭后 ${afterClose.log})`,
		afterClose.log > beforeFinish.log, JSON.stringify({beforeFinish, afterClose}))
	check("关闭后写下 intro_seen 标记", afterClose.seen === "1", JSON.stringify(afterClose))

	/* ---- 再打开 App: 不该自动弹 ---- */
	await nav()
	await sleep(2400)
	check("第二次打开不再自动弹", (await evalJs(`!!document.querySelector(".intro-mask")`)) === false)

	/* ---- 设置页: 更新记录已删, 新手引导按钮可重开 ---- */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	const settings = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const txt = sheet.innerText || ""
		return {
			hasChangelog: txt.includes("更新记录") || sheet.querySelectorAll(".changelog").length > 0,
			hasIntroBtn: !!([...sheet.querySelectorAll("button")].find(b => /新手引导/.test(b.textContent))),
			introBtnText: ([...sheet.querySelectorAll("button")].find(b => /新手引导/.test(b.textContent)) || {}).textContent || "",
		}
	})()`)
	console.log(`   设置页: ${JSON.stringify(settings)}`)
	check("设置页最下方的「更新记录」已删除", settings.hasChangelog === false, JSON.stringify(settings))
	check("设置页有「新手引导」按钮", settings.hasIntroBtn === true, JSON.stringify(settings))

	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /新手引导/.test(b.textContent))?.click()`)
	await sleep(600)
	const reopened = await evalJs(`(() => {
		const m = document.querySelector(".intro-mask")
		if (!m) return {shown: false}
		return {shown: true, step: (m.querySelector(".intro-step")||{}).innerText||"", zIndex: getComputedStyle(m).zIndex}
	})()`)
	check("「新手引导」按钮能重新弹出 (并回到第 1 步)", reopened.shown === true && reopened.step.includes("1 / 4"), JSON.stringify(reopened))
	check("从设置重开时层级仍在面板之上", Number(reopened.zIndex) >= 80, reopened.zIndex)

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
