/* 探针: 音效改为「从网上下载」+ 设置里一个「下载音效」按钮 (2026-10-02)
 *
 * 背景: 包内不再内置 assets/sfx (合成版听感差; 原版改为下载 ⇒ 包更小、也不再分发素材)。
 * 验的是**用户真正会走的那条路**，不是"源码里有没有那个函数":
 *   ① 设置面板里「音效文件」那一行在「按键音效音量」那一行**之后** (DOM 顺序断言, 用
 *      compareDocumentPosition 与行序号两个口径一起卡)
 *   ② 点「下载音效」→ 假桥 downloadSfx 被调用**一次**
 *   ③ 状态行从「未下载（点右边按钮）」变「已下载 5/5」, 按钮变「重新下载」
 *   ④ **未下载时按键音静默但不报错**: 拍一次底栏按钮的 pointerdown —— 不得有任何
 *      /sfx-local/ 的 Audio 被播放, 不得有 window.onerror / Runtime.exceptionThrown;
 *      同时断言前端**确实问了**原生状态 (__sfxStatusCalls 涨了, 不是"根本没接上")
 *   ⑤ 假桥回 {ok:false, failed:["start.m4a"], done:4} 时, 状态行要显示失败+可重试+代理/魔法提示
 *
 * ⚠ 假桥必须在**页面第一个脚本之前**装好: harness 的 shim 会 `window.NoriChat = {...}` 覆盖掉
 *   后装的桥, 所以这里用 `Object.defineProperty` 的 setter 把假方法**并进**去 ——
 *   这样 App 启动时读到的就是"未下载"(等于验证了"首次进入读一次状态")。
 *
 * 运行: node tmp-memcheck/probe-sfx-download.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9456
const profile = mkdtempSync(join(tmpdir(), "nori-sfx-"))
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

/* 页面第一个脚本之前就要跑的东西: ① 假桥(含音效三方法) ② Audio 钩子 ③ onerror 计数 */
const INIT = `(() => {
	window.__sfxDlCalls = 0; window.__sfxStatusCalls = 0;
	window.__sfxMode = "ok"; window.__sfxReadyFlag = false;
	window.__sfxAudio = []; window.__sfxOnError = 0;
	window.addEventListener("error", function () { window.__sfxOnError += 1 });
	const FAKE = {
		sfxStatus: function () {
			window.__sfxStatusCalls += 1;
			return JSON.stringify(window.__sfxReadyFlag
				? {ready: true, done: 5, total: 5, missing: []}
				: {ready: false, done: 0, total: 5, missing: ["button_click.m4a", "start.m4a", "complete.m4a", "return.m4a", "abandon.m4a"]});
		},
		downloadSfx: function () {
			window.__sfxDlCalls += 1;
			const mode = window.__sfxMode;
			// 500ms 才回: 「下载中…」那一态必须**看得见**才能断言 (真机上要下 5 个文件, 更慢)
			setTimeout(function () {
				try {
					if (mode === "partial") {
						window.__noriSfxDownloadRes(JSON.stringify({ok: false, total: 5, done: 4, failed: ["start.m4a"]}));
					} else {
						window.__sfxReadyFlag = true;
						window.__noriSfxDownloadRes(JSON.stringify({ok: true, total: 5, done: 5, failed: []}));
					}
				} catch (e) {}
			}, 500);
			return "ok";
		}
	};
	// harness 的 shim 之后会 window.NoriChat = {...}: 用 setter 把假方法并进去 (别被覆盖)
	let nc = null;
	Object.defineProperty(window, "NoriChat", {
		configurable: true,
		get: function () { return nc },
		set: function (v) { nc = v; if (v && typeof v === "object") { for (const k in FAKE) v[k] = FAKE[k] } }
	});
	// 钩住 Audio: 记下每一次"被播放"的地址 (静默与否一眼可见)
	const Orig = window.Audio;
	window.Audio = function (src) {
		const a = new Orig(src);
		const op = a.play.bind(a);
		a.play = function () { window.__sfxAudio.push(String(a.src || src)); return op().catch(function () {}) };
		return a;
	};
	window.Audio.prototype = Orig.prototype;
})()`

try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	const jsErrors = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") {
			jsErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?")
		}
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
	const seed = {apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m", sfxVolume: 0.5}
	await send("Page.addScriptToEvaluateOnNewDocument", {source: INIT}, sessionId)
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(seed)}`}, sessionId)
	await sleep(4300)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)

	/** 「音效文件」那一行的现场 (含与「按键音效音量」行的先后关系) */
	const sfxRow = () => evalJs(`(() => {
		const body = document.querySelector(".sheet .sheet-body")
		if (!body) return {ok: false}
		const rows = [...body.querySelectorAll(".settings-row")]
		const vol = rows.find(r => /按键音效音量/.test(r.textContent))
		const btnOf = (r) => [...r.querySelectorAll("button")].find(b => /下载音效|重新下载|下载中/.test(b.textContent))
		const row = rows.find(r => !!btnOf(r))
		const btn = row ? btnOf(row) : null
		const hints = row ? [...row.querySelectorAll(".hint")] : []
		return {
			ok: true, rowCount: rows.length,
			volIdx: vol ? rows.indexOf(vol) : -1,
			idx: row ? rows.indexOf(row) : -1,
			after: !!(vol && row && (vol.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)),
			label: row && row.querySelector("label") ? row.querySelector("label").textContent.trim() : "",
			status: hints.length ? hints[0].textContent.trim() : "",
			statusCls: hints.length ? String(hints[0].className) : "",
			btn: btn ? btn.textContent.trim() : "",
			disabled: btn ? btn.disabled === true : null
		}
	})()`)
	const clickSfxBtn = () => evalJs(`(() => {
		const rows = [...document.querySelectorAll(".sheet .sheet-body .settings-row")]
		const row = rows.find(r => [...r.querySelectorAll("button")].some(b => /下载音效|重新下载|下载中/.test(b.textContent)))
		const b = row ? [...row.querySelectorAll("button")].find(x => /下载音效|重新下载|下载中/.test(x.textContent)) : null
		if (!b || b.disabled) return "skip"
		b.click(); return "clicked"
	})()`)

	/* ---- 启动: 假桥一路说"未下载" ---- */
	const boot = await evalJs(`({status: window.__sfxStatusCalls, audio: (window.__sfxAudio || []).length})`)
	check("⓪ 启动时前端问过一次原生音效状态 (首次进入读一次)", (boot.status || 0) >= 1, JSON.stringify(boot))

	/* ---- ④ 未下载时拍底栏按钮: 静默 + 不抛异常 ---- */
	const beforeAudio = (await evalJs(`(window.__sfxAudio || []).length`)) || 0
	const beforeStatus = (await evalJs(`window.__sfxStatusCalls`)) || 0
	const pressed = await evalJs(`(() => {
		const fab = [...document.querySelectorAll(".dock .fab")].find(x => /日记/.test(x.textContent))
		if (!fab) return "no-fab"
		fab.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}))
		return "pressed"
	})()`)
	await sleep(400)
	const after = await evalJs(`({audio: (window.__sfxAudio || []), status: window.__sfxStatusCalls, onerror: window.__sfxOnError})`)
	const playedSfx = (after.audio || []).filter(u => /sfx-local/.test(u))
	check("④-a 底栏按钮拍得下去 (找得到 .dock .fab)", pressed === "pressed", String(pressed))
	check("④-b 未下载时**没有任何** /sfx-local/ 音效被播放 (静默)", playedSfx.length === 0, JSON.stringify(after.audio))
	check("④-c 前端确实问了原生状态 (不是「没接上」导致的不响)", (after.status || 0) > beforeStatus,
		`before=${beforeStatus} after=${after.status}`)
	check("④-d 未下载时按按钮不抛异常 (window.onerror = 0)", (after.onerror || 0) === 0, `onerror=${after.onerror}`)
	check("④-e 未下载时不会凭空多出 Audio 实例", (after.audio || []).length === beforeAudio,
		`before=${beforeAudio} after=${(after.audio || []).length}`)

	/* ---- 打开设置面板 ---- */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)

	/* ---- ① 按钮存在 + DOM 顺序 ---- */
	const row0 = await sfxRow()
	check("①-a 设置面板打得开", row0.ok === true, JSON.stringify(row0))
	check("①-b 有「音效文件」这一行, 行内按钮是「下载音效」", row0.label === "音效文件" && row0.btn === "下载音效",
		`label=${row0.label} btn=${row0.btn}`)
	check("①-c 它在「按键音效音量」那一行**之后** (compareDocumentPosition)",
		row0.after === true && row0.volIdx >= 0 && row0.idx > row0.volIdx,
		JSON.stringify({volIdx: row0.volIdx, idx: row0.idx, after: row0.after}))
	check("①-d 初始状态行 =「未下载（点右边按钮）」且按钮可点",
		/未下载（点右边按钮）/.test(row0.status) && row0.disabled === false,
		`status=${row0.status} disabled=${row0.disabled}`)

	/* ---- ② 点一下: 假桥被调用一次 ---- */
	const clicked = await clickSfxBtn()
	await sleep(120)
	const during = await sfxRow()
	check("②-a 点得到「下载音效」", clicked === "clicked", String(clicked))
	check("②-b 下载中: 状态行「下载中…」+ 按钮禁用 (不许能连点)",
		/下载中/.test(during.status) && during.disabled === true,
		`status=${during.status} disabled=${during.disabled} btn=${during.btn}`)
	await sleep(700)
	const calls = await evalJs(`window.__sfxDlCalls`)
	check("②-c 假桥 downloadSfx 被调用**一次** (点一下只下一次)", calls === 1, `calls=${calls}`)

	/* ---- ③ 成功: 已下载 5/5 + 按钮变「重新下载」 ---- */
	const row1 = await sfxRow()
	check("③-a 状态行变「已下载 5/5」", /已下载 5\/5/.test(row1.status), `status=${row1.status}`)
	check("③-b 按钮变「重新下载」且恢复可点", row1.btn === "重新下载" && row1.disabled === false,
		`btn=${row1.btn} disabled=${row1.disabled}`)
	check("③-c 成功态用的是 ok 配色 (没有 bad)", /\bok\b/.test(row1.statusCls) && !/\bbad\b/.test(row1.statusCls),
		`cls=${row1.statusCls}`)

	/* ---- ⑤ 部分失败: 报出坏文件 + 可重试 ---- */
	await evalJs(`window.__sfxMode = "partial"`)
	const clicked2 = await clickSfxBtn()
	await sleep(120)
	const during2 = await sfxRow()
	check("⑤-a 「重新下载」点得动且当场进「下载中…」(失败后按钮没卡死)",
		clicked2 === "clicked" && /下载中/.test(during2.status), `clicked=${clicked2} status=${during2.status}`)
	await sleep(700)
	const row2 = await sfxRow()
	check("⑤-b 状态行报出坏文件且写明可重试", /下载失败：start\.m4a（可重试）/.test(row2.status), `status=${row2.status}`)
	check("⑤-c 提示里写清国内可能需要代理/魔法", /国内可能需要代理\/魔法/.test(row2.status), `status=${row2.status}`)
	check("⑤-d 失败态用 bad 配色", /\bbad\b/.test(row2.statusCls), `cls=${row2.statusCls}`)
	check("⑤-e 失败后按钮回到可点", row2.btn === "重新下载" && row2.disabled === false,
		`btn=${row2.btn} disabled=${row2.disabled}`)
	// "（可重试）"不能只是文案: 再点一次必须**真的又调了一次桥**
	const clicked3 = await clickSfxBtn()
	await sleep(700)
	const calls3 = await evalJs(`window.__sfxDlCalls`)
	check("⑤-f 再点一次真的会重试 (桥又被调用一次)", clicked3 === "clicked" && calls3 === 3, `clicked=${clicked3} calls=${calls3}`)

	/* ---- 收尾: 全程不该有未捕获异常 ---- */
	check("⑥ 全程无未捕获异常 (Runtime.exceptionThrown = 0)", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))
	const finalOnError = await evalJs(`window.__sfxOnError`)
	check("⑦ 全程 window.onerror = 0", (finalOnError || 0) === 0, `onerror=${finalOnError}`)
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
}
