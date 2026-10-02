/* 查证探针: 上下文窗口多长? 自动整理到底什么时候触发? (2026-09-28 回答用户疑问)
 *
 * 用户疑问: "45 条之内的 nori 都能看到、只不过只显示最近 25 条? 出了 45 条后自动整理一次吗?"
 *
 * 本探针逐条推进消息, 在**每一步**都检查两件事 (都不靠推理, 直接跑源码):
 *   ① 上下文原文窗口有多长 (contextHistory 返回几条);
 *   ② 哪一条消息触发了自动整理 (summarizeIfNeeded 返回 true 时的总数/待整理数);
 *   ③ 【不变量】每条消息要么已被摘要覆盖、要么还在上下文窗口里 —— 不允许"两边都不在"(空窗)。
 *
 * 三种情形都跑: A 首次(从未裁剪) / B 裁剪开启(与 App.vue 同规则) / C 关闭"自动裁剪"。
 *
 * 运行: cd web-src && node tmp-memcheck/probe-organize-cadence.mjs
 */
await import("./build-mem-bundles.mjs")
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {
	NoriChat: {
		readFile: (n) => files.get(n) ?? "",
		writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
	},
}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)

let clock = Date.now() - 10_000_000
const summarizeCall = async (prompt) => {
	const tss = [...prompt.matchAll(/第(\d+)句/g)].map(m => Number(m[1]))
	return `摘要正文。\n===MEM===\n${JSON.stringify({topic: "段",
		items: [{content: `覆盖 ${Math.min(...tss)}-${Math.max(...tss)}`, type: "fact", importance: 0.5}]})}`
}

/**
 * 跑一轮: 逐条推消息, 记录每次触发整理时的状态
 * @param trim 是否复刻 App.vue 的自动裁剪
 */
const run = async (label, trim, maxMsgs) => {
	files.clear()
	mem.reloadMemory()
	let arr = []
	let next = 0
	const triggers = []
	const holes = []
	for (let i = 0; i < maxMsgs; i += 1) {
		const real = arr.filter(m => m.role !== "system").length
		arr.push({role: real % 2 ? "assistant" : "user", content: `第${next}句`, ts: clock++})
		next += 1
		const before = mem.organizeProgress(arr)
		const did = await mem.summarizeIfNeeded(arr, summarizeCall)
		if (did) {
			await mem.flushMemoryPersist()
			const disk = JSON.parse(files.get("memory.json") || "{}")
			triggers.push({
				msgNo: next,                    // 触发时已产生的消息条数
				arrayLen: arr.length,           // 触发时数组长度 (含占位符)
				pendingBefore: before.pending,  // 触发前"待整理"条数
				batches: (disk.blocks ?? []).length,
				lastRange: (disk.blocks ?? []).slice(-1)[0]?.toTs,
			})
			if (trim) {
				const dropN = mem.safeTrimDrop(arr.length)
				if (dropN > 0) {
					arr = [{role: "system", content: "（更早的对话已压缩为历史总结）", ts: clock++, placeholder: true}, ...arr.slice(dropN)]
					mem.notifyHistoryTrimmed(dropN)
					await mem.flushMemoryPersist()
				}
			}
		}
		/* 不变量: 每条消息要么被摘要覆盖, 要么在上下文窗口里 */
		const disk = JSON.parse(files.get("memory.json") || "{}")
		const ranges = (disk.blocks ?? []).map(b => [b.fromTs, b.toTs])
		const ctx = mem.contextHistory(arr)
		const ctxTs = new Set(ctx.map(m => m.ts))
		for (const m of arr) {
			if (ctxTs.has(m.ts)) continue
			if (ranges.some(([lo, hi]) => m.ts >= lo && m.ts <= hi)) continue
			if (m.role === "system") continue   // 占位符不是真消息
			holes.push({msgNo: next, content: m.content})
		}
	}
	console.log(`\n===== ${label} =====`)
	console.log(`  上下文窗口长度 (contextHistory): ${mem.contextHistory(arr).length} 条 · 当前数组 ${arr.length} 条`)
	console.log(`  自动整理触发点 (已产生消息数 → 触发前待整理数 → 累计块数):`)
	for (const t of triggers.slice(0, 6)) {
		console.log(`    第 ${t.msgNo} 条消息时触发 (数组 ${t.arrayLen} 条, 触发前待整理 ${t.pendingBefore}, 累计块 ${t.batches})`)
	}
	if (triggers.length > 6) console.log(`    … 共 ${triggers.length} 次`)
	const gaps = triggers.slice(1).map((t, i) => t.msgNo - triggers[i].msgNo)
	console.log(`  相邻两次触发间隔 (条消息): ${gaps.join(", ") || "(只触发过一次)"}`)
	console.log(`  【不变量】两边都不在的消息 (空窗): ${holes.length === 0 ? "0 条 ✓" : JSON.stringify(holes.slice(0, 5))}`)
	return {triggers, holes, ctxLen: mem.contextHistory(arr).length, arrayLen: arr.length}
}

const A = await run("A. 首次 (从未裁剪过)", false, 50)
const B = await run("B. 开自动裁剪 (与 App.vue 同规则)", true, 80)
const C = await run("C. 关自动裁剪 (只累计不裁剪)", false, 80)

let bad = 0
const check = (name, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ← ${detail}`}`)
	if (!cond) bad += 1
}
console.log("\n===== 断言 =====")
check("A: 从未裁剪时, 第 45 条消息触发第一次整理 (待整理 25)",
	A.triggers[0]?.msgNo === 45 && A.triggers[0]?.pendingBefore === 25,
	JSON.stringify(A.triggers[0]))
check("B: 裁剪后是'再攒 25 条'触发 (第 45 条首发, 之后间隔 25)",
	B.triggers[0]?.msgNo === 45 && B.triggers.slice(1).every((t, i) => t.msgNo - B.triggers[i].msgNo === 25),
	JSON.stringify(B.triggers.map(t => t.msgNo)))
check("C: 关裁剪时也是每 25 条触发一次",
	C.triggers.every((t, i) => i === 0 ? t.msgNo === 45 : t.msgNo - C.triggers[i - 1].msgNo === 25),
	JSON.stringify(C.triggers.map(t => t.msgNo)))
check("上下文窗口 = min(数组长度, 45) —— 上限 45, 数组更短时就全发",
	A.ctxLen === Math.min(A.arrayLen, 45) && B.ctxLen === Math.min(B.arrayLen, 45) && C.ctxLen === Math.min(C.arrayLen, 45) &&
	A.ctxLen === 45 && C.ctxLen === 45,
	`A=${A.ctxLen}/${A.arrayLen} B=${B.ctxLen}/${B.arrayLen} C=${C.ctxLen}/${C.arrayLen}`)
check("三种情形都**没有空窗** (messages 要么在窗口、要么已进摘要)",
	A.holes.length === 0 && B.holes.length === 0 && C.holes.length === 0,
	`A=${A.holes.length} B=${B.holes.length} C=${C.holes.length}`)
console.log(bad ? `\n${bad} 项未通过` : "\n全部通过")
process.exitCode = bad ? 1 : 0
