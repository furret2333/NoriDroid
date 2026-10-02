/* E2E: 数据海背景的**触摸响应**（跟随更慢 + 渐入缓冲 + 不再变亮）的真实浏览器验证。
 *
 * ## 分工（重要）
 * - **门禁 `run-datasea-touch-tests.mjs`（44 条）** 验的是**数学**：渐入/渐出曲线、趋近率、
 *   半径边界、NaN 一律为 0、吸引点低通的帧率无关性、以及"渐入基准不被 move 刷新"。
 * - **本套 E2E** 验的是**接线**：pointerdown/move/up 真的驱动了那个状态机；
 *   而且**关键时序必须放在页内测**（Node↔CDP 一次往返就有 50~200ms，
 *   用 Node 侧 sleep 去卡"120ms 时强度是多少"必然是错的 —— 这个项目已经踩过一次）。
 *
 * ## 覆盖
 *   1. 探针 + 粒子数；初始未按下
 *   2. **只 move 不按下 = 空操作**（悬停不算触摸）
 *   3. 按下后强度**在 350ms 内渐入**（不是一碰就满）
 *   4. **按住期间反复 move，强度不掉**（若渐入错误地按"最近一次移动"计时，这里必红）
 *   5. 按住 → 粒子确实**朝吸引点聚拢**（同一批粒子的平均距离显著缩小）
 *   6. 抬手后强度在 400ms 内**渐出**到 0（不是突然停住）
 *
 * 运行: node tmp-memcheck/e2e-datasea-touch.mjs   (需 harness 在 8123 + 先 pnpm build)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9411
const profile = mkdtempSync(join(tmpdir(), "nori-dstouch-"))
/* 窗口故意开得很小：这一套只测**背景粒子**，与布局无关；而 headless 走 SwiftShader，
   全屏 canvas 的每帧光栅能到 ~200ms ⇒ rAF 采样点会稀到"卡时间窗"的断言必然假红。
   实测：260×380 下 rAF 采样足够密，且粒子更靠近中心 ⇒ 聚拢信号更强。 */
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=260,380", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${detail}`}`)
}
const KNOWN_FAILS = []
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}
const J = (v) => JSON.stringify(v)

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
	const pageErrors = []
	await send("Runtime.addBinding", {name: "__noriNoop"}, sessionId).catch(() => {})
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") {
			pageErrors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? "?")
		}
	})
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4000)

	const probe = await evalJs(`(() => {
		const d = window.__noriDataseaDebug ? window.__noriDataseaDebug() : null
		if (!d) return {ok: false}
		return {ok: true, n: d.px.length, down: d.down, strength: d.strength, radius: d.radius}
	})()`)
	check("探针可用且背景粒子已播种 (130 个)", probe?.ok === true && probe?.n === 130, J(probe))
	check("初始未按下且强度为 0", probe?.down === false && probe?.strength === 0, J(probe))
	check("影响半径 = 170（沿用旧值）", probe?.radius === 170, String(probe?.radius))

	/* ---- 页内一次跑完：按下 → 采样渐入 → 反复 move → 聚拢 → 抬手 → 采样渐出 ----
	   全部放在页内是为了**时序精度**（见文件头说明）。 */
	const trace = await evalJs(`(async () => {
		const D = window.__noriDataseaDebug
		const dispatch = (type, x, y) => document.dispatchEvent(new PointerEvent(type, {
			clientX: x, clientY: y, pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true}))
		const wait = (ms) => new Promise((r) => setTimeout(r, ms))
		const P = {x: Math.round(innerWidth / 2), y: Math.round(innerHeight * 0.42)}
		const out = {}

		/* 1) 只 move 不按下 —— 应为空操作 */
		dispatch("pointermove", P.x + 30, P.y + 30)
		await wait(80)
		out.hoverOnly = {down: D().down, strength: D().strength}

		/* 2) 按下 + 逐帧采样强度（600ms） */
		const t0 = performance.now()
		dispatch("pointerdown", P.x, P.y)
		const ramp = []
		await new Promise((res) => {
			const tick = () => {
				const d = D()
				ramp.push([Math.round(performance.now() - t0), Number(d.strength.toFixed(4))])
				if (performance.now() - t0 < 600) requestAnimationFrame(tick); else res()
			}
			requestAnimationFrame(tick)
		})
		out.ramp = ramp
		out.downAfterPress = D().down

		/* 3) 按住期间反复 move（模拟手指移动）—— 若渐入按"最近一次移动"计时，强度会掉下去 */
		for (let i = 0; i < 8; i += 1) { dispatch("pointermove", P.x + i * 4, P.y); await wait(30) }
		out.afterMoves = Number(D().strength.toFixed(4))

		/* 4) 固定一批粒子（按下瞬间离吸引点最近的 12 个），看它们的平均距离会不会缩小 */
		const snap = D()
		const idx = snap.px.map(([x, y], i) => [i, Math.hypot(x - snap.x, y - snap.y)])
			.sort((a, b) => a[1] - b[1]).slice(0, 12).map(([i]) => i)
		const meanDist = () => {
			const d = D()
			let s = 0
			for (const i of idx) { const [x, y] = d.px[i]; s += Math.hypot(x - d.x, y - d.y) }
			return s / idx.length
		}
		out.distBefore = Number(meanDist().toFixed(2))
		await wait(3000)
		out.distAfter = Number(meanDist().toFixed(2))
		out.strengthWhileHeld = Number(D().strength.toFixed(4))

		/* 5) 抬手 + 逐帧采样渐出（700ms） */
		const t1 = performance.now()
		dispatch("pointerup", P.x, P.y)
		const rel = []
		await new Promise((res) => {
			const tick = () => {
				const d = D()
				rel.push([Math.round(performance.now() - t1), Number(d.strength.toFixed(4)), d.down ? 1 : 0])
				if (performance.now() - t1 < 700) requestAnimationFrame(tick); else res()
			}
			requestAnimationFrame(tick)
		})
		out.release = rel
		out.finalDown = D().down
		out.finalStrength = Number(D().strength.toFixed(4))
		return out
	})()`)

	/* ---- 断言 ----
	   ⚠ 时序断言的写法（这一版是踩过坑后改的）：
	   **不要**卡"第 120ms 时强度应该是多少" —— headless 里 rAF 只有 20~50fps，
	   采样点根本落不到那个时刻上（第一次写就是这么假红的，而产品行为其实是对的）。
	   改成**形状断言**：序列首/中/尾的存在性 + 单调性 —— 既与时序无关，又照样能抓住
	   "一碰就满强度"（不会有中间值）与"抬手突然停住"（不会出现渐出的中间值）。 */
	const seq = (list, i) => (list ?? []).map((r) => r[i])
	const monoUp = (xs) => xs.every((v, i) => i === 0 || v >= xs[i - 1] - 1e-9)
	const monoDown = (xs) => xs.every((v, i) => i === 0 || v <= xs[i - 1] + 1e-9)

	const ramp = seq(trace?.ramp, 1)
	const rel = seq(trace?.release, 1)
	console.log(`   渐入采样(ms,强度): ${J((trace?.ramp ?? []).filter((_, i) => i % 5 === 0))}`)
	console.log(`   渐出采样(ms,强度,down): ${J((trace?.release ?? []).filter((_, i) => i % 5 === 0))}`)
	console.log(`   聚拢: 最近 12 个粒子的平均距离 ${trace?.distBefore} → ${trace?.distAfter}`)

	check("只 move 不按下 → 空操作（悬停不算触摸）",
		trace?.hoverOnly?.down === false && trace?.hoverOnly?.strength === 0, J(trace?.hoverOnly))
	check("按下后 down = true", trace?.downAfterPress === true, String(trace?.downAfterPress))
	check("采样够密（600ms 窗内 ≥ 5 个 rAF 采样点）", ramp.length >= 5, `只有 ${ramp.length} 个`)
	check("**渐入**：第一个采样点还没到满强度（不是一碰就满）",
		ramp.length > 0 && ramp[0] < 0.999, `首点 = ${ramp[0]} @${trace?.ramp?.[0]?.[0]}ms`)
	check("**渐入**：序列里存在中间值 (0 < s < 0.999)", ramp.some((v) => v > 0 && v < 0.999), J(ramp.slice(0, 8)))
	check("**渐入**：单调不减且最后到 1", monoUp(ramp) && ramp.length > 0 && ramp[ramp.length - 1] >= 0.999,
		`单调=${monoUp(ramp)} 末值=${ramp[ramp.length - 1]}`)
	check("按住期间反复 move，强度仍是 1（渐入按「按下时刻」计时，不被 move 刷新）",
		trace?.afterMoves === 1, String(trace?.afterMoves))
	check("按住期间强度保持满值（未因 move 掉下去）", trace?.strengthWhileHeld === 1, String(trace?.strengthWhileHeld))
	check("按住 3 秒后这批粒子确实朝吸引点靠拢（平均距离缩小 ≥ 15%）",
		typeof trace?.distBefore === "number" && typeof trace?.distAfter === "number" &&
		trace.distBefore > 0 && (trace.distBefore - trace.distAfter) / trace.distBefore >= 0.15,
		`${trace?.distBefore} → ${trace?.distAfter} (${(((trace?.distBefore - trace?.distAfter) / trace?.distBefore) * 100 || 0).toFixed(1)}%)`)

	check("**渐出**：抬手后第一个采样点仍接近满强度（不是瞬间清零）",
		rel.length > 0 && rel[0] > 0.5, `首点 = ${rel[0]}`)
	check("**渐出**：序列里存在中间值 (0 < s < 1)", rel.some((v) => v > 0 && v < 1), J(rel.slice(0, 8)))
	check("**渐出**：单调不增且最后归 0", monoDown(rel) && rel.length > 0 && rel[rel.length - 1] === 0,
		`单调=${monoDown(rel)} 末值=${rel[rel.length - 1]}`)
	check("抬手后 down = false", trace?.finalDown === false, String(trace?.finalDown))
	check("期间无未捕获 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "))
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const failed = results.filter((r) => !r.cond)
	const isKnown = (r) => KNOWN_FAILS.some((k) => r.name.includes(k.match))
	const known = failed.filter(isKnown)
	const unknown = failed.filter((r) => !isKnown(r))
	const stale = KNOWN_FAILS.filter((k) => !results.some((r) => r.name.includes(k.match) && !r.cond))
	const passed = results.length - failed.length
	console.log(`\n${passed}/${results.length} passed` + (known.length ? `  （含 ${known.length} 条白名单内的已知失败）` : ""))
	if (known.length) {
		console.log("已知失败（预期内，不算回归）:")
		for (const k of KNOWN_FAILS) console.log(`  · ${k.match}\n    └ ${k.why}`)
	}
	if (unknown.length) {
		console.log(`❗未知失败 ${unknown.length} 条（**这才是回归**）:`)
		for (const r of unknown) console.log(`  · ${r.name}`)
	}
	if (stale.length) {
		console.log(`⚠ 白名单已过期: ${stale.map((k) => k.match).join(" / ")} 现在**通过**了 —— 请从 KNOWN_FAILS 里删掉该条目`)
	}
	if (unknown.length || stale.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
