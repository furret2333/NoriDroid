/**
 * 口型（lipSync）单测 —— 补上 `lipSync.ts` 文件头自己声称"门禁能在 Node 里精确单测包络"、
 * 但**一直没写**的那份测试（2026-10-08）。
 *
 * ## 为什么补它（而不是把那两个孤儿导出删掉）
 * `lipSync.ts` 有两个导出全仓库零引用：
 *   - `mouthOpenNow()`  —— "上一帧实际写进去的开口量", 注释写着"诊断/E2E 用"；
 *   - `__resetLipSyncForTest()` —— "仅供测试：重置状态"。
 * 而模块头部写着 `lipStep` 是纯函数 ⇒ 门禁能精确单测包络。**那份单测从来没写** ——
 * 所以钩子是为"不存在的测试"准备的死代码。删掉当然也能让死导出审计归零，
 * 但更值得做的是把它变成"有覆盖的活代码"，顺带补上一块**真实空白**：
 * 此前嘴型只有"模型里有没有 ParamMouthOpenY"这类结构断言（probe-l2d-params /
 * probe-bow-params / run-param-owner-tests），**没有任何测试验证包络本身**
 * （攻击/释放、底噪不张嘴、上限、3 分钟兜底、振幅映射、PCM 头解析）。
 *
 * 运行: cd web-src && node tmp-memcheck/run-lipsync-tests.mjs
 * 先自建 bundle（build-lipsync-bundle.mjs）⇒ 测的是当前源码, 不会静默读旧产物。
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-lipsync-bundle.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const lip = await import(pathToFileURL(path.join(root, "tmp-memcheck/lipsync-bundle.mjs")).href)

const results = []
const check = (name, cond, detail = "") => {
	results.push({name, ok: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `  ← ${detail}`}`)
}
const box = (t) => console.log(`\n${"─".repeat(74)}\n${t}\n${"─".repeat(74)}`)

const {
	MOUTH_PARAM, LIP_STEP_MS, LIP_MIN, LIP_MAX, LIP_ATTACK, LIP_RELEASE, LIP_MAX_RUN_MS,
	newLipState, lipStep, amplitudeToMouthOpen, pcmRms,
	applyLipSync, mouthOpenNow, __resetLipSyncForTest, notifyPlaybackAmplitude,
} = lip

/* ============================================================================
 * ① 契约与常量之间的关系（不钉死具体数值 —— 幅度是要调的，见源码注释）
 * ==========================================================================*/
box("① 契约与常量")
check("L1: MOUTH_PARAM 与 model3.json 的 Groups.LipSync 对齐", MOUTH_PARAM === "ParamMouthOpenY", MOUTH_PARAM)
check("L2: 开口区间合法 (0 < MIN < MAX ≤ 1)",
	Number.isFinite(LIP_MIN) && Number.isFinite(LIP_MAX) && LIP_MIN > 0 && LIP_MIN < LIP_MAX && LIP_MAX <= 1,
	`MIN=${LIP_MIN} MAX=${LIP_MAX}`)
check("L3: 换目标的周期是正数且不长于 1 秒（太快像抽搐/太慢像在嚼）",
	Number.isFinite(LIP_STEP_MS) && LIP_STEP_MS > 0 && LIP_STEP_MS <= 1000, String(LIP_STEP_MS))
check("L4: 攻击/释放比例都在 (0,1) 且释放不慢于攻击（'说完即收'）",
	LIP_ATTACK > 0 && LIP_ATTACK < 1 && LIP_RELEASE > 0 && LIP_RELEASE < 1 && LIP_RELEASE >= LIP_ATTACK,
	`attack=${LIP_ATTACK} release=${LIP_RELEASE}`)
check("L5: 3 分钟量级的兜底上限存在（播放器卡在 true 也不至于张着嘴到天荒地老）",
	Number.isFinite(LIP_MAX_RUN_MS) && LIP_MAX_RUN_MS >= 60_000, String(LIP_MAX_RUN_MS))
check("L6: newLipState 是干净初态", (() => {
	const s = newLipState()
	return s.open === 0 && s.target === 0 && s.startedAt === 0
})())

/* ============================================================================
 * ② amplitudeToMouthOpen: 底噪不张嘴 / 单调 / 封顶
 * ==========================================================================*/
box("② 振幅 → 开口量")
check("L7: 静音 (0) 不张嘴", amplitudeToMouthOpen(0) === 0, String(amplitudeToMouthOpen(0)))
check("L8: 底噪 (≤ 0.025) 一律判为不发音 —— 否则句间停顿会留下小幅张嘴",
	amplitudeToMouthOpen(0.01) === 0 && amplitudeToMouthOpen(0.025) === 0,
	`${amplitudeToMouthOpen(0.01)} / ${amplitudeToMouthOpen(0.025)}`)
check("L9: 非有限输入不产生 NaN（时钟/振幅脏数据 fail-safe）",
	amplitudeToMouthOpen(NaN) === 0 && amplitudeToMouthOpen(Infinity) === 0 && amplitudeToMouthOpen(-1) === 0,
	`${amplitudeToMouthOpen(NaN)} / ${amplitudeToMouthOpen(Infinity)} / ${amplitudeToMouthOpen(-1)}`)
check("L10: 足够响时封顶到 LIP_MAX（不是 1.0 —— 用户反馈过'幅度太大'）",
	Math.abs(amplitudeToMouthOpen(1) - LIP_MAX) < 1e-9 && Math.abs(amplitudeToMouthOpen(0.6) - LIP_MAX) < 1e-9,
	`${amplitudeToMouthOpen(1)} / ${amplitudeToMouthOpen(0.6)}`)
check("L11: 全程落在 [0, LIP_MAX] 且随振幅单调不减", (() => {
	let prev = -1
	for (let r = 0; r <= 1.0001; r += 0.005) {
		const v = amplitudeToMouthOpen(r)
		if (!(v >= 0 && v <= LIP_MAX + 1e-9)) return false
		if (v < prev - 1e-9) return false
		prev = v
	}
	return true
})())
check("L12: 中间档确实在 MIN 与 MAX 之间（不是二值跳变）", (() => {
	const mid = amplitudeToMouthOpen(0.115)
	return mid > LIP_MIN + 1e-6 && mid < LIP_MAX - 1e-6
})(), String(amplitudeToMouthOpen(0.115)))

/* ============================================================================
 * ③ lipStep 包络（纯函数）
 * ==========================================================================*/
box("③ lipStep 包络")
{
	// 时钟脏数据: 什么都不写, 也不毒化状态
	const st = {open: 0.3, target: 0.2, nextChangeAt: 500, startedAt: 100}
	const f = lipStep(st, NaN, true)
	check("L13: 时钟非有限 ⇒ 不写、不改状态", f.write === false && f.state === st && f.open === st.open)

	// 停声: 收口 + 清本段状态
	const f2 = lipStep({open: 0.4, target: 0.2, nextChangeAt: 500, startedAt: 100}, 1000, false)
	check("L14: 停声 ⇒ 按 LIP_RELEASE 收口并清掉本段状态 (target/nextChangeAt/startedAt 归零)",
		Math.abs(f2.open - 0.4 * (1 - LIP_RELEASE)) < 1e-9 && f2.state.target === 0 &&
		f2.state.nextChangeAt === 0 && f2.state.startedAt === 0 && f2.write === true,
		JSON.stringify({open: f2.open, state: f2.state}))

	const f3 = lipStep({open: 0.005, target: 0, nextChangeAt: 0, startedAt: 0}, 1000, false)
	check("L15: 停声且残余已很小时直接归零 (不留长期小残值), 但仍写一次把嘴闭上",
		f3.open === 0 && f3.write === true, JSON.stringify(f3))

	const f4 = lipStep({open: 0, target: 0, nextChangeAt: 0, startedAt: 0}, 1000, false)
	check("L16: 已经闭着嘴的停声帧 ⇒ 一个字都不写 (write=false)", f4.write === false && f4.open === 0)

	// 出声但没有可信振幅 ⇒ 目标 0（防"播放器 speaking 跨过句间停顿"把停顿当说话）
	const f5 = lipStep({open: 0.4, target: 0.4, nextChangeAt: 0, startedAt: 0}, 1000, true, Math.random, null)
	check("L17: 出声但没有可信振幅 ⇒ 目标归 0 并收口（不能随机乱动）",
		f5.state.target === 0 && f5.open < 0.4 && f5.write === true, JSON.stringify({open: f5.open, target: f5.state.target}))

	// 有声幅 ⇒ 目标取映射值, 并安排下次换目标
	const f6 = lipStep(newLipState(), 1000, true, Math.random, 0.2)
	const expectTarget = amplitudeToMouthOpen(0.2)
	check("L18: 有声幅 ⇒ 目标 = amplitudeToMouthOpen(振幅), 下次换目标在 now+LIP_STEP_MS",
		Math.abs(f6.state.target - expectTarget) < 1e-9 && f6.state.nextChangeAt === 1000 + LIP_STEP_MS &&
		f6.state.startedAt === 1000 && f6.open > 0 && f6.write === true,
		JSON.stringify({target: f6.state.target, expectTarget, next: f6.state.nextChangeAt}))

	// 攻击系数: 从 0 起第一帧 = target * LIP_ATTACK
	check("L19: 张嘴用 LIP_ATTACK 比例靠近目标",
		Math.abs(f6.open - expectTarget * LIP_ATTACK) < 1e-9, `${f6.open} vs ${expectTarget * LIP_ATTACK}`)

	// 还没到 nextChangeAt ⇒ 目标与下次时刻都不动
	const hold = {open: 0.2, target: 0.3, nextChangeAt: 5000, startedAt: 1000}
	const f7 = lipStep(hold, 4990, true, Math.random, 0.9)
	check("L20: 未到换目标时刻 ⇒ 目标/时刻都保持（不每帧乱改）",
		f7.state.target === 0.3 && f7.state.nextChangeAt === 5000, JSON.stringify(f7.state))

	// 开口恒在 [0,1]
	check("L21: 任何输入下开口都夹在 [0,1]", (() => {
		for (const open of [0, 0.5, 0.99, 1]) {
			for (const level of [null, 0, 0.2, 1]) {
				for (const speaking of [true, false]) {
					const r = lipStep({open, target: 0.4, nextChangeAt: 0, startedAt: 1}, 1000, speaking, Math.random, level)
					if (!(r.open >= 0 && r.open <= 1)) return false
				}
			}
		}
		return true
	})())

	// 兜底: 连续"出声"超过上限就不再动嘴
	const guarded = lipStep({open: 0.4, target: 0.3, nextChangeAt: 0, startedAt: 1000}, 1000 + LIP_MAX_RUN_MS + 1, true, Math.random, 0.5)
	check("L22: 超过 LIP_MAX_RUN_MS ⇒ 不再张嘴 (write=false) 且开始收口",
		guarded.write === false && guarded.state.target === 0 && guarded.state.open < 0.4 &&
		Math.abs(guarded.state.open - 0.4 * (1 - LIP_RELEASE)) < 1e-9 && guarded.state.startedAt === 1000,
		JSON.stringify(guarded))
	const atLimit = lipStep({open: 0.4, target: 0.3, nextChangeAt: 0, startedAt: 1000}, 1000 + LIP_MAX_RUN_MS, true, Math.random, 0.5)
	check("L23: 恰好等于上限时不触发兜底（判据是严格的 >）", atLimit.write === true, JSON.stringify({write: atLimit.write}))

	// 纯函数: 不改入参
	const frozen = {open: 0.25, target: 0.1, nextChangeAt: 10, startedAt: 5}
	const before = JSON.stringify(frozen)
	lipStep(frozen, 20, true, Math.random, 0.5)
	check("L24: lipStep 不修改入参（纯函数契约）", JSON.stringify(frozen) === before, before)
}

/* ============================================================================
 * ④ pcmRms: Fish 16 字节分块头解析
 * ==========================================================================*/
box("④ PCM RMS 与分块头")
{
	const pcm = (values, header = null) => {
		const size = values.length * 2
		const buf = new Uint8Array((header ? 16 : 0) + size)
		const dv = new DataView(buf.buffer)
		const off = header ? 16 : 0
		if (header) {
			dv.setInt32(4, header.pcmSize ?? size, true)
			dv.setInt32(8, header.sampleRate ?? 24000, true)
		}
		values.forEach((v, i) => dv.setInt16(off + i * 2, v, true))
		return buf
	}
	check("L25: 空输入 ⇒ 0", pcmRms(new Uint8Array(0)) === 0)

	// 纯 PCM（无头）: 恒定 0.5 幅度 ⇒ RMS = 0.5
	const plain = pcm(new Array(400).fill(Math.round(0.5 * 32767)))
	check("L26: 纯 PCM 的 RMS 计算正确 (恒定 0.5 ⇒ ≈0.5)", Math.abs(pcmRms(plain) - 0.5) < 1e-3, String(pcmRms(plain)))

	check("L27: 满幅 PCM ⇒ ≈1", Math.abs(pcmRms(pcm(new Array(400).fill(32767))) - 1) < 1e-3, String(pcmRms(pcm(new Array(400).fill(32767)))))

	// 带 Fish 头: 头 16 字节填满 0x7f（若被当成样本 RMS 会接近 1）, payload 全 0 ⇒ 正确实现得 0
	{
		const payloadBytes = 400
		const buf = new Uint8Array(16 + payloadBytes)
		buf.fill(0x7f)
		const dv = new DataView(buf.buffer)
		dv.setInt32(4, payloadBytes, true)
		dv.setInt32(8, 24000, true)
		buf.fill(0, 16)          // payload 全 0
		check("L28: 合法分块头被跳过 —— 头部脏字节不会污染 RMS（payload 全 0 ⇒ 0）",
			pcmRms(buf) === 0, String(pcmRms(buf)))
	}
	// 头里的采样率越界 ⇒ 不认这个头, 退回全量计算（不崩、不静默归零）
	{
		const buf = new Uint8Array(16 + 400)
		buf.fill(0x7f)
		const dv = new DataView(buf.buffer)
		dv.setInt32(4, 400, true)
		dv.setInt32(8, 1000, true)   // < 8000 ⇒ 非法
		buf.fill(0, 16)
		check("L29: 分块头不合法（采样率越界）⇒ 退回全量计算, 结果不为 0 也不抛异常",
			pcmRms(buf) > 0, String(pcmRms(buf)))
	}
	// 声明的 pcmSize 超出实际长度 ⇒ 同样退回全量
	{
		const buf = new Uint8Array(16 + 400)
		buf.fill(0x7f)
		const dv = new DataView(buf.buffer)
		dv.setInt32(4, 999999, true)
		dv.setInt32(8, 24000, true)
		buf.fill(0, 16)
		check("L30: 声明的长度超过实际缓冲区 ⇒ 退回全量（不越界读）", pcmRms(buf) > 0, String(pcmRms(buf)))
	}
}

/* ============================================================================
 * ⑤ applyLipSync 的 IO 侧 + 两个孤儿导出的真实用途
 * ==========================================================================*/
box("⑤ applyLipSync（写参数）与状态复位")
{
	const mkHooks = (indexOfResult) => {
		const calls = []
		return {
			calls,
			hooks: {
				set: (id, v) => { calls.push([id, v]) },
				...(indexOfResult === "absent" ? {} : {indexOf: () => indexOfResult}),
			},
		}
	}

	// 1) 正常: 有声幅 + 参数存在 ⇒ 写一次, mouthOpenNow 反映真实写入值
	__resetLipSyncForTest()
	check("L31: __resetLipSyncForTest 把上次写入量清 0", mouthOpenNow() === 0, String(mouthOpenNow()))
	const h1 = mkHooks(0)
	notifyPlaybackAmplitude(0.2, 1000)
	const r1 = applyLipSync(true, 1010, h1.hooks)
	check("L32: 出声且参数存在 ⇒ 写一次 MOUTH_PARAM 并返回 1",
		r1 === 1 && h1.calls.length === 1 && h1.calls[0][0] === MOUTH_PARAM && h1.calls[0][1] > 0,
		JSON.stringify(h1.calls))
	check("L33: mouthOpenNow() == 真正写下去的值（诊断/E2E 的读数就是这个）",
		mouthOpenNow() > 0 && mouthOpenNow() === h1.calls[0][1], `${mouthOpenNow()} vs ${h1.calls[0][1]}`)

	// 2) 没有 set 钩子 ⇒ 不写, lastWritten 归 0
	__resetLipSyncForTest()
	const r2 = applyLipSync(true, 1010, {})
	check("L34: 拿不到写参数钩子 ⇒ 返回 0 且 mouthOpenNow 归 0", r2 === 0 && mouthOpenNow() === 0, String(r2))

	// 3) 拿不到 indexOf 时**照样写**（宁可多写: 误判"没有参数"会让口型永久不动）
	__resetLipSyncForTest()
	const h3 = mkHooks("absent")
	notifyPlaybackAmplitude(0.2, 1000)
	const r3 = applyLipSync(true, 1010, h3.hooks)
	check("L35: 拿不到 indexOf ⇒ 照样写（误判的代价比多写严重得多）", r3 === 1 && h3.calls.length === 1, String(r3))

	// 4) indexOf 明确说"没这个参数" ⇒ 永久禁用（记住一次, 不再每帧问）
	__resetLipSyncForTest()
	const hBad = mkHooks(-1)
	const rBad = applyLipSync(true, 1010, hBad.hooks)
	const hAfter = mkHooks(0)
	notifyPlaybackAmplitude(0.2, 2000)
	const rAfter = applyLipSync(true, 2010, hAfter.hooks)
	check("L36: indexOf<0 ⇒ 判定模型没这个参数并永久停写", rBad === 0 && hBad.calls.length === 0, `bad=${rBad}`)
	check("L37: 停写状态会被记住（后续帧也不再写）", rAfter === 0 && hAfter.calls.length === 0, `after=${rAfter}`)
	// 5) 复位钩子能把这个 latch 清掉 —— 这正是 __resetLipSyncForTest 存在的理由
	__resetLipSyncForTest()
	const hReset = mkHooks(0)
	notifyPlaybackAmplitude(0.2, 3000)
	const rReset = applyLipSync(true, 3010, hReset.hooks)
	check("L38: __resetLipSyncForTest 清掉'参数缺失'的 latch（换模型/重载后能重新动嘴）",
		rReset === 1 && hReset.calls.length === 1, `reset=${rReset}`)

	// 6) 不在出声 ⇒ 不写
	__resetLipSyncForTest()
	const h6 = mkHooks(0)
	check("L39: 不在出声 ⇒ 返回 0、不写参数", applyLipSync(false, 4000, h6.hooks) === 0 && h6.calls.length === 0)

	// 7) 时钟脏数据 ⇒ fail-safe 不写
	__resetLipSyncForTest()
	const h7 = mkHooks(0)
	check("L40: 时钟非有限 ⇒ fail-safe 不写", applyLipSync(true, NaN, h7.hooks) === 0 && h7.calls.length === 0)

	// 8) 写参数抛异常不该影响渲染（返回 0 但要吞掉异常）
	__resetLipSyncForTest()
	notifyPlaybackAmplitude(0.2, 5000)
	let threw = false
	let r8 = null
	try { r8 = applyLipSync(true, 5010, {set: () => { throw new Error("桥坏了") }, indexOf: () => 0}) } catch { threw = true }
	check("L41: 写参数抛异常被吞掉（不影响渲染）", threw === false && r8 === 1, `threw=${threw} r=${r8}`)

	// 9) 振幅尾巴: 太久没刷新就视为静音 ⇒ 目标归 0
	__resetLipSyncForTest()
	const h9 = mkHooks(0)
	notifyPlaybackAmplitude(0.5, 6000)
	applyLipSync(true, 6010, h9.hooks)                       // 尾巴内 ⇒ 有声幅
	const inTail = mouthOpenNow()
	__resetLipSyncForTest()
	const h10 = mkHooks(0)
	notifyPlaybackAmplitude(0.5, 7000)
	const r10 = applyLipSync(true, 7000 + 500, h10.hooks)     // 超出 AMPLITUDE_TAIL_MS ⇒ 视作静音
	check("L42: 振幅过期后视作静音（目标归 0, 开始收口）",
		inTail > 0 && r10 === 1 && h10.calls[0][1] < inTail,
		JSON.stringify({inTail, stale: h10.calls[0]?.[1]}))

	__resetLipSyncForTest()
}

/* ============================================================================
 * 汇总
 * ==========================================================================*/
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
	process.exitCode = 1
	console.log("FAILED:", failed.map(f => f.name).join(" | "))
}
