/* 帧率档位验证: 用模拟时钟模拟不同刷新率下的 rAF 节奏, 数实际绘制次数。
   最关键的几条:
     ① 60Hz 屏设 60 必须仍是 60fps (不能因门限掉到 30) —— 早期比例容差就栽在这
     ② 低帧率档 (20/15) 在 60Hz 屏上必须真的降下来 —— 早期比例容差在这**完全失效**
        (目标 20fps 的门限 16ms < 60Hz 一帧 16.67ms → 每帧都通过 → 仍是 60fps)
     ③ 门限 0 = 不限制, 每帧都画
   运行: cd web-src && node tmp-memcheck/test-framecap.mjs  (需先跑 run-tests.mjs 生成 bundle) */
import path from "node:path"
import {pathToFileURL} from "node:url"
const root = path.resolve(process.cwd())
const mod = await import(pathToFileURL(path.join(root, "tmp-memcheck/framecap-bundle.mjs")).href)
const {installFrameCap, setFrameCap, frameThreshold, normalizeFps, L2D_FPS_OPTIONS, L2D_FPS_DEFAULT, L2D_FRAME_TOLERANCE_MS, frameGate, frameDtCapMs} = mod

let cases = 0
const fails = []
const check = (name, cond, detail = "") => {
	cases += 1
	if (!cond) fails.push(`${name}  ${detail}`)
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ← ${detail}`}`)
}

/** 模拟一段时间的 rAF 回调, 返回实际绘制次数
 *  @param hz 屏幕刷新率; @param seconds 时长; @param fps 档位; @param jitterMs 每帧抖动上限 */
const simulate = (hz, seconds, fps, jitterMs = 0) => {
	let t = 0
	const host = {}
	installFrameCap(host, fps, () => (t < 0 ? 0 : t))
	let draws = 0
	const updater = {updateTime: () => {}}
	const model = {update: () => { draws += 1 }}
	const step = 1000 / hz
	let seed = 12345
	const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
	while (t < seconds * 1000) {
		host.__noriL2dTick(updater, model)
		t += step + (jitterMs ? (rnd() * 2 - 1) * jitterMs : 0)
	}
	return draws
}

/** 期望帧率 = min(档位, 屏幕刷新率), 但受 vsync 整除限制允许一定偏差 */
const near = (got, want, tolRatio = 0.18) => Math.abs(got - want) <= Math.max(2, want * tolRatio)

console.log(`容差 = ${L2D_FRAME_TOLERANCE_MS}ms (绝对值)   档位 = [${L2D_FPS_OPTIONS.join(", ")}]   默认 = ${L2D_FPS_DEFAULT}\n`)

/* ---- 门限换算 ---- */
console.log("—— 门限换算 ——")
check("门限: 60fps → 14.67ms", Math.abs(frameThreshold(60) - (1000 / 60 - 2)) < 0.01, `${frameThreshold(60)}`)
check("门限: 0 → 不限制", frameThreshold(0) === 0, `${frameThreshold(0)}`)
check("门限: 20fps = 48ms, 大于 60Hz 一帧 16.67ms (比例容差正是在此失效)",
	frameThreshold(20) > 1000 / 60, `${frameThreshold(20)} vs ${(1000 / 60).toFixed(2)}`)
check("门限: 15fps = 64.67ms, 大于 60Hz 一帧", frameThreshold(15) > 1000 / 60, `${frameThreshold(15)}`)

/* ---- normalizeFps 归一化 ---- */
console.log("\n—— 档位归一化 ——")
check("normalizeFps(undefined) → 默认档", normalizeFps(undefined) === L2D_FPS_DEFAULT)
check("normalizeFps(30) → 30", normalizeFps(30) === 30)
check("normalizeFps(45) → 非法, 回落默认档", normalizeFps(45) === L2D_FPS_DEFAULT, `${normalizeFps(45)}`)
check("normalizeFps(0) → 0 (不限制合法)", normalizeFps(0) === 0)
check("normalizeFps('20') → 20 (字符串也认)", normalizeFps("20") === 20)

/* ---- 各档位 × 各刷新率 ----
   两个核心保证:
     a) **绝不超过档位** (节流的意义所在; 允许 12% + 1 帧的计数误差)
     b) 档位低于屏幕刷新率时**确实降下来了** (不能形同虚设)
   不逐档断言"精确等于 N": 帧率只能落在 vsync 整数分频上 (30Hz 屏拿不到 20fps, 只能 15),
   逐档写死精确值会把这种正常量化误判成失败。 */
console.log("\n—— 各档位实测 (模拟 1.5 秒) ——")
const SEC = 1.5
for (const hz of [120, 90, 60, 30]) {
	for (const fps of L2D_FPS_OPTIONS) {
		const perSec = simulate(hz, SEC, fps) / SEC
		const cap = fps === 0 ? hz : Math.min(fps, hz)
		const withinCap = perSec <= cap * 1.12 + 1
		const throttled = fps === 0 || fps >= hz ? true : perSec < hz * 0.9
		check(
			`${hz}Hz 屏 + 档位 ${fps === 0 ? "不限" : fps}: 不超帽 + ${fps === 0 || fps >= hz ? "(无需节流)" : "确实节流"} → 实测 ${perSec.toFixed(1)}fps (帽 ${cap})`,
			withinCap && throttled,
			`实测 ${perSec.toFixed(1)}fps, 帽 ${cap}`,
		)
	}
}

/* ---- 关键回归: 60Hz 设 60 必须真的是 60 ---- */
console.log("\n—— 关键回归防线 ——")
check("60Hz + 档位 60 保持 60fps (不因门限掉到 30)", near(simulate(60, 1, 60), 60, 0.05), `实测 ${simulate(60, 1, 60)}`)
check("60Hz + 档位 60 + ±1.2ms 抖动 仍 60fps", simulate(60, 1, 60, 1.2) >= 56, `实测 ${simulate(60, 1, 60, 1.2)}`)
check("120Hz + 档位 60 省一半", near(simulate(120, 1, 60), 60), `实测 ${simulate(120, 1, 60)}`)
// 低帧率档必须真的降下来 —— 这是旧比例容差完全失效的地方 (门限 16ms < 60Hz 一帧 16.67ms)
{
	const p20 = simulate(60, 2, 20) / 2
	const p15 = simulate(60, 2, 15) / 2
	check("60Hz + 档位 20 真的降到 20 (旧比例容差在此完全失效, 仍是 60)", near(p20, 20), `实测 ${p20.toFixed(1)}fps`)
	check("60Hz + 档位 15 真的降到 15 (旧比例容差在此完全失效, 仍是 60)", near(p15, 15), `实测 ${p15.toFixed(1)}fps`)
}

/* ---- 边界 ---- */
console.log("\n—— 边界 ——")
{
	const host = {}
	let t = 0
	installFrameCap(host, 60, () => t)
	let draws = 0
	const u = {updateTime: () => {}}
	const m = {update: () => { draws += 1 }}
	host.__noriL2dTick(u, m)
	check("首帧必画 (last 未定义时不跳过)", draws === 1, `draws=${draws}`)
	host.__noriL2dTick(u, m)
	check("同一时刻的第二帧被跳过", draws === 1, `draws=${draws}`)
}
{
	check("档位 0 = 不限制 (120Hz 全画)", near(simulate(120, 1, 0), 120, 0.05), `实测 ${simulate(120, 1, 0)}`)
}
{
	let t = 0
	const host = {}
	installFrameCap(host, 60, () => t)
	let draws = 0
	const u = {updateTime: () => {}}
	const m = {update: () => { draws += 1 }}
	for (let i = 0; i < 60; i += 1) { host.__noriL2dTick(u, m); t += 1000 / 60 }
	const afterHigh = draws
	setFrameCap(host, 20)
	for (let i = 0; i < 60; i += 1) { host.__noriL2dTick(u, m); t += 1000 / 60 }
	const lowPhase = draws - afterHigh
	check("运行时切档立即生效 (60→20 后 1 秒只画约 20 帧)", near(lowPhase, 20), `切换后 1 秒画了 ${lowPhase} 帧`)
	check("切档不影响已过去的时段 (前 1 秒仍是 60)", near(afterHigh, 60, 0.05), `${afterHigh} 帧`)
}
{
	check("长跑 5 秒无累积漂移", near(simulate(120, 5, 60), 300, 0.03), `实测 ${simulate(120, 5, 60)} 帧 / 5 秒`)
}

/* ---------------- frameGate / frameDtCapMs: 形象与背景共用的门控 ----------------
 * 背景(数据海)现在跟随**同一个旋钮**, 走的就是这两个纯函数 —— 所以边界必须钉住。 */
{
	check("frameGate: 首帧必画 (last 还没记)", frameGate(1000, undefined, 14.67).draw)
	check("frameGate: 门限内不画", !frameGate(1005, 1000, 14.67).draw)
	const skipped = frameGate(1005, 1000, 14.67)
	check("frameGate: 跳过时不推进 last (否则会一路顺延)", skipped.last === 1000, String(skipped.last))
	check("frameGate: 刚好到门限就画 (边界取 >=)", frameGate(1014, 1000, 14).draw)
	check("frameGate: 差 1ms 不画", !frameGate(1013, 1000, 14).draw)
	const drawn = frameGate(1020, 1000, 14.67)
	check("frameGate: 超过门限就画", drawn.draw)
	check("frameGate: 画了才推进 last", drawn.last === 1020, String(drawn.last))
	check("frameGate: 门限 0 = 不限制, 每帧都画", frameGate(1000.1, 1000, 0).draw)
	check("frameGate: 门限为负也当不限制", frameGate(1000.1, 1000, -5).draw)
	const nan = frameGate(NaN, 1000, 14.67)
	check("frameGate: now=NaN 时仍然画 (fail-open: 宁可少节流, 也不能冻住画面)", nan.draw, JSON.stringify(nan))
	check("frameGate: now=NaN 时不推进 last (不把 NaN 写进去污染后续判断)", nan.last === 1000, JSON.stringify(nan))
	check("frameGate: last 是 NaN 时当作没记过 (首帧语义)", frameGate(2000, NaN, 14.67).last === 2000, JSON.stringify(frameGate(2000, NaN, 14.67)))

	/* ⭐ 关键回归: 形象(installFrameCap 的 tick) 与 背景 必须走**同一个** frameGate。
	   以前 tick 里手写过一遍同样的判断 ⇒ 两处会漂移, 且那份没有 NaN 保护
	   (now() 返回 NaN → 写入 __noriL2dLast=NaN → 之后 `NaN-last<iv` 恒 false → 门控永久失效)。 */
	{
		let t = NaN
		const host = {}
		installFrameCap(host, 60, () => t)
		host.__noriL2dTick({updateTime: () => {}}, {update: () => {}})
		check("回归: 时钟给出 NaN 时 tick 仍会画 (不会因门控冻住渲染)", Number.isNaN(host.__noriL2dLast) === false, String(host.__noriL2dLast))
		// 时钟恢复正常后必须立刻回到"按档位节流", 而不是永久不限帧
		let draws = 0
		let tt = 1000
		const host2 = {}
		installFrameCap(host2, 60, () => tt)
		const model = {update: () => { draws += 1 }}
		const updater = {updateTime: () => {}}
		for (let i = 0; i < 60; i += 1) { host2.__noriL2dTick(updater, model); tt += 1000 / 60 }
		check(`回归: 1 秒 60Hz 内 tick 绘制约 60 次 (实测 ${draws})`, near(draws, 60, 0.1), String(draws))
	}

	/** 模拟"被门控的 rAF 循环"在给定刷新率下 1 秒真正画了几次 (与背景里的用法一致) */
	const simulateGated = (hz, seconds, fps, jitterMs = 0) => {
		let t = 0
		let last
		let draws = 0
		const minInterval = frameThreshold(fps)
		const step = 1000 / hz
		for (let i = 0; i < hz * seconds; i += 1) {
			t += step
			const now = jitterMs ? t + (Math.random() - 0.5) * jitterMs : t
			const g = frameGate(now, last, minInterval)
			last = g.last
			if (g.draw) draws += 1
		}
		return draws
	}
	check("背景: 120Hz 屏设 60 → 约 60 次/秒", near(simulateGated(120, 1, 60), 60, 0.1), String(simulateGated(120, 1, 60)))
	check("背景: 120Hz 屏设 30 → 约 30 次/秒", near(simulateGated(120, 1, 30), 30, 0.15), String(simulateGated(120, 1, 30)))
	check("背景: 120Hz 屏设 20 → 约 20 次/秒", near(simulateGated(120, 1, 20), 20, 0.2), String(simulateGated(120, 1, 20)))
	check("背景: 120Hz 屏设 15 → 约 15 次/秒", near(simulateGated(120, 1, 15), 15, 0.25), String(simulateGated(120, 1, 15)))
	check("背景: 60Hz 屏设 60 → 仍约 60 次/秒 (不能掉到 30)", near(simulateGated(60, 1, 60), 60, 0.1), String(simulateGated(60, 1, 60)))
	check("背景: 60Hz 屏设 20 → 约 20 次/秒", near(simulateGated(60, 1, 20), 20, 0.2), String(simulateGated(60, 1, 20)))
	check("背景: 不限 → 每帧都画 (120 次/秒)", simulateGated(120, 1, 0) === 120, String(simulateGated(120, 1, 0)))
	check("背景: 带 rAF 抖动仍不高过档位", simulateGated(60, 1, 20, 3) <= 22, String(simulateGated(60, 1, 20, 3)))

	/* dt 封顶必须跟着门限走 —— 这是"限帧后粒子变慢"的唯一防线 */
	check("dt 封顶基准 = 50ms", frameDtCapMs(0) === 50, String(frameDtCapMs(0)))
	check("60fps 档 (14.67ms) 仍用基准 50ms", frameDtCapMs(14.6667) === 50, String(frameDtCapMs(14.6667)))
	// 注意: 门限 *2 大于基准时就该放大 —— 这正是"别把低帧率档的 dt 夹掉"的机制
	check("20fps 档 (48ms) 放大到 96ms (≥ 一帧间隔 50ms)", frameDtCapMs(48) >= 1000 / 20, String(frameDtCapMs(48)))
	check("20fps 档的封顶 = 基准与 2×门限的较大者", frameDtCapMs(48) === Math.max(50, 96), String(frameDtCapMs(48)))
	const cap15 = frameDtCapMs(frameThreshold(15))
	check(`15fps 档的 dt 封顶 (${cap15.toFixed(1)}ms) 必须大于一帧间隔 (66.7ms)`, cap15 > 1000 / 15, String(cap15))
	check("回归: 旧的固定 50ms 在 15fps 下会夹掉每一帧", 50 < 1000 / 15, `50 < ${1000 / 15}`)
	check("dt 封顶对 NaN 回落到基准", frameDtCapMs(NaN) === 50, String(frameDtCapMs(NaN)))
}

console.log(`\n${cases - fails.length}/${cases} passed`)
if (fails.length) {
	process.exitCode = 1
	console.log("FAILED:\n  " + fails.join("\n  "))
}
