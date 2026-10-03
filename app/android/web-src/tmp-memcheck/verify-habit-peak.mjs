/**
 * B1 回归测试: habitProfile().peakHour 必须落在真实高峰时段。
 *
 * 修前症状: `prob.indexOf(max)` —— prob 是归一化数组 (元素 ≤1), max 是原始计数,
 * 除峰值恰好为 1 外恒返回 -1 ⇒ peakHour = floor(-30/60) = -1 ⇒ habitLateToday 判据
 * 变成 "首条记录晚于 00:30 就算迟到" ⇒ ambient 几乎每天都播"今天来得比平时晚呢…"。
 *
 * 本测试直接把 habit.ts 打成 bundle, 用确定性数据 (峰值在 20:00) 断言:
 *   ① peakHour == 20        (修前为 -1)
 *   ② habitLateToday() 在同日 21:30 首条记录时必须为 false (修前为 true)
 *   ③ 真正的迟到 (首条 23:00 而高峰 20:00) 仍必须为 true (不能把 bug 修成永远 false)
 * 顺带覆盖 ④ 冷启动 (<3 天) 必须返回 null。
 */
import {readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"
import os from "node:os"
import assert from "node:assert"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

let bad = 0
let total = 0
/** 生成的临时 bundle: 跑完删掉, 不在仓库里留未跟踪文件 (写到 os.tmpdir() 也一样删) */
const tmpFiles = []
const check = (ok, label, extra = "") => {
	total += 1
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`)
	if (!ok) bad += 1
}

// habit.ts 内部 import 的是 "./chat" 的 readFile/writeFile (走原生桥, node 里没有)。
// 做法: 每次打一个 bundle, 把待测的档案 JSON **内联**进 chat 桩 —— 每个 case 独立模块实例,
// 也就绕开了 habit.ts 里的模块级 cache。
async function buildWith(storeJson) {
	const plugin = {
		name: "stub-chat-inline",
		setup(b) {
			b.onResolve({filter: /^\.\/chat$/}, () => ({path: "stub-chat", namespace: "stub"}))
			b.onLoad({filter: /.*/, namespace: "stub"}, () => ({
				contents: `
					const FILES = ${JSON.stringify({["habit-profile.json"]: storeJson})}
					export const readFile = (name) => FILES[name] ?? ""
					export const writeFile = (name, content) => { FILES[name] = content; return true }
				`,
				loader: "js",
			}))
		},
	}
	const o = await build({
		entryPoints: [path.join(root, "src/services/habit.ts")],
		bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent",
		plugins: [plugin], absWorkingDir: root,
	})
	const f = path.join(os.tmpdir(), `nori-habit-peak-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
	writeFileSync(f, o.outputFiles[0].text)
	tmpFiles.push(f)
	return import(pathToFileURL(f).href)
}

const DAY = 24 * 3600 * 1000
/** 生成 n 天的记录; 每天 hour:min 处一条 (本地时间) */
function makeStore(days, hour, min) {
	const now = new Date()
	const daysObj = {}
	for (let i = 1; i <= days; i++) {
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, hour, min, 0, 0)
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
		daysObj[key] = [{t: d.getTime(), kind: "open"}]
	}
	return JSON.stringify({days: daysObj, updated: Date.now()})
}

// ---- ① 峰值 20:00, 14 天数据 ----
{
	const m = await buildWith(makeStore(14, 20, 0))
	const p = m.habitProfile()
	check(p !== null, "① habitProfile 有档案 (14 天数据)" )
	check(p && p.peakHour === 20, "① peakHour == 20 (修前 = -1)", `实际=${p && p.peakHour}`)
}

// ---- ② 高峰 20:00, 今天首条 21:30 → 距高峰 90 分钟, 边界不算迟到 (>90 才是) ----
{
	const now = new Date()
	const store = JSON.parse(makeStore(14, 20, 0))
	const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
	const first = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 21, 30, 0, 0)
	store.days[todayKey] = [{t: first.getTime(), kind: "open"}]
	const m = await buildWith(JSON.stringify(store))
	check(m.habitLateToday() === false, "② 首条 21:30 / 高峰 20:00 → 不判迟到 (修前误判 true)")
}

// ---- ③ 真迟到: 首条 23:00, 高峰 20:00 → 差 180 分钟 > 90, 必须 true ----
{
	const now = new Date()
	const store = JSON.parse(makeStore(14, 20, 0))
	const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
	const first = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 0, 0, 0)
	store.days[todayKey] = [{t: first.getTime(), kind: "open"}]
	const m = await buildWith(JSON.stringify(store))
	check(m.habitLateToday() === true, "③ 首条 23:00 / 高峰 20:00 → 仍判迟到 (修复不能修成永远 false)")
}

// ---- ④ 冷启动: 2 天数据 → null ----
{
	const m = await buildWith(makeStore(2, 20, 0))
	check(m.habitProfile() === null, "④ 不足 3 天 → 返回 null (冷启动回退)")
}

// ---- ⑤ 峰值桶必须是**原始计数**的最大值所在桶: 双峰 (09:00 多、21:00 少) ----
{
	const now = new Date()
	const daysObj = {}
	for (let i = 1; i <= 10; i++) {
		const d9 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 9, 0, 0, 0)
		const d21 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 21, 0, 0, 0)
		const key = `${d9.getFullYear()}-${String(d9.getMonth() + 1).padStart(2, "0")}-${String(d9.getDate()).padStart(2, "0")}`
		// 09:00 三条, 21:00 一条 → 高峰应为 9 点
		daysObj[key] = [
			{t: d9.getTime(), kind: "open"},
			{t: d9.getTime() + 1000, kind: "touch"},
			{t: d9.getTime() + 2000, kind: "touch"},
			{t: d21.getTime(), kind: "open"},
		]
	}
	const m = await buildWith(JSON.stringify({days: daysObj, updated: Date.now()}))
	const p = m.habitProfile()
	check(p && p.peakHour === 9, "⑤ 双峰数据 → peakHour == 9 (最高计数桶)", `实际=${p && p.peakHour}`)
}

for (const f of tmpFiles) { try { unlinkSync(f) } catch { /* 忽略 */ } }

console.log(bad ? `\n${bad} 项未通过` : "\n全部通过: B1 高峰时段修复验证")
// 统一给 run-all-gates.mjs 读的计数行 (它 tail 里找 "N/N passed")
console.log(`${total - bad}/${total} passed`)
process.exitCode = bad ? 1 : 0
