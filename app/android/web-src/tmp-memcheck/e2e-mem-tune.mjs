/* E2E: 记忆库「记忆优化」小节 (整理优化, 2026-09-28)
 *
 * 断言真实 DOM + 真实持久化:
 *   ① 小节存在: 标题「记忆优化」+ 自动优化开关(默认关) + 三个按钮;
 *   ② 点「立即优化」→ 生成示例并落盘 (exampleSet: pos 来自生效记忆, neg 来自回收站);
 *   ③ 「查看示例」展开显示 该记/不该记 + "只是风格示例"的说明;
 *   ④ 「清除示例」→ 落盘里 exampleSet 消失, 按钮回到禁用;
 *   ⑤ 首次点会先弹一次"建议先自己过一遍记忆"的确认 (这里自动确认)。
 *
 * 运行: node tmp-memcheck/e2e-mem-tune.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9426
const profile = mkdtempSync(join(tmpdir(), "nori-memtune-"))
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

	const S = Buffer.from(JSON.stringify({apiKey: "sk-e2e", baseUrl: "https://api.e2e.test", model: "e2e-model"})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4300)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	for (let i = 0; i < 5; i += 1) {
		if (!(await evalJs(`!!document.querySelector(".intro-mask")`))) break
		await evalJs(`document.querySelector(".intro-next")?.click()`)
		await sleep(300)
	}
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await evalJs(`window.confirm = () => true`)   // 首次确认自动通过

	/* 造 14 条生效记忆 (过冷启动阈值) + 回收站 1 条 (反例来源) */
	const ts0 = Date.now() - 3600_000
	await evalJs(`(() => {
		const mk = (id, content, type, over = {}) => ({id, content, type, importance:0.7, confidence:0.9,
			createdAt:${ts0}, updatedAt:${ts0}, lastAccessedAt:0, accessCount:0, tags:[], decayDays:null, ...over});
		const mems = [];
		for (let i = 0; i < 14; i++) mems.push(mk("a" + i, "我喜欢第" + i + "种点心", "preference", {importance: 0.6 + (i % 4) / 10}));
		window.NoriChat.writeFile("memory.json", JSON.stringify({
			memories: mems, summaries: [], summarizedMsgCount: 0, tombstones: [{id:"d1", at:${ts0}}], meta: [],
			schemaVersion: 2, blocks: [],
			deletedBin: [mk("d1", "我有点困，准备去睡觉", "event", {importance: 0.3, deletedAt: ${ts0}})]
		}));
		return mems.length
	})()`)
	await sleep(300)

	/* 开记忆库 (点三下) */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	for (let i = 0; i < 3; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(320) }
	await sleep(800)

	const before = await evalJs(`(() => {
		const tune = document.querySelector(".sheet .mem-tune")
		if (!tune) return {err: "没有 .mem-tune 小节"}
		const cb = tune.querySelector("input[type=checkbox]")
		const btns = [...tune.querySelectorAll("button")]
		return {
			title: (tune.querySelector(".mem-sec-title") || {}).innerText || "",
			hasCheckbox: !!cb, checked: cb ? cb.checked : null,
			btns: btns.map(b => b.textContent.trim()),
			clearDisabled: (btns.find(b => /清除示例/.test(b.textContent)) || {}).disabled ?? null,
			info: (tune.querySelector(".hint") || {}).innerText || "",
		}
	})()`)
	console.log(`   小节: ${JSON.stringify(before)}`)
	check("①有「记忆优化」小节 + 自动优化开关(默认关) + 三个按钮",
		before.title === "记忆优化" && before.hasCheckbox === true && before.checked === false &&
		before.btns.includes("立即优化") && before.btns.includes("查看示例") && before.btns.includes("清除示例"),
		JSON.stringify(before))
	check("①还没有示例时「清除示例」是禁用的、说明文字提示先点立即优化",
		before.clearDisabled === true && /还没有示例/.test(before.info), JSON.stringify({d: before.clearDisabled, i: before.info}))

	/* ② 立即优化 */
	await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet .mem-tune button")].find(x => /立即优化/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(1200)
	const after = await evalJs(`(() => {
		const tune = document.querySelector(".sheet .mem-tune")
		const mem = (() => { try { return JSON.parse(window.NoriChat.readFile("memory.json") || "{}") } catch { return {} } })()
		const ex = mem.exampleSet || null
		return {
			info: (tune ? (tune.querySelector(".hint") || {}).innerText : "") || "",
			ex: ex ? {pos: ex.pos, neg: ex.neg, basedOn: ex.basedOn} : null,
			clearDisabled: (() => { const b = [...document.querySelectorAll(".sheet .mem-tune button")].find(x => /清除示例/.test(x.textContent)); return b ? b.disabled : null })(),
		}
	})()`)
	console.log(`   立即优化后: ${JSON.stringify(after)}`)
	check("②点了「立即优化」→ 示例落盘 (正例来自生效记忆、反例来自回收站)",
		!!after.ex && after.ex.pos.length > 0 && after.ex.neg.some(t => t.includes("准备去睡觉")) && after.ex.basedOn >= 12,
		JSON.stringify(after.ex))
	check("②说明行显示条数, 「清除示例」变为可用",
		/正例\s*\d+\s*条\s*\/\s*反例\s*\d+\s*条/.test(after.info) && after.clearDisabled === false,
		JSON.stringify({info: after.info, d: after.clearDisabled}))

	/* ③ 查看示例 */
	await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet .mem-tune button")].find(x => /查看示例/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(500)
	const detail = await evalJs(`(() => { const d = document.querySelector(".sheet .mem-tune-detail"); return d ? d.innerText : null })()`)
	console.log(`   示例详情: ${JSON.stringify(String(detail).slice(0, 160))}`)
	check("③「查看示例」展开显示 该记/不该记 + 「只是风格示例」说明",
		!!detail && /该记：/.test(detail) && /不该记：/.test(detail) && /只是风格示例/.test(detail),
		String(detail).slice(0, 120))

	/* ④ 清除示例 */
	await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet .mem-tune button")].find(x => /清除示例/.test(x.textContent)); b && b.click(); return !!b })()`)
	await sleep(900)
	const cleared = await evalJs(`(() => {
		const mem = (() => { try { return JSON.parse(window.NoriChat.readFile("memory.json") || "{}") } catch { return {} } })()
		const b = [...document.querySelectorAll(".sheet .mem-tune button")].find(x => /清除示例/.test(x.textContent))
		return {hasSet: !!mem.exampleSet, clearDisabled: b ? b.disabled : null}
	})()`)
	console.log(`   清除后: ${JSON.stringify(cleared)}`)
	check("④「清除示例」后落盘里没有 exampleSet 了, 按钮回到禁用",
		cleared.hasSet === false && cleared.clearDisabled === true, JSON.stringify(cleared))

	check("全程无未捕获 JS 异常", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}

const failed = results.filter(r => !r.cond)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
	process.exitCode = 1
	console.log("FAILED:", failed.map(f => f.name).join(" | "))
}
