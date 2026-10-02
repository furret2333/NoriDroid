/* 端到端验证: 眨眼（真实浏览器里打开 App、挂上模型、采样眼部参数的实时值）。
 *
 * 为什么要 E2E: 眨眼的失败模式全是**静默**的 ——
 *   ① 库内置的 CubismEyeBlink 因为 model3.json 里 `Groups.EyeBlink.Ids` 是空数组而**从不眨眼**
 *      （能力在、名单空），看代码看不出来；
 *   ② 时序错（加在顶点计算之后）⇒ 参数写了但画面不动；
 *   ③ 覆盖写 ⇒ 把表情压掉；
 *   ④ 钩子槽位被另一个消费者顶掉 ⇒ 眨眼整个失效。
 * 所以这里直接**采样真实参数值**，要求它在一段时间里"确实闭下去又睁开"。
 *
 * 运行: node tmp-memcheck/e2e-blink.mjs   (需 harness 在 8123 跑着)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9357
const SAMPLE_MS = 50
const SAMPLE_FOR_MS = 12000
/** 采样窗口后再多采一小段：给"闭过之后要睁开"留出观测机会（见 ③ 处的说明） */
const TAIL_FOR_MS = 700
/**
 * 双眨时两次眨眼**起始**之间的间隔 = 一次眨眼的完整时长 + doubleGapMs
 *   = (closeMs 90 + closedMs 40 + openMs 130) + 130 = **390ms**
 * （门禁 `run-blink-tests.mjs` 有精确断言: `nextAtMs = 上次 nextAtMs + total + doubleGapMs`）
 *
 * ⚠ 这里原先写的是"双眨的 130ms"，并断言短间隔 `<= 300` —— 那个 130 是
 * **上一次眨完 → 下一次开始**的间隔，不是两次**起始**之间的间隔。结果：只要真的
 * 触发双眨（每次眨眼 12% 概率），这条断言就**必然假红**（实测 4 次里踩到 1 次）。
 */
const DOUBLE_BLINK_START_GAP_MS = 390
/** 采样是"轮询 + CDP 往返"（名义 50ms），观测值会比理论值多出约一个采样周期 */
const SAMPLE_SLACK_MS = 200

const profile = mkdtempSync(join(tmpdir(), "nori-e2e-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const J = (v) => JSON.stringify(v)

let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sessionId) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sessionId ? {sessionId} : {})}))
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
	/* 真·异常收集: 订阅 Runtime.exceptionThrown。
	   （注: 别的脚本里用的 `window.__noriE2EErrors` **全项目都没有定义** ⇒ 那条断言是空转的，
	    永远读回 0 就永远通过。这里不沿用那个写法。） */
	const pageErrors = []
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params?.exceptionDetails?.exception?.description ?? "?")
	})
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}

	/* ---- 挂模型（眼部参数要模型在场才有） ---- */
	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4000)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
	await sleep(1500)
	const card = await evalJs(`(() => { const c = [...document.querySelectorAll(".mc")].find(x => x.textContent.includes("ARGNori")); if (!c) return "NO_CARD"; c.click(); return "CLICKED" })()`)
	await sleep(9000)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(800)
	check("① 模型已挂载", card === "CLICKED", card)

	/* ---- ② 前提: 模型确实有这两个参数（否则下面测的是空气） ---- */
	const infoL = await evalJs(`window.__noriParamInfo ? window.__noriParamInfo("ParamEyeLOpen") : null`)
	const infoR = await evalJs(`window.__noriParamInfo ? window.__noriParamInfo("ParamEyeROpen") : null`)
	check("② 模型有 ParamEyeLOpen", !!infoL && infoL.i >= 0, J(infoL))
	check("② 模型有 ParamEyeROpen", !!infoR && infoR.i >= 0, J(infoR))
	if (infoL) console.log(`   ParamEyeLOpen = ${J({i: infoL.i, min: infoL.min, max: infoL.max, def: infoL.def, value: infoL.value})}`)

	/* ---- ③ 采样: 12 秒里眼部开合度必须"闭下去又睁开" ---- */
	const samples = []
	const t0 = Date.now()
	const sampleOnce = async () => {
		const s = await evalJs(`(() => {
			const d = (window.__noriPetDebug ? window.__noriPetDebug() : null) || {};
			return {l: typeof d.eyeLOpen === "number" ? d.eyeLOpen : null, r: typeof d.eyeROpen === "number" ? d.eyeROpen : null,
				closure: typeof d.blinkClosure === "number" ? d.blinkClosure : null, count: typeof d.blinkCount === "number" ? d.blinkCount : null}
		})()`)
		samples.push({...s, ms: Date.now() - t0})
		await sleep(SAMPLE_MS)
	}
	while (Date.now() - t0 < SAMPLE_FOR_MS) await sampleOnce()
	/* 尾巴: 窗口末尾很可能正好落在一次眨眼中间（甚至刚要开始眨）——
	   不补这一段，④「闭上之后必须睁开」的失败原因会是"窗口到点了"而不是"卡在闭眼"，属**假红**。 */
	const tail0 = Date.now()
	while (Date.now() - tail0 < TAIL_FOR_MS) await sampleOnce()
	const vals = samples.map(s => s.l).filter(v => typeof v === "number")
	check(`③ 采到了足够的样本 (${vals.length} 个)`, vals.length > 100, String(vals.length))
	if (!vals.length) throw new Error("一个参数值都没读到 —— 钩子或调试探针没接上")

	const maxV = Math.max(...vals)
	const minV = Math.min(...vals)
	const closed = samples.filter(s => typeof s.l === "number" && s.l <= Math.max(0.4, maxV * 0.5))
	const counts = samples.map(s => s.count).filter(v => typeof v === "number")
	const blinkCount = counts.length ? Math.max(...counts) : 0
	console.log(`   开合度范围 [${minV.toFixed(3)}, ${maxV.toFixed(3)}]；眨眼计数 ${blinkCount}；闭合采样 ${closed.length} 个`)
	if (closed.length) console.log(`   闭合时刻示例: ${closed.slice(0, 5).map(s => `${s.ms}ms l=${s.l.toFixed(2)} k=${(s.closure ?? 0).toFixed(2)}`).join(" | ")}`)

	check("③ 眼睛正常时是睁开的 (存在 ≥0.9 的采样)", maxV >= 0.9, `最大 ${maxV}`)
	/* 实测眨眼间隔（计数变化点）—— 计数偏多时这是唯一能定位"是不是抽筋"的证据 */
	const incTimes = []
	let prevCount = null
	for (const s of samples) {
		if (typeof s.count !== "number") continue
		if (prevCount !== null && s.count > prevCount) incTimes.push(s.ms)
		prevCount = s.count
	}
	const gaps = incTimes.slice(1).map((t, i) => t - incTimes[i])
	console.log(`   计数增点(ms): ${J(incTimes)}`)
	if (gaps.length) {
		const minGap = Math.min(...gaps)
		const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
		console.log(`   实测间隔(ms): min=${minGap} 平均=${avg.toFixed(0)} 全部=${J(gaps)}`)
		// 正常间隔应 ≥ 2.4s；只有"双眨"是允许的短间隔，其**起始**间隔 ≈ 390ms（见文件头的算式）
		const shortLimit = DOUBLE_BLINK_START_GAP_MS + SAMPLE_SLACK_MS
		const tooShort = gaps.filter(g => g < shortLimit + 100)
		check(`③ 眨眼间隔符合设置 (≥2.4s, 或双眨的 ~${DOUBLE_BLINK_START_GAP_MS}ms) —— 实测 min=${minGap}`,
			gaps.every(g => g >= 2300 || (g >= 100 && g <= shortLimit)), J(gaps))
		check("③ 双眨不该连续出现 (短间隔不超过 1 次)", tooShort.length <= 1, J(tooShort))
	}
	check("③ 出现过明显的闭合 (存在 ≤0.4 的采样) —— 这就是「在眨眼」", minV <= 0.4, `最小 ${minV}`)
	check("③ 闭眼时闭合量也非零", closed.some(s => (s.closure ?? 0) > 0.3), J(closed.slice(0, 2)))
	/* 注意口径: `blinkCount` 是**页面生命周期累计**(挂模型那十几秒也在眨),
	   所以"次数"要用**采样窗口内新增**来判, 否则会误判成"眨得太频繁"。 */
	check(`③ 采样窗口内眨眼次数合理 (${incTimes.length} 次 / ${SAMPLE_FOR_MS / 1000}s)`, incTimes.length >= 1 && incTimes.length <= 6, String(incTimes.length))
	check("③ 累计计数 ≥ 窗口内新增 (口径自检)", blinkCount >= incTimes.length, `累计 ${blinkCount} / 窗口 ${incTimes.length}`)

	/* ---- ④ 眨完必须回到睁开（乘性闭合不能留残留） ---- */
	const lastClosed = [...samples].reverse().find(s => typeof s.l === "number" && s.l <= 0.4)
	if (lastClosed) {
		const after = samples.filter(s => s.ms > lastClosed.ms).slice(0, 12)
		const recovered = after.some(s => typeof s.l === "number" && s.l >= 0.9)
		check("④ 闭过之后又睁开了 (没有残留/卡在闭眼)", recovered,
			J(after.map(s => s.l)))
	}
	check("④ 结束时眼睛是睁着的", (() => { const tail = samples.slice(-6).map(s => s.l).filter(v => typeof v === "number"); return tail.length > 0 && Math.max(...tail) >= 0.9 })(),
		J(samples.slice(-6).map(s => s.l)))

	/* ---- ⑤ 两只眼同步（同一帧写两个参数, 不该只闭一只） ---- */
	const pairs = samples.filter(s => typeof s.l === "number" && typeof s.r === "number" && s.l <= 0.6)
	check("⑤ 闭合时两只眼都闭 (左右同步)", pairs.length > 0 && pairs.every(s => s.r <= 0.75),
		J(pairs.slice(0, 3).map(s => ({l: s.l, r: s.r}))))

	/* ---- ⑥ 不该"抽筋": 闭合总时长占采样时长比例很小 ---- */
	const closedRatio = samples.filter(s => typeof s.l === "number" && s.l <= 0.6).length / samples.length
	check(`⑥ 闭合时间占比很小 (${(closedRatio * 100).toFixed(1)}% < 25%)`, closedRatio < 0.25, String(closedRatio))

	check("⑦ 期间无未捕获 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "))
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
