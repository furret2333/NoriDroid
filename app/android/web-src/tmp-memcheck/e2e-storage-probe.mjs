/* E2E: 设置页「存储自检」按钮 (2026-09-26 用户反馈"卸载重装后公共目录内容不读取")。
 *
 * 这里能测的是**前端行为**: 按钮把原生 probePublicFiles 的返回如实渲染出来 (三种情况都要能显示)。
 * 原生直读是否真的可行只能在真机验 (本机无 adb/模拟器) —— 所以本测试用假桥喂三种典型返回,
 * 断言界面把它们**如实**呈现 (而不是美化/吞掉)。
 *
 * 运行: node tmp-memcheck/e2e-storage-probe.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9406
const profile = mkdtempSync(join(tmpdir(), "nori-store-"))
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

try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	const jsErrors = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") jsErrors.push(m.params?.exceptionDetails?.exception?.description || "?")
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

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4200)

	/* 假桥: 三种典型返回 (覆盖"读不到"的三种成因) + 「所有文件访问权限」状态 */
	await evalJs(`(() => {
		window.__probeCalls = [];
		window.__accessAsked = 0;
		window.__access = false;
		window.NoriChat = window.NoriChat || {};
		window.NoriChat.hasAllFilesAccessJs = () => window.__access;
		window.NoriChat.requestAllFilesAccess = () => { window.__accessAsked += 1; };
		window.NoriChat.probePublicFiles = (name) => {
			window.__probeCalls.push(name);
			const base = {sdk:36, dir:"/storage/emulated/11/Download/NoriDroid", dirExists:true, dirReadable:true, allFilesAccess: window.__access, useDirectFile: window.__access, listed:[]};
			if (name === "chat.json") return JSON.stringify({...base, inMediaStore:false, mediaStoreBytes:-1, onDisk:true, fileReadable:window.__access, fileBytes:5436});
			if (name === "memory.json") return JSON.stringify({...base, inMediaStore:false, mediaStoreBytes:-1, onDisk:true, fileReadable:false, fileBytes:-1, listed:[]});
			return JSON.stringify({...base, inMediaStore:true, mediaStoreBytes:88, onDisk:false, fileReadable:false, fileBytes:-1});
		};
		return true;
	})()`)

	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)

	const before = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		const txt = sheet.innerText || ""
		return {
			hasProbeBtn: !!([...sheet.querySelectorAll("button")].find(b => /自检/.test(b.textContent))),
			hasGrantBtn: !!([...sheet.querySelectorAll("button")].find(b => /去授权/.test(b.textContent))),
			accessLine: (txt.match(/所有文件访问权限[^\\n]*/) || [""])[0],
			hasOldClaim: txt.includes("卸载重装也不丢"),
			hasPre: !!sheet.querySelector(".store-probe"),
		}
	})()`)
	check("设置页有「存储自检」按钮", before.hasProbeBtn === true, JSON.stringify(before))
	check("设置页有「所有文件访问权限 → 去授权」按钮", before.hasGrantBtn === true, JSON.stringify(before))
	check("未授权时显示「未授权」", before.accessLine.includes("未授权"), before.accessLine)
	check("旧的错误说明「卸载重装也不丢」已移除", before.hasOldClaim === false, JSON.stringify(before))
	check("未点自检时不显示结果块", before.hasPre === false)

	/* 点「去授权」应调用原生 requestAllFilesAccess */
	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /去授权/.test(b.textContent))?.click()`)
	await sleep(400)
	check("点「去授权」调用了原生的 requestAllFilesAccess",
		(await evalJs(`window.__accessAsked`)) === 1, `asked=${await evalJs(`window.__accessAsked`)}`)

	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /自检/.test(b.textContent))?.click()`)
	await sleep(600)
	const after = await evalJs(`(() => {
		const pre = document.querySelector(".sheet .store-probe")
		return {
			text: pre ? pre.innerText : "",
			calls: window.__probeCalls || [],
			mono: pre ? getComputedStyle(pre).fontFamily : "",
		}
	})()`)
	console.log(`   自检输出:\n${(after.text || "").split("\n").map(l => "     " + l).join("\n")}`)
	check("点自检后查到 4 个数据文件", after.calls.length === 4, JSON.stringify(after.calls))
	check("如实报告「磁盘上有但 MediaStore 不可见」", after.text.includes("磁盘上存在: 是(5436 字节)") && after.text.includes("MediaStore 可见: 否"), after.text)
	check("如实报告「连直读也被挡住」", after.text.includes("可直读: 否") && after.text.includes("目录内容: []"), after.text)
	check("如实报告「MediaStore 可见(正常路径)」", after.text.includes("MediaStore 可见: 是(88 字节)"), after.text)
	check("自检输出含「所有文件访问权限」状态", after.text.includes("所有文件访问权限: 否"), after.text)

	/* 授权后: 状态应变「已授权」，且 probe 里 fileReadable 跟着变 */
	await evalJs(`window.__access = true; window.__accessAsked = 0; "ok"`)
	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /自检/.test(b.textContent))?.click()`)
	await sleep(500)
	const granted = await evalJs(`(() => {
		const sheet = document.querySelector(".sheet")
		return {
			text: (sheet.querySelector(".store-probe") || {}).innerText || "",
			accessLine: ((sheet.innerText || "").match(/所有文件访问权限[^\\n]*/) || [""])[0],
		}
	})()`)
	console.log(`   授权后自检:\n${(granted.text || "").split("\n").slice(0, 6).map(l => "     " + l).join("\n")}`)
	check("授权后自检显示「所有文件访问权限: 是」", granted.text.includes("所有文件访问权限: 是"), granted.text)
	check("授权后该文件变为「可直读: 是」", granted.text.includes("可直读: 是"), granted.text)

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
