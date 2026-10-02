/* UI token 化 (只替换颜色字面量, 不动模板与逻辑)。
 * 安全措施: ①先备份 App.vue; ②替换前报告每个值在 <script> 段内出现几次 (非 0 就拒绝执行,
 * 因为那可能是 canvas 绘图用的颜色常量, 换成 var() 会直接坏掉)。
 */
import {readFileSync, writeFileSync, copyFileSync, existsSync} from "node:fs"

const P = "src/App.vue"
const BAK = "tmp-memcheck/.App.vue.before-tokenize"
if (!existsSync(BAK)) copyFileSync(P, BAK)
let src = readFileSync(P, "utf8")

const scriptStart = src.indexOf("<script setup")
const scriptEnd = src.indexOf("</script>", scriptStart)
if (scriptStart < 0 || scriptEnd < 0) throw new Error("找不到 <script setup> 段")
const inScript = src.slice(scriptStart, scriptEnd)
const styleStart = src.indexOf("<style", scriptEnd)
console.log(`段落定位: script ${scriptStart}~${scriptEnd} · style 从 ${styleStart} 开始`)
const inStyle = src.slice(styleStart)

const VALUES = [
	// 边框: 6 个近似透明度 → 3 个语义档
	["rgba(148, 163, 184, 0.25)", "var(--line-strong)"],
	["rgba(148, 163, 184, 0.22)", "var(--line-strong)"],
	["rgba(148, 163, 184, 0.2)", "var(--line)"],
	["rgba(148, 163, 184, 0.18)", "var(--line)"],
	["rgba(148, 163, 184, 0.16)", "var(--line-soft)"],
	["rgba(148, 163, 184, 0.14)", "var(--line-soft)"],
	["rgba(148, 163, 184, 0.12)", "var(--line-soft)"],
	// 高频文字/底色
	["#e2e8f0", "var(--fg)"],
	["#cbd5e1", "var(--fg-2)"],
	["#94a3b8", "var(--fg-3)"],
	["#64748b", "var(--fg-dim)"],
	["#7dd3fc", "var(--accent)"],
	["#38bdf8", "var(--accent-strong)"],
]

// ① 先体检: script 段里不能有这些字面量
let blocked = 0
for (const [from] of VALUES) {
	const n = inScript.split(from).length - 1
	if (n > 0) { console.log(`⛔ 脚本段里出现 ${n} 次 ${from} —— 拒绝替换, 请人工确认用途`); blocked += 1 }
}
if (blocked) { console.log("\n未做任何修改。"); process.exit(1) }

// ② 替换并统计
const counts = {}
for (const [from, to] of VALUES) {
	counts[from] = src.split(from).length - 1
	src = src.split(from).join(to)
}
writeFileSync(P, src)
console.log("已替换 (次数 → token):")
for (const [from, to] of VALUES) console.log(`  ${String(counts[from]).padStart(3)}  ${from}  →  ${to}`)
console.log(`\n备份: ${BAK}`)
