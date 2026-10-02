/**
 * 摸头台词门禁（Node 直测，不用浏览器 / 不用 harness）。
 *
 * 覆盖 `src/services/live2d/petSpeech.ts`：
 *   - `PET_LINES`      : **逐字对拍用户给的台词文档**（10 句，含 `....` 与 `…` 的区别）
 *   - `petSpeechDraw`  : 首次必说 / 10s 窗口 / 边界 10000ms / NaN 不动状态 / 纯函数
 *   - 洗牌袋           : 10 句说完之前不重复、重装袋不与刚说过的相连、`rand` 真的被使用
 *   - 有状态入口        : 计数、最后一句、`petSpeechWaitMs` 语义
 *
 * 一条"不逐字就是坏的"断言（这个项目最容易出的事）：
 *   TTS 收到的是 `cleanSpeechText(台词)` —— 若台词里混进 Markdown/多余空白，
 *   屏幕上写的和嘴里说的会不一样。所以每条都要求**原样返回**。
 *
 * 运行: cd web-src && node tmp-memcheck/run-pet-speech-tests.mjs
 */
import {readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

const bundleOf = async (entry, outfile) => {
	await build({
		entryPoints: [path.join(root, entry)],
		bundle: true, platform: "neutral", format: "esm", logLevel: "silent", outfile: path.join(root, "tmp-memcheck", outfile),
	})
	return import(pathToFileURL(path.join(root, "tmp-memcheck", outfile)).href)
}

const S = await bundleOf("src/services/live2d/petSpeech.ts", "petSpeech-bundle.mjs")
const F = await bundleOf("src/services/tts/fishaudio.ts", "fishaudio-bundle.mjs")
const {
	PET_LINES, PET_SPEECH_WINDOW_MS,
	petSpeechDraw, newPetSpeechState, maybePetSpeechLine,
	petSpeechCount, petSpeechLastLine, petSpeechWaitMs, __resetPetSpeechForTest,
} = S
const {cleanSpeechText} = F

let pass = 0
let fail = 0
const check = (name, cond, detail = "") => {
	if (cond) { pass += 1; console.log(`PASS  ${name}`) }
	else { fail += 1; console.log(`FAIL  ${name}  ← ${detail}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(want)}`)

/** **文档原文**：由 `tmp-webarch-audit/gen-pet-lines.mjs` 直接读用户文档生成（零转写）。
 *  保留第 6 句的 `....`（4 个英文句点）—— 用来核对"归一"到底改了哪一处。 */
const DOC = [
	"头发都被你揉乱啦。",
	"再摸就要收费啦。",
	"Nori不是小狗啦。",
	"为什么摸我的头呀。",
	"你摸Nori，Nori也不会掉毛的。",
	"好乖....啊，说反了，是你在摸我。",
	"只有Nori有摸头待遇吗？",
	"嘿嘿，摸摸头很舒服，感觉芯片都要开心得发热了。",
	"这算是表扬吗？那我记下来了。",
	"被摸头…有点想睡了。",
]

/** **实际出厂的台词表**：文档原文 + 第 6 句省略号归一（用户要求"直接归一"）。 */
const EXPECTED = DOC.map((l, i) => (i === 5 ? l.replace("....", "…") : l))

/* 一次都不许重复的确定性子: 抽满一整袋 */
const drawAll = (rand) => {
	const st = newPetSpeechState()
	const out = []
	let s = st
	for (let i = 0; i < PET_LINES.length; i++) {
		const r = petSpeechDraw(s, i * PET_SPEECH_WINDOW_MS, rand)
		s = r.state
		out.push(r.line)
	}
	return out
}

/* ================= 1. 常量与台词表 ================= */
{
	eq("窗口 = 10 秒（用户定）", PET_SPEECH_WINDOW_MS, 10000)
	eq("台词恰好 10 句", PET_LINES.length, 10)
	eq("台词等于「文档原文 + 第 6 句省略号归一」（顺序也一致）", [...PET_LINES], EXPECTED)

	/* 归一必须**只**改那一处: 多改一个字都是错 */
	const diff = DOC.map((l, i) => (l === PET_LINES[i] ? -1 : i)).filter((i) => i >= 0)
	eq("与文档的差异**只有**第 6 句这一处", diff, [5])
	eq("第 6 句的差异就是 `....` → `…`", PET_LINES[5], DOC[5].replace("....", "…"))
	check("第 6 句不再有连续英文句点", !/\.{2,}/.test(PET_LINES[5]), JSON.stringify(PET_LINES[5]))
	check("全表都不再有连续英文句点", PET_LINES.every((l) => !/\.{2,}/.test(l)))
	check("第 6 句用的是省略号 `…`（与第 10 句同一写法）",
		PET_LINES[5].includes("…") && !PET_LINES[5].includes("."), JSON.stringify(PET_LINES[5]))
	check("第 10 句用的是省略号 `…`",
		PET_LINES[9].includes("…"), JSON.stringify(PET_LINES[9]))
	check("第 3 / 5 句保留第三人称自称 `Nori`（用户选 A：一字不改）",
		PET_LINES[2].startsWith("Nori") && PET_LINES[4].includes("Nori"), JSON.stringify([PET_LINES[2], PET_LINES[4]]))
}

/* ================= 2. 台词原样送进 TTS ================= */
{
	const mangled = PET_LINES.filter((l) => cleanSpeechText(l) !== l)
	eq("每句都能被 cleanSpeechText 原样返回（屏幕上写的 = 嘴里说的）", mangled, [])
	const empties = PET_LINES.filter((l) => !cleanSpeechText(l).length)
	eq("没有一句会被清洗成空串", empties, [])
	check("没有一句带换行（换行会被清洗成空格）", PET_LINES.every((l) => !/[\r\n]/.test(l)))
}

/* ================= 3. 窗口语义 ================= */
{
	const st0 = newPetSpeechState()
	const first = petSpeechDraw(st0, 0, () => 0.5)
	check("首次摸头必说（状态里的 lastSpokeAt = -Infinity）", first.line !== null, JSON.stringify(first))
	check("首次说的话来自台词表", PET_LINES.includes(first.line), JSON.stringify(first.line))
	eq("说过之后 lastSpokeAt = now", first.state.lastSpokeAt, 0)

	const inWin = petSpeechDraw(first.state, 9999, () => 0.5)
	eq("窗口内（9999ms）不说", inWin.line, null)
	check("窗口内返回的**就是同一个 state 对象**（调用方可以当「没发生」）", inWin.state === first.state)

	const edge = petSpeechDraw(first.state, 10000, () => 0.5)
	check("边界 10000ms 算窗口已过 → 说", edge.line !== null, JSON.stringify(edge))
	eq("边界处 lastSpokeAt 推进到 10000", edge.state.lastSpokeAt, 10000)

	const nan = petSpeechDraw(first.state, NaN, () => 0.5)
	eq("now = NaN → 不说", nan.line, null)
	check("now = NaN → 状态不变（同一个对象）", nan.state === first.state)
	eq("now = Infinity → 不说", petSpeechDraw(first.state, Infinity, () => 0.5).line, null)
	eq("now = -Infinity → 不说", petSpeechDraw(first.state, -Infinity, () => 0.5).line, null)

	const badState = petSpeechDraw(newPetSpeechState(), 5000, () => 0.5)
	eq("lastSpokeAt 损坏成 NaN 时按「没说过」处理（fail-open）",
		petSpeechDraw({lastSpokeAt: NaN, bag: [], lastIdx: -1}, 5000, () => 0.5).line !== null, true)
	check("损坏状态也真的说出了话", badState.line !== null)
}

/* ================= 4. 长摸的节奏（每 10s 一句） ================= */
{
	const st = newPetSpeechState()
	const said = []
	let s = st
	for (let t = 0; t <= 60000; t += 1000) {
		const r = petSpeechDraw(s, t, () => 0.5)
		s = r.state
		if (r.line !== null) said.push(t)
	}
	eq("一直摸 60s：恰好每 10s 说一句", said, [0, 10000, 20000, 30000, 40000, 50000, 60000])
}

/* ================= 5. 洗牌袋：先说完 10 句才可能重复 ================= */
{
	const seq = drawAll(() => 0.5)
	eq("一整袋恰好覆盖全部 10 句（无重复/无遗漏）", [...new Set(seq)].length, 10)
	const adjSame = seq.filter((l, i) => i > 0 && l === seq[i - 1])
	eq("袋内相邻两次不相同", adjSame, [])

	/* 跨袋: 连说 11 次, 第 11 次（重装后的第一句）不得等于第 10 句 */
	const st = newPetSpeechState()
	const long = []
	let s = st
	for (let i = 0; i < 11; i++) {
		const r = petSpeechDraw(s, i * PET_SPEECH_WINDOW_MS, () => 0.5)
		s = r.state
		long.push(r.line)
	}
	check("重装袋后的第一句不等于刚说过的最后一句", long[10] !== long[9], JSON.stringify([long[9], long[10]]))
	eq("重装后 11 句里仍然只有 1 次重复（10 句全在）", [...new Set(long)].length, 10)

	const a = drawAll(() => 0)[0]
	const b = drawAll(() => 0.999)[0]
	check("rand 真的被使用（两个极端 rand 抽出的第一句不同）", a !== b, JSON.stringify([a, b]))
	eq("rand 恒定 0 也能抽满一整袋", [...new Set(drawAll(() => 0))].length, 10)
	eq("rand 返回非有限值时不死循环 / 不产生 undefined", drawAll(() => NaN).filter((l) => typeof l !== "string"), [])
}

/* ================= 6. 有状态入口与探针 ================= */
{
	__resetPetSpeechForTest()
	eq("复位后计数为 0", petSpeechCount(), 0)
	eq("复位后最后一句为 null", petSpeechLastLine(), null)
	eq("复位后立即可说（waitMs = 0）", petSpeechWaitMs(0), 0)

	const l1 = maybePetSpeechLine(1000, () => 0.5)
	check("第一次调用就说", typeof l1 === "string" && l1.length > 0, JSON.stringify(l1))
	eq("计数 = 1", petSpeechCount(), 1)
	eq("最后一句 = 刚说的那句", petSpeechLastLine(), l1)
	eq("刚说完 waitMs = 10000", petSpeechWaitMs(1000), 10000)
	eq("过 6 秒 waitMs = 4000", petSpeechWaitMs(7000), 4000)
	eq("过 10 秒 waitMs = 0", petSpeechWaitMs(11000), 0)

	eq("窗口内再摸返回 null（App 层据此不发声）", maybePetSpeechLine(2000, () => 0.5), null)
	eq("窗口内不增加计数", petSpeechCount(), 1)
	eq("窗口内不覆盖最后一句", petSpeechLastLine(), l1)

	const l2 = maybePetSpeechLine(11000, () => 0.5)
	check("窗口过后再摸又说一句", typeof l2 === "string" && l2.length > 0, JSON.stringify(l2))
	check("第二句与第一句不同", l2 !== l1, JSON.stringify([l1, l2]))
	eq("计数 = 2", petSpeechCount(), 2)
	eq("最后一句更新为第二句", petSpeechLastLine(), l2)

	eq("NaN 时间不计数", maybePetSpeechLine(NaN, () => 0.5), null)
	eq("NaN 时间后计数仍为 2", petSpeechCount(), 2)
}

console.log("")
console.log(`摸头台词门禁: ${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
