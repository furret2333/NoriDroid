/* 探针: 自动裁剪之后, "保留下来的那 20 条原文" 还有机会被总结吗? (2026-09-27 重构 P5)
 *
 * 背景 (读代码得到的怀疑, 本探针负责证实/证伪):
 *   App.vue 的流程是「先 summarizeIfNeeded, 成功后再裁剪到近端 20 条」, 然后调
 *   notifyHistoryTrimmed(kept.length) 把游标设成"保留条数(含占位符)=21"。
 *   但**保留的这 20 条恰恰是最近的、从没被总结过的** —— 把它标成"已摘要"之后,
 *   下一次总结就从第 21 条往后取, 那 20 条被永久跳过 (最终被下一次裁剪无声删掉)。
 *
 *   今天看不出来, 是因为实时通道每轮都在把话写进长期记忆, 兜住了这 20 条;
 *   P3 把实时通道默认关掉之后, 这个洞就会变成"每轮对话有 20 句永远记不住"。
 *
 * 不变量 (两条, 都是"按时间顺序"的硬要求):
 *   ① **已覆盖的必须是从头开始的连续前缀, 中间不许有洞** —— 原 bug 的签名就是
 *      "覆盖 0~24, 然后跳到 45~69", 中间的 25~44 一条都没进摘要;
 *   ② 没覆盖的那些只能出现在**最右边一段连续的尾巴**里 (= 正在攒的待整理批次),
 *      不许出现"覆盖 → 没覆盖 → 又覆盖"的交错。
 *
 * 运行: cd web-src && node tmp-memcheck/probe-trim-skip.mjs
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

/** 消息时间戳从"当前时间往前"排 —— 与实机一致 (占位符用 Date.now(), 必须是最新的那条) */
const TOTAL_ROUNDS = 6
const PER_ROUND = 25
const BASE = Date.now() - (TOTAL_ROUNDS * PER_ROUND + 10) * 1000
const RAW_WINDOW = 20
/** 模拟模型: 从提示词里读出这批消息的 ts 区间, 用它当条目内容 (事后核对覆盖范围用 blocks) */
const summarizeCall = async (prompt) => {
	const tss = [...prompt.matchAll(/第(\d+)句/g)].map(m => Number(m[1]))
	const lo = Math.min(...tss), hi = Math.max(...tss)
	return `摘要正文。\n===MEM===\n${JSON.stringify({
		topic: "段",
		items: [{content: `覆盖 ${lo}-${hi}`, type: "fact", importance: 0.5}],
	})}`
}

files.clear()
mem.reloadMemory()
/** 消息数组 (与 App.vue 的 messages.value 同构: 裁剪后会插一条占位 system 消息) */
let arr = []
let nextTs = BASE
const push = (n) => {
	for (let i = 0; i < n; i += 1) {
		const real = arr.filter(m => m.role !== "system").length
		arr.push({role: real % 2 ? "assistant" : "user", content: `第${nextTs}句`, ts: nextTs})
		nextTs += 1000
	}
}
/** 复刻 App.vue 的裁剪 (P5 口径: 只裁"已进过摘要的前缀" + 登记被裁条数) */
const trimLikeApp = () => {
	const dropN = mem.safeTrimDrop(arr.length)
	if (dropN <= 0) return false
	const kept = arr.slice(dropN)
	kept.unshift({role: "system", content: "（更早的对话已压缩为历史总结，可在设置→记忆系统查看）", ts: Date.now(), placeholder: true})
	arr = kept
	mem.notifyHistoryTrimmed(dropN)
	return true
}

for (let round = 0; round < TOTAL_ROUNDS; round += 1) {
	push(PER_ROUND)
	await mem.summarizeIfNeeded(arr, summarizeCall)
	await mem.flushMemoryPersist()   // 落盘是 400ms 防抖的, 不 flush 读到的还是旧文件
	trimLikeApp()
}
await mem.flushMemoryPersist()

const ranges = (JSON.parse(files.get("memory.json") || "{}").blocks ?? [])
	.map(b => [b.fromTs, b.toTs])
	.sort((x, y) => x[0] - y[0])
const allTs = []
for (let t = BASE; t < nextTs; t += 1000) allTs.push(t)
const covered = (t) => ranges.some(([lo, hi]) => t >= lo && t <= hi)
const rawStart = arr.length > RAW_WINDOW ? arr[arr.length - RAW_WINDOW].ts : (arr[0]?.ts ?? 0)
const seq = allTs.filter(t => t < rawStart).map(t => (covered(t) ? "C" : "."))

/* 不变量合并成一条: 逐条序列必须是「一串连续覆盖 + 一串连续未覆盖」
   (有洞 = 中间出现覆盖/未覆盖交错; 消息 ts 间隔是 1000, 不能拿 ts 做 +1 判定) */
const shape = seq.join("")
const okShape = /^C*\.*$/.test(shape)
const coveredN = seq.filter(c => c === "C").length

console.log("覆盖区间:", JSON.stringify(ranges.map(([lo, hi]) => `${Math.round((lo - BASE) / 1000)}~${Math.round((hi - BASE) / 1000)}`)))
console.log(`消息总数 ${allTs.length} · 近端窗口起点 +${Math.round((rawStart - BASE) / 1000)} · 已滑出窗口 ${seq.length} 条`)
console.log(`滑出窗口的覆盖形态 (C=已进摘要, .=待整理): ${shape}`)
console.log(`已覆盖 ${coveredN} 条 · 待整理 ${seq.length - coveredN} 条`)
const ok = okShape
console.log(ok
	? "OK: 已进摘要的是一段连续前缀, 没有消息被跳过 (剩下的都在待整理尾巴里, 下次总结会覆盖)"
	: "FAIL: 出现「覆盖 → 空洞 → 又覆盖」= 有消息被永久跳过 (裁剪把没总结过的消息标成了已摘要)")
process.exitCode = ok ? 0 : 1
