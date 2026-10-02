/**
 * 眨眼 + "顶点计算之前"钩子调度器 的门禁 (Node 直测, 不用浏览器 / 不用 harness / 毫秒级).
 *
 * 覆盖:
 *   - `beforeUpdate.ts` : 单槽位钩子的注册/去重/顺序/异常隔离/幂等 —— 两个消费者(低头/眨眼)不能互相顶掉
 *   - `blink.ts`        : 闭合曲线、随机间隔、状态机、双眨、时钟跳变、乘性写入
 *
 * 为什么必须有: 眨眼是"看不见就以为没做"的功能, 而它的失败模式又特别静默 ——
 * 名单为空(库不眨)、时序错(顶点已算完)、覆盖写(把表情压掉)、钩子被顶掉(另一个功能失效)。
 * 这些都是**只能靠断言钉住**、看图看不出来的。
 *
 * 运行: cd web-src && node tmp-memcheck/run-blink-tests.mjs
 */
import {readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

// esbuild 没被提升 (pnpm 严格布局), 从 .pnpm 目录里动态解析
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

const outfile = path.join(root, "tmp-memcheck/blink-bundle.mjs")
await build({
	entryPoints: [path.join(root, "src/services/live2d/blink.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile,
})
/* 调度器单独打一份 bundle: esbuild 只导出**入口文件**的导出,
   beforeUpdate 作为依赖被内联进来但不会从 blink-bundle 里再导出。 */
const dispOut = path.join(root, "tmp-memcheck/beforeUpdate-bundle.mjs")
await build({
	entryPoints: [path.join(root, "src/services/live2d/beforeUpdate.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: dispOut,
})
const B = await import(pathToFileURL(outfile).href)
const {
	DEFAULT_BLINK_TUNING, blinkTotalMs, nextBlinkGap, blinkClosure, newBlinkState, blinkStep,
	BLINK_PARAMS, applyBlink, blinkCount, blinkClosureNow,
	__resetBlinkForTest,
} = B
const D = await import(pathToFileURL(dispOut).href)
const {registerBeforeUpdate, runBeforeUpdate, installBeforeUpdate, beforeUpdateHandlerCount, __resetBeforeUpdateForTest} = D

let pass = 0
let fail = 0
const check = (name, cond, detail = "") => {
	if (cond) { pass += 1; console.log(`PASS  ${name}`) }
	else { fail += 1; console.log(`FAIL  ${name}  ← ${detail}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(want)}`)

/* ================= 1. 钩子调度器 ================= */
{
	__resetBeforeUpdateForTest()
	eq("初始没有消费者", beforeUpdateHandlerCount(), 0)

	const calls = []
	const a = () => calls.push("a")
	const b = () => calls.push("b")
	registerBeforeUpdate(a)
	eq("注册 1 个", beforeUpdateHandlerCount(), 1)
	registerBeforeUpdate(a)
	eq("重复注册同一函数不增加 (幂等)", beforeUpdateHandlerCount(), 1)
	registerBeforeUpdate(b)
	eq("注册第 2 个", beforeUpdateHandlerCount(), 2)
	registerBeforeUpdate(null)
	registerBeforeUpdate("not-a-function")
	eq("非法入参被忽略", beforeUpdateHandlerCount(), 2)

	runBeforeUpdate()
	eq("按注册顺序调用", calls, ["a", "b"])

	// 一个消费者抛异常不能拖垮其它消费者, 也不能向外抛
	const boom = () => { throw new Error("消费者炸了") }
	registerBeforeUpdate(boom)
	let threw = false
	try { runBeforeUpdate() } catch { threw = true }
	check("消费者抛异常不会向外抛", threw === false, String(threw))
	eq("抛异常的那次仍跑完了其余消费者", calls, ["a", "b", "a", "b"])

	// 装钩子: 幂等, 且装上后由钩子驱动全部消费者
	const host = {}
	installBeforeUpdate(host)
	const first = host.__noriBeforeModelUpdate
	check("钩子已装上", typeof first === "function", String(typeof first))
	installBeforeUpdate(host)
	check("重复安装是幂等的 (不换函数)", host.__noriBeforeModelUpdate === first, "被换掉了")
	const before = calls.length
	host.__noriBeforeModelUpdate()
	// boom 会抛, 它自己不计入 calls ⇒ 只有 a/b 各一次
	eq("钩子驱动所有消费者 (抛异常的也在被调用之列)", calls.length - before, 2)

	// Node 里没有 window 也不能抛 (门禁环境)
	__resetBeforeUpdateForTest()
	let threw2 = false
	try { installBeforeUpdate() } catch { threw2 = true }
	check("无 window 时不抛异常", threw2 === false, String(threw2))

	// 槽位被"直接赋值"抢夺 → 必须**当场报错**（而不是静默顶掉调度器、让效果失效）
	__resetBeforeUpdateForTest()
	const a2 = () => calls.push("a2")
	registerBeforeUpdate(a2)
	const savedWin = globalThis.window
	try {
		const fakeWin = {}
		globalThis.window = fakeWin
		installBeforeUpdate(fakeWin)
		check("装上了", fakeWin.__noriBeforeModelUpdate === runBeforeUpdate)
		check("槽位不可写 (描述符 writable=false)",
			Object.getOwnPropertyDescriptor(fakeWin, "__noriBeforeModelUpdate")?.writable === false,
			JSON.stringify(Object.getOwnPropertyDescriptor(fakeWin, "__noriBeforeModelUpdate")))
		let stealThrew = false
		try { fakeWin.__noriBeforeModelUpdate = () => { /* 想抢占的小偷 */ } } catch { stealThrew = true }
		check("直接赋值抢夺会当场抛错 (严格模式) —— 不会再出现静默失效", stealThrew, String(stealThrew))
		check("抢夺失败后调度器仍在位", fakeWin.__noriBeforeModelUpdate === runBeforeUpdate)
		const n0 = calls.length
		fakeWin.__noriBeforeModelUpdate()
		check("消费者照常执行 (没被顶掉)", calls.length - n0 === 1, String(calls.length - n0))
		// 外部工具（探针/控制台）的正规入口：槽位不可写后, 只能走这个
		check("暴露了 __noriRegisterBeforeUpdate 给外部工具", typeof fakeWin.__noriRegisterBeforeUpdate === "function", String(typeof fakeWin.__noriRegisterBeforeUpdate))
		check("暴露了 __noriBeforeUpdateCount 用于自检", typeof fakeWin.__noriBeforeUpdateCount === "function", String(typeof fakeWin.__noriBeforeUpdateCount))
		const n1 = fakeWin.__noriBeforeUpdateCount()
		let extRan = 0
		fakeWin.__noriRegisterBeforeUpdate(() => { extRan += 1 })
		eq("通过正规入口注册成功", fakeWin.__noriBeforeUpdateCount(), n1 + 1)
		fakeWin.__noriBeforeModelUpdate()
		check("外部注册的消费者也会被执行", extRan >= 1, String(extRan))
	} finally {
		if (savedWin === undefined) delete globalThis.window
		else globalThis.window = savedWin
	}
	__resetBeforeUpdateForTest()
}

/* ================= 1.5 组合: 眨眼 + 另一个消费者 共用同一个钩子槽位 =================
 * 这是整个调度器存在的**唯一理由**（多个消费者不能互相顶掉），所以必须有一条组合断言。
 * 产品侧目前只有眨眼一个消费者（"摸头低头"已按用户决定删除），所以这里**合成一个**消费者 ——
 * 测的是"调度器能不能带多个消费者"，与具体是哪个效果无关。
 * 注意: 必须让 blink 与 beforeUpdate **在同一个 bundle 里**（否则各自的 beforeUpdate
 * 模块状态是独立副本, 组合就测不出东西）—— 所以用 esbuild 的 stdin 入口现拼一个。 */
{
	const comboOut = path.join(root, "tmp-memcheck/compose-bundle.mjs")
	await build({
		stdin: {
			contents: [
				`export * from "./src/services/live2d/beforeUpdate"`,
				`export {installBlink, applyBlink, blinkCount, __resetBlinkForTest} from "./src/services/live2d/blink"`,
			].join("\n"),
			resolveDir: root,
			sourcefile: "compose-entry.ts",
			loader: "ts",
		},
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
		outfile: comboOut,
	})
	const C = await import(pathToFileURL(comboOut).href)
	const savedWin = globalThis.window
	try {
		C.__resetBeforeUpdateForTest()
		C.__resetBlinkForTest(0, () => 0.5)
		const fakeWin = {}
		globalThis.window = fakeWin
		const writes = []
		fakeWin.__noriAddParam = (id, v) => { writes.push([id, v]); return true }
		fakeWin.__noriGetParam = () => 1

		C.installBlink()
		// 合成第二个消费者（模拟"以后有人再加一个顶点前的效果"）
		let otherRuns = 0
		C.registerBeforeUpdate(() => { otherRuns += 1; fakeWin.__noriAddParam("ParamMouthForm", 0.1) })
		eq("两个消费者都注册了", C.beforeUpdateHandlerCount(), 2)
		check("钩子只装了一次 (同一个函数, 不是各装各的)", fakeWin.__noriBeforeModelUpdate === C.runBeforeUpdate, String(typeof fakeWin.__noriBeforeModelUpdate))

		// 一帧内两个消费者都要跑到：合成消费者计数 + 眨眼在到点后写眼睛参数
		const blinkAt = 4300                                   // rand=0.5 → 起始间隔 4300ms
		fakeWin.__noriBeforeModelUpdate()                      // 第 1 帧(未到点): 只有合成消费者写
		eq("合成消费者每帧都执行", otherRuns, 1)
		eq("合成消费者写了它的参数", writes.filter(([id]) => id === "ParamMouthForm").length, 1)
		eq("未到眨眼时刻时不写眼睛", writes.filter(([id]) => /Eye.*Open/.test(id)).length, 0)
		// 眨眼推进到"确实在眨"的那一帧（用 applyBlink 直接给时刻，绕开真实时钟）
		C.applyBlink(blinkAt, {get: () => 1, add: (id, v) => { writes.push([id, v]); return true }})
		C.applyBlink(blinkAt + 90, {get: () => 1, add: (id, v) => { writes.push([id, v]); return true }})
		check("眨眼也在写同一个模型 (ParamEyeLOpen/ROpen)",
			writes.some(([id]) => id === "ParamEyeLOpen") && writes.some(([id]) => id === "ParamEyeROpen"),
			JSON.stringify(writes.slice(-4)))
		check("眨眼计数为 1", C.blinkCount() === 1, String(C.blinkCount()))
		eq("两个消费者仍都注册着 (没被对方顶掉)", C.beforeUpdateHandlerCount(), 2)

		// 再走一次真实钩子调用: 两个消费者都还在干活
		const otherBefore = otherRuns
		fakeWin.__noriBeforeModelUpdate()
		eq("再次调用钩子: 合成消费者仍在跑", otherRuns, otherBefore + 1)
		eq("再次调用钩子: 眨眼消费者也仍在列", C.beforeUpdateHandlerCount(), 2)
	} finally {
		if (savedWin === undefined) delete globalThis.window
		else globalThis.window = savedWin
	}
}

/* ================= 2. 眨眼参数与曲线 ================= */
{
	const T = DEFAULT_BLINK_TUNING
	check("随机间隔下界 < 上界", T.minGapMs < T.maxGapMs, JSON.stringify(T))
	check("三个时长都是正数", T.closeMs > 0 && T.closedMs > 0 && T.openMs > 0, JSON.stringify(T))
	const total = blinkTotalMs(T)
	check(`一次眨眼总时长合理 (${total}ms ∈ [150, 500])`, total >= 150 && total <= 500, String(total))
	check("双眨概率在 [0,1]", T.doubleChance >= 0 && T.doubleChance <= 1, String(T.doubleChance))
	check("双眨间隔比正常间隔短得多", T.doubleGapMs < T.minGapMs, String(T.doubleGapMs))

	// 随机源只该被调用一次 (调用两次会让"注入固定随机"的测试失控)
	let n = 0
	const counting = () => { n += 1; return 0.5 }
	nextBlinkGap(counting, T)
	eq("nextBlinkGap 只调一次随机源", n, 1)
	eq("rand=0 → 取下界", nextBlinkGap(() => 0, T), T.minGapMs)
	eq("rand=1 → 取上界", nextBlinkGap(() => 1, T), T.maxGapMs)
	eq("rand=NaN → 回落到下界", nextBlinkGap(() => NaN, T), T.minGapMs)
	eq("rand 越界(-5) → 夹到 0", nextBlinkGap(() => -5, T), T.minGapMs)
	eq("rand 越界(9) → 夹到 1", nextBlinkGap(() => 9, T), T.maxGapMs)
}
{
	const T = DEFAULT_BLINK_TUNING
	const total = blinkTotalMs(T)
	eq("起点闭合量为 0 (睁着)", blinkClosure(0, T), 0)
	eq("闭合段结束 = 全闭", blinkClosure(T.closeMs, T), 1)
	eq("全闭段仍为 1", blinkClosure(T.closeMs + T.closedMs / 2, T), 1)
	eq("结束时回到 0", blinkClosure(total, T), 0)
	eq("超过总时长仍为 0", blinkClosure(total * 3, T), 0)
	eq("负数时刻 = 0 (不毒化)", blinkClosure(-5, T), 0)
	eq("NaN 时刻 = 0 (不毒化)", blinkClosure(NaN, T), 0)
	check("闭合中点约 0.5", Math.abs(blinkClosure(T.closeMs / 2, T) - 0.5) < 1e-9, String(blinkClosure(T.closeMs / 2, T)))
	check("睁开中点约 0.5", Math.abs(blinkClosure(T.closeMs + T.closedMs + T.openMs / 2, T) - 0.5) < 1e-9,
		String(blinkClosure(T.closeMs + T.closedMs + T.openMs / 2, T)))

	// 全程取值都在 [0,1]，且形状是"闭→开"（前段不减、后段不增）
	let allInRange = true, closeMonotone = true, openMonotone = true
	let prev = 0
	for (let t = 0; t <= total; t += 1) {
		const k = blinkClosure(t, T)
		if (!(k >= 0 && k <= 1)) allInRange = false
		if (t <= T.closeMs && k < prev - 1e-9) closeMonotone = false
		prev = k
	}
	for (let t = T.closeMs + T.closedMs; t <= total; t += 1) {
		const k = blinkClosure(t, T), kPrev = blinkClosure(t - 1, T)
		if (k > kPrev + 1e-9) openMonotone = false
	}
	check("闭合量全程在 [0,1]", allInRange)
	check("闭合段单调不减", closeMonotone)
	check("睁开段单调不增", openMonotone)
}

/* ================= 3. 眨眼状态机 ================= */
{
	const T = DEFAULT_BLINK_TUNING
	const noDouble = () => 0.99          // > doubleChance ⇒ 不触发双眨
	const mid = () => 0.5
	const st0 = newBlinkState(1000, mid, T)
	eq("初始未在眨", st0.blinking, false)
	eq("初始计数为 0", st0.count, 0)
	check("首眨排在下界与上界之间", st0.nextAtMs >= 1000 + T.minGapMs && st0.nextAtMs <= 1000 + T.maxGapMs, String(st0.nextAtMs))

	const before = blinkStep(st0, st0.nextAtMs - 1, noDouble, T)
	eq("未到点不眨", before.closure, 0)
	eq("未到点状态不变", before.state, st0)

	const start = blinkStep(st0, st0.nextAtMs, noDouble, T)
	eq("到点开始眨", start.state.blinking, true)
	eq("计数 +1", start.state.count, 1)
	eq("起步闭合量为 0 (从睁开开始)", start.closure, 0)

	const mid1 = blinkStep(start.state, st0.nextAtMs + T.closeMs / 2, noDouble, T)
	check("眨的过程中闭合量 > 0", mid1.closure > 0.4 && mid1.closure < 0.6, String(mid1.closure))
	eq("眨的过程中计数不变", mid1.state.count, 1)

	const total = blinkTotalMs(T)
	const done = blinkStep(start.state, st0.nextAtMs + total, noDouble, T)
	eq("眨完闭眼复位", done.closure, 0)
	eq("眨完不再标记进行中", done.state.blinking, false)
	eq("眨完计数不变", done.state.count, 1)
	check("眨完后排的下一次仍在 [minGap,maxGap]",
		done.state.nextAtMs >= st0.nextAtMs + total + T.minGapMs && done.state.nextAtMs <= st0.nextAtMs + total + T.maxGapMs,
		String(done.state.nextAtMs))
	eq("不触发双眨时 doublePending 为 false", done.state.doublePending, false)

	// 双眨: 随机源强制 < doubleChance
	let seq = [0.5, 0.01, 0.5]   // 第一次取间隔、第二次决定双眨、第三次取下一间隔
	const rnd = () => seq.shift() ?? 0.5
	const stA = newBlinkState(0, rnd, T)
	const startA = blinkStep(stA, stA.nextAtMs, rnd, T)
	const doneA = blinkStep(startA.state, stA.nextAtMs + total, rnd, T)
	eq("双眨: 下一次间隔 = doubleGapMs", doneA.state.nextAtMs, stA.nextAtMs + total + T.doubleGapMs)
	eq("双眨: 标记 doublePending", doneA.state.doublePending, true)
	const startB = blinkStep(doneA.state, doneA.state.nextAtMs, rnd, T)
	eq("双眨的第二下也计数", startB.state.count, 2)
	const doneB = blinkStep(startB.state, doneA.state.nextAtMs + total, rnd, T)
	check("不连三下: 第二下之后回到正常间隔",
		doneB.state.nextAtMs >= doneA.state.nextAtMs + total + T.minGapMs, String(doneB.state.nextAtMs))
	eq("不连三下: doublePending 复位", doneB.state.doublePending, false)

	// 关掉
	const offState = {...start.state, on: false}
	const off = blinkStep(offState, offState.startMs + 10, noDouble, T)
	eq("关掉后立刻停止闭合", off.closure, 0)
	eq("关掉后清掉进行中的眨", off.state.blinking, false)

	// 时钟跳变 (挂起很久后不要卡在闭眼)
	const jump = blinkStep(start.state, start.state.startMs + total * 100, noDouble, T)
	eq("时钟大幅跳变后不卡在闭合", jump.closure, 0)
	eq("时钟大幅跳变后重排下一次", jump.state.blinking, false)

	// 纯函数: 不改入参
	const snapshot = JSON.stringify(st0)
	blinkStep(st0, st0.nextAtMs + 5, noDouble, T)
	eq("blinkStep 不修改入参 (纯函数)", JSON.stringify(st0), snapshot)
	eq("now=NaN 时状态不变", blinkStep(st0, NaN, noDouble, T).state, st0)
}

/* ================= 4. 乘性写入 (IO 侧) ================= */
{
	const T = DEFAULT_BLINK_TUNING
	eq("驱动的是模型真实存在的两个参数", [...BLINK_PARAMS], ["ParamEyeLOpen", "ParamEyeROpen"])

	// 无钩子时不能抛
	__resetBlinkForTest(0, () => 0.5)
	let threw = false
	let wrote = -1
	try { wrote = applyBlink(0, {}) } catch { threw = true }
	check("没有钩子时不抛异常", threw === false, String(threw))
	eq("没有钩子时不写", wrote, 0)

	// 眨眼帧: 必须按 -c*k 写, 且两个都写
	const st = newBlinkState(0, () => 0.5, T)
	const target = st.nextAtMs + T.closeMs   // 正好全闭
	const writes = []
	const fake = {
		get: (id) => (id === "ParamEyeLOpen" ? 1 : 0.6),
		add: (id, v) => { writes.push([id, v]); return true },
	}
	__resetBlinkForTest(0, () => 0.5)
	applyBlink(st.nextAtMs, fake)            // 起步 (k=0) → 不该写
	eq("眨眼前一步不写参数", writes.length, 0)
	applyBlink(target, fake)                 // 全闭 → 两个参数都按比例闭
	eq("全闭时两个参数都被写", writes.length, 2)
	eq("左眼按当前睁度乘性闭合", writes[0], ["ParamEyeLOpen", -1])
	eq("右眼按当前睁度乘性闭合", writes[1], ["ParamEyeROpen", -0.6])

	// 眼睛本来闭着 (如 Sleep 表情把值设成 0) ⇒ 不该写
	writes.length = 0
	__resetBlinkForTest(0, () => 0.5)
	applyBlink(st.nextAtMs, {get: () => 0, add: () => { writes.push(1); return true }})
	applyBlink(target, {get: () => 0, add: () => { writes.push(1); return true }})
	eq("眼睛本来就闭着时不写 (乘性天然无动作)", writes.length, 0)

	// 读回异常值 ⇒ 跳过, 不能算出 NaN 写进去
	writes.length = 0
	__resetBlinkForTest(0, () => 0.5)
	applyBlink(st.nextAtMs, {get: () => null, add: () => { writes.push(1); return true }})
	applyBlink(target, {get: () => null, add: () => { writes.push(1); return true }})
	eq("读不回值时跳过 (不写 NaN)", writes.length, 0)

	// 不眨眼的时间段一个字都不写
	writes.length = 0
	__resetBlinkForTest(0, () => 0.5)
	for (let t = 0; t < 2000; t += 16) applyBlink(t, {get: () => 1, add: (id, v) => { writes.push([id, v]); return true }})
	eq("不眨眼的 2 秒内零写入", writes.length, 0)

	// 计数与闭合量能读出来 (E2E 靠它做确定性证据)
	__resetBlinkForTest(0, () => 0.5)
	const s2 = newBlinkState(0, () => 0.5, T)
	applyBlink(s2.nextAtMs, fake)
	eq("眨过一次后计数为 1", blinkCount(), 1)
	applyBlink(s2.nextAtMs + T.closeMs, fake)
	eq("全闭时闭合量读回 1", blinkClosureNow(), 1)
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exitCode = 1
