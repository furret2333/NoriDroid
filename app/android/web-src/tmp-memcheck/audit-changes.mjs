/* 改动清单审计 (可重复运行): 对比 1.1.27 基线 与 当前源码, 列出本会话累积改动。
   用途: 回答"之前改的现在怎么办 / 会不会有更多 bug" —— 先看清改动面, 再逐项核对覆盖。
   用法: node tmp-memcheck/audit-changes.mjs
   注意: 基线路径写死为 backups/summaries-20260916-230643 (1.1.27 状态)。
        若该备份被清理, 改 BASE 指向其它同期备份。 */
import {readFileSync, existsSync} from "node:fs"

const BASE = "D:/norios/backups/summaries-20260916-230643"
const CUR = "D:/norios/noriVerZcode/DeepEr-main/app/android/web-src"

/** [标签, 基线文件, 当前文件] —— 只列本会话真正改过的文件 */
const pairs = [
	["memory/core.ts", `${BASE}/core.ts`, `${CUR}/src/services/memory/core.ts`],
	["memory/index.ts", `${BASE}/index.ts`, `${CUR}/src/services/memory/index.ts`],
]

let totalRemoved = 0
let totalAdded = 0
for (const [label, a, b] of pairs) {
	if (!existsSync(a)) { console.log(`${label}: 基线缺失 (${a})`); continue }
	if (!existsSync(b)) { console.log(`${label}: 当前文件缺失`); continue }
	const la = readFileSync(a, "utf8").split("\n")
	const lb = readFileSync(b, "utf8").split("\n")
	const setA = new Set(la.map(s => s.trim()).filter(Boolean))
	const setB = new Set(lb.map(s => s.trim()).filter(Boolean))
	const removed = [...setA].filter(s => !setB.has(s))
	const added = [...setB].filter(s => !setA.has(s))
	totalRemoved += removed.length
	totalAdded += added.length
	console.log(`\n===== ${label} =====`)
	console.log(`  ${la.length} 行 -> ${lb.length} 行 (${lb.length - la.length >= 0 ? "+" : ""}${lb.length - la.length})`)
	console.log(`  删除/替换 ${removed.length} 行, 新增/替换 ${added.length} 行`)
	if (removed.length) {
		console.log("  --- 基线有、现在没有 (这些是被删掉的行为, 需确认是否有意) ---")
		for (const s of removed) console.log(`    - ${s.slice(0, 140)}`)
	}
}

console.log("\n===== 汇总 =====")
console.log(`记忆侧共 删除/替换 ${totalRemoved} 行, 新增/替换 ${totalAdded} 行`)
console.log("另改过 (不在本脚本对比范围, 详见 backups/ 各期 说明.txt):")
console.log("  src/services/chat/index.ts  —— 落盘归并 / 占位符去重 / 写失败重试 / 流空闲看门狗")
console.log("  src/App.vue                 —— 番茄钟静音 / 统计扩展 / 面板透明 / 输入框样式 / 摘要游标通知")
console.log("  src/float/BubbleApp.vue     —— 同上 (悬浮窗侧)")
console.log("  services/nori-diary.ts, habit.ts, live2d/modelStore.ts, pomo-stats.ts(新)")
