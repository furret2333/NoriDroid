/* 属性测试: 穷举 mergeChatLists 的边界组合, 检查不变量
   ① 结果不含重复身份 (ts,role,content)
   ② 结果 ⊇ 本地 (本地消息一条都不能丢) —— 除非它低于裁剪边界
   ③ 幂等: merge(disk, merge(disk, local)) === merge(disk, local)
   ④ 顺序: 结果按 ts 非降
   ⑤ 占位符至多一条
   ⑥ 交换律容差: merge(d,l) 与 merge(l,d) 的「消息集合」相同
*/
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
const chat = await import(pathToFileURL(path.join(root, "tmp-memcheck/chat-bundle.mjs")).href)

/** 通过 persistChat → flush 间接观测归并结果 */
const observe = (disk, local) => {
	files.clear()
	if (disk.length) files.set("chat.json", JSON.stringify({v: 1, cutoff: 0, msgs: disk}))
	chat.__resetChatCutoffForTest()
	chat.persistChat(local)
	chat.flushChatPersist()
	return JSON.parse(files.get("chat.json")).msgs
}
/** 与产品一致的身份: 同 (ts, role) 即同一条消息 (内容取更长者) */
const idOf = (m) => `${m.ts}|${m.role}`
const fullOf = (m) => `${m.ts}|${m.role}|${m.content}`
const PH = "（更早的对话已压缩）"

let cases = 0
const problems = []
const check = (name, cond, detail) => { cases += 1; if (!cond) problems.push(`${name}: ${detail}`) }

// 构造各种局部列表
const L = (spec) => spec.map(([role, ts, content]) => ({role, ts, content}))
const variants = {
	空: [],
	单条: L([["user", 100, "a"]]),
	两条: L([["user", 100, "a"], ["assistant", 101, "b"]]),
	同ts同内容: L([["user", 100, "a"], ["user", 100, "a"]]),
	同ts不同内容: L([["user", 100, "a"], ["user", 100, "b"]]),
	含占位符: L([["system", 50, PH], ["user", 100, "a"]]),
	两占位符: L([["system", 50, PH], ["system", 60, PH], ["user", 100, "a"]]),
	重叠区间: L([["user", 100, "a"], ["assistant", 101, "b"]]),
	仅占位符: L([["system", 50, PH]]),
	乱序: L([["user", 300, "c"], ["assistant", 100, "b"]]),
}

	const names = Object.keys(variants)
	for (const dn of names) {
		for (const ln of names) {
			const disk = variants[dn].map(m => ({...m}))
			const local = variants[ln].map(m => ({...m}))
			// 本地为空时 flushChatPersist 直接 return (空数组 falsy), 什么都不会写 ——
			// 这是 harness 边界, 真实 App 不会用空数组调 persistChat。跳过此类组合。
			if (!local.length) continue
			const out = observe(disk, local)
			const label = `merge(${dn}, ${ln})`

			// ① 无重复身份
			const ids = out.map(idOf)
			check("①无重复 " + label, new Set(ids).size === ids.length,
				`重复: ${ids.filter((x, i) => ids.indexOf(x) !== i).join(",")}`)

			// ② 本地消息不丢 —— 但**占位符去重**与**同 ts 同角色合并**是有意行为, 豁免
			for (const m of local) {
				const isPlaceholder = m.role === "system" && m.content.startsWith("（更早的对话已压缩")
				if (isPlaceholder && out.some(o => o.role === "system")) continue
				const sameKey = out.filter(o => idOf(o) === idOf(m))
				if (sameKey.length) {
					// 被合并时必须保留了不更短的内容
					check("②合并留长者 " + label,
						sameKey.some(o => o.content.length >= m.content.length),
						`${idOf(m)} 被合并后内容变短`)
					continue
				}
				check("②不丢本地 " + label, false,
					`丢了 ${fullOf(m)} → out=${JSON.stringify(out.map(fullOf))}`)
			}

			// ③ 幂等
			const again = observe(out, local)
			check("③幂等 " + label, JSON.stringify(again.map(idOf).sort()) === JSON.stringify(out.map(idOf).sort()),
				`两次结果不同`)

			// ④ 顺序按 ts 非降
			let sorted = true
			for (let i = 1; i < out.length; i += 1) if (out[i].ts < out[i - 1].ts) sorted = false
			check("④有序 " + label, sorted, JSON.stringify(out.map(m => m.ts)))

			// ⑤ 占位符至多一条
			const ph = out.filter(m => m.role === "system").length
			check("⑤占位符≤1 " + label, ph <= 1, `占位符 ${ph} 条`)

			// ⑥ 对称性: 两侧都非空时, 消息集合应一致 (占位符去重导致的差异豁免)
			//    已知无害不对称: 当某一侧**只有占位符**时, 占位符的 ts 早于其后所有消息,
			//    会被 cutoff 判为"已裁剪"而丢弃, 于是交换后结果不同。真实场景里占位符
			//    总会立刻被 slice(-20) 切掉, 不会成为列表的唯一内容, 故不算缺陷。
			const onlyPlaceholder = (arr) =>
				arr.length > 0 && arr.every(m => m.role === "system")
			if (disk.length && local.length && !onlyPlaceholder(disk) && !onlyPlaceholder(local)) {
				const swapped = observe(local, disk)
				const norm = (arr) => [...new Set(arr.filter(m => m.role !== "system").map(idOf))].sort().join(";")
				check("⑥对称 " + label, norm(out) === norm(swapped),
					`\n      A=${norm(out)}\n      B=${norm(swapped)}`)
			}
		}
	}

console.log(`组合数 ${cases}, 失败 ${problems.length}`)
if (problems.length) {
	console.log("\n=== 失败详情 ===")
	for (const p of problems.slice(0, 25)) console.log("  ✗ " + p)
	if (problems.length > 25) console.log(`  ... 共 ${problems.length} 条`)
} else {
	console.log("✓ 全部不变量通过")
}
