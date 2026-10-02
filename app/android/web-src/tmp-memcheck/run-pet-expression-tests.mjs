/**
 * 摸头表情门禁（Node 直测，不用浏览器 / 不用 harness）。
 *
 * 覆盖 `src/services/live2d/petExpression.ts`：
 *   - `pickPetExpression`    : shy/smile 二选一、**必须过 EXPRESSION_DENY**、跨模型安全
 *   - `petExpressionStep`    : 1 秒宽限、抚摸期间不换脸、超时收回、纯函数
 *   - `applyPetExpression`   : **只在状态变化时**才调库（这条是"不闪烁"的守门人）
 *
 * 两条关键回归（都是这个项目真出过的事）：
 *   ① 旧的 `pickStrokeExpression()` 用 `includes("happy")` ⇒ 恒出 `13_Happy`，shy/smile 永远轮不到；
 *   ② 若不过 `EXPRESSION_DENY`，Nori 的 `Finale_Smile` / `Finale_Sad_Smile` 这类**结算动画**
 *      会被 `includes("smile")` 命中（历史上"难过"就演成了 `Finale_Sad`）。
 *
 * 运行: cd web-src && node tmp-memcheck/run-pet-expression-tests.mjs
 */
import {readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

const outfile = path.join(root, "tmp-memcheck/petExpression-bundle.mjs")
await build({
	entryPoints: [path.join(root, "src/services/live2d/petExpression.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent", outfile,
})
const M = await import(pathToFileURL(outfile).href)
const {
	PET_EXPRESSION_KEYS, PET_EXPRESSION_GRACE_MS,
	pickPetExpression, newPetExpressionState, petExpressionStep,
	applyPetExpression, petExpressionName, petExpressionShowing, petExpressionHoldsLayer,
	__resetPetExpressionForTest,
} = M

let pass = 0
let fail = 0
const check = (name, cond, detail = "") => {
	if (cond) { pass += 1; console.log(`PASS  ${name}`) }
	else { fail += 1; console.log(`FAIL  ${name}  ← ${detail}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(want)}`)

/** 真实模型的表情名（实测自 model3.json / expressions 目录） */
const ARGNORI = ["00_Default", "01_KiraKira", "02_Dizzy", "03_Angry", "04_Shy", "05_Dark", "06_Speechless",
	"07_Smile", "08_Tears", "09_Troubled", "10_Doubt", "11_Disgust", "12_Serious", "13_Happy", "Sleep", "14_Surprised"]
const NORI = [...ARGNORI.filter((n) => n !== "14_Surprised"), "Chibi", "LongHairOFF", "Shojo", "TailOFF",
	"Finale_Default", "Finale_EyeClosed", "Finale_EyeClosed_Smile", "Finale_Farewell", "Finale_Sad", "Finale_Sad_Smile", "Finale_Smile"]

/* ================= 1. 常量 ================= */
{
	eq("关键词恰好是 shy / smile", [...PET_EXPRESSION_KEYS], ["shy", "smile"])
	eq("宽限期 = 1 秒（用户定）", PET_EXPRESSION_GRACE_MS, 1000)
}

/* ================= 2. 挑选 ================= */
{
	const picked = new Set()
	for (let i = 0; i < 200; i += 1) picked.add(pickPetExpression(ARGNORI))
	eq("ARGNori 上只会挑出 shy/smile 两个", [...picked].sort(), ["04_Shy", "07_Smile"])
	check("**不会**再挑出 13_Happy（旧实现恒出它）", !picked.has("13_Happy"), JSON.stringify([...picked]))

	// 全集：两个都要能被选中（否则等于写死了一个）
	eq("rand=0 → 第一个 shy/smile", pickPetExpression(ARGNORI, () => 0), "04_Shy")
	eq("rand=0.999 → 第二个 shy/smile", pickPetExpression(ARGNORI, () => 0.999), "07_Smile")
	eq("rand=0.5 → 二选一里的第二个（floor(0.5*2)=1）", pickPetExpression(ARGNORI, () => 0.5), "07_Smile")

	// ⭐ 关键回归: 结算动画必须被 DENY 挡住
	const noriPicks = new Set()
	for (let i = 0; i < 300; i += 1) noriPicks.add(pickPetExpression(NORI))
	eq("Nori 上也只挑 shy/smile", [...noriPicks].sort(), ["04_Shy", "07_Smile"])
	check("**绝不**挑中 Finale_Smile / Finale_Sad_Smile 这类结算动画",
		![...noriPicks].some((n) => /^(finale_|chibi|shojo|tailoff|longhairoff|05_dark|00_default)/i.test(n)), JSON.stringify([...noriPicks]))

	// 若某个模型只有 Finale_Smile（没有干净的 smile）→ 宁可不播
	eq("只有结算动画可用时返回 null", pickPetExpression(["00_Default", "Finale_Smile", "Chibi"], () => 0), null)
	eq("一个相关表情都没有 → null", pickPetExpression(["01_KiraKira", "13_Happy"], () => 0), null)
	eq("空列表 → null", pickPetExpression([], () => 0), null)
	eq("非数组 → null（不崩）", pickPetExpression(null), null)

	// 大小写/前后缀容差（别的模型可能叫 Shy / smile_2）
	eq("大小写不敏感", pickPetExpression(["SHY"], () => 0), "SHY")
	eq("前缀形式也认", pickPetExpression(["Expr_Smile_A"], () => 0), "Expr_Smile_A")

	// 随机源健壮性
	eq("rand=NaN 不崩（取第一个）", pickPetExpression(ARGNORI, () => NaN), "04_Shy")
	eq("rand=-1 被夹到 0", pickPetExpression(ARGNORI, () => -1), "04_Shy")
	eq("rand=9 被夹到末尾", pickPetExpression(ARGNORI, () => 9), "07_Smile")
	let calls = 0
	pickPetExpression(ARGNORI, () => { calls += 1; return 0 })
	eq("随机源只被调用一次", calls, 1)
}

/* ================= 3. 状态机（1 秒宽限 + 抚摸期间不换脸） ================= */
{
	const fresh = newPetExpressionState()
	eq("初始未展示", [fresh.showing, fresh.name], [false, null])

	// 没在摸：什么都不做
	const idle = petExpressionStep(fresh, 1000, false, ARGNORI, () => 0)
	eq("没在摸且未展示 → 不展示", [idle.show, idle.name], [false, null])
	eq("没在摸时不改状态", idle.state, fresh)

	// 开始摸：挑一个，并记住时刻
	const t0 = 10_000
	const p1 = petExpressionStep(fresh, t0, true, ARGNORI, () => 0)
	eq("开始摸 → 展示", [p1.show, p1.name], [true, "04_Shy"])
	eq("记住最近摸头时刻", p1.state.lastPetMs, t0)

	// 持续摸：名字必须**不变**（这就是"整个抚摸过程只播一种表情"）
	let st = p1.state
	const seen = new Set()
	for (let i = 1; i <= 60; i += 1) {
		const r = petExpressionStep(st, t0 + i * 16, true, ARGNORI, () => 0.999)   // 故意给"会挑另一个"的随机
		st = r.state
		seen.add(r.name)
	}
	eq("持续抚摸期间名字恒定（不给随机源换脸的机会）", [...seen], ["04_Shy"])

	// 停手：宽限期内仍然展示同一张
	const g1 = petExpressionStep(st, st.lastPetMs + 400, false, ARGNORI, () => 0.999)
	eq("停手 0.4s → 仍在展示同一张", [g1.show, g1.name], [true, "04_Shy"])
	const g2 = petExpressionStep(g1.state, st.lastPetMs + PET_EXPRESSION_GRACE_MS - 1, false, ARGNORI, () => 0.999)
	eq("停手 0.999s → 仍在展示（宽限内）", [g2.show, g2.name], [true, "04_Shy"])
	const g3 = petExpressionStep(g2.state, st.lastPetMs + PET_EXPRESSION_GRACE_MS, false, ARGNORI, () => 0.999)
	eq("停手满 1 秒 → 收回", [g3.show, g3.name], [false, null])
	eq("收回后状态里不再留名字（下次抚摸会重新随机）", g3.state.name, null)

	// 再次抚摸：允许换一张（"不要 10s 锁"的含义）
	const again = petExpressionStep(g3.state, st.lastPetMs + 5000, true, ARGNORI, () => 0.999)
	eq("再次抚摸会重新随机（这次抽到另一个）", again.name, "07_Smile")

	// 模型切换导致名字不可用 → 自动重挑，而不是展示一个不存在的表情
	const stale = {name: "04_Shy", showing: true, lastPetMs: 0}
	const re = petExpressionStep(stale, 100, true, ["07_Smile"], () => 0)
	eq("名字不在可用列表里 → 重挑", re.name, "07_Smile")

	// 边界与纯度
	const keep = {name: "04_Shy", showing: true, lastPetMs: 5}
	eq("now=NaN 时状态不变", petExpressionStep(keep, NaN, true, ARGNORI).state, keep)
	const snap = JSON.stringify(keep)
	petExpressionStep(keep, 99999, false, ARGNORI)
	eq("petExpressionStep 不修改入参（纯函数）", JSON.stringify(keep), snap)
	const noPool = petExpressionStep(fresh, 1, true, ["01_KiraKira"], () => 0)
	eq("摸头但没有 shy/smile 可播 → 不展示（不硬编名字）", [noPool.show, noPool.name], [false, null])
}

/* ================= 4. IO 侧：只在状态变化时才调库（"不闪烁"的守门人） ================= */
{
	__resetPetExpressionForTest()
	const plays = []
	let stops = 0
	const hooks = {play: (n) => plays.push(n), stop: () => { stops += 1 }}
	eq("初始不在展示", petExpressionShowing(), false)
	eq("初始不占表情层", petExpressionHoldsLayer(), false)

	// 第一帧（开始摸）
	let showing = applyPetExpression(1000, true, ARGNORI, hooks, () => 0)
	eq("开始摸 → 展示并播一次", [showing, plays], [true, ["04_Shy"]])
	eq("占住表情层（聊天回复要让位）", petExpressionHoldsLayer(), true)

	// 之后 60 帧持续摸：**一次库调用都不该再有**（否则会把 0.5s 淡入反复重置 → 闪烁）
	for (let i = 1; i <= 60; i += 1) applyPetExpression(1000 + i * 16, true, ARGNORI, hooks, () => 0.999)
	eq("持续抚摸期间**不再重复调用** playExpression（这是「不闪烁」的保证）", plays.length, 1)
	eq("期间没有多余 stop", stops, 0)

	// 停手：宽限期内不调 stop
	applyPetExpression(1000 + 61 * 16 + 300, false, ARGNORI, hooks)
	eq("宽限期内不收回（不调 stop）", stops, 0)
	eq("宽限期内仍在展示", petExpressionShowing(), true)

	// 超时：调一次 stop，并让循环可以退出
	showing = applyPetExpression(1000 + 61 * 16 + PET_EXPRESSION_GRACE_MS + 50, false, ARGNORI, hooks)
	eq("超时 → 收回并调一次 stop", [showing, stops], [false, 1])
	eq("收回后不再占表情层（聊天可以重新抢）", petExpressionHoldsLayer(), false)
	eq("收回后名字清空", petExpressionName(), null)

	// 再摸一次：重新播（允许换脸）
	applyPetExpression(20000, true, ARGNORI, hooks, () => 0.999)
	eq("再次抚摸 → 再播一次（这次是另一张）", plays, ["04_Shy", "07_Smile"])

	// 钩子缺失/抛异常都不能崩
	__resetPetExpressionForTest()
	let threw = false
	try {
		applyPetExpression(1, true, ARGNORI, {})
		applyPetExpression(2, true, ARGNORI, {play: () => { throw new Error("库炸了") }})
		applyPetExpression(99999, false, ARGNORI, {stop: () => { throw new Error("库炸了") }})
	} catch { threw = true }
	check("没有钩子 / 钩子抛异常都不向外抛", threw === false, String(threw))
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exitCode = 1
