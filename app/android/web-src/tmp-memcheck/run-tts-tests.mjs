/**
 * 音色↔模型纯逻辑门禁 (Node 直测, 不用浏览器 / 不用 harness / 毫秒级).
 *
 * 覆盖 src/services/tts/cosy-models.ts 的全部导出:
 *   - cosyModelFromVoiceId : 从音色 id 前缀反推所属模型
 *   - normalizeCloneVoices : settings 里 cosyCloneVoices 的归一化 (含旧数据兼容与去重)
 *   - pickVoiceModel       : "这个音色属于哪个模型" 的统一入口
 *   - COSY_MODELS          : 前缀无歧义这条不变量 (以后加模型时靠它守住)
 *
 * 为什么要单独有这个: 这几轮改的语音逻辑此前**只**被浏览器 E2E 覆盖,
 * 而那需要 harness + headless Edge + 两个空闲端口。少了这个门禁,
 * 只跑 pnpm build && gradlew 的话, 这些逻辑坏了没有任何东西会报。
 *
 * 运行: cd web-src && node tmp-memcheck/run-tts-tests.mjs
 */
import {readFileSync, readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

// esbuild 没被提升 (pnpm 严格布局), 从 .pnpm 目录里动态解析
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

const outfile = path.join(root, "tmp-memcheck/cosy-models-bundle.mjs")
await build({
	entryPoints: [path.join(root, "src/services/tts/cosy-models.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile,
})
const M = await import(pathToFileURL(outfile).href)
const {COSY_MODELS, cosyModelFromVoiceId, normalizeCloneVoices, pickVoiceModel} = M

let pass = 0
let fail = 0
const check = (name, cond, detail = "") => {
	if (cond) { pass += 1; console.log(`PASS  ${name}`) }
	else { fail += 1; console.log(`FAIL  ${name}  ← ${detail}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(want)}`)

/* ---------------- COSY_MODELS: 前缀无歧义 (不变量) ---------------- */
{
	const conflicts = []
	for (const a of COSY_MODELS) for (const b of COSY_MODELS) {
		if (a !== b && b.startsWith(a + "-")) conflicts.push(`${a} → ${b}`)
	}
	check("COSY_MODELS 无「带横线前缀」冲突 (加模型时必须守住)", conflicts.length === 0, conflicts.join(", "))
	check("COSY_MODELS 非空且无重复", COSY_MODELS.length > 0 && new Set(COSY_MODELS).size === COSY_MODELS.length, String(COSY_MODELS.length))
}

/* ---------------- cosyModelFromVoiceId ---------------- */
{
	// 官方格式: {target_model}-{prefix}-{唯一标识}
	for (const m of COSY_MODELS) {
		eq(`认得出 ${m}`, cosyModelFromVoiceId(`${m}-myvoice-ab12cd`), m)
	}
	eq("v3.5 不会被 v3 抢走 (靠 . 与 - 区分)", cosyModelFromVoiceId("cosyvoice-v3.5-flash-myvoice-x"), "cosyvoice-v3.5-flash")
	eq("plus 不会被 flash 抢走", cosyModelFromVoiceId("qwen-audio-3.0-tts-plus-myvoice-x"), "qwen-audio-3.0-tts-plus")
	eq("认不出 → 空串", cosyModelFromVoiceId("legacy_custom_9"), "")
	eq("空串 → 空串", cosyModelFromVoiceId(""), "")
	eq("纯空白 → 空串", cosyModelFromVoiceId("   "), "")
	eq("只有模型名、没有 -前缀-标识 → 空串", cosyModelFromVoiceId("cosyvoice-v3-flash"), "")
	eq("模型名不在开头 → 空串", cosyModelFromVoiceId("x-cosyvoice-v3-flash-myvoice"), "")
	eq("首尾空白被忽略", cosyModelFromVoiceId("  cosyvoice-v2-myvoice-x  "), "cosyvoice-v2")
	eq("undefined 不炸", cosyModelFromVoiceId(undefined), "")
}

/* ---------------- normalizeCloneVoices ---------------- */
{
	eq("非数组 → 空数组", normalizeCloneVoices(undefined), [])
	eq("非数组(字符串) → 空数组", normalizeCloneVoices("nope"), [])
	eq("非数组(对象) → 空数组", normalizeCloneVoices({}), [])

	// 旧数据: 只有 id 的 string[], 靠前缀回填归属
	eq("旧 string[] 回填归属",
		normalizeCloneVoices(["cosyvoice-v3-flash-myvoice-ab12cd"]),
		[{id: "cosyvoice-v3-flash-myvoice-ab12cd", model: "cosyvoice-v3-flash"}])
	eq("旧 string[] 认不出时保持未知",
		normalizeCloneVoices(["legacy_voice_9"]),
		[{id: "legacy_voice_9", model: ""}])

	// 新结构原样保留
	eq("新结构原样保留",
		normalizeCloneVoices([{id: "v1", model: "cosyvoice-v2"}]),
		[{id: "v1", model: "cosyvoice-v2"}])

	// 坏数据
	eq("坏数据被丢弃",
		normalizeCloneVoices([null, 42, {}, {id: ""}, {id: 123}, "   ", {id: "ok_1"}]),
		[{id: "ok_1", model: ""}])
	eq("空白被 trim",
		normalizeCloneVoices([{id: "  v_x  ", model: "  cosyvoice-v2  "}]),
		[{id: "v_x", model: "cosyvoice-v2"}])

	// 去重: 优先保留"带模型"的那条, 且与先后顺序无关
	eq("去重: 带模型的在后 → 保留带模型的",
		normalizeCloneVoices([{id: "dup", model: ""}, {id: "dup", model: "cosyvoice-v2"}]),
		[{id: "dup", model: "cosyvoice-v2"}])
	eq("去重: 带模型的在前 → 保留带模型的",
		normalizeCloneVoices([{id: "dup", model: "cosyvoice-v2"}, {id: "dup", model: ""}]),
		[{id: "dup", model: "cosyvoice-v2"}])
	eq("去重: 两条都有模型 → 保留先出现的",
		normalizeCloneVoices([{id: "dup", model: "A"}, {id: "dup", model: "B"}]),
		[{id: "dup", model: "A"}])
	eq("去重: 两条都没有模型 → 保留一条",
		normalizeCloneVoices(["legacy_x", "legacy_x"]),
		[{id: "legacy_x", model: ""}])
	eq("去重不改动插入顺序",
		normalizeCloneVoices(["b_voice", "a_voice", "b_voice"]),
		[{id: "b_voice", model: ""}, {id: "a_voice", model: ""}])
	eq("前缀回填让重复的两条只剩带模型的一条",
		normalizeCloneVoices([{id: "cosyvoice-v2-myvoice-x", model: ""}, "cosyvoice-v2-myvoice-x"]),
		[{id: "cosyvoice-v2-myvoice-x", model: "cosyvoice-v2"}])
}

/* ---------------- pickVoiceModel ---------------- */
{
	const list = [{id: "rec_1", model: "cosyvoice-v2"}]
	eq("空音色 → 空串", pickVoiceModel("", list), "")
	eq("纯空白音色 → 空串", pickVoiceModel("   ", list), "")
	eq("记录里的绑定优先", pickVoiceModel("rec_1", list), "cosyvoice-v2")
	eq("无记录时用前缀反推", pickVoiceModel("cosyvoice-v3-flash-myvoice-x", list), "cosyvoice-v3-flash")
	eq("记录为空但有前缀 → 用前缀", pickVoiceModel("cosyvoice-v3-flash-myvoice-x", [{id: "cosyvoice-v3-flash-myvoice-x", model: ""}]), "cosyvoice-v3-flash")
	eq("两者都认不出 → 空串", pickVoiceModel("legacy_9", list), "")
	eq("cloneVoices 为 undefined 也能用", pickVoiceModel("cosyvoice-v2-myvoice-x", undefined), "cosyvoice-v2")
	eq("记录里的绑定胜过前缀推断 (以记录为准)",
		pickVoiceModel("cosyvoice-v2-myvoice-x", [{id: "cosyvoice-v2-myvoice-x", model: "cosyvoice-v3-flash"}]),
		"cosyvoice-v3-flash")
}

/* ---------------- 组合场景: 切模型后应当能看出不匹配 ---------------- */
{
	const cloneList = normalizeCloneVoices(["cosyvoice-v3-flash-myvoice-legacy"])
	const voiceOf = "cosyvoice-v3-flash-myvoice-legacy"
	eq("旧数据: 归属被回填", pickVoiceModel(voiceOf, cloneList), "cosyvoice-v3-flash")
	check("旧数据: 切到别的模型后能被判为不匹配",
		pickVoiceModel(voiceOf, cloneList) !== "cosyvoice-v2", "")
	check("旧数据: 切回原模型则匹配",
		pickVoiceModel(voiceOf, cloneList) === "cosyvoice-v3-flash", "")
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exitCode = 1
