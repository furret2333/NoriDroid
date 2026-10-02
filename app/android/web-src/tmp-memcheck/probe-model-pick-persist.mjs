/* 探针: **Live2D 模型选择必须被记住**（用户 2026-09-30 报的小 bug）
 *
 * 症状：换模型后重启，回到"已装列表第一个"（选 nori，重启还是 nori）。
 * 根因（定位）：pick() 只改内存不落盘；Settings.model 是 LLM 模型名，没有字段存 Live2D 模型；
 *              启动写死 currentModelId = installed[0].id。
 *
 * 本探针验三件事（都在真实浏览器里跑，看 UI 实际表现）：
 *   ① 首启没有保存值时：用已装列表第一个（这是**有意**的默认，别改坏）
 *   ② 点另一只 → settings.json 里必须出现 live2dModel = 点的那只      ← 修前应为红
 *   ③ "重启"（用刚写下的 settings.json 重新开页）→ 仍是点的那只        ← 修前应为红
 *   ④ 守卫：保存的模型**已经不在已装列表里**（卸载/换机）→ 回落第一只，不许卡死
 *
 * 注：假桥的 readFile/writeFile 是**页面内存**，刷新即丢 —— 真实设备上是原生写文件。
 *     所以"重启"这一步用**刚写下的 settings.json 作为 ?seed=** 重新开页，等价于真机的写-读回路。
 *
 * 运行: node tmp-memcheck/probe-model-pick-persist.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9449
const profile = mkdtempSync(join(tmpdir(), "nori-modelpick-"))
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

/* 在页面任何脚本之前挂上钩子：把 harness 写死的 listInstalled（只有 ARGNori）
   换成"装了两只"。
   注：不能用 download 调用当"加载了哪只"的证据 —— 两只都报已装时根本不会走下载。
   改为看**网络请求**（Live2D 会去取 `<模型id>/xxx.model3.json` 等文件），那才是真的去加载哪只。 */
const HOOK = `(() => {
	let _v;
	Object.defineProperty(window, "NoriBridge", {
		configurable: true,
		get() { return _v },
		set(v) {
			_v = v;
			if (!v || typeof v !== "object") return;
			v.listInstalled = () => JSON.stringify([{id: "Nori", entryBase: "Nori"}, {id: "ARGNori", entryBase: "ARGNori"}]);
		},
	});
})();`

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")

try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	/* 记下每次"取模型文件"的请求 URL —— 用来证明**真的去加载了哪只**（而不是只改了高亮） */
	let modelReqs = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return }
		if (m.method === "Network.requestWillBeSent") {
			const u = String(m.params?.request?.url || "")
			if (/Nori|ARGNori/.test(u) && /\.(model3\.json|moc3|json|png|webp)/i.test(u)) modelReqs.push(u)
		}
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	await send("Network.enable", {}, sessionId)
	await send("Page.addScriptToEvaluateOnNewDocument", {source: HOOK}, sessionId)
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}
	/** 开页 + 等模型层稳定；seed = 当次 settings.json 的内容 */
	const openApp = async (settings) => {
		modelReqs = []
		await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(settings)}`}, sessionId)
		await sleep(4200)
		await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1");
			document.querySelector(".intro-mask")?.remove()`)
		await sleep(800)
	}
	/** 当前"选中的是哪只"：顶栏 tag 显示 currentModel?.name */
	const currentName = () => evalJs(`(document.querySelector(".tag")?.textContent || "").trim()`)
	/** 已落盘的 settings.json（假桥：页面内存 + seed 兜底） */
	const savedSettings = () => evalJs(`(() => { try { return JSON.parse(window.NoriChat.readFile("settings.json") || "{}") } catch { return {} } })()`)
	/** 真的去加载了哪只（看模型文件请求） */
	const loadedIds = () => {
		const hit = new Set()
		for (const u of modelReqs) { if (u.includes("ARGNori")) hit.add("ARGNori"); if (/\/Nori\b|\/Nori\//.test(u)) hit.add("Nori") }
		return [...hit]
	}

	/* ---------- 场景 A：首启没有保存值 → 用已装列表第一个（有意默认） ---------- */
	await openApp({apiKey: "sk-probe", baseUrl: "https://api.probe.test", model: "m"})
	const aName = await currentName()
	check("① 首启无保存值 → 用已装列表第一个 (Nori)", aName === "Nori", `tag=${JSON.stringify(aName)}`)
	check("① 且真的去加载的是 Nori", loadedIds().includes("Nori"), JSON.stringify({reqs: modelReqs.slice(0, 4), loaded: loadedIds()}))

	/* ---------- 场景 B：点另一只 → 必须落盘 ---------- */
	const clicked = await evalJs(`(() => {
		const b = [...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent));
		if (b) b.click();
		return !!b;
	})()`)
	await sleep(1000)
	const cards = await evalJs(`[...document.querySelectorAll(".mc")].map(c => c.querySelector(".mname")?.textContent?.trim())`)
	check("②-0 模型面板列出两只", Array.isArray(cards) && cards.includes("ARGNori") && cards.includes("Nori"), JSON.stringify(cards))
	await evalJs(`(() => { const c = [...document.querySelectorAll(".mc")].find(x => /ARGNori/.test(x.textContent)); if (c) c.click(); return !!c })()`)
	await sleep(2000)
	const saved1 = await savedSettings()
	check("② 点 ARGNori 后 settings.json 里有 live2dModel=ARGNori", saved1.live2dModel === "ARGNori", JSON.stringify(saved1.live2dModel))
	const bName = await currentName()
	check("② 且画面上确实切到了 ARGNori", bName === "ARGNori", `tag=${JSON.stringify(bName)}`)
	check("② 且真的去加载了 ARGNori", loadedIds().includes("ARGNori"), JSON.stringify(loadedIds()))

	/* ---------- 场景 C："重启"（把刚写下的设置当种子重开）→ 仍是 ARGNori ---------- */
	await openApp(saved1)
	const cName = await currentName()
	check("③ 重开后仍是 ARGNori（记住了上次选的）", cName === "ARGNori", `tag=${JSON.stringify(cName)}`)
	check("③ 重开后真的去加载的是 ARGNori（不是只改了显示）", loadedIds().includes("ARGNori"), JSON.stringify({reqs: modelReqs.slice(0, 4), loaded: loadedIds()}))

	/* ---------- 场景 D：保存的模型已不在已装列表里 → 回落第一只，不许卡死 ---------- */
	await openApp({...saved1, live2dModel: "GhostModel"})
	const dName = await currentName()
	check("④ 保存的模型不存在 → 回落已装列表第一个 (Nori)", dName === "Nori", `tag=${JSON.stringify(dName)}`)
	check("④ 且没有去加载那个不存在的模型", !loadedIds().includes("GhostModel"), JSON.stringify(loadedIds()))

	/* ---------- 场景 E：悬浮窗要跟主 App 显示**同一只** ---------- */
	modelReqs = []
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/float.html?shim=1&seed=${b64(saved1)}`}, sessionId)
	await sleep(4500)
	check("⑤ 悬浮窗也按主 App 保存的模型加载 (ARGNori)", loadedIds().includes("ARGNori"),
		JSON.stringify({reqs: modelReqs.slice(0, 4), loaded: loadedIds()}))
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
