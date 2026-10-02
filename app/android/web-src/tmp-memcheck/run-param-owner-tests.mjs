/**
 * **参数通道归属**门禁 —— 这个项目栽过一次，所以留一条常驻的守卫。
 *
 * ## 事故回顾（为什么需要它）
 * 摸头"低头"的第一版往 `ParamAngleY` / `ParamEyeBallY` 上叠偏移，而库**每帧**也在写这两个
 * （`dragY*30` / `dragY`，值域正好占满参数量程）⇒ 效果随手指位置被抵消、量程边缘被夹掉。
 * 当时没人问过一句"**这个参数现在归谁**"。
 *
 * ## 它做两件事
 * 1. **具体断言**：`blink.ts` 写的参数必须不在"库占用"名单里。
 * 2. **通用守卫（静态扫描）**：把 `src/` 里**任何**对"库占用参数"的引用扫出来；
 *    每一处都必须登记在 `ALLOWED` 里并写明理由（例如"调试探针只读对照"）。
 *    ⇒ 以后谁再往 `ParamAngleX/Y/Z` / `ParamEyeBall*` 上写东西，**这里当场红**，
 *      逼他解释清楚，而不是等到实机上发现"功能时灵时不灵"。
 *
 * 名单来源：源码取证 `D:\norios\tmp-webarch-audit\scan-lib-writes.mjs`
 *          + 动态实测 `tmp-memcheck/probe-param-owner.mjs`（空闲/交互两轮采样）。
 *
 * 运行: cd web-src && node tmp-memcheck/run-param-owner-tests.mjs
 */
import {readdirSync, readFileSync, statSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path, {join} from "node:path"

const root = path.resolve(import.meta.dirname, "..")

let pass = 0
let fail = 0
const check = (name, cond, detail = "") => {
	if (cond) { pass += 1; console.log(`PASS  ${name}`) }
	else { fail += 1; console.log(`FAIL  ${name}  ← ${detail}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}, 期望 ${JSON.stringify(want)}`)

/**
 * **库每帧写的参数**（它自己拥有这些通道）：
 * - 压缩源码里 6 条 `addParameterValueById(_idParam…)`：AngleX/Y/Z、BodyAngleX、EyeBallX/Y
 * - 模型 `Groups.LipSync.Ids` 填了 `ParamMouthOpenY` ⇒ 说话时由库的 lipsync 写
 * - `ParamEyeBallShrink*` 三个是**探针动态发现、静态扫描漏掉**的（交互采样摆幅 0.18~0.26）
 */
const LIBRARY_OWNED = [
	"ParamAngleX", "ParamAngleY", "ParamAngleZ",
	"ParamBodyAngleX",
	"ParamEyeBallX", "ParamEyeBallY",
	"ParamMouthOpenY",
	"ParamEyeBallShrinkL", "ParamEyeBallShrink1L7", "ParamEyeBallShrink1L8",
].sort()

/** 允许在 src 里出现的"库占用参数"引用（每一处都要写理由） */
const ALLOWED = [
	{name: "ParamAngleY", why: "App.vue 的 __noriPetDebug 只读对照（readParam 读回注视通道）", where: "App.vue" },
	/* 崩溃报告快照：把"库此刻写进去的值"一并带进导出物，方便回传定位（**只读**，走 __noriParamInfo） */
	{name: "ParamAngleX", why: "崩溃报告只读快照（__noriParamInfo）", where: "services/diag/index.ts" },
	{name: "ParamAngleY", why: "崩溃报告只读快照（__noriParamInfo）", where: "services/diag/index.ts" },
	{name: "ParamMouthOpenY", why: "崩溃报告只读快照（__noriParamInfo）", where: "services/diag/index.ts" },
]

/* ---------------- 1. 具体断言: 我们写的通道不能是库占用的 ---------------- */
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)
const blinkOut = path.join(root, "tmp-memcheck/blink-forowner-bundle.mjs")
await build({
	entryPoints: [path.join(root, "src/services/live2d/blink.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent", outfile: blinkOut,
})
const {BLINK_PARAMS} = await import(pathToFileURL(blinkOut).href)

{
	check("库占用名单非空且格式正常", LIBRARY_OWNED.length >= 6 && LIBRARY_OWNED.every((n) => n.startsWith("Param")), JSON.stringify(LIBRARY_OWNED))
	for (const id of LIBRARY_OWNED) {
		check(`眨眼不写库占用的通道: ${id}`, !BLINK_PARAMS.includes(id), JSON.stringify([...BLINK_PARAMS]))
	}
	// 回归守卫：明确点名当年踩过的那两个
	check("回归守卫: 眨眼不写 ParamAngleY", !BLINK_PARAMS.includes("ParamAngleY"), JSON.stringify([...BLINK_PARAMS]))
	check("回归守卫: 眨眼不写 ParamEyeBallY", !BLINK_PARAMS.includes("ParamEyeBallY"), JSON.stringify([...BLINK_PARAMS]))
	check("眨眼写的是模型真实存在的两个参数", [...BLINK_PARAMS].join(",") === "ParamEyeLOpen,ParamEyeROpen", JSON.stringify([...BLINK_PARAMS]))
}

/* ---------------- 2. 通用守卫: 静态扫描 src 里所有"库占用参数"的引用 ---------------- */
{
	const walk = (dir, out = []) => {
		for (const n of readdirSync(dir)) {
			const p = join(dir, n)
			if (statSync(p).isDirectory()) walk(p, out)
			else if (/\.(ts|vue)$/.test(p)) out.push(p)
		}
		return out
	}
	/** 粗略去注释: 跳过以 * 或 // 开头的行（够用: 本项目的注释都规规矩矩） */
	const codeLines = (text) => text.split("\n").map((l, i) => ({l, i: i + 1}))
		.filter(({l}) => { const t = l.trim(); return t && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") })

	const hits = []
	for (const file of walk(path.join(root, "src"))) {
		const rel = path.relative(root, file).replace(/\\/g, "/")
		for (const {l, i} of codeLines(readFileSync(file, "utf8"))) {
			for (const name of LIBRARY_OWNED) {
				if (l.includes(name)) hits.push({file: rel, line: i, name, text: l.trim().slice(0, 110)})
			}
		}
	}
	const allowed = (h) => ALLOWED.some((a) => a.name === h.name && h.file.endsWith(a.where))
	const bad = hits.filter((h) => !allowed(h))
	const unusedAllow = ALLOWED.filter((a) => !hits.some((h) => h.name === a.name && h.file.endsWith(a.where)))

	console.log(`\n静态扫描: src 里出现"库占用参数"共 ${hits.length} 处（白名单 ${ALLOWED.length} 条）`)
	for (const h of hits) console.log(`   ${allowed(h) ? "· 已登记" : "⚠ 未登记"}  ${h.file}:${h.line}  ${h.name}  |  ${h.text}`)
	check("src 里对库占用参数的引用**全部**已登记理由", bad.length === 0,
		bad.map((h) => `${h.file}:${h.line} ${h.name}`).join(" / "))
	check("白名单没有过期条目", unusedAllow.length === 0, unusedAllow.map((a) => a.name).join(" / "))
	/* ⚠ 原先这条写的是 `!hits.some(h => !allowed(h))` —— 与上一条**完全同一个条件**，
	   只是名字叫"没有出现在写入路径上"，名不副实（永远不会单独红，也就没有额外守护力）。
	   现在改成它名字真正声称的事：扫描到的那些行里**不许出现写入 API**。 */
	const WRITE_CALL = /(setParam|addParam|__noriSetParam|__noriAddParam)\s*\(/
	const writeHits = hits.filter((h) => WRITE_CALL.test(h.text))
	check("库占用参数没有出现在写入路径上（只允许只读对照）", writeHits.length === 0,
		writeHits.map((h) => `${h.file}:${h.line} | ${h.text}`).join(" / "))
}

/* ---------------- 3. 名单与工具的一致性 ---------------- */
{
	const probe = readFileSync(path.join(root, "tmp-memcheck/probe-param-owner.mjs"), "utf8")
	const missing = LIBRARY_OWNED.filter((n) => !probe.includes(n))
	// 探针里的 LIBRARY_WRITTEN 只是"已知"子集（其余靠动态采样发现），所以只要求那几个显式写的不漏
	const mustBeListed = ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamEyeBallX", "ParamEyeBallY"]
	const missingMust = mustBeListed.filter((n) => !probe.includes(n))
	check("探针里列出了库的 6 条显式写入", missingMust.length === 0, missingMust.join(" / "))
	if (missing.length) console.log(`   （探针未逐字列出的: ${missing.join(" ")} —— 它们靠动态采样发现，属正常）`)
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exitCode = 1
