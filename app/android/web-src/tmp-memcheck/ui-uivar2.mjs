/* 第二轮: 把**其余**圆角也收敛到 --ui-radius-* ——
 * 像素风下全部变 0 (与已改的组件一致), 柔和风下按档位统一 (12/10/8/pill)。
 * 之前只改了 .sheet/.btn/.fab/.mini/.chip 等, 结果像素风"抠了一半": .mc/.diary-cal/.bubble
 * 这些还是圆角 —— 所以像素风看起来才那么怪(又硬又软混杂)。 */
import {readFileSync, writeFileSync} from "node:fs"
const P = "src/App.vue"
let src = readFileSync(P, "utf8")
const scriptEnd = src.indexOf("</script>")
const styleStart = src.indexOf("<style", scriptEnd)
if (styleStart < 0) throw new Error("style 段定位失败")
const head = src.slice(0, styleStart)
let style = src.slice(styleStart)

// 数值 → 语义档: 16/14 → 卡片, 12/10 → 控件, 8/6/4 → 小件, 999 → 胶囊
const R = [
	["border-radius: 16px", "border-radius: var(--ui-radius-card)"],
	["border-radius: 14px", "border-radius: var(--ui-radius-card)"],
	["border-radius: 12px", "border-radius: var(--ui-radius-ctl)"],
	["border-radius: 10px", "border-radius: var(--ui-radius-ctl)"],
	["border-radius: 9px", "border-radius: var(--ui-radius-ctl)"],
	["border-radius: 8px", "border-radius: var(--ui-radius-card)"],
	["border-radius: 6px", "border-radius: var(--ui-radius-ctl)"],
	["border-radius: 4px", "border-radius: var(--ui-radius-ctl)"],
	["border-radius: 999px", "border-radius: var(--ui-radius-pill)"],
]
let n = 0
for (const [from, to] of R) {
	const c = style.split(from).length - 1
	if (c) { style = style.split(from).join(to); n += c; console.log(`  ${String(c).padStart(2)} × ${from} → ${to}`) }
}
writeFileSync(P, head + style)
console.log(`\n共 ${n} 处`)
