/* 探针: 设置 →「更多工具」里的「界面字体」（2026-10-15 用户要求）
 *
 * 验的是**用户真正会走的那条路**：
 *   ① 设置面板 →「更多工具」二级菜单里有「界面字体」行，三个选项（系统默认 / 霞鹜文楷 / 站酷快乐体）
 *   ② 默认 = 系统默认：<html data-ui-font="system">，正文不会用上 Nori WenKai
 *   ③ 点「霞鹜文楷」→ data-ui-font=wenkai，**真的用上了**这套字体（与"不存在的字体"逐像素对比不同）
 *      ，并且落盘 settings.json（重启后还在）
 *   ④ 点「站酷快乐体」→ 同理（Nori KuaiLe）
 *   ⑤ 点回「系统默认」→ 回到系统字体栈（不留 data-ui-font=wenkai 的残留）
 *
 * 为什么加"逐像素对比"：只查 `font-family` 字符串会骗人 —— 字体没加载时字符串照样写着
 *   "Nori WenKai"，但渲染出来是系统字体（2026-10-15 做预览页时踩过这个坑）。
 *
 * 运行: node tmp-memcheck/probe-ui-font.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9477
const profile = mkdtempSync(join(tmpdir(), "nori-uifont-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sid) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sid ? {sessionId: sid} : {})}))
	return new Promise((res, rej) => {
		pending.set(m, {res, rej})
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 30000)
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
	const seed = Buffer.from(JSON.stringify({baseUrl: "https://api.probe.test", model: "m"})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${seed}`}, sessionId)
	await sleep(4300)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)

	/* 现场：界面字体那一行 + html 上的 data-ui-font + body 实际字体栈 */
	const state = () => evalJs(`(() => {
		const body = document.querySelector(".sheet .sheet-body")
		if (!body) return {ok: false}
		const row = [...body.querySelectorAll(".settings-row")].find(r => /界面字体/.test(r.querySelector("label")?.textContent || ""))
		const btns = row ? [...row.querySelectorAll("button")] : []
		const det = row ? row.closest("details") : null
		const cs = getComputedStyle(document.body)
		return {
			ok: true,
			inTools: !!det && /更多工具/.test(det.querySelector("summary")?.textContent || ""),
			labels: btns.map(b => b.textContent.trim()),
			on: btns.filter(b => b.classList.contains("on")).map(b => b.textContent.trim()),
			attr: document.documentElement.getAttribute("data-ui-font"),
			font: cs.fontFamily,
			saved: (() => { try { return JSON.parse(window.NoriChat.readFile("settings.json") || "{}").uiFont ?? null } catch (e) { return "err" } })(),
		}
	})()`)

	/** 这个字体到底有没有被用上：把同一句用"候选字体"和"不存在的字体"各画一遍，像素不同才算真生效 */
	const reallyUsed = (fam) => evalJs(`(() => {
		const cv = document.createElement("canvas"); cv.width = 96; cv.height = 96
		const ctx = cv.getContext("2d", {willReadFrequently: true})
		const draw = (f) => { ctx.clearRect(0,0,96,96); ctx.font = '40px ' + f; ctx.textBaseline = "top"; ctx.fillStyle = "#000"; ctx.fillText("界面字体霞鹜文楷", 4, 4); return cv.toDataURL() }
		return draw('"' + ${JSON.stringify(fam)} + '"') !== draw('"__NoSuchFontZZ__"')
	})()`)

	const openSettings = async () => {
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(900)
	}
	const click = (label) => evalJs(`(() => {
		const body = document.querySelector(".sheet .sheet-body")
		const row = [...body.querySelectorAll(".settings-row")].find(r => /界面字体/.test(r.querySelector("label")?.textContent || ""))
		if (!row) return "no-row"
		const b = [...row.querySelectorAll("button")].find(x => x.textContent.trim() === ${JSON.stringify(label)})
		if (!b) return "no-btn"
		b.click(); return "clicked"
	})()`)

	/* ================= ① 位置与选项 ================= */
	await openSettings()
	const s0 = await state()
	check("①-1 设置里能找到「界面字体」行且它确实在「更多工具」二级菜单里", s0.ok === true && s0.inTools === true, JSON.stringify(s0))
	check("①-2 三个选项：系统默认 / 霞鹜文楷 / 站酷快乐体",
		JSON.stringify(s0.labels) === JSON.stringify(["系统默认", "霞鹜文楷", "站酷快乐体"]), JSON.stringify(s0.labels))
	check("①-3 默认选中「系统默认」", JSON.stringify(s0.on) === JSON.stringify(["系统默认"]), JSON.stringify(s0.on))
	check("①-4 默认不写 data-ui-font=wenkai/kuaile（= 还是系统字体）",
		s0.attr === "system" || s0.attr === null, JSON.stringify(s0.attr))
	check("①-5 系统字体栈里没有 Nori WenKai / Nori KuaiLe",
		!/Nori WenKai|Nori KuaiLe/.test(s0.font || ""), JSON.stringify(s0.font))

	/* ================= ② 切到霞鹜文楷 ================= */
	const c1 = await click("霞鹜文楷")
	await sleep(1200)
	const s1 = await state()
	check("②-1 点得动「霞鹜文楷」", c1 === "clicked", String(c1))
	check("②-2 <html data-ui-font=wenkai>", s1.attr === "wenkai", JSON.stringify(s1.attr))
	check("②-3 body 字体栈切到 Nori WenKai", /Nori WenKai/.test(s1.font || ""), JSON.stringify(s1.font))
	check("②-4 **字体真的生效**（与不存在字体的渲染像素不同）", (await reallyUsed("Nori WenKai")) === true, "字形没换")
	check("②-5 选中态落在「霞鹜文楷」上", JSON.stringify(s1.on) === JSON.stringify(["霞鹜文楷"]), JSON.stringify(s1.on))
	check("②-6 已落盘 settings.json（重启后还在）", s1.saved === "wenkai", JSON.stringify(s1.saved))
	/* ②-7 真 Bold：界面里 600/700 的地方很多，只声明 400 的话浏览器会"合成加粗"（小字号发糊）。
	   这里要求 "Nori WenKai" 至少有 2 张 face、且高字重那张被真的加载了。 */
	const boldFace = await evalJs(`(async () => {
		await document.fonts.load('700 20px "Nori WenKai"', '界面字体');
		await document.fonts.load('600 20px "Nori WenKai"', '界面字体');
		const faces = [...document.fonts].filter(f => f.family.replace(/"/g, "") === "Nori WenKai");
		return {count: faces.length, weights: faces.map(f => String(f.weight)).sort(),
			boldLoaded: faces.some(f => /^(6|7|8|9)/.test(String(f.weight)) && f.status === "loaded")};
	})()`)
	check("②-7 文楷有**真 Bold** face（不是只靠浏览器合成加粗）",
		boldFace.count >= 2 && boldFace.boldLoaded === true, JSON.stringify(boldFace))

	/* ================= ③ 切到站酷快乐体 ================= */
	const c2 = await click("站酷快乐体")
	await sleep(1200)
	const s2 = await state()
	check("③-1 点得动「站酷快乐体」", c2 === "clicked", String(c2))
	check("③-2 <html data-ui-font=kuaile>", s2.attr === "kuaile", JSON.stringify(s2.attr))
	check("③-3 body 字体栈切到 Nori KuaiLe", /Nori KuaiLe/.test(s2.font || ""), JSON.stringify(s2.font))
	check("③-4 **字体真的生效**", (await reallyUsed("Nori KuaiLe")) === true, "字形没换")
	check("③-5 已落盘 uiFont=kuaile", s2.saved === "kuaile", JSON.stringify(s2.saved))

	/* ================= ④ 切回系统默认 ================= */
	const c3 = await click("系统默认")
	await sleep(900)
	const s3 = await state()
	check("④-1 点得动「系统默认」", c3 === "clicked", String(c3))
	check("④-2 data-ui-font 回到 system", s3.attr === "system", JSON.stringify(s3.attr))
	check("④-3 字体栈里不再有 Nori WenKai / Nori KuaiLe",
		!/Nori WenKai|Nori KuaiLe/.test(s3.font || ""), JSON.stringify(s3.font))
	check("④-4 已落盘 uiFont=system", s3.saved === "system", JSON.stringify(s3.saved))

	/* ================= ⑤ 启动时读取（等价于"重启后还在"） =================
	 * ⚠ 不能用"重新开页再看 settings.json"来验：harness 的假桥是**每页内存**的，
	 *   重新导航后文件自然是空的（那样测的是假桥，不是我们的代码）。
	 *   正确做法：用 seed 预置一份 settings.json（等价于用户上次选过），看启动时有没有应用。 */
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${Buffer.from(JSON.stringify({baseUrl: "https://api.probe.test", model: "m", uiFont: "wenkai"})).toString("base64url")}`}, sessionId)
	await sleep(4500)
	const booted = await evalJs(`(() => ({attr: document.documentElement.getAttribute("data-ui-font"), font: getComputedStyle(document.body).fontFamily}))()`)
	check("⑤-1 启动时读设置并应用（预置 uiFont=wenkai → data-ui-font=wenkai）", booted.attr === "wenkai", JSON.stringify(booted.attr))
	check("⑤-2 启动即用上 Nori WenKai（不用手点）", /Nori WenKai/.test(booted.font || ""), JSON.stringify(booted.font))

	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${Buffer.from(JSON.stringify({baseUrl: "https://api.probe.test", model: "m", uiFont: "手改坏的值"})).toString("base64url")}`}, sessionId)
	await sleep(4500)
	const bad = await evalJs(`document.documentElement.getAttribute("data-ui-font")`)
	check("⑤-3 设置文件里是坏值 → 归一化成 system（不许把坏值写进 DOM）", bad === "system", JSON.stringify(bad))
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
