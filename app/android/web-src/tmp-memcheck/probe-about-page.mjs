/* 探针: 应用内「关于 / 隐私 / 开源许可」页（2026-10-02 用户要求）
 *
 * 走的是**用户真正会走的那条路**（不是"源码里有没有那段文字"）：
 *   ① 设置面板底部有入口按钮（且它确实在 .settings-row 里）
 *   ② **顶部第一块 .settings-row 仍是人设行**（这次不许动人设区，作回归护栏）
 *   ③ 点入口 → 用现有 sheet 面板机制打开（sheet 还在，标题变成「关于 / 隐私 / 开源许可」），页面可见有尺寸
 *   ④ 版本号与 app/android/app/build.gradle 的 versionName 一致（防版本漂移）
 *   ⑤~⑧ **正文（document.body.innerText）里四项关键内容同时存在，缺一不可**：
 *      GPL-3.0（+ 上游 DeepEr / 修改版声明）· Live2D + 专有协议链接 · 卸载丢数据警告 · Vue（第三方许可）· 471419518（反馈群）
 *   ⑨ 隐私三件套：联网做什么 / 存在哪（公共下载目录 vs 应用私有目录）/ 权限用途（INTERNET·悬浮窗·通知·所有文件访问）
 *   ⑩ 许可清单与「不随包分发」声明（人设/音效/参考音频/模型）
 *   ⑪ 页内链接真的可点：仓库 → openExternal(仓库 URL)，Live2D 协议 → openExternal(协议 URL)
 *
 * 运行: node tmp-memcheck/probe-about-page.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {fileURLToPath} from "node:url"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9456
const REPO = "https://github.com/furret2333/NoriDroid"
const EULA = "https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html"
const profile = mkdtempSync(join(tmpdir(), "nori-about-"))
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
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")

/** 版本号的**唯一权威来源**: app/android/app/build.gradle 的 versionName。
 *  探针直接读它来对页面上的版本 —— 免得"页面上写的版本"和"真正打包的版本"各说各话。 */
const gradleVersion = (() => {
	try {
		const txt = readFileSync(fileURLToPath(new URL("../../app/build.gradle", import.meta.url)), "utf-8")
		return (txt.match(/versionName\s+"([^"]+)"/) || [])[1] || ""
	} catch { return "" }
})()

/* 假桥: 只加 openExternal（记录被打开的外链），其余沿用 harness 注入的那套 */
const FAKE = `(() => {
	window.__opened = [];
	const nc = window.NoriChat || (window.NoriChat = {});
	nc.openExternal = function (url) { window.__opened.push(url) };
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
	const seed = {apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m", ttsProvider: "cosyvoice"}

	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(seed)}`}, sessionId)
	await sleep(4300)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await evalJs(FAKE)

	/* ================= ① 设置面板里的入口 ================= */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	const entry = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		if (!sheet) return {ok: false, why: "设置面板没打开"}
		const body = sheet.querySelector(".sheet-body")
		const btn = [...body.querySelectorAll("button")].find(b => /关于/.test(b.textContent))
		const row = btn ? btn.closest(".settings-row") : null
		const rows = [...body.querySelectorAll(".settings-row")]
		return {ok: true, title: (sheet.querySelector(".sheet-title") || {}).textContent || "",
			hasEntry: !!btn, entryText: btn ? btn.textContent.replace(/\\s+/g, " ").trim() : "",
			inSettingsRow: !!row, rowIndex: row ? rows.indexOf(row) : -1,
			firstRow: rows[0] ? rows[0].textContent.replace(/\\s+/g, " ").trim().slice(0, 60) : "",
			aboutAlready: !!document.querySelector(".about-page")}
	})()`)
	console.log(`   设置面板: ${JSON.stringify(entry)}`)
	check("① 设置面板里有「关于 / 隐私 / 开源许可」入口按钮", entry.ok === true && entry.hasEntry === true, JSON.stringify(entry))
	check("② 入口确实在 .settings-row 里（按用户要求的做法，不是裸按钮）", entry.inSettingsRow === true, JSON.stringify(entry))
	check("③ **顶部第一块 .settings-row 仍是人设行**（这次不许动人设区）",
		/人设文案/.test(entry.firstRow || ""), JSON.stringify(entry.firstRow))
	check("④ 打开设置时关于页还没渲染（是点出来的，不是一直挂在 DOM 里）", entry.aboutAlready === false, JSON.stringify(entry))

	/* ================= ② 点开 → 现有 sheet 面板机制里可见 ================= */
	await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet .sheet-body button")].find(x => /关于/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(600)
	const page = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const pg = document.querySelector(".about-page")
		if (!sheet || !pg) return {ok: false, sheet: !!sheet, page: !!pg}
		const r = pg.getBoundingClientRect()
		const cs = getComputedStyle(pg)
		const body = sheet.querySelector(".sheet-body")
		const first = pg.querySelector(".about-sec")
		const fr = first ? first.getBoundingClientRect() : null
		return {ok: true, title: (sheet.querySelector(".sheet-title") || {}).textContent || "",
			mask: !!document.querySelector(".sheet-mask"), w: Math.round(r.width), h: Math.round(r.height),
			right: Math.round(r.right), vw: innerWidth, display: cs.display, visibility: cs.visibility,
			secs: pg.querySelectorAll(".about-sec").length,
			scrollTop: body ? Math.round(body.scrollTop) : -1,
			firstSecTop: fr ? Math.round(fr.top) : null,
			bodyTop: body ? Math.round(body.getBoundingClientRect().top) : null,
			firstSecText: first ? first.textContent.replace(/\\s+/g, " ").trim().slice(0, 24) : "",
			text: document.body.innerText}
	})()`)
	check("⑤ 点入口后关于页可见（在 sheet 里、有尺寸、没被隐藏）",
		page.ok === true && page.w > 0 && page.h > 0 && page.display !== "none" && page.visibility !== "hidden",
		JSON.stringify({ok: page.ok, w: page.w, h: page.h, display: page.display}))
	check("⑥ 用的是现有 sheet 面板机制（sheet-mask + 标题变成关于页）",
		page.mask === true && /关于/.test(page.title || ""), JSON.stringify({mask: page.mask, title: page.title}))
	check("⑦ 页面不横向溢出（右边不出视口）", page.right <= page.vw + 1, JSON.stringify({right: page.right, vw: page.vw}))
	check("⑧ 四块内容都在（版本 / 隐私 / 许可 / 反馈）", page.secs >= 4, `secs=${page.secs}`)
	/* 入口在设置面板最下面, 而 .sheet-body 的滚动位置跨面板保留 —— 不滚回顶部的话点进来会直接落在
	   「开源许可」那一屏, 用户看不到开头的「版本」。 */
	check("⑧-b 点开后停在页面顶部（scrollTop=0 且第一块「版本」在可视区内）",
		page.scrollTop === 0 && page.firstSecTop !== null && page.bodyTop !== null && page.firstSecTop >= page.bodyTop - 1,
		JSON.stringify({scrollTop: page.scrollTop, firstSecTop: page.firstSecTop, bodyTop: page.bodyTop, first: page.firstSecText}))

	/* ================= ③ 关键内容: 全部用 document.body.innerText 断言 ================= */
	const txt = String(page.text || "")
	const has = (re) => re.test(txt)
	const miss = (label, re) => check(label, has(re), `正文里找不到 ${re}`)

	/* 版本 + 上游声明 */
	check("⑨ 版本号与 build.gradle 的 versionName 一致 (页面上 v" + gradleVersion + ")",
		!!gradleVersion && txt.includes(gradleVersion), `gradle=${gradleVersion} | 页面片段=${txt.slice(0, 120)}`)
	miss("⑩ 含上游声明「衍生自 DeepEr」", /衍生自[\s\S]{0,40}DeepEr/)
	miss("⑪ 含 GPL-3.0", /GPL-3\.0/)
	miss("⑫ 含「本项目为修改版」声明", /修改版/)
	miss("⑬ 含本项目仓库链接文本", /github\.com\/furret2333\/NoriDroid/)

	/* 隐私说明 */
	miss("⑭ 含「卸载会丢数据」警告", /卸载/)
	miss("⑮ 卸载说明写明「公共目录不丢 / 私有目录会清」", /卸载后一般仍在/)
	miss("⑯ 含联网事项: LLM 对话 / TTS 朗读 / 一键克隆 / 下载音效",
		/LLM 对话[\s\S]*TTS 朗读[\s\S]*一键克隆[\s\S]*下载音效/)
	miss("⑰ 含存储位置: 公共下载目录 + 应用私有目录",
		/公共下载目录[\s\S]*应用私有目录/)
	miss("⑱ 含 Download\/NoriDroid 具体路径", /Download\/NoriDroid/)
	miss("⑲ 含权限用途: INTERNET / 悬浮窗 / 通知 / 所有文件访问",
		/INTERNET[\s\S]*悬浮窗[\s\S]*通知[\s\S]*所有文件访问/)

	/* 开源许可 */
	miss("⑳ 含 Vue 3 第三方许可", /Vue 3[\s\S]{0,40}MIT/)
	miss("㉑ 含 live2d-easy-control（被打补丁=修改版）", /live2d-easy-control[\s\S]{0,120}打过补丁/)
	miss("㉒ 含 AndroidX / androidx.webkit (Apache-2.0)", /androidx\.webkit[\s\S]{0,40}Apache-2\.0/)
	miss("㉓ 含 Kotlin stdlib (Apache-2.0)", /Kotlin stdlib[\s\S]{0,40}Apache-2\.0/)
	miss("㉔ 含 Live2D Cubism Core 专有许可 + 协议链接",
		/Live2D Cubism Core[\s\S]*live2d\.com\/eula\/live2d-proprietary-software-license-agreement_en\.html/)
	miss("㉕ 写明 Core 按原样分发、不修改、不置于开源许可之下",
		/按原样分发、不修改[\s\S]{0,40}不置于会允许第三方修改的开源许可之下/)
	miss("㉖ 含「不随包分发」声明（人设/音效/参考音频/模型）",
		/不随包分发[\s\S]*人设[\s\S]*音效[\s\S]*参考音频[\s\S]*模型/)
	miss("㉗ 指向仓库根 THIRD-PARTY.md", /THIRD-PARTY\.md/)

	/* 反馈渠道 */
	miss("㉘ 含反馈 QQ 群 471419518", /471419518/)

	/* ================= ④ 页内链接真的可点（走原生 openExternal） ================= */
	await evalJs(`(() => { const b = [...document.querySelectorAll(".about-page button")].find(x => /erhiolab\\/DeepEr/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(300)
	await evalJs(`(() => { const b = [...document.querySelectorAll(".about-page button")].find(x => /NoriDroid/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(300)
	await evalJs(`(() => { const b = [...document.querySelectorAll(".about-page button")].find(x => /live2d\\.com\\/eula/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(300)
	const opened = await evalJs(`window.__opened || []`)
	console.log(`   openExternal 收到的 URL: ${JSON.stringify(opened)}`)
	check("㉙ 点仓库链接走原生 openExternal 且 URL 正确", opened.includes(REPO), JSON.stringify(opened))
	check("㉚ 点 Live2D 协议链接走原生 openExternal 且 URL 正确", opened.includes(EULA), JSON.stringify(opened))
	check("㉛ 点上游链接走原生 openExternal 且 URL = erhiolab/DeepEr",
		opened.includes("https://github.com/erhiolab/DeepEr"), JSON.stringify(opened))

	check("㉜ 全程无未捕获 JS 异常", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
}
