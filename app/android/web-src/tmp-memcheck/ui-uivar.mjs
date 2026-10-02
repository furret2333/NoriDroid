/* 把像素风的硬编码形状参数替换成 --ui-* 变量, 让 `.ui-soft` 覆盖层能整体切换。
 * 只做**等值替换**(像素风渲染结果不变), 因此可用脚本; 替换前后都跑 e2e-pixel-ui 核对。
 */
import {readFileSync, writeFileSync, copyFileSync, existsSync} from "node:fs"

const P = "src/App.vue"
const BAK = "tmp-memcheck/.App.vue.before-uivar"
if (!existsSync(BAK)) copyFileSync(P, BAK)
let src = readFileSync(P, "utf8")

const scriptEnd = src.indexOf("</script>")
const styleStart = src.indexOf("<style", scriptEnd)
if (scriptEnd < 0 || styleStart < 0) throw new Error("段落定位失败")
const head = src.slice(0, styleStart)
let style = src.slice(styleStart)

// 只替换 style 段; <script> 段里不允许出现这些串 (出现说明我定位错了)
const inScript = src.slice(src.indexOf("<script setup"), scriptEnd)
for (const bad of ["inset 2px 2px 0 0 var(--px-hilite)", "border-radius: 0;"]) {
	if (inScript.includes(bad)) throw new Error(`script 段里出现 ${bad}, 拒绝执行`)
}

const MAP = [
	// 圆角: 面板 / 卡片 / 控件 / 胶囊
	["border-top-left-radius: 0;\n\tborder-top-right-radius: 0;", "border-top-left-radius: var(--ui-radius-panel);\n\tborder-top-right-radius: var(--ui-radius-panel);"],
	["border-radius: 0;", "border-radius: var(--ui-radius-ctl);"],
	// 描边
	["border: 2px solid var(--px-stroke);", "border: var(--ui-line-w) solid var(--ui-line-c);"],
	["border: 2px solid var(--px-line);", "border: var(--ui-line-w) solid var(--ui-line-c-soft);"],
	["border-top: 2px solid var(--px-stroke);", "border-top: var(--ui-line-w) solid var(--ui-line-c);"],
	["border-top: 2px solid var(--px-line);", "border-top: var(--ui-line-w) solid var(--ui-line-c-soft);"],
	["border-bottom: 2px solid var(--px-line);", "border-bottom: var(--ui-line-w) solid var(--ui-line-c-soft);"],
	// 凸起/凹陷
	[
		"box-shadow: inset 2px 2px 0 0 var(--px-hilite), inset -2px -2px 0 0 var(--px-void), 0 4px 0 0 var(--px-void);",
		"box-shadow: inset 2px 2px 0 0 var(--ui-hi), inset -2px -2px 0 0 var(--ui-lo), 0 var(--ui-lift) 0 0 var(--ui-lo), var(--ui-shadow);",
	],
	[
		"box-shadow: inset -2px -2px 0 0 var(--px-hilite), inset 2px 2px 0 0 var(--px-void), 0 2px 0 0 var(--px-void);",
		"box-shadow: var(--ui-press), 0 calc(var(--ui-lift) / 2) 0 0 var(--ui-lo);",
	],
	[
		"box-shadow: inset 2px 2px 0 0 var(--px-hilite), inset -2px -2px 0 0 var(--px-void);",
		"box-shadow: inset 2px 2px 0 0 var(--ui-hi), inset -2px -2px 0 0 var(--ui-lo), var(--ui-shadow);",
	],
	["box-shadow: inset -2px -2px 0 0 var(--px-hilite), inset 2px 2px 0 0 var(--px-void);", "box-shadow: var(--ui-press);"],
	["box-shadow: inset 1px 1px 0 0 var(--px-hilite);", "box-shadow: inset 1px 1px 0 0 var(--ui-hi);"],
	["box-shadow: inset -2px -2px 0 0 var(--px-void), inset 2px 2px 0 0 var(--px-hilite);", "box-shadow: inset -2px -2px 0 0 var(--ui-lo), inset 2px 2px 0 0 var(--ui-hi), var(--ui-shadow);"],
	["box-shadow: inset 2px 2px 0 0 var(--px-void), inset -2px -2px 0 0 var(--px-hilite);", "box-shadow: var(--ui-press);"],
	["box-shadow: inset 0 2px 0 0 var(--px-panel-2), 0 -6px 0 0 rgba(5, 8, 17, 0.55);", "box-shadow: inset 0 2px 0 0 var(--px-panel-2), 0 -6px 0 0 rgba(5, 8, 17, 0.55), var(--ui-shadow);"],
]

let total = 0
for (const [from, to] of MAP) {
	const n = style.split(from).length - 1
	if (n) { style = style.split(from).join(to); total += n; console.log(`  ${String(n).padStart(2)} × ${from.slice(0, 62).replace(/\n\t/g, " ")}…`) }
}
writeFileSync(P, head + style)
console.log(`\n共替换 ${total} 处; 备份: ${BAK}`)
