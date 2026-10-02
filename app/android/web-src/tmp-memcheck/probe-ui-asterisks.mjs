/* 探针: 界面里有没有"字面显示出来的 ** " (markdown 星号漏渲染) —— 2026-09-30
 *
 * 为什么要它: 项目里不少提示文案用 `**…**` 表示强调; 新手引导有专门的渲染器把它转成加粗,
 * 但**别处的普通文本节点不会转** —— 用户在界面上就会看到两个星号。grep 源码查不准
 * (注释里全是 `**`), 所以这里直接看**渲染出来的文字**。
 *
 * 运行: node tmp-memcheck/probe-ui-asterisks.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9447
const profile = mkdtempSync(join(tmpdir(), "nori-star-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,1000", "about:blank"], {stdio: "ignore"})
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
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* wait */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}
const bad = []
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
	const S = Buffer.from(JSON.stringify({apiKey: "sk-star", baseUrl: "https://api.star.test", model: "m"})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4500)
	/** 扫当前页面: 找出文字里出现 "**" 的元素 (取最内层, 附带上下文) */
	const scan = async (label) => {
		const hits = await evalJs(`(() => {
			const out = [];
			const walk = (el) => {
				for (const n of el.childNodes) {
					if (n.nodeType === 3) {
						const t = n.textContent || "";
						if (t.includes("**")) out.push({where: el.className || el.tagName, text: t.trim().slice(0, 160)});
					} else if (n.nodeType === 1) walk(n);
				}
			};
			walk(document.body);
			return out;
		})()`)
		if (hits.length) {
			bad.push({label, hits})
			console.log(`FAIL  ${label}: ${hits.length} 处`)
			for (const h of hits.slice(0, 4)) console.log(`        [${h.where}] ${JSON.stringify(h.text)}`)
		} else {
			console.log(`PASS  ${label}`)
		}
		return hits.length
	}
	const clickFab = async (re) => {
		await evalJs(`(() => { const b = [...document.querySelectorAll(".fab")].find(x => new RegExp(${JSON.stringify(re)}).test(x.textContent)); if (b) b.click(); return !!b })()`)
		await sleep(900)
	}
	/* 自检: 扫描器本身有效吗 —— 往 DOM 临时塞一个带 ** 的节点, 必须被扫出来 (否则"全 PASS"是假绿) */
	const selfHit = await evalJs(`(() => {
		const d = document.createElement("div");
		d.textContent = "自检 ** 星号";
		document.body.appendChild(d);
		let hit = 0;
		const walk = (el) => { for (const n of el.childNodes) {
			if (n.nodeType === 3) { if ((n.textContent || "").includes("**")) hit += 1 }
			else if (n.nodeType === 1) walk(n) } };
		walk(document.body);
		d.remove();
		return hit;
	})()`)
	if (selfHit > 0) console.log("PASS  探针自检: 注入的 ** 能被扫出来")
	else { console.log("FAIL  探针自检: 扫描器没抓到注入的 ** (后面的 PASS 不可信)"); bad.push({label: "探针自检", hits: [{where: "self", text: "扫描器失效"}]}) }
	const closeSheet = async () => { await evalJs(`document.querySelector(".sheet-mask")?.click()`); await sleep(500) }
	const scrollSheet = async (top) => { await evalJs(`(() => { const b = document.querySelector(".sheet .sheet-body") || document.querySelector(".sheet"); if (b) b.scrollTop = ${top}; return true })()`); await sleep(400) }

	/* ① 新手引导 (有专门的 ** 渲染器, 这里顺带验证它没问题) */
	const hasIntro = await evalJs(`!!document.querySelector(".intro-mask")`)
	if (hasIntro) await scan("新手引导(首屏)")
	for (let i = 0; i < 8; i += 1) {
		if (!(await evalJs(`!!document.querySelector(".intro-mask")`))) break
		await evalJs(`document.querySelector(".intro-next")?.click()`)
		await sleep(350)
	}
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await sleep(300)
	await scan("主界面(底栏)")

	/* ② 各面板 */
	for (const [re, name] of [["对话|聊天", "对话面板"], ["设置", "设置页"]]) {
		await clickFab(re)
		await scan(`${name}·顶部`)
		await scrollSheet(700); await scan(`${name}·中部`)
		await scrollSheet(2000); await scan(`${name}·中下`)
		await scrollSheet(99999); await scan(`${name}·底部`)
		if (name === "设置页") {
			/* 三级入口: 语音合成 / 动作列表 / 表情列表 / 新手引导 */
			for (const sub of ["语音合成", "动作列表", "表情列表", "新手引导"]) {
				const ok = await evalJs(`(() => { const b = [...document.querySelectorAll(".sheet button")].find(x => x.textContent.trim().startsWith(${JSON.stringify(sub)})); if (b) { b.click(); return true } return false })()`)
				await sleep(1100)
				if (ok) await scan(`设置→${sub}`)
				else console.log(`  (跳过 ${sub}: 没找到按钮)`)
				await evalJs(`document.querySelector(".sheet .x")?.click()`); await sleep(600)
				await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`); await sleep(900)
				await scrollSheet(99999)
			}
			/* 记忆库 (点三下) */
			await scrollSheet(0)
			for (let i = 0; i < 3; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(400) }
			await sleep(700)
			await scan("记忆库·顶部")
			await scrollSheet(900); await scan("记忆库·中部")
			await scrollSheet(99999); await scan("记忆库·底部")
		}
		await closeSheet()
	}
	/* ③ 其余面板 */
	for (const [re, name] of [["日记", "日记"], ["番茄", "番茄钟"], ["模型", "选择模型"], ["触摸", "自定义触摸"]]) {
		await clickFab(re)
		await scan(name)
		await closeSheet()
	}
} catch (e) {
	console.log("探针失败:", e.message)
	process.exitCode = 1
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}
console.log(`\n合计 ${bad.length} 个界面有字面 **`)
for (const b of bad) for (const h of b.hits) console.log(`  - ${b.label} [${h.where}] ${JSON.stringify(h.text)}`)
process.exitCode = bad.length ? 1 : 0
