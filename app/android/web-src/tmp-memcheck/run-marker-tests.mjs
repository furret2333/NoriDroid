/**
 * 表情/动作标记映射门禁 (Node 直测, 不用浏览器).
 *
 * 为什么需要: 2026-09-23 用户反馈"好多动作根本不会触发"。查下来是
 * `markerRules.ts` 的映射表按**另一套英文命名**写的 (happy/jump/wave/hug/dance/pet…),
 * 而这些名字在 ARGNori / Nori 两个模型里**一个都不存在** ——
 * 提示词允许的 13 个动作词里有 9 个落空, 落空后静默走中性 idle 兜底, 用户看起来就是"没反应"。
 * 本门禁用两个模型的**真实名单**守住这个映射, 防止再退化。
 *
 * fixture 来源: 真实 model3.json (D:/norios/models/<id>/<id>.model3.json) 于 2026-09-23 抄录。
 * 本项目只用这两个模型, 所以直接固化比读文件更稳 (CI/无模型时也能跑)。
 *
 * 运行: cd web-src && node tmp-memcheck/run-marker-tests.mjs
 */
import {readFileSync, readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

/* ---------------- 两个模型的真实资源名 (抄自 model3.json) ---------------- */
const ARGNORI = {
	motions: ["back_Loop", "01_Idle_Loop", "sleep_Loop", "02_Nod", "03_ShakeHead", "04_WakuWaku", "05_Angry", "06_Troubled", "07_Dizzy", "08_Glitch_Loop", "Idle_pose_Loop", "Idle_pose_expidle_Loop"],
	expressions: ["00_Default", "01_KiraKira", "02_Dizzy", "03_Angry", "04_Shy", "05_Dark", "06_Speechless", "07_Smile", "08_Tears", "09_Troubled", "10_Doubt", "11_Disgust", "12_Serious", "13_Happy", "Sleep", "14_Surprised"],
}
const NORI = {
	motions: ["back_Loop", "00_Idle", "00_Sleep", "00_IdleCamera", "00_IdleCameraEyeClosed", "01_Nod", "02_ShakeHead", "02_Stare_loop", "03_Stare_in", "03_Stare", "04_WakuWaku_in", "04_Wakuwaku_loop", "05_Angry", "06_Doubt", "07_Troubled", "08_Dizzy", "09_Bow", "10_NoNoNo"],
	expressions: ["01_KiraKira", "02_Dizzy", "03_Angry", "04_Shy", "05_Dark.", "06_Speechless", "08_Tears", "09_Troubled", "10_Doubt", "07_Smile", "11_Disgust", "12_Serious", "13_Happy", "Chibi", "TailOFF", "LongHairOFF", "00_Default", "Shojo", "Finale_Sad", "Finale_Smile", "Finale_EyeClosed", "Finale_EyeClosed_Smile", "Finale_Farewell", "Finale_Default", "Finale_Sad_Smile"],
}
const MODELS = {ARGNori: ARGNORI, Nori: NORI}

/** 与 nori-prompt.md「反应标记」段保持一致 —— 改了提示词词表, 这里也要改 */
const PROMPT_EMOTIONS = ["开心", "难过", "生气", "害羞", "困", "惊讶", "认真", "无奈", "温柔", "感动", "孤单", "头晕", "疑惑", "嫌弃"]
const PROMPT_MOTIONS = ["开心", "难过", "生气", "困", "点头", "摇头", "兴奋", "疑惑", "鞠躬", "摆手", "盯着", "头晕"]
/** 旧提示词用过、现已移除的动作词: 只要求"不抛异常", 不要求映射成功 */
const LEGACY_MOTIONS = ["害羞", "惊讶", "游戏", "摸头", "抱抱", "跳舞", "再见", "谢谢", "加油"]

/* ---------------- 打包被测模块 ---------------- */
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)
const outfile = path.join(root, "tmp-memcheck/markerRules-bundle.mjs")
await build({
	entryPoints: [path.join(root, "src/services/live2d/markerRules.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile,
})
const R = await import(pathToFileURL(outfile).href)

let pass = 0, fail = 0
const check = (name, cond, detail = "") => {
	if (cond) { pass += 1; console.log(`PASS  ${name}`) }
	else { fail += 1; console.log(`FAIL  ${name}  ← ${detail}`) }
}
const eq = (name, got, want) => check(name, got === want, `得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(want)}`)

/* ---------------- 1. 提示词里每个词都必须"有人接" ---------------- */
{
	const orphans = []
	for (const w of PROMPT_MOTIONS) {
		const hit = Object.values(MODELS).some(m => R.resolveMarkerMotion(w, m.motions))
		if (!hit) orphans.push(w)
	}
	check("提示词的每个动作词都能在至少一个模型上映射到动作", orphans.length === 0,
		`落空的词(会静默走 idle 兜底): ${orphans.join(", ")}`)

	const emoOrphans = []
	for (const w of PROMPT_EMOTIONS) {
		const hit = Object.values(MODELS).some(m => R.resolveMarkerEmotion(w, m.expressions))
		if (!hit) emoOrphans.push(w)
	}
	check("提示词的每个表情词都能在至少一个模型上映射到表情", emoOrphans.length === 0,
		`落空的词: ${emoOrphans.join(", ")}`)
}

/* ---------------- 2. 关键情绪必须映射到语义正确的动作 ---------------- */
{
	const want = [
		["开心", ARGNORI, "04_WakuWaku"], ["开心", NORI, "04_WakuWaku_in"],
		["难过", ARGNORI, "06_Troubled"], ["难过", NORI, "07_Troubled"],
		["生气", ARGNORI, "05_Angry"], ["生气", NORI, "05_Angry"],
		["困", ARGNORI, "sleep_Loop"], ["困", NORI, "00_Sleep"],
		["点头", ARGNORI, "02_Nod"], ["点头", NORI, "01_Nod"],
		["摇头", ARGNORI, "03_ShakeHead"], ["摇头", NORI, "02_ShakeHead"],
		["头晕", ARGNORI, "07_Dizzy"], ["头晕", NORI, "08_Dizzy"],
		["鞠躬", NORI, "09_Bow"],
		["摆手", NORI, "10_NoNoNo"],
		["盯着", NORI, "02_Stare_loop"],
		["疑惑", NORI, "06_Doubt"],
	]
	for (const [word, model, expected] of want) {
		eq(`动作 ${word} → ${expected}`, R.resolveMarkerMotion(word, model.motions), expected)
	}
}

/* ---------------- 3. 两个曾经错掉的映射 (回归守卫) ---------------- */
{
	check("「惊讶」不再被映射成 Dizzy(头晕) —— 动作侧",
		Object.values(MODELS).every(m => (R.resolveMarkerMotion("惊讶", m.motions) ?? "").toLowerCase().indexOf("dizzy") < 0),
		JSON.stringify(MODELS.ARGNori && R.resolveMarkerMotion("惊讶", MODELS.Nori.motions)))
	check("「惊讶」不再被映射成 Dizzy(头晕) —— 表情侧",
		(R.resolveMarkerEmotion("惊讶", MODELS.Nori.expressions) ?? "").toLowerCase().indexOf("dizzy") < 0,
		JSON.stringify(R.resolveMarkerEmotion("惊讶", MODELS.Nori.expressions)))
	check("「开心」不再被映射成 Bow(鞠躬)",
		(R.resolveMarkerMotion("开心", MODELS.Nori.motions) ?? "").toLowerCase().indexOf("bow") < 0,
		JSON.stringify(R.resolveMarkerMotion("开心", MODELS.Nori.motions)))
	check("「谢谢」仍应映射到 Bow(鞠躬) —— 这个是合理的",
		R.resolveMarkerMotion("谢谢", MODELS.Nori.motions) === "09_Bow",
		JSON.stringify(R.resolveMarkerMotion("谢谢", MODELS.Nori.motions)))
}

/* ---------------- 4. 覆盖面不能退化 (低于这个数就是又掉动作了) ---------------- */
{
	for (const [id, m] of Object.entries(MODELS)) {
		// 注意: 这里数的是"**多少个字能映射到东西**", 不是"多少个不同动作" ——
		// 多个词映射到同一动作是正常的 (开心/兴奋 都→WakuWaku)。
		const mapped = PROMPT_MOTIONS.filter(w => R.resolveMarkerMotion(w, m.motions))
		// ARGNori 只有 12 个动作且其中 5 个是待机/背景/特效, 没有 Bow/Stare → 10/12 就是它的上限
		const floor = id === "Nori" ? 12 : 10
		check(`${id}: 提示词 ${PROMPT_MOTIONS.length} 个动作词至少 ${floor} 个能映射 (实得 ${mapped.length})`,
			mapped.length >= floor, `落空: ${PROMPT_MOTIONS.filter(w => !R.resolveMarkerMotion(w, m.motions)).join(", ")}`)
	}
}

/* ---------------- 5. 旧词兼容: 不抛异常即可 ---------------- */
{
	let threw = null
	for (const w of LEGACY_MOTIONS) {
		try {
			for (const m of Object.values(MODELS)) { R.resolveMarkerMotion(w, m.motions); R.resolveMarkerEmotion(w, m.expressions) }
		} catch (e) { threw = `${w}: ${e}` }
	}
	check("旧动作词解析不抛异常", threw === null, String(threw))
	eq("未知名词返回 null 而不是报错", R.resolveMarkerMotion("这个词根本不存在", NORI.motions), null)
	eq("「无」按约定返回 null", R.resolveMarkerMotion("无", NORI.motions), null)
	eq("空串返回 null", R.resolveMarkerMotion("   ", NORI.motions), null)
}

/* ---------------- 6. 正文关键词兜底也要能命中新动作, 且不能子串误命中 ---------------- */
{
	eq("正文含「点头」→ Nod", R.detectMotionByRules("Nori点了点头表示同意", NORI.motions), "01_Nod")
	eq("正文含「疑惑」→ Doubt", R.detectMotionByRules("Nori有点疑惑", NORI.motions), "06_Doubt")
	check("正文含「头晕」→ Dizzy", (R.detectMotionByRules("Nori有点头晕", NORI.motions) ?? "").toLowerCase().includes("dizzy"),
		JSON.stringify(R.detectMotionByRules("Nori有点头晕", NORI.motions)))

	// 子串误命中守卫: "有【点头】晕" / "一【点头】绪" 都不该被判成点头
	check("「Nori有点头晕」不该被判成点头(Nod)",
		(R.detectMotionByRules("Nori有点头晕", NORI.motions) ?? "").toLowerCase().indexOf("nod") < 0,
		JSON.stringify(R.detectMotionByRules("Nori有点头晕", NORI.motions)))
	check("「我一点头绪都没有」不该被判成点头(Nod)",
		(R.detectMotionByRules("我一点头绪都没有", NORI.motions) ?? "").toLowerCase().indexOf("nod") < 0,
		JSON.stringify(R.detectMotionByRules("我一点头绪都没有", NORI.motions)))
	check("「我一点头绪都没有」也不该被判成摇头",
		(R.detectMotionByRules("我一点头绪都没有", NORI.motions) ?? "").toLowerCase().indexOf("shakehead") < 0,
		JSON.stringify(R.detectMotionByRules("我一点头绪都没有", NORI.motions)))
}

/* ---------------- 7. 否定前缀不能被误判为正向情绪 ---------------- */
{
	const e = R.detectExpressionByRules("我一点也不开心", MODELS.ARGNori.expressions)
	check("「我一点也不开心」不该判成 Happy", (e ?? "").toLowerCase().indexOf("happy") < 0, JSON.stringify(e))
	const e2 = R.detectExpressionByRules("今天好开心呀", MODELS.ARGNori.expressions)
	check("「今天好开心呀」应判成 Happy", (e2 ?? "").toLowerCase().indexOf("happy") >= 0, JSON.stringify(e2))
}

/* ---------------- 8. 待机挑选: index 必须是原始数组下标, 且不能选中被排除的动作 ---------------- */
{
	// 用 Nori 的真实 Idle 组: sleep 必须被排除掉
	const groups = [{group: "Idle", names: ["00_Idle", "00_Sleep", "00_IdleCamera", "00_IdleCameraEyeClosed"]}]
	const seen = new Set()
	let played = null
	for (let i = 0; i < 200; i++) {
		const p = R.pickNeutralIdle(groups)
		if (!p) { played = "null"; break }
		// 调用方就是这么用的: playMotionByIndex(p.group, p.index) → 原始数组
		const n = groups[0].names[p.index]
		seen.add(n)
		if (n === undefined) { played = "越界"; break }
		if (/sleep/i.test(n)) { played = n; break }
	}
	check("pickNeutralIdle 的 index 不会指向被排除的 sleep (200 次抽样)", played === null,
		`抽到 ${JSON.stringify(played)}`)
	check("pickNeutralIdle 的 index 不越界", played !== "越界", String(played))
	check("抽样中确实出现了多个不同动作 (不是恒定一个)", seen.size >= 1, [...seen].join(", "))
	eq("idle 组为空时返回 null", R.pickNeutralIdle([{group: "Reactions", names: ["05_Angry"]}]), null)
}

/* ---------------- 9. 新补的三个表情词 (原来 ARGNori 上永远触发不到) ---------------- */
{
	eq("表情 头晕 → Dizzy", R.resolveMarkerEmotion("头晕", ARGNORI.expressions), "02_Dizzy")
	eq("表情 疑惑 → Doubt", R.resolveMarkerEmotion("疑惑", ARGNORI.expressions), "10_Doubt")
	eq("表情 嫌弃 → Disgust", R.resolveMarkerEmotion("嫌弃", ARGNORI.expressions), "11_Disgust")
	check("正文含「头晕」也能落到 Dizzy",
		(R.detectExpressionByRules("Nori有点头晕", ARGNORI.expressions) ?? "").toLowerCase().includes("dizzy"),
		JSON.stringify(R.detectExpressionByRules("Nori有点头晕", ARGNORI.expressions)))
	check("正文含「疑惑」也能落到 Doubt",
		(R.detectExpressionByRules("Nori一脸疑惑", ARGNORI.expressions) ?? "").toLowerCase().includes("doubt"),
		JSON.stringify(R.detectExpressionByRules("Nori一脸疑惑", ARGNORI.expressions)))
}

/* ---------------- 10. 同情绪变体轮换 + 绝不随机到"功能开关"表情 ---------------- */
{
	// pickEmotionVariant 用注入的 rand 做确定化验证
	eq("pickEmotionVariant: rand=0 取组内第一个", R.pickEmotionVariant("13_Happy", ARGNORI.expressions, () => 0), "13_Happy")
	eq("pickEmotionVariant: rand→1 取组内最后一个", R.pickEmotionVariant("13_Happy", ARGNORI.expressions, () => 0.999), "01_KiraKira")
	eq("pickEmotionVariant: 不在任何组里 → 原样返回", R.pickEmotionVariant("12_Serious", ARGNORI.expressions, () => 0.5), "12_Serious")
	eq("pickEmotionVariant: 组内当前模型没有的名字被忽略 (Nori 无 01_KiraKira 时只剩两项)",
		R.pickEmotionVariant("13_Happy", ["13_Happy", "07_Smile"], () => 0.999), "07_Smile")

	// 抽样: 开心 应当轮换出 3 个正向表情
	const seenHappy = new Set()
	const seenSad = new Set()
	for (let i = 0; i < 300; i++) {
		seenHappy.add(R.resolveMarkerEmotion("开心", ARGNORI.expressions))
		seenSad.add(R.resolveMarkerEmotion("难过", ARGNORI.expressions))
	}
	check("ARGNori「开心」会轮换出 13_Happy / 07_Smile / 01_KiraKira",
		["13_Happy", "07_Smile", "01_KiraKira"].every(n => seenHappy.has(n)), [...seenHappy].join(", "))
	check("ARGNori「难过」会轮换出 08_Tears / 09_Troubled",
		["08_Tears", "09_Troubled"].every(n => seenSad.has(n)), [...seenSad].join(", "))

	// 安全线: 任何情况下都不能随机到默认脸/功能开关/结算动画
	const FORBIDDEN = /^(00_Default|05_Dark\.?|Chibi|TailOFF|LongHairOFF|Shojo|Finale_)/i
	const leaked = new Set()
	for (const w of PROMPT_EMOTIONS) {
		for (const m of Object.values(MODELS)) {
			for (let i = 0; i < 100; i++) {
				const r = R.resolveMarkerEmotion(w, m.expressions)
				if (r && FORBIDDEN.test(r)) leaked.add(`${w}→${r}`)
			}
		}
	}
	check("任何情绪词都不会随机到 默认脸/功能开关/结算动画", leaked.size === 0, [...leaked].join(", "))

	// 变体分组本身的自检
	check("变体分组里不含功能开关类表情",
		!R.EMOTION_VARIANT_GROUPS.flat().some(n => FORBIDDEN.test(n)),
		JSON.stringify(R.EMOTION_VARIANT_GROUPS))
}

/* ---------------- 11. 反应动作"回中性状态"的调度器 ---------------- */
{
	// 单独打包这个模块 (它用的是真实 setTimeout, 所以测试里用很短的延迟)
	const mrOut = path.join(root, "tmp-memcheck/motionReturn-bundle.mjs")
	await build({
		entryPoints: [path.join(root, "src/services/live2d/motionReturn.ts")],
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
		outfile: mrOut,
	})
	const MR = await import(pathToFileURL(mrOut).href)
	const sleep = (ms) => new Promise(r => setTimeout(r, ms))

	// ① 到点会触发
	MR.cancelReturnToNeutral()
	let fired = 0
	MR.scheduleReturnToNeutral(() => { fired += 1 }, 20)
	check("调度后立刻处于 pending", MR.hasPendingReturn() === true)
	await sleep(60)
	eq("到点触发一次", fired, 1)
	check("触发后不再是 pending", MR.hasPendingReturn() === false)

	// ② 重复调度会重置 (只按最后一个算)
	fired = 0
	MR.scheduleReturnToNeutral(() => { fired += 1 }, 40)
	await sleep(15)
	MR.scheduleReturnToNeutral(() => { fired += 1 }, 40)  // 重置
	await sleep(25)
	eq("重置后旧的不会提前触发", fired, 0)
	await sleep(40)
	eq("最终只触发一次", fired, 1)

	// ③ 取消
	fired = 0
	MR.scheduleReturnToNeutral(() => { fired += 1 }, 20)
	MR.cancelReturnToNeutral()
	check("取消后不再是 pending", MR.hasPendingReturn() === false)
	await sleep(50)
	eq("取消后不会触发", fired, 0)

	// ④ 回调抛异常不能把定时器带崩 (也不该冒泡)
	MR.cancelReturnToNeutral()
	let after = 0
	MR.scheduleReturnToNeutral(() => { throw new Error("boom") }, 15)
	MR.scheduleReturnToNeutral(() => { after += 1 }, 15)   // 重置: 只留这个
	await sleep(50)
	eq("抛异常的回调被吞掉且不影响后续调度", after, 1)

	MR.cancelReturnToNeutral()
	check("默认延迟是个正数且不至于太短 (< 1s 会看不清动作)",
		MR.NEUTRAL_RETURN_DELAY_MS >= 2000 && MR.NEUTRAL_RETURN_DELAY_MS <= 15000,
		String(MR.NEUTRAL_RETURN_DELAY_MS))
}

/* ---------------- 12. 抚摸幅度曲线 (只让幅度渐强, 频率不变) ---------------- */
{
	const pfOut = path.join(root, "tmp-memcheck/petEffect-bundle.mjs")
	await build({
		entryPoints: [path.join(root, "src/services/live2d/petEffect.ts")],
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
		outfile: pfOut,
	})
	const PF = await import(pathToFileURL(pfOut).href)

	const {PET_SWAY_AMP_MIN: MIN, PET_SWAY_AMP_MAX: MAX, PET_SWAY_RAMP_MS: RAMP, petSwayAmp} = PF
	check("幅度上限必须大于起手值 (否则'渐强'没意义)", MAX > MIN, `min=${MIN} max=${MAX}`)
	check("渐强时长在合理区间 (1~6 秒)", RAMP >= 1000 && RAMP <= 6000, String(RAMP))

	eq("起点 = 起手幅度", petSwayAmp(0), MIN)
	eq("刚到一半 ≈ 中值", Math.round(petSwayAmp(RAMP / 2) * 100) / 100, Math.round(((MIN + MAX) / 2) * 100) / 100)
	eq("到达渐强时长 = 上限", petSwayAmp(RAMP), MAX)
	eq("超出时长仍是上限 (封顶, 不会无限变大)", petSwayAmp(RAMP * 10), MAX)
	eq("负数时长按起点处理 (不返回 NaN)", petSwayAmp(-500), MIN)
	eq("NaN 时长按起点处理", petSwayAmp(NaN), MIN)

	// 单调不减 + 全程落在 [MIN, MAX]
	let mono = true
	let inRange = true
	let prev = -Infinity
	for (let t = 0; t <= RAMP * 1.5; t += 50) {
		const v = petSwayAmp(t)
		if (v < prev) mono = false
		if (v < MIN || v > MAX) inRange = false
		prev = v
	}
	check("幅度随时间单调不减", mono)
	check("幅度全程落在 [起手值, 上限] 内", inRange)
}

/* ---------------- 13. 抚摸采样器 (移植自网页版 headPat 的 r8e) ----------------
 * 从 rAF/pointermove 回调里抽出来的纯函数, 否则 Node 测不到 = 没验证。
 * 断言钉的是**语义**: 横向为主 / 速度门槛 / 断档作废 / 进度封顶 / 一次抚摸只完成一次。 */
{
	const psOut = path.join(root, "tmp-memcheck/petStroke-bundle.mjs")
	await build({
		entryPoints: [path.join(root, "src/services/live2d/petStroke.ts")],
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
		outfile: psOut,
	})
	const PS = await import(pathToFileURL(psOut).href)
	const {DEFAULT_PET_STROKE_TUNING: T, createPetStrokeDetector, PET_STROKE_IDLE} = PS

	// 与网页版 w4 / DEFAULT_NORI_PAT_TUNING 同值 —— 抄错一个数就白抄了
	eq("requiredMs 与网页版一致", T.requiredMs, 1000)
	eq("horizontalDominance 与网页版一致", T.horizontalDominance, 1)
	eq("minSpeedX 与网页版一致", T.minSpeedX, 0.05)
	eq("maxSampleGapMs 与网页版一致", T.maxSampleGapMs, 250)

	// 未 start: 喂点不应产生任何效果
	{
		const d = createPetStrokeDetector()
		const s = d.move(100, 999, 999)
		eq("未 start 时 move 不合格", s.qualifying, false)
		eq("未 start 时进度为 0", s.progressMs, 0)
		eq("未 start 时 active=false", d.active, false)
	}

	// 纯横向快摸: 每 50ms 挪 5 单位 = 100 单位/秒; 1250ms 内只完成一次
	{
		const d = createPetStrokeDetector()
		d.start(0, 0, 0)
		let t = 0, x = 0, done = 0, firstAt = -1, qual = 0
		for (let i = 0; i < 25; i += 1) {
			t += 50
			x += 5
			const s = d.move(t, x, 0)
			if (s.qualifying) qual += 1
			if (s.completed) { done += 1; if (firstAt < 0) firstAt = t }
		}
		eq("横向快摸: 每次都合格", qual, 25)
		eq("横向快摸 1250ms 只完成一次 (latch 生效)", done, 1)
		eq("完成发生在累计满 1000ms 那次采样", firstAt, 1000)
		eq("进度封顶在 requiredMs (不会超过)", d.progressMs, 1000)
	}

	// 纵向为主 → 不合格 (网页版要求横向主导); 斜向但横向占优 → 合格
	{
		const d = createPetStrokeDetector()
		d.start(0, 0, 0)
		eq("纵向为主 (|dx|<|dy|) 不合格", d.move(50, 1, 10).qualifying, false)
		eq("纵向为主不涨进度", d.progressMs, 0)
		eq("斜向 10:9 仍算横向为主", d.move(100, 11, 9).qualifying, true)
	}

	// 速度太慢 → 不合格 (0.001/50ms = 0.02 单位/秒 < 0.05)
	{
		const d = createPetStrokeDetector()
		d.start(0, 0, 0)
		const s = d.move(50, 0.001, 0)
		eq("速度低于 minSpeedX 不合格", s.qualifying, false)
		eq("速度太慢不涨进度", s.progressMs, 0)
	}

	// 采样断档 → 本次作废, 但**已累计进度不清零** (网页版原版行为, 故意保留)
	{
		const d = createPetStrokeDetector()
		d.start(0, 0, 0)
		d.move(50, 5, 0)
		d.move(100, 10, 0)
		eq("断档前已累计 100ms", d.progressMs, 100)
		const s = d.move(500, 15, 0) // dt=400 > 250
		eq("采样间隔超过 250ms 本次作废", s.qualifying, false)
		eq("断档不清零已有进度 (与网页版一致)", s.progressMs, 100)
	}

	// dt<=0 不能算出 Infinity 速度
	{
		const d = createPetStrokeDetector()
		d.start(1000, 0, 0)
		const s = d.move(1000, 5, 0)
		eq("dt=0 本次作废", s.qualifying, false)
		check("dt=0 不产生 Infinity 速度", Number.isFinite(s.velocityX), String(s.velocityX))
	}

	// NaN 输入: 不崩、不污染进度、**不毒化后续采样**(这点比网页版更稳)
	{
		const d = createPetStrokeDetector()
		d.start(0, 0, 0)
		d.move(50, 5, 0)
		const bad = d.move(NaN, NaN, NaN)
		eq("NaN 采样不合格", bad.qualifying, false)
		eq("NaN 采样不污染进度", bad.progressMs, 50)
		const after = d.move(100, 10, 0)
		eq("NaN 之后正常采样仍合格 (基准点没被毒化)", after.qualifying, true)
		eq("NaN 之后进度继续累加", after.progressMs, 100)
	}

	// 向左摸: 速度为负但同样合格 (对称性)
	{
		const d = createPetStrokeDetector()
		d.start(0, 100, 0)
		const s = d.move(50, 95, 0)
		eq("向左摸同样合格", s.qualifying, true)
		check("向左摸速度为负", s.velocityX < 0, String(s.velocityX))
	}

	// start/end 复位
	{
		const d = createPetStrokeDetector()
		d.start(0, 0, 0)
		d.move(50, 5, 0)
		d.end()
		eq("end() 后 active=false", d.active, false)
		eq("end() 后进度清零", d.progressMs, 0)
		d.start(1000, 0, 0)
		eq("重新 start 后进度从 0 开始", d.progressMs, 0)
		let done = 0, t = 1000, x = 0
		for (let i = 0; i < 21; i += 1) { t += 50; x += 5; if (d.move(t, x, 0).completed) done += 1 }
		eq("重新 start 后仍能完成一次", done, 1)
	}

	// 一次抚摸(按下→抬起)内连续摸 3 秒也只完成一次
	{
		const d = createPetStrokeDetector()
		d.start(0, 0, 0)
		let t = 0, x = 0, done = 0
		for (let i = 0; i < 60; i += 1) { t += 50; x += 5; if (d.move(t, x, 0).completed) done += 1 }
		eq("连续摸 3000ms 也只完成一次", done, 1)
	}

	// 可注入 tuning: requiredMs 调小 → 更快完成
	{
		const d = createPetStrokeDetector(() => ({...T, requiredMs: 200}))
		d.start(0, 0, 0)
		let t = 0, x = 0, firstAt = -1
		for (let i = 0; i < 10; i += 1) { t += 50; x += 5; if (d.move(t, x, 0).completed && firstAt < 0) firstAt = t }
		eq("注入 requiredMs=200 后 200ms 即完成", firstAt, 200)
	}

	check("PET_STROKE_IDLE 是冻结的 (共享常量不可被调用方改写)", Object.isFrozen(PET_STROKE_IDLE))
}

/* ---------------- 14. 抚摸音效的**纯函数**部分 (移植自网页版 headPat 的 RK/w8e/S8e) ----------------
 * Web Audio 那半截(建图/接节点)Node 测不了, 所以把"速度→包络"的映射抽成纯函数在这里钉住。
 * 建图本身由 e2e-pet-effect 在真实浏览器里验(检查图有没有建起来)。 */
{
	const paOut = path.join(root, "tmp-memcheck/petAudio-bundle.mjs")
	await build({
		entryPoints: [path.join(root, "src/services/live2d/petAudio.ts")],
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
		outfile: paOut,
	})
	const PA = await import(pathToFileURL(paOut).href)
	const {petSoundProfile, PET_AUDIO_VX_FULL: FULL, PET_AUDIO_LEVEL: LEVEL,
		PET_TOUCH_PROFILE: TOUCH, PET_COMPLETE_PROFILE: DONE,
		PET_COMPLETE_ECHO_MS: ECHO_MS, PET_COMPLETE_ECHO_PROFILE: ECHO} = PA

	// 与网页版 w8e/S8e 的 ky(...) 实参一致 —— 抄错数字就白抄了
	eq("刚摸到的包络 level 与网页版一致 (0.35)", TOUCH.level, 0.35)
	eq("刚摸到的包络亮度与网页版一致 (0.15)", TOUCH.brightness, 0.15)
	eq("完成的包络 level 与网页版一致 (0.5)", DONE.level, 0.5)
	eq("完成的包络亮度与网页版一致 (0.3)", DONE.brightness, 0.3)
	eq("完成第二段的延迟与网页版一致 (150ms)", ECHO_MS, 150)
	eq("完成第二段包络 level 与网页版一致 (0.4)", ECHO.level, 0.4)
	eq("完成第二段包络亮度与网页版一致 (0.3)", ECHO.brightness, 0.3)

	check("满量程是正数", FULL > 0, String(FULL))
	check("音量基数是可听范围内的正数 (0.05~1)", LEVEL > 0.05 && LEVEL <= 1, String(LEVEL))

	// RK() 的映射: e = clamp(|v|/xK), level = e^1.4, brightness = e
	eq("速度为 0 → 完全静音", petSoundProfile(0).level, 0)
	eq("速度为 0 → 亮度 0", petSoundProfile(0).brightness, 0)
	eq("满量程 → level 1", petSoundProfile(FULL).level, 1)
	eq("满量程 → 亮度 1", petSoundProfile(FULL).brightness, 1)
	eq("超过满量程被夹到 1 (不会更响)", petSoundProfile(FULL * 5).level, 1)
	eq("向左摸与向右摸音效相同 (取绝对值)", petSoundProfile(-FULL / 2).level, petSoundProfile(FULL / 2).level)
	eq("NaN 速度 → 静音 (不炸)", petSoundProfile(NaN).level, 0)
	// 有意偏差: 网页版没挡非有限值(NaN 会喂给节点, Infinity 夹到满音量);
	// 这里一律静音 —— 宁可没声, 也不要一个卡在最大声的节点
	eq("Infinity 速度 → 静音 (不夹到满音量)", petSoundProfile(Infinity).level, 0)
	eq("-Infinity 速度 → 静音", petSoundProfile(-Infinity).level, 0)

	// 单调不减 + level 不超过 brightness(指数 1.4 > 1 ⇒ e^1.4 <= e, 0<e<=1)
	let mono = true, bounded = true, prev = -1
	for (let i = 0; i <= 40; i += 1) {
		const v = (i / 20) * FULL
		const p = petSoundProfile(v)
		if (p.level < prev) mono = false
		prev = p.level
		if (p.level < 0 || p.level > 1 || p.brightness < 0 || p.brightness > 1) bounded = false
		if (p.level > p.brightness + 1e-9) bounded = false
	}
	check("音效强度随速度单调不减", mono)
	check("强度/亮度全程落在 [0,1] 且强度不超过亮度", bounded)
}

/* ---------------- 15. "摸到头"判定 (移植自网页版 headPat 的部件判定) ----------------
 * 这个模型**没有 Part9**(网页版硬编码的那个), 所以改成按几何挑头盒 —— 纯函数, 在这里钉住。
 * 用的数据是探针在真实模型上实测出来的 (tmp-memcheck/probe-part-bounds.mjs)。 */
{
	const hzOut = path.join(root, "tmp-memcheck/petHeadZone-bundle.mjs")
	await build({
		entryPoints: [path.join(root, "src/services/live2d/petHeadZone.ts")],
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
		outfile: hzOut,
	})
	const HZ = await import(pathToFileURL(hzOut).href)
	const {pickHeadBox, inHeadBand, headBandLine, SKULL_TOP_BAND, HEAD_TOP_EPS_RATIO} = HZ

	// 与网页版 w4 同值: band 0.6
	eq("skullTopBand 与网页版一致 (0.6)", SKULL_TOP_BAND, 0.6)
	check("容差是小的正数 (0.01~0.1)", HEAD_TOP_EPS_RATIO > 0.01 && HEAD_TOP_EPS_RATIO < 0.1, String(HEAD_TOP_EPS_RATIO))

	// 实测数据: ARGNori 的模型盒与"最顶部部件" Part3
	const MODEL = {left: -0.3498, right: 0.3390, top: 0.8824, bottom: -0.5663}
	const HEAD = {left: -0.0597, right: 0.1881, top: 0.8823, bottom: 0.6128}

	const headOnly = pickHeadBox([HEAD], MODEL)
	check("单个顶部部件 → 头盒就是它", !!headOnly && Math.abs(headOnly.top - HEAD.top) < 1e-9 && Math.abs(headOnly.bottom - HEAD.bottom) < 1e-9, JSON.stringify(headOnly))

	// 网页版判定: 命中点 y=0.851 (E2E 扫出来的实体点) → 应在头带内; 分界线实测 ≈ 0.721
	const line = headBandLine(headOnly)
	check("分界线落在实测值附近 (0.70~0.74)", line > 0.70 && line < 0.74, String(line))
	eq("头上点 (y=0.851) 在头带内", inHeadBand(headOnly, 0.851), true)
	eq("下巴附近 (y=0.616) 在头带外", inHeadBand(headOnly, 0.616), false)
	eq("胸口 (y=0.35) 在头带外", inHeadBand(headOnly, 0.35), false)
	eq("脚 (y=-0.5) 在头带外", inHeadBand(headOnly, -0.5), false)
	eq("恰好压线算通过 (>= 语义)", inHeadBand(headOnly, line), true)
	eq("线下方一点算不通过", inHeadBand(headOnly, line - 1e-6), false)

	/* **实测教训**: 不能"取与顶部带相交的所有部件求并集" —— 会被竖直长条部件污染。
	   真实数据里 Part18 y[0.000, 0.597] / Part19 y[0.000, 0.554] 都伸进了顶部带,
	   一并集就把盒子拉到 y=0, 分界线掉到胸口。 */
	const polluted = [
		HEAD,
		{left: 0, right: 0.202, top: 0.597, bottom: 0.000},
		{left: 0, right: 0.175, top: 0.554, bottom: 0.000},
	]
	const safe = pickHeadBox(polluted, MODEL)
	check("竖直长条部件不会污染头盒 (盒底仍是 0.61 而非 0)",
		!!safe && Math.abs(safe.bottom - HEAD.bottom) < 1e-9, JSON.stringify(safe))
	eq("因此分界线不会被拉到胸口", Math.abs(headBandLine(safe) - line) < 1e-9, true)

	// 容差: 顶部相差在容差内的部件并入同一个头盒
	const nearTop = {...HEAD, left: -0.2, right: 0.2, top: MODEL.top}
	const merged = pickHeadBox([HEAD, nearTop], MODEL)
	check("顶部齐平的部件会被并成一个头盒", !!merged && Math.abs(merged.top - MODEL.top) < 1e-9, JSON.stringify(merged))
	const lowPart = {left: -0.2, right: 0.2, top: MODEL.top - 0.2, bottom: 0.1}
	const notMerged = pickHeadBox([HEAD, lowPart], MODEL)
	check("顶部差得远的部件不并入头盒", !!notMerged && Math.abs(notMerged.top - HEAD.top) < 1e-9, JSON.stringify(notMerged))

	// 退化输入: 一律不崩, 且**拿不到几何时不放行**(宁可严一点)
	eq("空部件表 → null", pickHeadBox([], MODEL), null)
	eq("模型盒为 null → null", pickHeadBox([HEAD], null), null)
	eq("零高度模型盒 → null", pickHeadBox([HEAD], {left: 0, right: 1, top: 5, bottom: 5}), null)
	eq("部件含 NaN → 被跳过, 不影响结果", Math.abs(pickHeadBox([{left: NaN, right: 0, top: NaN, bottom: NaN}, HEAD], MODEL).bottom - HEAD.bottom) < 1e-9, true)
	eq("头盒为 null → 判定 false (不放行)", inHeadBand(null, 0.9), false)
	eq("y 为 NaN → false", inHeadBand(headOnly, NaN), false)
	eq("y 为 Infinity → false", inHeadBand(headOnly, Infinity), false)
	// 注意: 这里不能拿"精确相等"卡浮点边界 (band=1 时分界线会算成 bottom+1e-16),
	// 用容差判"盒底之上算头 / 盒底之下不算"。
	eq("band 为 1 → 盒底之上的点算头", inHeadBand(headOnly, HEAD.bottom + 1e-9, 1), true)
	eq("band 为 1 → 盒底之下的点不算", inHeadBand(headOnly, HEAD.bottom - 1e-6, 1), false)
	eq("band 为 0 → 只有最顶端算", inHeadBand(headOnly, HEAD.bottom), false)
	eq("band 越界值被夹住 (不放大范围)", inHeadBand(headOnly, HEAD.bottom, 5), true)

	/* ---- 17. 头区迟滞: 进入用严格线, 留驻用**有界的 leash 盒** ----
	   (不留驻盒只有下界 → 摸完头往上/往旁边挪进空白区还继续算"摸头", 抬手才取消 —— 实机 bug) ---- */
	{
		const {inHeadZoneHysteresis, HEAD_LEASH_RATIO, HEAD_LEASH_MARGIN_RATIO} = HZ
		check("迟滞比例是个克制的小值 (0.02~0.15)", HEAD_LEASH_RATIO >= 0.02 && HEAD_LEASH_RATIO <= 0.15, String(HEAD_LEASH_RATIO))
		check("leash 盒边距是小值 (0.005~0.05)", HEAD_LEASH_MARGIN_RATIO > 0.005 && HEAD_LEASH_MARGIN_RATIO < 0.05, String(HEAD_LEASH_MARGIN_RATIO))
		const base = HZ.headZoneLine(headOnly, MODEL)
		const H = MODEL.top - MODEL.bottom
		const outLine = base - H * HEAD_LEASH_RATIO
		const CX = 0            // 头盒中心附近
		const inBox = (x, y, wasIn, band, ratio, leash) => inHeadZoneHysteresis(headOnly, MODEL, x, y, wasIn, band, ratio, leash)
		// 进入: 必须过严格线 (与 x 无关 —— 是否命中实体由调用方再判)
		eq("头区外(未在内) → 不算头", inBox(CX, base - 0.01, false), false)
		eq("刚过线(未在内) → 算头", inBox(CX, base + 0.01, false), true)
		eq("未在内时 x 再偏也不放行 (进入只看严格线+实体)", inBox(9, base + 0.01, false), true)
		// 留驻: 盒内继续
		eq("线下 1 分但已在盒内 → 仍算头", inBox(CX, base - 0.01, true), true)
		eq("恰在盒底 → 仍算头", inBox(CX, outLine + 1e-9, true), true)
		eq("跌出盒底 → 不算头", inBox(CX, outLine - 1e-3, true), false)
		eq("掉到胸口 → 不算头", inBox(CX, 0.30, true), false)
		eq("掉到腿 → 不算头", inBox(CX, -0.3, true), false)
		// **这次的实机 bug: 往上/往左右挪进空白区必须算离开**
		eq("往上移出模型顶 → 不算头", inBox(CX, MODEL.top + H * 0.2, true), false)
		eq("往上一点点(仍在边距内) → 仍算头", inBox(CX, MODEL.top + H * 0.01, true), true)
		eq("往左移出模型左界 → 不算头", inBox(MODEL.left - H * 0.2, base + 0.05, true), false)
		eq("往右移出模型右界 → 不算头", inBox(MODEL.right + H * 0.2, base + 0.05, true), false)
		eq("横向仍在模型宽度内 → 仍算头", inBox(MODEL.left + 0.01, base + 0.05, true), true)
		// 抖动: 分界线附近来回不能反复切换
		let st = inBox(CX, base + 0.02, false)
		let flips = 0
		for (const y of [base - 0.005, base + 0.005, base - 0.008, base + 0.002, base - 0.01]) {
			const nx = inBox(CX, y, st)
			if (nx !== st) flips += 1
			st = nx
		}
		eq("分界线上抖动不产生状态翻转 (迟滞挡住)", flips, 0)
		// 边界与退化
		eq("迟滞为 0 时几乎无余量 (盒底=分界线)", inBox(CX, base - 0.01, true, 0.6, 0.32, 0), false)
		eq("迟滞为 NaN → 当作 0", inBox(CX, base - 0.01, true, 0.6, 0.32, NaN), false)
		eq("y=NaN → false", inBox(CX, NaN, true), false)
		eq("x=NaN → false", inBox(NaN, base + 0.05, true), false)
		eq("几何全缺 → false", inHeadZoneHysteresis(null, null, CX, 0.9, true), false)
		eq("只有模型盒时留驻仍生效", inHeadZoneHysteresis(null, MODEL, CX, base - 0.01, true), true)
	}

	/* ---- 头区 = 头盒 ∪ 模型顶部比例 ---- 
	   实机反馈"一直判断在头外": 网页版的 band 0.6 是针对**它自己那份模型的部件切法**调的,
	   而这份模型里 Part3 是"下巴到头顶的整个头", 按 0.6 会把脸排除, 双马尾更低更是全在带外。 */
	const {inHeadZone, headZoneLine, HEAD_ZONE_RATIO} = HZ
	check("头区兜底比例在合理区间 (0.15~0.5)", HEAD_ZONE_RATIO > 0.15 && HEAD_ZONE_RATIO < 0.5, String(HEAD_ZONE_RATIO))

	const zoneLine = headZoneLine(headOnly, MODEL)
	check("头区判定线比头盒带线更低 (取并集)", zoneLine < line, `zone=${zoneLine} band=${line}`)
	check("头区判定线落在实测的肩线附近 (0.40~0.44)", zoneLine > 0.40 && zoneLine < 0.44, String(zoneLine))
	eq("headZoneLine 取两者中更低的那条", zoneLine, MODEL.top - (MODEL.top - MODEL.bottom) * HEAD_ZONE_RATIO)

	// 关键：这些正是实机上"摸头却没反应"的位置
	eq("头顶在头区", inHeadZone(headOnly, MODEL, 0.851), true)
	eq("额头在头区", inHeadZone(headOnly, MODEL, 0.78), true)
	eq("脸/下巴在头区 (旧 band 判定为头外 —— 这就是那个 bug)", inHeadZone(headOnly, MODEL, 0.65), true)
	eq("双马尾下端在头区", inHeadZone(headOnly, MODEL, 0.43), true)
	eq("肩/胸 (0.397) 不在头区", inHeadZone(headOnly, MODEL, 0.397), false)
	eq("胸腹 (0.30) 不在头区", inHeadZone(headOnly, MODEL, 0.30), false)
	eq("腿 (-0.3) 不在头区", inHeadZone(headOnly, MODEL, -0.3), false)
	eq("脚 (-0.5) 不在头区", inHeadZone(headOnly, MODEL, -0.5), false)

	// 只有模型盒、没有头盒时仍能判定（探针拿不到部件映射也不至于全废）
	eq("头盒缺失但有模型盒 → 仍按比例判定 (脸算头)", inHeadZone(null, MODEL, 0.65), true)
	eq("头盒缺失但有模型盒 → 胸仍不算头", inHeadZone(null, MODEL, 0.30), false)
	eq("两者都缺失 → false (由调用方决定兜底)", inHeadZone(null, null, 0.9), false)
	eq("两者都缺失时判定线为 null", headZoneLine(null, null), null)
	eq("y 为 NaN → false", inHeadZone(headOnly, MODEL, NaN), false)

	// 并集不与旧带线冲突: 头盒比比例线更低时, 取头盒带线(区域只会变大不会变小)
	const lowHead = {left: -0.1, right: 0.1, top: 0.884, bottom: 0.10}
	check("头盒更低时判定线更低 (并集不缩水)",
		headZoneLine(lowHead, MODEL) < headZoneLine(headOnly, MODEL),
		`low=${headZoneLine(lowHead, MODEL)} only=${headZoneLine(headOnly, MODEL)}`)
	// 0.416 夹在两条线之间: 只有 lowHead 才算头 → 证明并集确实扩大了范围
	eq("并集情形: 夹缝里的点算头", inHeadZone(lowHead, MODEL, 0.416), true)
	eq("同一批几何下(头盒不含该点)则不算头", inHeadZone(headOnly, MODEL, 0.416), false)
}

/* ---------------- 16. canvas CSS 变换的坐标逆变换 (实机"粒子冒在头顶上空"的根因) ----------------
 * stage.ts 给 canvas 加的是 **CSS** transform: scale(s) translate(ox,oy) (origin center),
 * 而库的 transformViewX/Y 完全不知道它 ⇒ scale≠1 或 offset≠0 时命中判定与渲染整体错位。
 * 这里把逆变换钉死, 并用**独立按 CSS 语义写的正向公式**做往返对照。 */
{
	const stOut = path.join(root, "tmp-memcheck/stage-bundle.mjs")
	await build({
		entryPoints: [path.join(root, "src/services/live2d/stage.ts")],
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
		outfile: stOut,
	})
	const ST = await import(pathToFileURL(stOut).href)
	const {clientFromCanvasPoint: fwd, canvasPointFromClient: inv} = ST

	// 与 stage.ts 里 applyCanvasLayout 写进 canvas.style 的字符串一致
	eq("正向公式与 applyCanvasLayout 的 CSS 一致 (含 origin center)",
		`transform: scale(${0.5}) translate(${30}px, ${-40}px)`, "transform: scale(0.5) translate(30px, -40px)")

	const V = {w: 1000, h: 800, scale: 1, offsetX: 0, offsetY: 0}
	// 注意: eq 是严格比较, 对象字面量永远不等 —— 坐标一律逐字段比。
	const invIs = (name, cx, cy, view, wx, wy) => {
		const p = inv(cx, cy, view)
		eq(name, `${p.x},${p.y}`, `${wx},${wy}`)
	}
	invIs("scale=1/offset=0 时逆变换是恒等 (不改变既有行为)", 123, 456, V, 123, 456)

	const S = {w: 1000, h: 800, scale: 0.5, offsetX: 0, offsetY: 0}
	invIs("缩放中心不动 (画布中心映射到自身)", 500, 400, S, 500, 400)
	invIs("缩小一半后, 屏幕左边缘对应原画布更靠外", 250, 400, S, 0, 400)
	invIs("缩小一半后, 屏幕右边缘同理", 750, 400, S, 1000, 400)
	eq("缩小时屏幕上方空白 → 原画布的负坐标 (会被判成模型外)", inv(500, 200, S).y, 0)

	const O = {w: 1000, h: 800, scale: 1, offsetX: 30, offsetY: -40}
	invIs("纯平移: 逆变换减去偏移", 130, 360, O, 100, 400)

	// 往返: inv 后再 fwd 必须回到原点 (含缩放+平移组合)
	let rt = true
	for (const v of [V, S, O, {w: 1080, h: 2400, scale: 0.37, offsetX: -120, offsetY: 260}, {w: 520, h: 900, scale: 2.4, offsetX: 15, offsetY: -300}]) {
		for (const p of [{x: 0, y: 0}, {x: 123, y: 456}, {x: v.w, y: v.h}, {x: v.w / 2, y: v.h / 2}, {x: -80, y: 1200}]) {
			const q = fwd(inv(p.x, p.y, v).x, inv(p.x, p.y, v).y, v)
			if (Math.abs(q.x - p.x) > 1e-6 || Math.abs(q.y - p.y) > 1e-6) rt = false
		}
	}
	check("任意 scale/offset 下 逆→正 往返都回到原点", rt)

	// 退化输入不能产生 NaN/除零
	const bad = inv(100, 100, {w: 800, h: 600, scale: 0, offsetX: NaN, offsetY: NaN})
	check("scale=0 / NaN 偏移时退化为恒等而不是 NaN",
		Number.isFinite(bad.x) && Number.isFinite(bad.y), JSON.stringify(bad))
	const badF = fwd(100, 100, {w: 800, h: 600, scale: NaN, offsetX: 0, offsetY: 0})
	check("正向 scale=NaN 也不产生 NaN", Number.isFinite(badF.x) && Number.isFinite(badF.y), JSON.stringify(badF))

	// 实机症状复现: scale=0.5 时, 屏幕上"模型头顶上方"的点, 逆变换后应落在原画布更靠上(即模型外)
	const above = inv(500, 150, {w: 1000, h: 800, scale: 0.5, offsetX: 0, offsetY: 0})
	check("复现实机症状: 缩放后头顶上方的点会被逆变换推到画布外/更上方",
		above.y < 0, JSON.stringify(above))
}
	/* ---- 18. （已删除）摸头"低头" ----
	   那套实现（`petBow.ts` + 这里的 12 条断言 + `PET_PRESS_DOWN_RATIO`）**已按用户决定永久删除**：
	   走 `ParamAngleY`/`ParamEyeBallY` 会与库每帧的注视写入抢参数；换成干净通道 + 渐变后
	   用户仍判定不要这个效果（实机症状是"头部角度跳变"）。
	   **摸头反馈改为"表情"**：见 `tmp-memcheck/run-pet-expression-tests.mjs`。
	   通道归属的守卫搬到 `tmp-memcheck/run-param-owner-tests.mjs`（与低头无关，是通用护栏）。
	   历史实现留档：`backups\低头重做与参数归属护栏-20260924-232222\`（最新一版）。 */

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exitCode = 1