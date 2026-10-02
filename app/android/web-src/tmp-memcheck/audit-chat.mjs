/* 数据丢失审计 (可重复运行, 非一次性脚本):
   反复 落盘→重载 下, 真实消息绝不能减少; 顺序必须保持 ts 升序。
   场景 A 只增长不裁剪 / B 反复裁剪 / C 合法重复内容 / D 仅占位符。
   依赖 chat-bundle-for-tests.mjs —— 它只由 run-tests.mjs 重建, 改了 chat 源码
   要先跑 run-tests.mjs 再跑本脚本, 否则测的是旧代码。 */
import path from "node:path"
import {pathToFileURL} from "node:url"
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {
	NoriChat: {
		readFile: (n) => files.get(n) ?? "",
		writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
	},
}
const chat = await import(pathToFileURL(path.join(root, "tmp-memcheck/chat-bundle-for-tests.mjs")).href)
const PH = "（更早的对话已压缩为历史总结，可在设置→记忆系统查看）"
const mk = (role, content, ts) => ({role, content, ts})
const realCount = (a) => a.filter(m => m.role !== "system").length
const phCount = (a) => a.filter(m => m.role === "system").length

files.clear()
let clock = 1_700_000_000_000
let messages = []
let worst = 0
let problems = []

/* 场景 A: 正常增长, 不裁剪 (用户说"以前总结正常"的那种用法) */
for (let round = 0; round < 60; round += 1) {
	messages.push(mk("user", `A-u${round}`, clock++))
	messages.push(mk("assistant", `A-a${round}`, clock++))
	chat.persistChat(messages)
	chat.flushChatPersist()
	const before = realCount(messages)
	messages = chat.loadChat()
	const after = realCount(messages)
	if (after < before) problems.push(`场景A 第${round}轮: 真实消息 ${before} → ${after}`)
	// 顺序检查
	for (let i = 1; i < messages.length; i += 1) {
		if (messages[i].ts < messages[i - 1].ts) { problems.push(`场景A 第${round}轮: ts 顺序错乱 @${i}`); break }
	}
}
console.log(`场景A (只增长不裁剪): 最终内存 ${messages.length} 条 (真实 ${realCount(messages)}, 占位 ${phCount(messages)})`)
console.log(`  磁盘 ${JSON.parse(files.get("chat.json")).msgs.length} 条`)

/* 场景 B: 反复裁剪 20 轮, 真实消息应稳定在 20, 占位符 1 */
files.clear()
clock = 1_700_000_000_000
messages = []
for (let round = 0; round < 20; round += 1) {
	for (let i = 0; i < 45; i += 1) messages.push(mk(i % 2 ? "assistant" : "user", `B${round}-${i}`, clock++))
	const kept = messages.slice(-20)
	kept.unshift({role: "system", content: PH, ts: Date.now(), placeholder: true})
	const firstReal = kept.find(m => m.role !== "system")
	if (firstReal) chat.setChatTrimCutoff(firstReal.ts)
	messages = kept
	chat.persistChat(messages)
	chat.flushChatPersist()
	messages = chat.loadChat()
	const disk = JSON.parse(files.get("chat.json")).msgs
	if (phCount(disk) !== 1) problems.push(`场景B 第${round}轮: 磁盘占位符 ${phCount(disk)}`)
	if (realCount(disk) !== 20) problems.push(`场景B 第${round}轮: 磁盘真实消息 ${realCount(disk)}`)
	if (disk.length > 21) problems.push(`场景B 第${round}轮: 磁盘总数 ${disk.length}`)
}
console.log(`场景B (反复裁剪20轮): 磁盘 ${JSON.parse(files.get("chat.json")).msgs.length} 条 = 真实 ${realCount(JSON.parse(files.get("chat.json")).msgs)} + 占位 ${phCount(JSON.parse(files.get("chat.json")).msgs)}`)

/* 场景 C: 合法重复内容必须全部保留 (不同 ts) */
files.clear()
chat.persistChat([
	mk("user", "好的", 1000), mk("assistant", "嗯嗯", 1001),
	mk("user", "好的", 1002), mk("assistant", "嗯嗯", 1003),
	mk("user", "好的", 1004),
])
chat.flushChatPersist()
const c = JSON.parse(files.get("chat.json")).msgs
console.log(`场景C (合法重复): 磁盘 ${c.length} 条, "好的"×${c.filter(m => m.content === "好的").length}, "嗯嗯"×${c.filter(m => m.content === "嗯嗯").length}`)
if (c.filter(m => m.content === "好的").length !== 3) problems.push("场景C: 合法重复的\"好的\"被吞")
if (c.filter(m => m.content === "嗯嗯").length !== 2) problems.push("场景C: 合法重复的\"嗯嗯\"被吞")

/* 场景 D: 只发占位符 (无真实消息) 时落盘 */
files.clear()
chat.persistChat([{role: "system", content: PH, ts: 1, placeholder: true}])
chat.flushChatPersist()
const d = JSON.parse(files.get("chat.json")).msgs
console.log(`场景D (仅占位符): 磁盘 ${d.length} 条`)
if (d.length > 1) problems.push(`场景D: 占位符未收敛 (${d.length})`)

/* 场景 E: App 全生命周期 (push→persist→flush→loadChat→裁剪) —— 踩过坑的路径。
   旧 mergeChatLists 在此场景**每轮翻倍** (21+22→43→85→167…), 界面表现为
   "发过的消息反复重复"。注意必须先复位裁剪边界: 场景 B 会留下高 cutoff,
   把所有消息都过滤掉从而掩盖 bug (实测正是这个把 T11 假装变绿)。 */
{
	files.clear()
	chat.__resetChatCutoffForTest()
	let clock = 1_700_000_000_000
	const tick = () => (clock += 7)
	let messages = chat.loadChat()
	const dupGroups = (arr) => {
		const c = {}
		for (const m of arr.filter(x => x.role !== "system")) c[m.role + "|" + m.content] = (c[m.role + "|" + m.content] || 0) + 1
		return Object.values(c).filter(n => n > 1).length
	}
	let maxTimes = 1
	for (let round = 0; round < 40; round += 1) {
		messages.push(mk("user", `E问题${round}`, tick()))
		chat.persistChat(messages)
		const live = mk("assistant", "", tick())
		messages.push(live)
		live.content += `E回答${round}`
		chat.persistChat(messages)
		chat.flushChatPersist()
		messages = chat.loadChat()
		if (round % 12 === 11 && messages.length > 20) {
			const kept = messages.slice(-20)
			kept.unshift({role: "system", content: PH, ts: tick(), placeholder: true})
			const fr = kept.find(m => m.role !== "system")
			if (fr) chat.setChatTrimCutoff(fr.ts)
			messages = kept
			chat.persistChat(messages)
			chat.flushChatPersist()
			messages = chat.loadChat()
		}
		const times = {}
		for (const m of messages.filter(x => x.role !== "system")) {
			const k = m.role + "|" + m.content
			times[k] = (times[k] || 0) + 1
		}
		const mx = Math.max(1, ...Object.values(times))
		if (mx > maxTimes) maxTimes = mx
	}
	const dm = JSON.parse(files.get("chat.json")).msgs
	console.log(`场景E (App 全生命周期 40 轮): 内存 ${messages.length} 条, 磁盘 ${dm.length} 条, 最大重复次数 ${maxTimes}`)
	if (maxTimes > 2) problems.push(`场景E: 消息被重复 ${maxTimes} 次 (归并翻倍 bug)`)
	if (dm.length > 60) problems.push(`场景E: 磁盘消息数爆炸 (${dm.length})`)
	if (dupGroups(dm)) problems.push(`场景E: 磁盘有 ${dupGroups(dm)} 组重复消息`)
}

console.log("\n=== 结论 ===")
console.log(problems.length ? `发现 ${problems.length} 个问题:\n  ` + problems.slice(0, 10).join("\n  ") : "✓ 未发现数据丢失 / 顺序错乱 / 重复累积")
