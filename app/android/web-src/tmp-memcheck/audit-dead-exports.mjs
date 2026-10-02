/* 审计工具: **死导出 / 多余导出扫描** —— 打包前跑一次。
 *
 * 背景：这个项目已经两次留下"没人用的导出"（`dataseaMinInterval()`、`setBlinkEnabled()`/`blinkEnabled()`），
 * 还有一次是常量（`PET_PRESS_DOWN_RATIO` 在产品代码里零引用、只有门禁在测）。
 * 手工扫一次能发现，但下次还会忘 —— 所以做成脚本。
 *
 * 它把每个 `export` 的符号分成四类，**只有第 1 类该动**：
 *
 *   1. **真死**：本文件内也不用（只有声明那一次），产品与门禁都没引用   → 删
 *   2. **多余导出**：本文件内还在用，只是外面没人 import               → 去掉 `export` 即可（无风险）
 *   3. **测试专用**：产品 0 引用、门禁有引用（`__resetXForTest` 之类）  → 正常，别删
 *   4. 类型 vs 值分开列：`interface/type` 的"没人引用"基本无害（多数是 API 文档），
 *      只列出来看，不当问题
 *
 * 已知局限（如实写）：
 *   - 纯正则解析，不看类型；`export *`、默认导出、SFC 内部导出不在覆盖范围
 *   - 只统计"名字出现过"，同名不同物会算成引用（所以短名会标 [短名?]，请人工确认）
 *   - 动态引用（如字符串拼出的名字）抓不到
 *
 * 运行: cd web-src && node tmp-memcheck/audit-dead-exports.mjs
 * 退出码: 有"真死"值导出 = 1（可当打包前门禁用）
 */
import {readdirSync, readFileSync, statSync} from "node:fs"
import {join, relative} from "node:path"

const root = process.cwd()
const SRC = join(root, "src")
const TESTS = join(root, "tmp-memcheck")

const walk = (dir, out = []) => {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) walk(p, out)
		else out.push(p)
	}
	return out
}

const srcFiles = walk(SRC).filter((f) => f.endsWith(".ts"))
const testFiles = walk(TESTS).filter((f) => f.endsWith(".mjs"))
/* ⚠ 引用语料必须含 **.vue** —— App.vue / FloatApp.vue 才是绝大多数导出的使用者。
   （第一版只扫 .ts，117 条"死代码"几乎全是假阳性：createLive2D、ambientTouch 明明在 .vue 里用着。） */
const refFiles = walk(SRC).filter((f) => f.endsWith(".ts") || f.endsWith(".vue"))

const readAll = (files) => files.map((f) => ({f, text: readFileSync(f, "utf8")}))
const srcTexts = readAll(srcFiles)
const refTexts = readAll(refFiles)
const testTexts = readAll(testFiles)

const EXPORT_RE = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
const TYPE_KINDS = new Set(["interface", "type"])

const countIn = (texts, name, excludeFile) =>
	texts.reduce((acc, {f, text}) => {
		if (excludeFile && f === excludeFile) return acc
		const m = text.match(new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g"))
		return acc + (m ? m.length : 0)
	}, 0)

const rows = []
for (const {f, text} of srcTexts) {
	for (const m of text.matchAll(EXPORT_RE)) {
		const [, kind, name] = m
		const inSelf = countIn([{f, text}], name, null)          // 含声明那一行
		const inSrc = countIn(refTexts, name, f)
		const inTests = countIn(testTexts, name, null)
		rows.push({kind, name, file: relative(root, f).replace(/\\/g, "/"), inSelf, inSrc, inTests, isType: TYPE_KINDS.has(kind)})
	}
}

const onlyDecl = (r) => r.inSelf <= 1
const dead = rows.filter((r) => !r.isType && onlyDecl(r) && r.inSrc === 0 && r.inTests === 0)
const redundant = rows.filter((r) => !r.isType && !onlyDecl(r) && r.inSrc === 0 && r.inTests === 0)
const testOnly = rows.filter((r) => r.inSrc === 0 && r.inTests > 0)
const unusedTypes = rows.filter((r) => r.isType && r.inSrc === 0 && r.inTests === 0)

const line = (r) => `  ${r.name.padEnd(28)} ${r.kind.padEnd(9)} ${r.file}${r.name.length <= 4 ? "   [短名? 人工确认]" : ""}`

console.log(`扫描 ${srcFiles.length} 个源文件（引用语料含 ${refTexts.length - srcFiles.length} 个 .vue）/ ${testFiles.length} 个测试脚本\n`)

console.log(dead.length
	? `=== ① 真死代码：只有声明、哪儿都没用（${dead.length} 个）→ 删 ===`
	: "=== ① 真死代码：无 ✓ ===")
for (const r of dead) console.log(line(r))

console.log(redundant.length
	? `\n=== ② 多余导出：本文件内还在用、外面没人 import（${redundant.length} 个）→ 去掉 export 即可 ===`
	: "\n=== ② 多余导出：无 ✓ ===")
for (const r of redundant) console.log(line(r))

console.log(`\n=== ③ 测试专用：产品 0 引用、门禁有引用（${testOnly.length} 个）→ 正常，别删 ===`)
for (const r of testOnly) console.log(line(r))

if (unusedTypes.length) {
	console.log(`\n=== ④ 类型导出但无人引用（${unusedTypes.length} 个）→ 基本无害，看一眼即可 ===`)
	for (const r of unusedTypes) console.log(line(r))
}

console.log(`\n打包前判据：① 为 0（②③④ 不影响）`)
if (dead.length) process.exitCode = 1
