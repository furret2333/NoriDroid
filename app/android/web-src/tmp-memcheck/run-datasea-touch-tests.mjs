/**
 * 数据海"触摸响应"门禁（Node 直测，不用浏览器 / 不用 harness）。
 *
 * 覆盖 `src/services/datasea-touch.ts`：
 *   - 常数：半径 170（沿用旧值）、趋近率 **0.18**（旧 0.4，用户要求"更慢"）、渐入 350ms、渐出 400ms
 *   - 渐入 / 渐出：起止值、单调、中点、非法时间
 *   - **渐入基准不能被 move 刷新**（文件头那个坑的守门人；旧代码正是按"最近一次移动"计时）
 *   - 吸引点低通的帧率无关性（60fps 与 30fps 走过同样的比例）
 *   - `dataseaTouchPull`：距离/强度/半径边界、NaN 一律 0（不许污染粒子坐标）
 *
 * 运行: cd web-src && node tmp-memcheck/run-datasea-touch-tests.mjs
 */
import {readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

const outfile = path.join(root, "tmp-memcheck/datasea-touch-bundle.mjs")
await build({
	entryPoints: [path.join(root, "src/services/datasea-touch.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent", outfile,
})
const T = await import(pathToFileURL(outfile).href)
const {
	DATASEA_TOUCH_RADIUS, DATASEA_TOUCH_PULL_RATE, DATASEA_TOUCH_RAMP_MS, DATASEA_TOUCH_RELEASE_MS,
	DATASEA_TOUCH_GLIDE_RATE,
	newDataseaTouchState, dataseaTouchStart, dataseaTouchMove, dataseaTouchEnd, dataseaTouchStep, dataseaTouchPull,
} = T

let pass = 0
let fail = 0
const check = (name, cond, detail = "") => {
	if (cond) { pass += 1; console.log(`PASS  ${name}`) }
	else { fail += 1; console.log(`FAIL  ${name}  ← ${detail}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(want)}`)
const near = (name, got, want, tol = 1e-6) => check(name, Number.isFinite(got) && Math.abs(got - want) <= tol, `得到 ${got}, 期望 ${want} ±${tol}`)

/** 以固定帧长推进若干帧，返回最后一帧的 step 结果（模拟 rAF 循环） */
const run = (st, from, frames, ms, fn) => {
	let s = st
	let last = null
	for (let i = 0; i < frames; i++) {
		last = dataseaTouchStep(s, from + i * ms, ms / 1000)
		s = last.state
		if (fn) fn(last, i)
	}
	return {state: s, last}
}

/* ================= 1. 常数（都是用户定过或沿用旧值） ================= */
{
	eq("影响半径沿用旧值 170", DATASEA_TOUCH_RADIUS, 170)
	eq("趋近率 = 0.18（旧 0.4，用户要求更慢）", DATASEA_TOUCH_PULL_RATE, 0.18)
	check("趋近率确实比旧值慢（时间常数 1/0.18 ≈ 5.6s > 2.5s）", 1 / DATASEA_TOUCH_PULL_RATE > 5, String(1 / DATASEA_TOUCH_PULL_RATE))
	eq("渐入 350ms", DATASEA_TOUCH_RAMP_MS, 350)
	eq("渐出 400ms", DATASEA_TOUCH_RELEASE_MS, 400)
	eq("吸引点低通 8/s", DATASEA_TOUCH_GLIDE_RATE, 8)
}

/* ================= 2. 渐入 ================= */
{
	const s0 = dataseaTouchStart(newDataseaTouchState(), 100, 200, 0)
	eq("刚按下这一帧强度 = 0（这就是「不要立即移动」）", dataseaTouchStep(s0, 0, 1 / 60).strength, 0)
	near("渐入中点 (175ms) ≈ 0.5", dataseaTouchStep(s0, 175, 1 / 60).strength, 0.5, 1e-9)
	near("渐入结束 (350ms) = 1", dataseaTouchStep(s0, 350, 1 / 60).strength, 1, 1e-9)
	near("超出渐入窗口后仍为 1（不会过冲）", dataseaTouchStep(s0, 5000, 1 / 60).strength, 1, 1e-9)

	let prev = -1
	let monotonic = true
	for (let ms = 0; ms <= 400; ms += 10) {
		const v = dataseaTouchStep(s0, ms, 1 / 60).strength
		if (v < prev - 1e-12) monotonic = false
		prev = v
	}
	check("渐入全程单调不减", monotonic)
	check("渐入 100ms 时强度仍很低 (< 0.25)", dataseaTouchStep(s0, 100, 1 / 60).strength < 0.25,
		String(dataseaTouchStep(s0, 100, 1 / 60).strength))
}

/* ================= 3. ⚠ 渐入基准不能被 move 刷新（旧实现的坑） ================= */
{
	let s = dataseaTouchStart(newDataseaTouchState(), 100, 200, 0)
	/* 手指一路移动：每 50ms 一次 move（旧实现会把"最近触摸时刻"一直刷新） */
	for (let ms = 50; ms <= 300; ms += 50) s = dataseaTouchMove(s, 100 + ms, 200)
	const at350 = dataseaTouchStep(s, 350, 1 / 60).strength
	near("反复 move 后，350ms 处强度仍然是 1（渐入按**按下时刻**计时）", at350, 1, 1e-9)
	near("startAt 不被 move 改动", s.startAt, 0, 0)
	check("move 只改指尖位置（最后一次 move 在 ms=300 ⇒ x = 400）", s.rawX === 400 && s.rawY === 200, JSON.stringify({x: s.rawX, y: s.rawY}))
}

/* ================= 4. 渐出 ================= */
{
	const pressed = dataseaTouchStart(newDataseaTouchState(), 10, 20, 0)
	const full = dataseaTouchStep(pressed, 400, 1 / 60).state
	const released = dataseaTouchEnd(full, 1000)
	near("抬手瞬间强度 = 抬手时的强度（不跳变）", dataseaTouchStep(released, 1000, 1 / 60).strength, 1, 1e-9)
	near("渐出中点 (1200ms) ≈ 0.5", dataseaTouchStep(released, 1200, 1 / 60).strength, 0.5, 1e-9)
	near("渐出结束 (1400ms) = 0", dataseaTouchStep(released, 1400, 1 / 60).strength, 0, 1e-9)
	eq("渐出结束后 active = false", dataseaTouchStep(released, 1500, 1 / 60).active, false)

	/* 渐入中途抬手：从**当时的**强度往下走，不会先跳到 1 */
	const mid = dataseaTouchStep(pressed, 100, 1 / 60).state
	const midStrength = mid.strength
	const rel2 = dataseaTouchEnd(mid, 100)
	near("渐入中途抬手：起点 = 当时强度", dataseaTouchStep(rel2, 100, 1 / 60).strength, midStrength, 1e-9)
	check("渐入中途抬手：后续强度不超过抬手时的值", dataseaTouchStep(rel2, 150, 1 / 60).strength <= midStrength + 1e-12,
		`${midStrength} -> ${dataseaTouchStep(rel2, 150, 1 / 60).strength}`)

	/* 释放中再次按下：从当前强度续上，不跳变 */
	const rel3 = dataseaTouchEnd(full, 1000)
	const half = dataseaTouchStep(rel3, 1200, 1 / 60)   // 强度 ≈0.5
	const rePressed = dataseaTouchStart(half.state, 50, 60, 1200)
	const first = dataseaTouchStep(rePressed, 1200, 1 / 60)
	near("释放中再次按下：第一帧强度 = 那一刻的值（不跳回 0）", first.strength, half.strength, 1e-9)
	check("随后朝 1 上涨", dataseaTouchStep(rePressed, 1550, 1 / 60).strength > half.strength, "未上涨")
}

/* ================= 5. 吸引点低通（缓冲）与帧率无关 ================= */
{
	const s0 = dataseaTouchStart(newDataseaTouchState(), 0, 0, 0)
	const moved = dataseaTouchMove(s0, 100, 0)
	const one = dataseaTouchStep(moved, 16, 1 / 60)
	const expectK = 1 - Math.exp(-DATASEA_TOUCH_GLIDE_RATE * (1 / 60))
	near("一帧后吸引点走过的比例 k = 1-e^(-r·dt)", one.x, 100 * expectK, 1e-9)
	check("不是瞬间到位（这就是手指抖动的缓冲）", one.x > 0 && one.x < 100, String(one.x))

	/* 帧率无关：60fps 走 30 帧 ≈ 30fps 走 15 帧（同样 0.5 秒） */
	const a = run(dataseaTouchMove(s0, 100, 0), 0, 30, 1000 / 60).state
	const b = run(dataseaTouchMove(s0, 100, 0), 0, 15, 1000 / 30).state
	check("吸引点位置帧率无关（60fps 走 30 帧 vs 30fps 走 15 帧，差 < 0.6px）",
		Math.abs(a.x - b.x) < 0.6, `${a.x} vs ${b.x}`)

	/* 非法 dt 不推进、也不污染 */
	const bad = dataseaTouchStep(moved, 16, NaN)
	eq("dt = NaN 时吸引点不动", bad.x, 0)
	check("dt = NaN 时 step 不抛异常", Number.isFinite(bad.strength))
}

/* ================= 6. dataseaTouchPull ================= */
{
	const dt = 1 / 60
	const at = (d) => dataseaTouchPull(dt, d, 1)
	check("强度 0 → 0（渐入期间几乎不动）", dataseaTouchPull(dt, 50, 0) === 0)
	check("半径外 → 0", at(DATASEA_TOUCH_RADIUS) === 0 && at(200) === 0)
	check("贴得太近 (d ≤ 1) → 0（避免除零/抖动）", at(1) === 0 && at(0) === 0)
	check("越近拉得越多（随距离单调递减）", at(20) > at(60) && at(60) > at(120), `${at(20)} ${at(60)} ${at(120)}`)
	check("随强度线性缩放", Math.abs(at(50) * 0.5 - dataseaTouchPull(dt, 50, 0.5)) < 1e-12)
	check("上限不超过 1", dataseaTouchPull(10, 2, 1) <= 1, String(dataseaTouchPull(10, 2, 1)))
	check("dt = 0 / NaN → 0", dataseaTouchPull(0, 50, 1) === 0 && dataseaTouchPull(NaN, 50, 1) === 0)
	check("dist = NaN → 0", dataseaTouchPull(dt, NaN, 1) === 0)
	check("strength = NaN → 0", dataseaTouchPull(dt, 50, NaN) === 0)
	check("strength 超过 1 时按 1 处理", dataseaTouchPull(dt, 50, 5) === dataseaTouchPull(dt, 50, 1))

	/* 数值感受（写进注释，免得以后又被问"到底慢了多少"）：
	   60fps、粒子距指尖 50px、强度满：每帧靠近 (1-50/170)*0.18*(1/60) ≈ 0.2118% ⇒ 时间常数 ≈5.6s */
	near("满强度 60fps 时每帧趋近比例 ≈ 0.2118%", at(50), Math.min(1, 0.18 / 60) * (1 - 50 / 170), 1e-12)
}

/* ================= 7. 未按下时 move/end 都是空操作 ================= */
{
	const s = newDataseaTouchState()
	check("未按下时 move 返回原状态（悬停不搅动背景）", dataseaTouchMove(s, 5, 5) === s)
	check("未按下时 end 返回原状态", dataseaTouchEnd(s, 100) === s)
	eq("未按下时 step 强度 = 0", dataseaTouchStep(s, 0, 1 / 60).strength, 0)
	eq("未按下时 step 不活跃", dataseaTouchStep(s, 0, 1 / 60).active, false)
	check("非法坐标不会污染状态", Number.isFinite(dataseaTouchStart(s, NaN, NaN, 0).x))
}

console.log("")
console.log(`数据海触摸响应门禁: ${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
