/* 属性测试: summariesOverlap 的重叠判定是否既不过宽也不过窄
   关键不变量:
   ① 自反: 任何合法区间与自己重叠
   ② 对称: overlap(a,b) === overlap(b,a)
   ③ 【误删防线】正常相邻两批 (游标接着上次末端) 必须**不**重叠
   ④ 【漏判防线】同一段被错位几条 (双实例场景) 必须重叠
   ⑤ 零重叠区间绝不判重叠
*/
import path from "node:path"
import {pathToFileURL} from "node:url"
const root = path.resolve(import.meta.dirname, "..")
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)
const {summariesOverlap: ov} = core

let cases = 0
const bad = []
const check = (name, cond, d) => { cases += 1; if (!cond) bad.push(`${name} ${d}`) }

const W = 25   // 正常一批覆盖 25 条消息
const mk = (s, len = W) => ({start: s, end: s + len - 1})

// ① 自反
for (let s = 0; s < 500; s += 37) check("自反", ov(mk(s), mk(s)), `s=${s}`)
// ② 对称
for (let a = 0; a < 300; a += 29) {
	for (let b = 0; b < 300; b += 31) {
		check("对称", ov(mk(a), mk(b)) === ov(mk(b), mk(a)), `a=${a} b=${b}`)
	}
}
// ③ 正常相邻两批: 起点相差 25 (游标接着上次末端) → 必须不重叠
for (let s = 0; s < 400; s += 23) {
	check("相邻不重叠", ov(mk(s), mk(s + W)) === false, `s=${s}`)
}
// ④ 错位 1..5 条 (双实例) → 必须重叠
for (let s = 0; s < 300; s += 17) {
	for (let d = 1; d <= 5; d += 1) {
		check("错位判重叠", ov(mk(s), mk(s + d)) === true, `s=${s} d=${d}`)
	}
}
// ⑤ 明确零重叠
for (let s = 0; s < 300; s += 19) {
	check("零重叠不判", ov(mk(s), mk(s + W + 1)) === false, `s=${s}`)
	check("零重叠不判2", ov(mk(s), mk(s + 50)) === false, `s=${s}`)
}
// ⑥ 边界: 重叠刚好一半
check("刚好一半算重叠", ov({start: 0, end: 100}, {start: 50, end: 150}) === true)
check("差一条不到一半不算", ov({start: 0, end: 100}, {start: 52, end: 152}) === false,
	`overlap=${101 - 52}`)
// ⑦ 极端: 长度差异很大
check("大包含小", ov({start: 0, end: 1000}, {start: 500, end: 510}) === true)
check("小被大包含", ov({start: 500, end: 510}, {start: 0, end: 1000}) === true)

console.log(`用例 ${cases}, 失败 ${bad.length}`)
if (bad.length) {
	// 归类展示
	const byKind = {}
	for (const b of bad) { const k = b.split(" ")[0]; byKind[k] = (byKind[k] || 0) + 1 }
	console.log("按类型:", JSON.stringify(byKind))
	for (const b of bad.slice(0, 12)) console.log("  ✗ " + b)
} else {
	console.log("✓ 重叠判定全部不变量通过 (不误删正常成对、不漏判错位同段)")
}
