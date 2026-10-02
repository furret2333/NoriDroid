/* 探针: 「下载模型」前的**答题门**（2026-10-02 用户要求: 和「一键克隆」一模一样的那道「模型授权验证」）
 *
 * 入口认定: 模型面板（dock「模型」→ .sheet）里的**模型卡片**就是下载入口 ——
 *   已装的一只点一下 = 切换; 没装的那只点一下 = 触发下载 (pick → loadModel → ensureModel →
 *   NoriBridge.download → 原生 ModelBridge, 源 https://fc39e5fc.pinme.dev 未改)。
 *   所以门接在 pick(): 没装的**先答题, 答对才真的开始下载**。
 *
 * 断言分五组（对应任务书 ①~⑤）:
 *   ① 点「下载模型」→ 弹出验证题（题目元素存在）+ 开门时下载桥 0 次调用
 *   ② 先**答错** → 提示答案不对, 且假桥的 download **一次都没被调用**（证明真拦住了）+ 弹窗不关可重试
 *   ③ 再**答对** → 才开始下载（假桥被调用**恰好 1 次**、且当时 __noriModelRes 已挂 ⇒ 走的是真的下载路径）,
 *      加载态/进度照旧（topbar「下载 Nori…」）, 下载完弹窗收起、选择落盘
 *   ④ "重启"一次（同一 seed 重新开页）再验取消/关闭: 取消后**也不下载**、✕ 同样
 *   ⑤ 克隆那道门没被搞坏: 同一份弹窗仍是克隆那套文案(.clone-gate /「验证并克隆」),
 *      答错不调桥、答对才 createPresetCloneVoice
 *
 * 注: 假桥的 listInstalled 沿用 harness 的"只装了 ARGNori"⇒ 面板里的 Nori 永远是**没装的那只**;
 *     "重启"用同一个 ?seed=（seed 里 live2dModel=ARGNori）重新开页, 等价于真机上再进来一次 ——
 *     这样第④组还能验"当前模型就是没装的那只"以外的取消路径（当前是 Nori 时点同款卡片本来就会
 *     被"点的是当前模型"守卫直接忽略, 那是原有行为, 不是门的事）。
 *
 * 运行: node tmp-memcheck/probe-model-download-gate.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9470
const profile = mkdtempSync(join(tmpdir(), "nori-modelgate-"))
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
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")

/* 假桥:
   - NoriBridge.listInstalled 保持 harness 的"只装了 ARGNori" ⇒ 面板里的 Nori 是**没装的那只**(点它=下载)
   - NoriBridge.download 换成计数版: 记下调用时 __noriModelRes 是否已挂(证明走的是 ensureModel 的真实路径),
     并且**挂着不回包**（由探针稍后手动放行）—— 这样"下载中"这个状态是确定可观测的, 不靠抢时间窗
   - NoriChat.createPresetCloneVoice/queryCloneVoice 供第⑤组复用克隆那道门                                    */
const FAKE = `(() => {
	window.__dlCalls = []; window.__cloneCalls = []; window.__queryCalls = [];
	const nb = window.NoriBridge;
	if (!nb) return "no-NoriBridge";
	nb.download = function (modelId) {
		window.__dlCalls.push({id: modelId, hadRes: typeof window.__noriModelRes === "function"});
		/* 不回包: 等探针调 window.__noriModelRes 放行（真机上是原生下载器几秒~几十秒后回调） */
	};
	const nc = window.NoriChat || (window.NoriChat = {});
	nc.createPresetCloneVoice = function (apiKey, model, prefix) {
		window.__cloneCalls.push([apiKey, model, prefix]);
		setTimeout(() => { try { window.__noriClonePresetRes && window.__noriClonePresetRes(JSON.stringify({ok: true, voice_id: "nori-probe-voice"})) } catch (e) {} }, 40);
	};
	nc.queryCloneVoice = function (apiKey, voiceId) {
		window.__queryCalls.push([apiKey, voiceId]);
		setTimeout(() => { try { window.__noriCloneQueryRes && window.__noriCloneQueryRes(JSON.stringify({ok: true, status: "OK", target_model: "cosyvoice-v3.5-flash"})) } catch (e) {} }, 40);
	};
	return "ok";
})()`

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
	/* 故意不填 apiKey: 免得开机 refreshModels 失败的错误条把 topbar 的"下载…"占掉（v-if error / v-else-if loading） */
	const seed = {baseUrl: "https://api.probe.test", model: "m", ttsProvider: "cosyvoice",
		cosyApiKey: "sk-cosy-probe", cosyModel: "cosyvoice-v3.5-flash", live2dModel: "ARGNori"}

	/** 开页 + 跳过引导 + 装假桥（每次"重启"都走一遍） */
	const boot = async () => {
		await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${b64(seed)}`}, sessionId)
		await sleep(4300)
		await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
		await evalJs(`document.querySelector(".intro-mask")?.remove()`)
		return evalJs(FAKE)
	}
	/** dock「模型」→ 模型面板（返回卡片名字数组） */
	const openModelPanel = async () => {
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
		await sleep(1000)
		return evalJs(`[...document.querySelectorAll(".mc")].map(c => c.querySelector(".mname")?.textContent?.trim())`)
	}
	/** 点**没装的那只** Nori 卡片（= 触发下载入口） */
	const clickNoriCard = () => evalJs(`(() => {
		const c = [...document.querySelectorAll(".mc")].find(x => x.querySelector(".mname")?.textContent?.trim() === "Nori")
		if (!c) return "没找到 Nori 卡片"
		c.click(); return "clicked"
	})()`)
	const gateState = () => evalJs(`(() => {
		const g = document.querySelector(".gate")
		if (!g) return null
		return {cls: g.className, title: g.querySelector(".gate-title")?.textContent.trim(),
			q: g.querySelector(".gate-q")?.textContent.trim(), hasInput: !!g.querySelector(".gate-input"),
			desc: g.querySelector(".gate-desc")?.textContent.trim() || "",
			btns: [...g.querySelectorAll("button")].map(b => b.textContent.trim()),
			calls: (window.__dlCalls || []).length}
	})()`)
	/** 往输入框打字。门不在时**不抛异常**（返回 "no-input"）—— 反向验证（把门短路）时还要继续往下跑，
	 *  好让"没答题却已经下载了"这种最关键的失败也被报出来, 而不是在第一步崩掉。 */
	const typeAnswer = (v) => evalJs(`(() => {
		const i = document.querySelector(".gate-input")
		if (!i) return "no-input"
		i.value = ${JSON.stringify(v)}
		i.dispatchEvent(new Event("input", {bubbles: true}))
		return "typed"
	})()`)
	/** 点门里的按钮（同样不抛异常） */
	const clickGateBtn = (pattern) => evalJs(`(() => {
		const b = [...document.querySelectorAll(".gate button")].find(b => /${pattern}/.test(b.textContent))
		if (!b) return "no-btn"
		b.click(); return "clicked"
	})()`)

	/* ================= ① 点「下载模型」→ 先弹验证题 ================= */
	const fakeSetup = await boot()
	check("⓪ 假桥就位（可计数 NoriBridge.download）", fakeSetup === "ok", String(fakeSetup))
	const cards = await openModelPanel()
	check("①-1 模型面板列出可下载的模型（ARGNori / Nori）", Array.isArray(cards) && cards.includes("ARGNori") && cards.includes("Nori"), JSON.stringify(cards))
	const clicked = await clickNoriCard()
	check("①-2 点「下载模型」（未安装的 Nori 卡片）能点", clicked === "clicked", String(clicked))
	await sleep(500)
	const gate = await gateState()
	check("①-3 弹出「模型授权验证」弹窗", gate && gate.title === "模型授权验证" && /gate/.test(gate.cls || ""), JSON.stringify(gate))
	check("①-4 题目元素存在（同一道题: Nori 写的诗第一句？8 字）", gate && /Nori 写的诗第一句/.test(gate.q || "") && /8 字/.test(gate.q || ""), JSON.stringify(gate && gate.q))
	check("①-5 有输入框 + 取消/验证并下载", gate && gate.hasInput && (gate.btns || []).some(t => /取消/.test(t)) && (gate.btns || []).some(t => /验证并下载/.test(t)), JSON.stringify(gate && gate.btns))
	check("①-6 说明按动作换成「模型」（不再是内置音色）", gate && /模型/.test(gate.desc || "") && !/内置音色/.test(gate.desc || ""), JSON.stringify(gate && gate.desc))
	check("①-7 **开门时下载桥一次都没被调用**（还没答题）", gate && gate.calls === 0, `calls=${gate && gate.calls}`)

	/* ================= ② 答错 → 不许下载 ================= */
	await typeAnswer("水母是月亮")
	await sleep(200)
	await clickGateBtn("验证并下载")
	await sleep(700)
	const wrong = await evalJs(`(() => ({calls: (window.__dlCalls || []).length,
		msg: document.querySelector(".gate .hint")?.textContent.trim() || "",
		stillOpen: !!document.querySelector(".gate"),
		tag: (document.querySelector(".tag")?.textContent || "").trim(),
		loading: (document.querySelector(".loading")?.textContent || "").trim()}))()`)
	check("②-1 答错时明确报错（答案不对）", /不对|错误|再想/.test(wrong.msg), JSON.stringify(wrong))
	check("②-2 **答错时假桥 download 一次都没被调用**", wrong.calls === 0, `calls=${wrong.calls}`)
	check("②-3 答错后弹窗不关（可以再试）", wrong.stillOpen === true, JSON.stringify(wrong))
	check("②-4 答错后没有开始下载/加载（topbar 无「下载」）", !/下载/.test(wrong.loading) && wrong.tag === "ARGNori", JSON.stringify(wrong))

	/* ================= ③ 答对 → 才开始下载 ================= */
	await typeAnswer(" 水母是水里的月亮。 ")
	await sleep(200)
	await clickGateBtn("验证并下载")
	await sleep(800)   // 假桥挂着不回包 ⇒ 此刻必定还在"下载中"（不抢时间窗）
	const during = await evalJs(`(() => ({calls: (window.__dlCalls || []).length,
		loading: (document.querySelector(".loading")?.textContent || "").trim(),
		gateOpen: !!document.querySelector(".gate")}))()`)
	check("③-1 答对后**恰好在下载**（假桥被调用 1 次）", during.calls === 1, JSON.stringify(during))
	const dl = await evalJs(`window.__dlCalls || []`)
	check("③-2 下载的是没装的那只（参数 = Nori）", dl[0]?.id === "Nori", JSON.stringify(dl))
	check("③-3 走的是真的下载路径（调用时 __noriModelRes 已挂）", dl[0]?.hadRes === true, JSON.stringify(dl))
	check("③-4 进度/状态照旧（topbar 显示「下载 Nori…」）", /下载/.test(during.loading), JSON.stringify(during))
	check("③-5 答对后弹窗收起", during.gateOpen === false, JSON.stringify(during))
	// 放行假桥（等价于原生下载器回包）—— 放行前 __noriModelRes 必须还在（证明 ensureModel 真的在等它）
	const released = await evalJs(`(() => {
		const f = window.__noriModelRes
		if (typeof f !== "function") return "no-pending-res"
		f(JSON.stringify({ok: true, entryBase: "Nori"}))
		return "released"
	})()`)
	check("③-6 放行原生回调（此时确实有在等的 __noriModelRes）", released === "released", String(released))
	await sleep(2000)
	const after = await evalJs(`(() => {
		const s = (() => { try { return JSON.parse(window.NoriChat.readFile("settings.json") || "{}") } catch { return {} } })()
		return {calls: (window.__dlCalls || []).length, saved: s.live2dModel || "", gateOpen: !!document.querySelector(".gate")}
	})()`)
	check("③-7 下载结束后仍只调用一次（没有被重复触发）", after.calls === 1, JSON.stringify(after))
	check("③-8 选择已落盘（live2dModel=Nori）", after.saved === "Nori", JSON.stringify(after))

	/* ================= ④ 取消/关闭 → 也不下载（"重启"一次: Nori 又回到"没装+非当前"） ================= */
	const fake2 = await boot()
	check("④-0 重启后假桥复位（Nori 又是没装的那只, 计数从 0 开始）", fake2 === "ok", String(fake2))
	await openModelPanel()
	await clickNoriCard()
	await sleep(500)
	const reopened = await evalJs(`(() => ({gateOpen: !!document.querySelector(".gate"), calls: (window.__dlCalls || []).length}))()`)
	check("④-1 再点一次未安装的模型 → 又弹题（每次下载都要过门）", reopened.gateOpen === true && reopened.calls === 0, JSON.stringify(reopened))
	await clickGateBtn("取消")
	await sleep(600)
	const canceled = await evalJs(`(() => ({gateOpen: !!document.querySelector(".gate"),
		calls: (window.__dlCalls || []).length,
		loading: (document.querySelector(".loading")?.textContent || "").trim(),
		panelOpen: !!document.querySelector(".sheet")}))()`)
	check("④-2 点「取消」能关掉弹窗", canceled.gateOpen === false, JSON.stringify(canceled))
	check("④-3 **取消后不下载**（调用次数 0）", canceled.calls === 0, JSON.stringify(canceled))
	check("④-4 取消后没有开始加载（topbar 无「下载」）", !/下载/.test(canceled.loading), JSON.stringify(canceled))
	check("④-5 取消后回到模型列表（面板还开着，可以重选）", canceled.panelOpen === true, JSON.stringify(canceled))
	// ✕ 关闭按钮同一条路
	await clickNoriCard()
	await sleep(500)
	const open2 = await evalJs(`!!document.querySelector(".gate")`)
	await evalJs(`document.querySelector(".gate .gate-head .x")?.click()`)
	await sleep(600)
	const closedX = await evalJs(`(() => ({gateOpen: !!document.querySelector(".gate"), calls: (window.__dlCalls || []).length}))()`)
	check("④-6 点✕ 也能关（且同样不下载）", open2 === true && closedX.gateOpen === false && closedX.calls === 0, JSON.stringify(closedX))

	/* ================= ⑤ 克隆那道门没被搞坏（同一份弹窗, 克隆文案/行为原样） ================= */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	await sleep(900)
	await evalJs(`[...document.querySelectorAll("button")].find(x => /语音合成/.test(x.textContent))?.click()`)
	await sleep(1200)
	const ttsOk = await evalJs(`!!document.querySelector(".tts-page")`)
	check("⑤-1 进得了「语音合成」页", ttsOk === true, String(ttsOk))
	await evalJs(`(() => { const b = [...document.querySelectorAll(".tts-page button")].find(x => /一键克隆/.test(x.textContent)); b?.click(); return !!b })()`)
	await sleep(500)
	const cg = await gateState()
	check("⑤-2 克隆那道门还是它自己（.clone-gate + 标题/题面不变）", cg && /clone-gate/.test(cg.cls || "") && cg.title === "模型授权验证" && /Nori 写的诗第一句/.test(cg.q || ""), JSON.stringify(cg))
	const cgHint = await evalJs(`document.querySelector(".gate .gate-hint")?.textContent.trim() || ""`)
	check("⑤-3 克隆文案原样（内置音色 + 验证并克隆 + 克隆底部提示）",
		cg && /内置音色/.test(cg.desc) && (cg.btns || []).some(t => /验证并克隆/.test(t)) && /audio 3\.1/.test(cgHint), JSON.stringify({desc: cg && cg.desc, btns: cg && cg.btns, hint: cgHint}))
	await typeAnswer("水母是月亮")
	await sleep(200)
	await clickGateBtn("验证并克隆")
	await sleep(600)
	const cw = await evalJs(`(() => ({calls: (window.__cloneCalls || []).length, msg: document.querySelector(".gate .hint")?.textContent.trim() || ""}))()`)
	check("⑤-4 克隆答错仍不建音色 + 报错", cw.calls === 0 && /不对|再想/.test(cw.msg), JSON.stringify(cw))
	await typeAnswer("水母是水里的月亮")
	await sleep(200)
	await clickGateBtn("验证并克隆")
	await sleep(900)
	const cc = await evalJs(`window.__cloneCalls || []`)
	check("⑤-5 克隆答对才建音色（调用 1 次, 参数 key/model/prefix）", cc.length === 1 && cc[0][0] === "sk-cosy-probe" && !!cc[0][2], JSON.stringify(cc))
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
