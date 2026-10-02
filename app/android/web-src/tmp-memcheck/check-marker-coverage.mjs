/**
 * 诊断: 提示词允许的情绪/动作词, 到底能映射到模型里的哪些动作/表情?
 *
 * 背景: 用户反馈"好多动作根本不会触发". 本脚本用**代码里真实的映射函数**
 * (services/live2d/markerRules.ts) 去跑**模型文件里真实的动作/表情名**
 * (model3.json), 把"能触发 / 触发不了"如实列出来。
 *
 * 运行: cd web-src && node tmp-memcheck/check-marker-coverage.mjs
 * 依赖: D:\norios\models\<id>\<id>.model3.json (没有就跳过, 只报提示)
 */
import {existsSync, readFileSync, readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const MODELS_DIR = "D:/norios/models"

// 提示词里允许 AI 使用的词 (nori-prompt.md「反应标记」段) —— 2026-09-23 按真实模型名订正后
const PROMPT_EMOTIONS = ["开心", "难过", "生气", "害羞", "困", "惊讶", "认真", "无奈", "温柔", "感动", "孤单", "头晕", "疑惑", "嫌弃"]
const PROMPT_MOTIONS = ["开心", "难过", "生气", "困", "点头", "摇头", "兴奋", "疑惑", "鞠躬", "摆手", "盯着", "头晕"]
// 旧提示词用过、现在已从词表移除的动作词: 留着是为了确认"旧标记/旧历史"不会解析崩
const LEGACY_MOTIONS = ["害羞", "惊讶", "游戏", "摸头", "抱抱", "跳舞", "再见", "谢谢", "加油"]

// esbuild 从 .pnpm 里动态解析
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

/** 从 model3.json 提取动作组与表情名 */
const loadModel = (id) => {
	const p = path.join(MODELS_DIR, id, `${id}.model3.json`)
	if (!existsSync(p)) return null
	const j = JSON.parse(readFileSync(p, "utf8"))
	const f = j.FileReferences ?? {}
	const groups = f.Motions ?? {}
	const motions = []
	for (const g of Object.keys(groups)) {
		for (const mm of (groups[g] ?? [])) {
			const file = String(mm.File ?? "")
			motions.push({group: g, name: file.replace(/^.*\//, "").replace(/\.motion3\.json$/, "")})
		}
	}
	const expressions = (f.Expressions ?? []).map(e => e.Name).filter(Boolean)
	return {motions, expressions}
}

const ids = existsSync(MODELS_DIR) ? readdirSync(MODELS_DIR, {withFileTypes: true}).filter(d => d.isDirectory()).map(d => d.name) : []
if (!ids.length) {
	console.log(`未找到模型目录 ${MODELS_DIR} —— 跳过 (本脚本需要真实 model3.json 才有意义)`)
	process.exit(0)
}

for (const id of ids) {
	const model = loadModel(id)
	if (!model) { console.log(`\n===== ${id}: 缺 model3.json, 跳过 =====`); continue }
	const motionNames = model.motions.map(m => m.name)
	const exprNames = model.expressions

	console.log(`\n================ ${id} ================`)
	console.log(`真实动作 ${motionNames.length} 个 / 真实表情 ${exprNames.length} 个`)

	/* ---- 表情 ---- */
	// 注意: 表情现在有"同情绪变体轮换"(pickEmotionVariant), 单跑一次看不出真实覆盖面,
	// 所以每个词都**抽样多次**再统计可达集合。
	const SAMPLES = 200
	const emoHit = new Map()
	let emoFail = 0
	const emoReach = new Set()
	for (const w of PROMPT_EMOTIONS) {
		let any = false
		for (let i = 0; i < SAMPLES; i++) {
			const r = R.resolveMarkerEmotion(w, exprNames)
			if (r) { any = true; emoReach.add(r); emoHit.set(r, [...new Set([...(emoHit.get(r) ?? []), w])]) }
		}
		if (!any) emoFail += 1
	}
	console.log(`\n-- 表情: 提示词 ${PROMPT_EMOTIONS.length} 个词 (每词抽样 ${SAMPLES} 次) --`)
	console.log(`   能映射: ${PROMPT_EMOTIONS.length - emoFail} 个   映射不到(会清空表情): ${emoFail} 个`)
	for (const [name, words] of emoHit) console.log(`     ${words.join("/")}  ->  ${name}`)
	const deadExpr = exprNames.filter(e => !emoReach.has(e))
	console.log(`   永远触达不到的表情 (${deadExpr.length}/${exprNames.length}): ${deadExpr.join(", ") || "无"}`)

	/* ---- 动作 ---- */
	const moHit = new Map()
	let moFail = 0
	for (const w of PROMPT_MOTIONS) {
		const r = R.resolveMarkerMotion(w, motionNames)
		if (r) moHit.set(r, [...(moHit.get(r) ?? []), w])
		else moFail += 1
	}
	console.log(`\n-- 动作: 提示词 ${PROMPT_MOTIONS.length} 个词 --`)
	console.log(`   能映射: ${PROMPT_MOTIONS.length - moFail} 个   映射不到(落到 idle 兜底): ${moFail} 个`)
	for (const [name, words] of moHit) console.log(`     ${words.join("/")}  ->  ${name}`)
	const reachable = new Set([...moHit.keys()])
	const deadMo = motionNames.filter(n => !reachable.has(n))
	console.log(`   永远触达不到的动作 (${deadMo.length}/${motionNames.length}):`)
	for (const g of [...new Set(model.motions.map(m => m.group))]) {
		const inGroup = model.motions.filter(m => m.group === g)
		const dead = inGroup.filter(m => !reachable.has(m.name)).map(m => m.name)
		if (dead.length) console.log(`     [${g}] ${dead.join(", ")}`)
	}

	/* ---- 旧词兼容: 已从提示词移除, 但仍应尽量映射到东西 (或安全落空) ---- */
	const legacy = LEGACY_MOTIONS.map(w => `${w}->${R.resolveMarkerMotion(w, motionNames) ?? "(空)"}`)
	console.log(`\n-- 旧动作词兼容 (已从提示词移除): ${legacy.join("  ")}`)
}

/* ---- 另外: ALIAS/规则里那些"英文动作名"在这个模型上存在吗 ---- */
console.log(`\n================ 规则表与真实模型名的匹配情况 ================`)
const allMotions = new Set()
for (const id of ids) { const m = loadModel(id); if (m) for (const x of m.motions) allMotions.add(x.name.toLowerCase()) }
const PROBE = ["happy", "jump", "wave", "hug", "dance", "pet", "cheer", "cry", "sigh", "smile", "bow", "nod", "shakehead"]
for (const w of PROBE) {
	const hit = [...allMotions].filter(n => n.includes(w) || w.includes(n))
	console.log(`  ${w.padEnd(11)} : ${hit.length ? hit.join(", ") : "★ 两个模型里都没有"}`)
}
