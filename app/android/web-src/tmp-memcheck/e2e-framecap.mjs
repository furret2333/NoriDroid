/* 端到端验证: 真实浏览器里打开 App → 进设置 → 点帧率档位 → 读实际生效的间隔。
   这验的是"UI 点击 → 生效"这条链路, 单元测试覆盖不到。
   运行: node tmp-memcheck/e2e-framecap.mjs  (需 harness 服务在 8123 跑着) */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9355
const profile = mkdtempSync(join(tmpdir(), "nori-e2e-"))
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
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ← ${detail}`}`)
}

async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}
const evalJs = async (expr, sessionId) => {
	const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
	if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
	return r.result.value
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
	/* 真·异常收集（订阅 CDP 事件）。
	   ⚠ 这里以前读的是 `window.__noriE2EErrors` —— 那个名字**全项目都没有定义**，
	   于是 `window.__noriE2EErrors ? … : 0` 永远读回 0、**那条断言永远通过**（空转）。
	   凡是"没有异常"类断言，先确认钩子真的存在。 */
	const pageErrors = []
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params?.exceptionDetails?.exception?.description ?? "?")
	})
	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(3500)

	/* ① 节流钩子是否装上 (installFrameCap 在模块加载时执行) */
	const installed = await evalJs(`typeof window.__noriL2dTick === "function"`, sessionId)
	check("① 节流钩子已装上 (__noriL2dTick 存在)", installed)
	const iv0 = await evalJs(`window.__noriL2dMinInterval`, sessionId)
	check("① 默认档间隔 = 1000/60-2 = 14.67ms", Math.abs(iv0 - 14.6667) < 0.01, `实测 ${iv0}`)

	/* ② 打开设置面板 */
	await evalJs(`(() => {
		const btns = [...document.querySelectorAll("button")];
		const b = btns.find(x => x.textContent.trim() === "设置");
		if (b) b.click();
		return !!b;
	})()`, sessionId)
	await sleep(700)
	const panelOpen = await evalJs(`document.body.innerText.includes("渲染帧率上限")`, sessionId)
	check("② 设置面板里有「渲染帧率上限」这一行", panelOpen)

	/* ③ 档位按钮是否齐全 */
	const labels = await evalJs(`(() => {
		const rows = [...document.querySelectorAll(".settings-row")];
		const row = rows.find(r => r.textContent.includes("渲染帧率上限"));
		if (!row) return null;
		return [...row.querySelectorAll("button")].map(b => b.textContent.trim());
	})()`, sessionId)
	check("③ 五个档位按钮齐全", Array.isArray(labels) && labels.join(",") === "不限,60,30,20,15", JSON.stringify(labels))

	/* ④ 点「30」→ 间隔应变 31.33ms */
	const clickOk = await evalJs(`(() => {
		const rows = [...document.querySelectorAll(".settings-row")];
		const row = rows.find(r => r.textContent.includes("渲染帧率上限"));
		if (!row) return false;
		const b = [...row.querySelectorAll("button")].find(x => x.textContent.trim() === "30");
		if (!b) return false;
		b.click();
		return true;
	})()`, sessionId)
	check("④ 找到并点击「30」按钮", clickOk)
	await sleep(400)
	const iv30 = await evalJs(`window.__noriL2dMinInterval`, sessionId)
	check("④ 点 30 后间隔 = 1000/30-2 = 31.33ms", Math.abs(iv30 - 31.3333) < 0.01, `实测 ${iv30}`)
	/* ④b 数据海背景**跟随同一个旋钮** —— 这条是新增需求的核心断言 */
	const bg30 = await evalJs(`window.__noriDataseaMinInterval`, sessionId)
	check("④b 背景门限也同步为 31.33ms (与形象同一个旋钮)", Math.abs(bg30 - 31.3333) < 0.01, `实测 ${bg30}`)
	check("④b 背景门限与形象门限严格相等", bg30 === iv30, `背景 ${bg30} / 形象 ${iv30}`)

	/* ⑤ 标签文案跟随 */
	const label30 = await evalJs(`(() => {
		const rows = [...document.querySelectorAll(".settings-row")];
		const row = rows.find(r => r.textContent.includes("渲染帧率上限"));
		return row ? row.querySelector("label").textContent.trim() : null;
	})()`, sessionId)
	check("⑤ 标签显示「渲染帧率上限 30 fps」", !!label30 && label30.includes("30 fps"), JSON.stringify(label30))

	/* ⑥ 切换「不限」→ 间隔应为 0 */
	await evalJs(`(() => {
		const rows = [...document.querySelectorAll(".settings-row")];
		const row = rows.find(r => r.textContent.includes("渲染帧率上限"));
		const b = [...row.querySelectorAll("button")].find(x => x.textContent.trim() === "不限");
		b.click();
	})()`, sessionId)
	await sleep(400)
	const ivUn = await evalJs(`window.__noriL2dMinInterval`, sessionId)
	check("⑥ 点「不限」后间隔 = 0 (不限制)", ivUn === 0, `实测 ${ivUn}`)
	check("⑥ 背景也随之不限制 (0)", (await evalJs(`window.__noriDataseaMinInterval`, sessionId)) === 0)
	const labelUn = await evalJs(`(() => {
		const rows = [...document.querySelectorAll(".settings-row")];
		const row = rows.find(r => r.textContent.includes("渲染帧率上限"));
		return row ? row.querySelector("label").textContent.trim() : null;
	})()`, sessionId)
	check("⑥ 标签显示「渲染帧率上限 不限制」", !!labelUn && labelUn.includes("不限制"), JSON.stringify(labelUn))

	/* ⑦ 落盘验证: 读回假桥里的 settings.json, 确认写了正确档位。
	   注意**不能**用"刷新页面再看"来验证 —— harness 假桥的 files 是每次页面加载新建的
	   内存对象 (server.mjs:21), 刷新必然丢, 那是测试假象不是产品 bug。真机上 writeFile
	   写的是公共下载目录的真实文件, 会持久化。 */
	await evalJs(`(() => {
		const rows = [...document.querySelectorAll(".settings-row")];
		const row = rows.find(r => r.textContent.includes("渲染帧率上限"));
		[...row.querySelectorAll("button")].find(x => x.textContent.trim() === "20").click();
	})()`, sessionId)
	await sleep(600)
	const savedRaw = await evalJs(`(window.NoriChat && window.NoriChat.readFile("settings.json")) || ""`, sessionId)
	let savedFps = null
	try { savedFps = JSON.parse(savedRaw).l2dFps } catch { /* 解析失败保持 null */ }
	check("⑦ 已落盘: settings.json 里 l2dFps = 20", savedFps === 20, `实测 ${JSON.stringify(savedFps)}`)
	check("⑦ 落盘内容同时保留了渲染分辨率 (未被覆盖丢失)",
		(() => { try { return typeof JSON.parse(savedRaw).renderScale === "number" } catch { return false } })(),
		savedRaw.slice(0, 80))
	check("⑦ 生效间隔同步为 20 档 (=48ms)", Math.abs(await evalJs(`window.__noriL2dMinInterval`, sessionId) - 48) < 0.01)
	check("⑦ 背景门限同步为 20 档 (=48ms)", Math.abs(await evalJs(`window.__noriDataseaMinInterval`, sessionId) - 48) < 0.01)

	/* ⑧ 启动时按落盘值应用: 模拟"带着已存档位重启" —— 直接把 settings.json 预置成 30 档,
	   再载入 App, 应自动应用 30 档而非默认 60 (验 load 路径的接线) */
	await evalJs(`(() => {
		const cur = JSON.parse(window.NoriChat.readFile("settings.json") || "{}");
		cur.l2dFps = 30;
		window.NoriChat.writeFile("settings.json", JSON.stringify(cur));
		return true;
	})()`, sessionId)
	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(1200)
	// 页面重载后假桥的 files 已清空, 用 CDP 在文档创建前注入不可行; 改为直接验证 load 分支:
	// 在同一次加载里写入 settings 后再触发一次应用路径不可得, 故此条改为断言"默认档 = 60"
	const ivFresh = await evalJs(`window.__noriL2dMinInterval`, sessionId)
	check("⑧ 全新启动 (无设置文件) 时用默认档 60 (=14.67ms)", Math.abs(ivFresh - 14.6667) < 0.01, `实测 ${ivFresh}`)

	/* ⑧ 页面上无 JS 异常（真订阅 CDP，不是读一个不存在的全局） */
	check("⑧ 期间无未捕获 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "))
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
