/* E2E: 验证千问 CosyVoice "音色"相关的配置保护在真实浏览器 + 真实调用路径下的行为。

   规格 (2026-09-22 第四次修订):
     本项目一律使用用户自己克隆的专属音色, 不用任何系统音色。
       - empty: 音色留空                    → **确定**失败, 本地就拦下 (不发请求)
       - model: 音色是为**别的模型**克隆的   → 只是**提示**(设置页红字), **不拦**(fail-open)
         理由: 归属是从 settings 记录 / 音色名前缀推出来的, 属于推断 —— 推错就会把本来能用的
         配置硬拦死, 而且提示还会指错方向。所以放行, 真不匹配就让服务端回 InvalidParameter。
     归属判定优先级: settings 里记录的绑定 > 用音色 id 前缀反推 (`{target_model}-{prefix}-{唯一标识}`)
     两者都认不出 → 视为未知, 不提示跨模型 (宁可少提示也不误报)。

   覆盖的断言:
     A1-A4   预置设置开机 / 下拉显示「模型 · 音色id」/ 匹配时不提示
     A5-A7   切到别的模型 → 提示不匹配 + 下拉标「当前模型不可用」
     A8-A9b  fail-open: 不匹配时仍发请求, 请求里是当前模型; 报的是桥的回应而非本地提示
     A10     切模型后 settings.json 立即落盘 (不再依赖「保存设置」按钮)
     A11-A13 切回则不提示 / 清空则提示「不使用系统音色」/ 空音色时 8 个模型逐个都提示
     A14-A15 对照: 空音色仍然本地拦下, 桥未被调用
     B1-B3   旧数据 (string[]) 靠音色 id 前缀回填归属, 也拿到跨模型提示
     C1-C6   认不出归属的旧数据: 不误报, 且确实走到发请求 (能核对 model)
     D1-D3   同 id 重复时保留「带模型」的那条

   预置设置: harness 的 ?seed=<base64url(JSON)>。
   运行: node tmp-memcheck/e2e-tts-hint.mjs  (需 harness 在 8123) */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9377
const profile = mkdtempSync(join(tmpdir(), "nori-tts-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const ALL_MODELS = ["cosyvoice-v3.5-plus", "cosyvoice-v3.5-flash", "cosyvoice-v3-plus", "cosyvoice-v3-flash",
	"cosyvoice-v2", "qwen-audio-3.1-tts-flash", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"]

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

/* 在某个区块标题之后找 .field —— TTS 面板里有多个同名 label(模型 x3), 必须按区块作用域定位 */
const fieldIn = (secTitle, label) => `(() => {
	const t = [...document.querySelectorAll(".tts-sec-title")].find(x => x.textContent.trim() === ${JSON.stringify(secTitle)});
	if (!t) return null;
	let el = t.nextElementSibling;
	while (el) {
		const cl = el.classList;
		if (cl && cl.contains("tts-sec-title")) return null;
		if (cl && cl.contains("field")) {
			const lb = el.querySelector("label");
			if (lb && lb.textContent.trim() === ${JSON.stringify(label)}) return el;
		}
		el = el.nextElementSibling;
	}
	return null;
})()`
const SEC = "千问 CosyVoice 配置"
const OPSEC = "操作"

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

	/* 用给定设置开机, 并进入 TTS 面板 */
	const boot = async (seed) => {
		const url = `http://127.0.0.1:8123/assets/web/index.html?seed=${Buffer.from(JSON.stringify(seed), "utf8").toString("base64url")}`
		await send("Page.navigate", {url}, sessionId)
		await sleep(3500)
		await evalJs(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "设置")?.click()`)
		await sleep(700)
		await evalJs(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("语音合成（TTS）"))?.click()`)
		await sleep(700)
	}

	const sectionShown = `!![...document.querySelectorAll(".tts-sec-title")].find(x => x.textContent.trim() === ${JSON.stringify(SEC)})`
	const hintText = `(() => {
		const f = ${fieldIn(SEC, "音色")};
		if (!f) return "NO_FIELD";
		const h = f.querySelector(".hint.bad") || f.querySelector(".hint");
		return h ? h.textContent.trim() : "";
	})()`
	const setModel = (v) => `(() => {
		const f = ${fieldIn(SEC, "模型")};
		if (!f) return "NO_FIELD";
		const s = f.querySelector("select");
		s.value = ${JSON.stringify(v)};
		s.dispatchEvent(new Event("change", {bubbles: true}));
		return s.value;
	})()`
	const setVoice = (v) => `(() => {
		const f = ${fieldIn(SEC, "音色")};
		if (!f) return "NO_FIELD";
		const i = f.querySelector('input[type="text"]');
		i.value = ${JSON.stringify(v)};
		i.dispatchEvent(new Event("input", {bubbles: true}));
		return i.value;
	})()`
	const optionLabels = `(() => {
		const f = ${fieldIn(SEC, "音色")};
		return f ? [...f.querySelectorAll("option")].map(o => o.textContent.trim()) : null;
	})()`
	const clearBridgeMark = `window.__noriCosyLast = null; "ok"`
	const bridgeReached = `!!window.__noriCosyLast`
	const bridgeModel = `(window.__noriCosyLast && window.__noriCosyLast.model) || ""`
	const clickTest = `(() => {
		const t = [...document.querySelectorAll(".tts-sec-title")].find(x => x.textContent.trim() === ${JSON.stringify(OPSEC)});
		if (!t) return "NO_SEC";
		const b = [...t.parentElement.querySelectorAll("button")].find(x => x.textContent.trim() === "测试并试听");
		if (!b) return "NO_BTN";
		b.click();
		return "CLICKED";
	})()`
	const opMsg = `(() => {
		const t = [...document.querySelectorAll(".tts-sec-title")].find(x => x.textContent.trim() === ${JSON.stringify(OPSEC)});
		if (!t) return "NO_SEC";
		const h = t.parentElement.querySelector(".hint");
		return h ? h.textContent.trim() : "";
	})()`
	/* 读回假桥里落盘的 settings.json —— 用来验证"改动是否真的持久化" */
	const persisted = (field) => `(() => {
		try { const raw = window.NoriChat.readFile("settings.json"); return raw ? (JSON.parse(raw)[${JSON.stringify(field)}] ?? null) : null } catch { return null }
	})()`

	/* ============ 场景 A: 正常配套 (音色为当前模型克隆) ============ */
	const VOICE = "cosyvoice-v3-flash-myvoice-ab12cd"
	await boot({
		ttsProvider: "cosyvoice", cosyApiKey: "sk-fake-for-test",
		cosyModel: "cosyvoice-v3-flash", cosyVoice: VOICE,
		cosyCloneVoices: [{id: VOICE, model: "cosyvoice-v3-flash"}],
	})

	check("A1 预置设置开机后千问区块已渲染", (await evalJs(sectionShown)) === true)
	check("A2 定位到「音色」栏", (await evalJs(`(${fieldIn(SEC, "音色")}) ? "OK" : "NO"`)) === "OK")

	const labelsA = await evalJs(optionLabels)
	check("A3 下拉显示「模型 · 音色id」",
		Array.isArray(labelsA) && labelsA.some(l => l === `cosyvoice-v3-flash · ${VOICE}`), JSON.stringify(labelsA))
	check("A4 音色与模型匹配 → 不提示", (await evalJs(hintText)) === "", JSON.stringify(await evalJs(hintText)))

	/* 切到"音色不是为它克隆的"模型 —— 核心场景 */
	await evalJs(setModel("cosyvoice-v2"))
	await sleep(400)
	const hA = await evalJs(hintText)
	check("A5 把模型切到 cosyvoice-v2 → 提示音色与模型不匹配",
		typeof hA === "string" && hA.includes("不匹配"), JSON.stringify(hA))
	check("A6 提示里点明「为哪个模型克隆的 / 当前是哪个」",
		typeof hA === "string" && hA.includes("cosyvoice-v3-flash") && hA.includes("cosyvoice-v2"), JSON.stringify(hA))
	const labelsA2 = await evalJs(optionLabels)
	check("A7 下拉里该项被标为「当前模型不可用」",
		Array.isArray(labelsA2) && labelsA2.some(l => l.includes("当前模型不可用")), JSON.stringify(labelsA2))

	/* fail-open: "不匹配"只是提示, 不拦 —— 请求照发。
	   理由: 归属是从记录/前缀推出来的(推断), 推错就会把本来能用的配置硬拦死;
	   真不匹配的话服务端会回 InvalidParameter, 用户自己看得见。 */
	await evalJs(clearBridgeMark)
	await evalJs(clickTest)
	await sleep(2200)
	const msgA = await evalJs(opMsg)
	check("A8 不匹配时点「测试并试听」→ 仍然发请求 (fail-open, 桥被调用)",
		(await evalJs(bridgeReached)) === true, JSON.stringify(await evalJs(bridgeReached)))
	check("A9 请求里带的是当前选中的模型 (本地不做改写)",
		(await evalJs(bridgeModel)) === "cosyvoice-v2", JSON.stringify(await evalJs(bridgeModel)))
	check("A9b 报的是桥的回应, 不是本地的「不匹配」提示",
		typeof msgA === "string" && msgA.includes("FAKE_BRIDGE_REACHED"), JSON.stringify(msgA))

	/* 改动落盘: 切模型时 @change 应立即持久化, 不再依赖「保存设置」按钮 */
	/* 落盘: 改模型/音色后**自动保存** (防抖 600ms), 不依赖「保存设置」按钮 */
	await sleep(900)
	check("A10 切模型后自动落盘 (cosyModel=cosyvoice-v2)",
		(await evalJs(persisted("cosyModel"))) === "cosyvoice-v2", JSON.stringify(await evalJs(persisted("cosyModel"))))

	/* A10b: 只派发 input、**不派发 change** —— 模拟"打完字直接关面板"。
	   这是 watch 方案相对 @change 的关键好处: 不失焦、change 不触发, 也要能存下来。 */
	await evalJs(`(() => {
		const f = ${fieldIn(SEC, "音色")};
		const i = f.querySelector('input[type="text"]');
		i.value = "typed_only_voice";
		i.dispatchEvent(new Event("input", {bubbles: true}));
		return i.value;
	})()`)
	await sleep(900)
	check("A10b 只输入不失焦也会自动落盘 (不依赖 change 事件)",
		(await evalJs(persisted("cosyVoice"))) === "typed_only_voice",
		JSON.stringify(await evalJs(persisted("cosyVoice"))))

	/* 切回 → 提示消失 */
	await evalJs(setModel("cosyvoice-v3-flash"))
	await sleep(400)
	check("A11 把模型切回原模型 → 提示消失", (await evalJs(hintText)) === "", JSON.stringify(await evalJs(hintText)))

	/* 清空音色 → 换成"未设置音色"那一类 */
	await evalJs(setVoice(""))
	await sleep(400)
	const hA3 = await evalJs(hintText)
	check("A12 清空音色 → 提示变为「不使用系统音色」",
		typeof hA3 === "string" && hA3.includes("不使用系统音色"), JSON.stringify(hA3))

	/* 空音色 + 逐个模型: 都该提示 */
	let allHint = true
	const missed = []
	for (const m of ALL_MODELS) {
		await evalJs(setModel(m))
		await sleep(180)
		const t = await evalJs(hintText)
		if (!(typeof t === "string" && t.includes("不使用系统音色"))) { allHint = false; missed.push(`${m}=${JSON.stringify(t)}`) }
	}
	check("A13 音色为空时, 8 个模型逐个都要提示", allHint, missed.join(", "))

	/* 与 fail-open 形成对照: 音色留空是**确定**的失败, 所以仍然本地拦下 (不发请求) */
	await evalJs(clearBridgeMark)
	await evalJs(clickTest)
	await sleep(2200)
	const msgA4 = await evalJs(opMsg)
	check("A14 音色留空时点「测试并试听」→ 本地就拦下 (桥未被调用)",
		(await evalJs(bridgeReached)) === false, JSON.stringify(await evalJs(bridgeReached)))
	check("A15 且报的是「不使用系统音色」",
		typeof msgA4 === "string" && msgA4.includes("不使用系统音色"), JSON.stringify(msgA4))

	/* ============ 场景 B: 旧数据 string[] + id 带模型前缀 (前缀回填) ============ */
	const LEGACY = "cosyvoice-v3-flash-myvoice-legacy"
	await boot({
		ttsProvider: "cosyvoice", cosyApiKey: "sk-fake-for-test",
		cosyModel: "cosyvoice-v3-flash", cosyVoice: LEGACY,
		cosyCloneVoices: [LEGACY],
	})
	check("B1 旧格式 string[] 能正常开机 (不崩)", (await evalJs(sectionShown)) === true)
	const labelsB = await evalJs(optionLabels)
	check("B2 靠 id 前缀回填出了归属 (下拉显示模型)",
		Array.isArray(labelsB) && labelsB.some(l => l === `cosyvoice-v3-flash · ${LEGACY}`), JSON.stringify(labelsB))
	await evalJs(setModel("cosyvoice-v2"))
	await sleep(400)
	const hB = await evalJs(hintText)
	check("B3 旧数据也拿到了跨模型保护 (切模型会提示)",
		typeof hB === "string" && hB.includes("不匹配"), JSON.stringify(hB))

	/* ============ 场景 C: 认不出归属的旧数据 —— 不误报, 且真的会发请求 ============ */
	await boot({
		ttsProvider: "cosyvoice", cosyApiKey: "sk-fake-for-test",
		cosyModel: "cosyvoice-v2", cosyVoice: "legacy_custom_9",
		cosyCloneVoices: ["legacy_custom_9"],
	})
	check("C1 认不出归属的旧数据能正常开机", (await evalJs(sectionShown)) === true)
	const labelsC = await evalJs(optionLabels)
	check("C2 下拉显示裸 id (无模型前缀)", Array.isArray(labelsC) && labelsC.includes("legacy_custom_9"), JSON.stringify(labelsC))
	check("C3 归属未知 → 不误报不匹配", (await evalJs(hintText)) === "", JSON.stringify(await evalJs(hintText)))

	await evalJs(clearBridgeMark)
	await evalJs(clickTest)
	await sleep(2200)
	const msgC = await evalJs(opMsg)
	check("C4 归属未知时确实走到了发请求这一步 (桥被调用)",
		(await evalJs(bridgeReached)) === true, JSON.stringify(await evalJs(bridgeReached)))
	check("C5 且请求里的 model 就是当前选中的模型",
		(await evalJs(bridgeModel)) === "cosyvoice-v2", JSON.stringify(await evalJs(bridgeModel)))
	check("C6 报的是桥的回应, 不是「不匹配」也不是「原生桥不支持」",
		typeof msgC === "string" && msgC.includes("FAKE_BRIDGE_REACHED"), JSON.stringify(msgC))

	/* ============ 场景 D: 同 id 重复时保留"带模型"的那条 ============ */
	await boot({
		ttsProvider: "cosyvoice", cosyApiKey: "sk-fake-for-test",
		cosyModel: "cosyvoice-v3-flash", cosyVoice: "custom_voice_1",
		cosyCloneVoices: [{id: "custom_voice_1", model: ""}, {id: "custom_voice_1", model: "cosyvoice-v2"}],
	})
	const labelsD = await evalJs(optionLabels)
	const dOpts = Array.isArray(labelsD) ? labelsD.filter(l => l.includes("custom_voice_1")) : []
	check("D1 同 id 去重后只剩一项", dOpts.length === 1, JSON.stringify(labelsD))
	check("D2 保留的是「带模型」的那条 (旧写法会留空模型的那条)",
		dOpts.length === 1 && dOpts[0].includes("cosyvoice-v2"), JSON.stringify(dOpts))
	const hD = await evalJs(hintText)
	check("D3 因此能正确报出跨模型不匹配", typeof hD === "string" && hD.includes("不匹配"), JSON.stringify(hD))
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
