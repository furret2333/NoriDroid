/* 探针: **这张模型上每个参数的"驱动者"是谁** —— 写参数之前先查这张表。
 *
 * 为什么需要它（血的教训）：
 *   "摸头低头"的第一版往 `ParamAngleY` / `ParamEyeBallY` 上叠偏移，而库**每帧也在写**这两个
 *   （`dragY*30` / `dragY`，值域正好占满参数量程）⇒ 效果随手指位置被抵消、量程边缘被夹掉。
 *   当时没人问过一句"**这个参数现在归谁**"。这个探针就是回答那句话的。
 *
 * 做法：空闲状态下（不摸头、不写字）连续采样每个参数的值，
 *   **自己会变的 = 有人在写**（库的注视/呼吸/物理/待机动作），**纹丝不动的 = 干净通道**。
 *   再与"已知库占用"的静态名单交叉标注（源码取证见 tmp-webarch-audit/scan-lib-writes.mjs）。
 *
 * 顺带能回答：模型若被重新导出、`model3.json` 的 `Groups.EyeBlink.Ids` 被填上，
 *   库的内置眨眼就会开始写 `ParamEyeLOpen/ROpen` —— 那时它们会从"干净"变成"有驱动"，
 *   而我们的自绘眨眼就成了**双重驱动**。跑一次这个探针就能看出来。
 *
 * 参数名单来源：模型自带的 `<id>.cdi3.json`（运行时 `__noriPartProbe().params` 在已打补丁的
 *   产物里是 undefined —— 见交接文档 §5 的说明，所以不依赖它）。
 *
 * 运行: node tmp-memcheck/probe-param-owner.mjs [模型名]   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync, readFileSync, existsSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const MODELS_DIR = "D:/norios/models"
const PORT = 9408
const SAMPLES = 20
const SAMPLE_MS = 60

/** 库**每帧**写的参数（源码取证：tmp-webarch-audit/scan-lib-writes.mjs） */
const LIBRARY_WRITTEN = new Set([
	"ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamEyeBallX", "ParamEyeBallY",
])
/** 我们自己的效果写的（用于直观对照） */
const OUR_WRITTEN = ["ParamBodyAngleY", "ParamBodyAngleYYDown", "ParamEyeLOpen", "ParamEyeROpen"]

const paramIds = (() => {
	for (const p of [join(MODELS_DIR, MODEL, `${MODEL}.cdi3.json`), join(MODELS_DIR, MODEL, MODEL, `${MODEL}.cdi3.json`)]) {
		if (!existsSync(p)) continue
		try {
			const ids = (JSON.parse(readFileSync(p, "utf8")).Parameters || []).map((x) => x.Id).filter(Boolean)
			if (ids.length) return ids
		} catch { /* 换下一个路径 */ }
	}
	return []
})()

const profile = mkdtempSync(join(tmpdir(), "nori-owner-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fx = (n) => (Number.isFinite(n) ? n.toFixed(3) : String(n))

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
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

try {
	if (!paramIds.length) throw new Error(`读不到参数名单（找过 ${MODELS_DIR}/${MODEL}/${MODEL}.cdi3.json）`)
	console.log(`模型 ${MODEL}：cdi3 参数 ${paramIds.length} 个；空闲采样 ${SAMPLES} 次 × ${SAMPLE_MS}ms\n`)

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

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4000)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
	await sleep(1500)
	const card = await evalJs(`(() => { const c = [...document.querySelectorAll(".mc")].find(x => x.textContent.includes(${JSON.stringify(MODEL)})); if (!c) return "NO_CARD"; c.click(); return "CLICKED" })()`)
	await sleep(9000)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(800)
	console.log(`模型加载: ${card}`)
	if (card === "NO_CARD") throw new Error("卡没找到 —— harness 没在跑? 或模型面板没打开")

	const hasGet = await evalJs(`typeof window.__noriGetParam === "function"`)
	if (!hasGet) throw new Error("缺少 __noriGetParam（补丁没打进产物?）")

	/* 空闲采样：不摸头、不写字，只看谁自己会变 */
	const series = new Map(paramIds.map((n) => [n, []]))
	for (let i = 0; i < SAMPLES; i += 1) {
		const snap = await evalJs(`(() => { const o = {}; for (const n of ${JSON.stringify(paramIds)}) o[n] = window.__noriGetParam(n); return o })()`)
		for (const n of paramIds) {
			const v = snap?.[n]
			if (typeof v === "number" && Number.isFinite(v)) series.get(n).push(v)
		}
		await sleep(SAMPLE_MS)
	}

	/* ② **交互采样**：空闲采样有致命盲区 —— 库写的 `dragX/dragY` 在没人碰屏幕时是 0，
	   于是 `ParamAngleX/Y/Z`、`ParamEyeBallX/Y` 全都"纹丝不动"，看起来像干净通道。
	   当初那个 bug 正是踩在这里（"ParamAngleY 归我独占"就是这么被误判的）。
	   所以主动驱动注视：**按住一处空白**（让视线跟随生效）→ 每轮移到**不同**的端点再采样。
	   ⚠ 端点必须每轮不同 —— 第一版每轮扫同一条路径，注视最后停在同一处，采出来全是 0 变化，
	     反而得出"ParamAngleY 没人写"的**错误**结论。 */
	const ev = (type, x, y) => evalJs(`document.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {clientX: ${x}, clientY: ${y}, pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true}))`)
	const PTS = [[40, 120], [480, 120], [480, 700], [40, 700], [40, 400], [480, 400]]
	await ev("pointerdown", 40, 400)          // 空白处按下：视线会跟随，但不会进头区(不触发我们的低头)
	const series2 = new Map(paramIds.map((n) => [n, []]))
	for (let i = 0; i < SAMPLES; i += 1) {
		const [x, y] = PTS[i % PTS.length]
		await ev("pointermove", x, y)
		await sleep(120)                      // 等注视的缓动跟上
		const snap = await evalJs(`(() => { const o = {}; for (const n of ${JSON.stringify(paramIds)}) o[n] = window.__noriGetParam(n); return o })()`)
		for (const n of paramIds) {
			const v = snap?.[n]
			if (typeof v === "number" && Number.isFinite(v)) series2.get(n).push(v)
		}
		await sleep(SAMPLE_MS)
	}
	await ev("pointerup", 40, 400)

	/* 这次库实际加载的 model3.json —— 用来判定"条件性库写入"（EyeBlink / LipSync）到底生效没有 */
	const modelSetting = await evalJs(`fetch("/assets/web/live2d/${MODEL}/${MODEL}/${MODEL}.model3.json").then(r => r.ok ? r.json() : null).then(j => j ? j.Groups : null).catch(() => null)`)
	const groupIds = (name) => {
		const g = (modelSetting || []).find((x) => x && x.Name === name)
		return g ? g.Ids || [] : null
	}

	const rows = paramIds.map((n) => {
		const vs = series.get(n) || []
		const vs2 = series2.get(n) || []
		const amp = vs.length ? Math.max(...vs) - Math.min(...vs) : 0
		const amp2 = vs2.length ? Math.max(...vs2) - Math.min(...vs2) : 0
		const last = vs.length ? vs[vs.length - 1] : null
		return {n, amp, amp2, last, driven: amp > 1e-6 || amp2 > 1e-6}
	})
	const driven = rows.filter((r) => r.driven).sort((a, b) => Math.max(b.amp, b.amp2) - Math.max(a.amp, a.amp2))
	const clean = rows.filter((r) => !r.driven)

	console.log(`\n=== 空闲/交互两轮采样后"动过"的参数（${driven.length} 个）：**有人写过，别往里叠效果** ===`)
	console.log(`   ${"参数".padEnd(26)} ${"空闲摆幅".padStart(10)} ${"交互摆幅".padStart(10)}  备注`)
	for (const r of driven) {
		const tag = LIBRARY_WRITTEN.has(r.n) ? "★ 库的注视通道（空闲时为 0，只有交互才现形）"
			: OUR_WRITTEN.includes(r.n) ? "☆ 可能是我们自己的效果写的"
				: ""
		console.log(`   ${r.n.padEnd(26)} ${fx(r.amp).padStart(10)} ${fx(r.amp2).padStart(10)}  ${tag}`)
	}
	console.log(`\n=== 两轮都没动过的参数（${clean.length} 个）：**这个窗口里**没人写（不等于永远没人写，见下） ===`)
	console.log("   " + clean.map((r) => r.n).join("  "))

	console.log("\n=== 我们关心的几个参数现在归谁 ===")
	for (const n of OUR_WRITTEN) {
		const r = rows.find((x) => x.n === n)
		if (!r) { console.log(`   ${n.padEnd(26)} —— cdi3 里没这个名字`); continue }
		const who = r.driven ? `⚠ 有人在写（空闲 ${fx(r.amp)} / 交互 ${fx(r.amp2)}）` : "✓ 两轮都没人写"
		console.log(`   ${n.padEnd(26)} ${who}`)
	}

	const eyeIds = groupIds("EyeBlink")
	console.log(`\n=== 条件性库写入（看这次真正加载的 model3.json） ===`)
	console.log(`   Groups.EyeBlink.Ids = ${eyeIds === null ? "（没有 EyeBlink 组）" : JSON.stringify(eyeIds)}`)
	if (eyeIds === null || eyeIds.length === 0) {
		console.log("   ⇒ 库的内置眨眼**没有参数可驱动** ⇒ `ParamEyeLOpen/ROpen` 上的驱动只可能来自**我们自己的眨眼**")
	} else {
		console.log(`   ⇒ ⚠ 库的内置眨眼**会写** ${eyeIds.join(" / ")}，与我们的自绘眨眼**双重驱动** —— 需要二选一`)
	}
	const lipIds = groupIds("LipSync")
	console.log(`   Groups.LipSync.Ids  = ${lipIds === null ? "（没有 LipSync 组）" : JSON.stringify(lipIds)}`)

	console.log("\n=== 这个探针的边界（别过度相信） ===")
	console.log("   · 它回答的是「**在这个采样窗口里**谁动过这个参数」，不是「谁拥有它」")
	console.log("   · 静态的「库写了哪几个参数」以源码取证为准: tmp-webarch-audit/scan-lib-writes.mjs")
	console.log("   · 只在特定动作里被写的参数（例如某个动作才动的骨骼），两轮采样都可能漏掉")
} catch (e) {
	console.log(`!! 执行异常: ${e?.message ?? e}`)
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
