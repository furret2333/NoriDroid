/* 探针: 背景音乐「已下载」状态必须以**磁盘上的真实文件**为准 (2026-10-02 用户报的 bug)
 *
 * 现象（用户）: BGM 明明下载过了, 关掉 App 再打开, 设置里**又显示「下载背景音乐资源」按钮**。
 * 根因: `services/bgm.ts` 的 `syncBgm()` 把"问原生要状态"放在了 `if (!s.bgmEnabled) return` **之后**
 *   —— 开关关着时状态永远停在模块初始值 `missing`, 与磁盘上有没有文件无关。
 *   于是设置面板按 `bgmState !== 'ready'` 渲染出「音频资源未下载 + 下载按钮」。
 *
 * 这条探针**假的原生桥**就是"磁盘": `bgmStatus()` 直接对应 filesDir/bgm 里三个音频文件在不在,
 * 用一个 localStorage 标记模拟"文件已经躺在磁盘上"(跨页面重载 = 关掉 App 再打开)。
 *
 * 断言:
 *   ① 开关**关着** + 磁盘上有资源 → 启动后前端确实问了原生 (不是没接上), 且设置里显示「资源已就绪」
 *      且**没有**「下载背景音乐资源」按钮 (旧代码在这里是红的: 显示"未下载"+下载按钮)
 *   ② 资源真没有时: 显示「未下载」+「下载背景音乐资源」按钮仍可点 (这条不能被修法弄没)
 *   ③ 点一下: 假桥 downloadBgm 被调用一次; 桥回 done 后状态变「资源已就绪」
 *   ④ **重启**(重新导航整页) 后仍然显示「资源已就绪」—— 用户报的就是这一条
 *   ⑤ 「重新下载」按钮在已就绪时存在, 点了会真的再触发一次下载 (force 语义)
 *   ⑥ 开关**开着** + 磁盘上有资源 → 前端会去播 /bgm-local/ (状态与播放都没被这次修法弄坏)
 *
 * 运行: node tmp-memcheck/probe-bgm-state.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9467
const profile = mkdtempSync(join(tmpdir(), "nori-bgm-"))
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

/**
 * 页面第一个脚本之前装假桥:
 * `PROBE_BGM_READY` = localStorage 里的"磁盘上有没有那三个文件"。
 * 之所以用 localStorage 而不是页面变量: 第 ④ 条要**重新导航整页**模拟"关掉 App 再打开",
 * 页面变量会被清掉, 而真机上 filesDir/bgm 是留着的 —— localStorage 才是它的等价物。
 */
const INIT = `(() => {
	window.__bgmStatusCalls = 0; window.__bgmDlCalls = 0; window.__bgmAudio = []; window.__bgmOnError = 0;
	window.addEventListener("error", function () { window.__bgmOnError += 1 });
	const diskReady = () => localStorage.getItem("PROBE_BGM_READY") === "1";
	const FAKE = {
		bgmStatus: function () {
			window.__bgmStatusCalls += 1;
			const ready = diskReady();
			return JSON.stringify({ready: ready, missing: ready ? [] : ["bgm_memory.mp3", "bgm1.m4a", "nori_daily_manifold.mp3"]});
		},
		bgmDownload: function () {
			window.__bgmDlCalls += 1;
			setTimeout(function () {
				localStorage.setItem("PROBE_BGM_READY", "1");
				try { window.__noriBgmRes(JSON.stringify({stage: "done", ready: true})); } catch (e) {}
			}, 400);
			return "ok";
		}
	};
	let nc = null;
	Object.defineProperty(window, "NoriChat", {
		configurable: true,
		get: function () { return nc },
		set: function (v) { nc = v; if (v && typeof v === "object") { for (const k in FAKE) v[k] = FAKE[k] } }
	});
	// 钩住 Audio: 看开关开着时到底有没有去播本地资源
	const Orig = window.Audio;
	window.Audio = function (src) {
		const a = new Orig(src);
		const op = a.play.bind(a);
		a.play = function () { window.__bgmAudio.push(String(a.src || src)); return op().catch(function () {}) };
		return a;
	};
	window.Audio.prototype = Orig.prototype;
})()`

/** 「背景音乐」那一行的现场 */
const bgmRow = () => evalJs(`(() => {
	const body = document.querySelector(".sheet .sheet-body")
	if (!body) return {ok: false}
	const rows = [...body.querySelectorAll(".settings-row")]
	const row = rows.find(r => {
		const l = r.querySelector(":scope > label")
		return l && /^背景音乐$/.test(l.textContent.trim())
	})
	if (!row) return {ok: false, why: "没找到「背景音乐」行", rows: rows.length}
	const hints = [...row.querySelectorAll(".hint")]
	const btns = [...row.querySelectorAll("button")].map(b => b.textContent.trim())
	return {
		ok: true,
		title: (row.querySelector(".mem-sec-title") || {}).textContent ? row.querySelector(".mem-sec-title").textContent.trim() : "",
		status: hints.length ? hints[0].textContent.trim() : "",
		hasDownload: btns.includes("下载背景音乐资源"),
		hasRedownload: btns.includes("重新下载"),
		btns
	}
})()`)
const clickBtn = (label) => evalJs(`(() => {
	const body = document.querySelector(".sheet .sheet-body")
	if (!body) return "no-panel"
	const rows = [...body.querySelectorAll(".settings-row")]
	const row = rows.find(r => { const l = r.querySelector(":scope > label"); return l && /^背景音乐$/.test(l.textContent.trim()) })
	if (!row) return "no-row"
	const b = [...row.querySelectorAll("button")].find(x => x.textContent.trim() === ${JSON.stringify(label)})
	if (!b || b.disabled) return "skip"
	b.click(); return "clicked"
})()`)

let evalJs = async () => { throw new Error("未初始化") }
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
	evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}
	const openSettings = async () => {
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(800)
	}
	const boot = async (seed) => {
		await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(seed)}`}, sessionId)
		await sleep(4300)
		await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
		await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	}
	await send("Page.addScriptToEvaluateOnNewDocument", {source: INIT}, sessionId)

	/* ================= ① 开关关着 + 磁盘上已有资源 (用户报的那条) ================= */
	await boot({apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m", bgmEnabled: false})
	// 第一次导航时 localStorage 还是空的 → 先把"磁盘上已有"标记写入, 再重载一次 = 真·重启
	await evalJs(`localStorage.setItem("PROBE_BGM_READY","1")`)
	await boot({apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m", bgmEnabled: false})
	const asks = await evalJs(`window.__bgmStatusCalls`)
	check("①-a 开关关着时, 启动也会问原生要一次状态 (证明状态不再依赖开关)", (asks || 0) >= 1, `calls=${asks}`)
	await openSettings()
	const r1 = await bgmRow()
	check("①-b 设置面板打得开且找得到「背景音乐」行", r1.ok === true, JSON.stringify(r1))
	check("①-c 磁盘上有资源 ⇒ 状态行 =「资源已就绪，随开关播放」", /资源已就绪/.test(r1.status || ""), `status=${r1.status}`)
	check("①-d 不再显示「下载背景音乐资源」按钮 (这就是用户看到的那个 bug)", r1.hasDownload === false, `btns=${JSON.stringify(r1.btns)}`)

	/* ================= ⑤ 已就绪时仍有「重新下载」的出口 ================= */
	check("⑤-a 已就绪时给的是「重新下载」按钮 (下载出口没被修法拿走)", r1.hasRedownload === true, `btns=${JSON.stringify(r1.btns)}`)
	const dlBefore = await evalJs(`window.__bgmDlCalls`)
	const clicked5 = await clickBtn("重新下载")
	await sleep(900)
	const dlAfter = await evalJs(`window.__bgmDlCalls`)
	check("⑤-b 「重新下载」点了真的又下了一次 (force 语义, 不是空转)",
		clicked5 === "clicked" && (dlAfter || 0) === (dlBefore || 0) + 1,
		`clicked=${clicked5} calls ${dlBefore} → ${dlAfter}`)

	/* ================= ④ 重启 (整页重新导航) 后仍显示已就绪 ================= */
	const callsBeforeReload = await evalJs(`window.__bgmStatusCalls`)
	await boot({apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m", bgmEnabled: false})
	const callsAfterReload = await evalJs(`window.__bgmStatusCalls`)
	await openSettings()
	const r2 = await bgmRow()
	check("④-a 重启后仍显示「资源已就绪」", /资源已就绪/.test(r2.status || ""), `status=${r2.status}`)
	check("④-b 重启后没有「下载背景音乐资源」按钮", r2.hasDownload === false, `btns=${JSON.stringify(r2.btns)}`)
	check("④-c 重启后确实是新页面 (状态查询计数从 0 重新开始)",
		(callsAfterReload || 0) >= 1 && (callsAfterReload || 0) < (callsBeforeReload || 0) + 1,
		`reload 前 ${callsBeforeReload} → 新页面 ${callsAfterReload}`)

	/* ================= ② 磁盘上没有资源: 未下载 + 下载按钮还在 ================= */
	await evalJs(`localStorage.removeItem("PROBE_BGM_READY")`)
	await boot({apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m", bgmEnabled: false})
	await openSettings()
	const r3 = await bgmRow()
	check("②-a 磁盘上没有资源 ⇒ 状态行是「音频资源未下载」", /音频资源未下载/.test(r3.status || ""), `status=${r3.status}`)
	check("②-b 「下载背景音乐资源」按钮在 (首次下载的路没被堵)",
		r3.hasDownload === true && r3.hasRedownload === false, `btns=${JSON.stringify(r3.btns)}`)

	/* ================= ③ 点下载: 调一次桥 → 完成后变已就绪 ================= */
	const clicked3 = await clickBtn("下载背景音乐资源")
	await sleep(1200)
	const dl3 = await evalJs(`window.__bgmDlCalls`)
	check("③-a 点「下载背景音乐资源」假桥被调用一次", clicked3 === "clicked" && dl3 === 1, `clicked=${clicked3} calls=${dl3}`)
	const r4 = await bgmRow()
	check("③-b 桥回 done 后状态行变「资源已就绪」", /资源已就绪/.test(r4.status || ""), `status=${r4.status}`)
	check("③-c 完成后按钮变「重新下载」", r4.hasRedownload === true && r4.hasDownload === false, `btns=${JSON.stringify(r4.btns)}`)

	/* ================= ⑥ 开关打开 + 磁盘上有资源 → 真的去播本地资源 ================= */
	await boot({apiKey: "sk-llm", baseUrl: "https://api.probe.test", model: "m", bgmEnabled: true, bgmVolume: 0.35})
	const audio = await evalJs(`window.__bgmAudio`)
	check("⑥-a 开关打开且资源就绪 ⇒ 去播 /bgm-local/ (状态没被修法弄坏)",
		(audio || []).some(u => /bgm-local\//.test(u)), JSON.stringify(audio))
	await openSettings()
	const r6 = await bgmRow()
	check("⑥-b 开着的状态下设置里也是「资源已就绪」", /资源已就绪/.test(r6.status || ""), `status=${r6.status}`)

	check("⑦ 全程无未捕获异常 (Runtime.exceptionThrown = 0)", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))
	const onerr = await evalJs(`window.__bgmOnError`)
	check("⑧ 全程 window.onerror = 0", (onerr || 0) === 0, `onerror=${onerr}`)
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const passed = results.filter(r => r.cond).length
	console.log(`\n${passed}/${results.length} passed`)
	if (passed !== results.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
}
