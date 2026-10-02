// 相对亮度 (WCAG) + 对比度, 用来判断"太亮"到底亮在哪
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const lum = (hex) => { const n = hex.replace('#',''); const r = parseInt(n.slice(0,2),16), g = parseInt(n.slice(2,4),16), b = parseInt(n.slice(4,6),16); return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b) }
const ratio = (a, b) => { const L1 = Math.max(lum(a), lum(b)), L2 = Math.min(lum(a), lum(b)); return (L1 + 0.05) / (L2 + 0.05) }
const void_ = '#050811', panel = '#0d1b33'
const rows = [
  ['现状 --px-cyan', '#67e8f9'], ['现状 --px-hilite', '#d6fbff'], ['现状 --px-white', '#f8fafc'],
  ['现状 --px-cyan-mid', '#22d3ee'], ['现状 --px-panel-2', '#142648'],
  ['收敛后 accent', '#4fb8cc'], ['收敛后 hilite', '#7fd4e6'], ['收敛后 text', '#e6f1f7'],
  ['收敛后 accent-strong(CTA only)', '#67e8f9'], ['收敛后 panel-2(抬升)', '#183055'],
]
console.log('色值            亮度    对比(底 #050811)  对比(面板 #0d1b33)')
for (const [name, hex] of rows) {
  console.log(`${name.padEnd(30)} ${lum(hex).toFixed(3)}   ${ratio(hex, void_).toFixed(1).padStart(5)}:1        ${ratio(hex, panel).toFixed(1).padStart(5)}:1`)
}
console.log('')
console.log('参考: WCAG AA 正文 >=4.5:1, 大字 >=3:1。超过 ~12:1 在深色底上就偏刺眼了。')
