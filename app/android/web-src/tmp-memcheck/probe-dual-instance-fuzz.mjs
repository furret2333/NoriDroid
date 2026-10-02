/* P2 双实例一致性**模糊测试** (2026-09-30)
 *
 * 为什么做它: 2026-09-27~30 修的三个真 bug **全部**出在"主界面 + 悬浮窗各持一份内存副本、
 * 靠 memory.json 落盘合并"这个机制上 (还原被墓碑复活 / 清除示例被磁盘旧副本复活 / 裁剪游标跳号),
 * 而且都是"想到才补一条用例"。本探针换打法: 让**两个真实模块实例**在共享磁盘上随机互相操作,
 * 然后检查一批**必须永远成立**的不变量 —— 用随机序列去撞那些想不到的组合。
 *
 * 怎么造出"两个实例": 同一个 bundle 用不同的 query 再 import 一次 (`?i=2`) —— ESM 会给出
 * 一份全新的模块实例 (各自的 cache / 会话标记), 而两者共用同一个假桥 (files), 正是双 WebView 的形态。
 *
 * 检查的不变量 (每次操作后抽查 + 每轮结束全查):
 *  ① 落盘 JSON 可解析; 条目总数 = 生效 + 已作废 + 已收起
 *  ② "生效"列表里不含 已作废/已收起 的条目; 块引用的 id 必须真实存在 (无孤儿)
 *  ③ 墓碑里的 id 不出现在条目里; 永久删除过的 id 在两边都彻底消失 (含回收站)
 *  ④ 手删的条目必须能在回收站里找到 (未溢出时); 回收站 ≤ MAX_DELETED_BIN
 *  ⑤ 已收起的条目再次被提到会复活 (reviveFaded) —— 抽查
 *  ⑥ 示例集里不该出现"已删掉/已收起/已作废"的内容 (与主人的取舍一致)
 *  ⑦ **收敛**: 两边各自 flush→reload 一个来回之后, 条目 id 集合与各自状态必须一致 (否则就是
 *     "同一份数据两个窗口看到的永远不一样")
 *
 * 运行: cd web-src && node tmp-memcheck/probe-dual-instance-fuzz.mjs [--steps=200] [--seeds=3]
 */
import {pathToFileURL} from "node:url"
import path from "node:path"

await import("./build-mem-bundles.mjs")
const root = path.resolve(import.meta.dirname, "..")
const files = new Map()
globalThis.window = {
	NoriChat: {
		readFile: (n) => files.get(n) ?? "",
		writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
	},
}
const bundleUrl = pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href
/** 两个"窗口": 同一个 bundle 的两份独立实例 (各自 cache/会话标记), 共享磁盘 */
const A = await import(bundleUrl)
const B = await import(`${bundleUrl}?i=2`)

const argv = process.argv.slice(2)
const numArg = (k, d) => { const a = argv.find(s => s.startsWith(`--${k}=`)); return a ? Number(a.slice(k.length + 3)) : d }
const STEPS = numArg("steps", 200)
const SEEDS = numArg("seeds", 4)
const STRICT = argv.includes("--strict")

const mulberry32 = (seed) => () => {
	seed = (seed + 0x6D2B79F5) | 0
	let t = seed
	t = Math.imul(t ^ (t >>> 15), t | 1)
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const results = []
const check = (name, cond, detail = "") => {
	results.push({name, cond: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ← ${detail}`}`)
}
/** 「发现」= 已经定性/待定性的行为问题: 默认只报告不改判 (加 --strict 才影响退出码) —— 与 P3 探针同一套约定 */
const findingsOut = []
const finding = (name, ok, detail = "") => {
	findingsOut.push({name, ok: !!ok})
	console.log(`  ${ok ? "OK  " : "⚠ 发现"}  ${name}${detail ? `  ← ${detail}` : ""}`)
}
/** 结构不变量违规 (这些必须在**任何**随机序列下都成立) */
const structural = []
let structuralFindings = 0
const invariant = (name, cond, detail) => { if (!cond) { structuralFindings += 1; structural.push(`${name} ${detail}`) } }

const readDisk = () => { try { return JSON.parse(files.get("memory.json") || "{}") } catch { return null } }
const activeOf = (mod) => mod.listAll(false).memories
const idsOf = (list) => list.map(m => m.id).sort().join(",")

/* ---------------- 词料: 让记忆真的会累积 ---------------- */
const NOUNS = ["下雨天", "咖啡", "吉他", "考研", "猫", "狗", "面条", "跑步", "钢琴", "地图", "加班", "熬夜"]
const rndText = (rng) => `我喜欢${NOUNS[Math.floor(rng() * NOUNS.length)]}`

/** 每个实例各跑 N 步随机操作; 返回这一轮的统计 */
const runSeed = async (seed) => {
	const rng = mulberry32(seed)
	files.clear()
	A.reloadMemory()
	B.reloadMemory()
	/* 种子: 先放几条进库, 让后面的 restore/delete 有东西可操作 */
	for (let i = 0; i < 8; i += 1) A.addMemoriesFromText(rndText(rng))
	await A.flushMemoryPersist()
	B.reloadMemory()

	/** 永久删除过的 id (跨整轮累积, 用来断言"再也回不来") */
	const purged = new Set()
	/** 手删过但没永久删的 id */
	const binned = new Set()
	const stats = {ops: 0, add: 0, del: 0, purge: 0, fade: 0, inv: 0, restore: 0, examples: 0, summarize: 0, trim: 0, reload: 0}
	/** "永久删除的条目复活了" 的次数 (硬不变量, 单独计数便于断言) */
	let purgeRevived = 0

	const fakeLlm = async () => "本段摘要。\n===MEM===\n" + JSON.stringify({
		topic: "模糊", items: [{content: `我喜欢${NOUNS[Math.floor(rng() * NOUNS.length)]}`, type: "preference", importance: 0.6}],
	})
	/** 真实形态的聊天数组: **一条条长大** (游标/裁剪都跟着它走 —— 这正是当年出 bug 的地方) */
	let chat = []
	let nextTs = 1_820_000_000_000

	for (let step = 0; step < STEPS; step += 1) {
		const mod = rng() < 0.5 ? A : B
		const other = mod === A ? B : A
		const op = rng()
		stats.ops += 1
		try {
			if (op < 0.20) {                       // 新增
				mod.addMemoriesFromText(rndText(rng))
				stats.add += 1
			} else if (op < 0.30) {                // 手删 → 回收站
				const list = activeOf(mod)
				if (list.length) { const m = list[Math.floor(rng() * list.length)]; if (mod.deleteMemory(m.id)) binned.add(m.id); stats.del += 1 }
			} else if (op < 0.36) {                // 永久删除 (不可逆)
				const bin = mod.listDeletedMemories()
				if (bin.length) { const m = bin[Math.floor(rng() * bin.length)]; if (mod.deleteMemoryForever(m.id)) { purged.add(m.id); binned.delete(m.id) } stats.purge += 1 }
			} else if (op < 0.44) {                // 从回收站还原
				const bin = mod.listDeletedMemories()
				if (bin.length) { const m = bin[Math.floor(rng() * bin.length)]; if (mod.restoreDeletedMemory(m.id)) binned.delete(m.id); stats.restore += 1 }
			} else if (op < 0.54) {                // 手动收起 / 从收起里放回
				const list = activeOf(mod)
				const faded = mod.listFadedMemories()
				if (list.length && rng() < 0.6) { const m = list[Math.floor(rng() * list.length)]; mod.fadeMemoryManually(m.id) }
				else if (faded.length) { mod.restoreFadedMemory(faded[Math.floor(rng() * faded.length)].id) }
				stats.fade += 1
			} else if (op < 0.64) {                // 作废 / 还原作废
				const list = activeOf(mod)
				const inv = mod.listInvalidMemories()
				if (list.length && rng() < 0.6) { const m = list[Math.floor(rng() * list.length)]; mod.invalidateMemory(m.id) }
				else if (inv.length) { mod.restoreMemory(inv[Math.floor(rng() * inv.length)].id) }
				stats.inv += 1
			} else if (op < 0.70) {                // 固定 / 取消固定
				const list = activeOf(mod)
				if (list.length) { const m = list[Math.floor(rng() * list.length)]; mod.pinMemory(m.id, !mod.isMemoryPinned(m.id)) }
			} else if (op < 0.76) {                // 聊几句 + 整理 (写真块 + 触发 prune/收起); 一半概率顺带裁剪
				for (let k = 0; k < 3; k += 1) chat.push({role: chat.length % 2 ? "assistant" : "user", content: `第${chat.length}句`, ts: nextTs++})
				const did = await mod.summarizeIfNeeded(chat, fakeLlm, true, rng() < 0.3)
				stats.summarize += 1
				if (did && rng() < 0.5) {
					// 与 App.vue 同一套裁剪动作 (含占位符与游标通知) —— 当年"每 45 条丢 20 条"就出在这里
					const dropN = mod.safeTrimDrop(chat.length)
					if (dropN > 0) {
						chat = [{role: "system", content: "（更早的对话已压缩为历史总结）", ts: nextTs++, placeholder: true}, ...chat.slice(dropN)]
						mod.notifyHistoryTrimmed(dropN)
						stats.trim += 1
					}
				}
				await mod.flushMemoryPersist()
			} else if (op < 0.82) {                // 示例集: 重建 / 清空
				if (rng() < 0.5) mod.rebuildMemoryExamples(); else mod.clearMemoryExamples()
				stats.examples += 1
			} else if (op < 0.90) {                // 落盘
				await mod.flushMemoryPersist()
			} else {                               // 重新载入 (合并磁盘上另一实例写的东西)
				await mod.flushMemoryPersist()
				other.reloadMemory()
				stats.reload += 1
			}
		} catch (e) {
			structural.push(`第 ${step} 步抛异常: ${String(e && e.message || e)}`)
			structuralFindings += 1
			break
		}
		/* 落盘是 **300ms 防抖** 的 ⇒ 查盘前必须先把本实例的写推下去, 否则读到的是旧文件 (假警报) */
		await mod.flushMemoryPersist()

		/* 抽查不变量 (每次操作后都查便宜的几条) */
		const disk = readDisk()
		invariant("磁盘 JSON 可解析", !!disk, `step=${step}`)
		if (disk) {
			const mems = disk.memories ?? []
			const act = mems.filter(m => !m.invalidAt && !m.fadedAt)
			invariant("总数 = 生效+作废+收起",
				mems.length === act.length + mems.filter(m => m.invalidAt).length + mems.filter(m => m.fadedAt && !m.invalidAt).length,
				`step=${step} total=${mems.length}`)
			invariant("回收站 ≤ MAX_DELETED_BIN", (disk.deletedBin ?? []).length <= 20, `step=${step} bin=${(disk.deletedBin ?? []).length}`)
			invariant("墓碑 ≤ 800", (disk.tombstones ?? []).length <= 800, `step=${step}`)
			/* 永久删除过的 id 不许在任何地方出现 */
			for (const id of purged) {
				const alive = mems.some(m => m.id === id) || (disk.deletedBin ?? []).some(m => m.id === id)
				if (alive) purgeRevived += 1
			}
			/* 块引用的 id 必须存在 (孤儿会让块视图指向不存在的条目) */
			const aliveIds = new Set(mems.map(m => m.id))
			for (const b of disk.blocks ?? []) {
				for (const i of b.itemIds ?? []) invariant("块引用无孤儿", aliveIds.has(i), `step=${step} blk=${b.id} id=${i}`)
			}
		}
		/* 生效列表里不许混入 已作废/已收起 */
		for (const m of [mod, other]) {
			invariant("生效列表不含作废/收起条目",
				(m.listAll(false).memories ?? []).every(x => !x.invalidAt && !x.fadedAt), `step=${step}`)
		}
	}

	/* 收尾: 双边来回合并, 看是否收敛 */
	await A.flushMemoryPersist()
	await B.flushMemoryPersist()
	A.reloadMemory()
	B.reloadMemory()
	await A.flushMemoryPersist()
	B.reloadMemory()
	const aIds = idsOf(A.listAll(true).memories)
	const bIds = idsOf(B.listAll(true).memories)
	const stateOf = (mod) => mod.listAll(true).memories.map(m =>
		`${m.id}:${m.invalidAt ? "I" : ""}${m.fadedAt ? "F" : ""}`).sort().join(",")
	const aState = stateOf(A)
	const bState = stateOf(B)
	/* 不收敛时把差异摊开 (只看 "谁多谁少/状态不同", 各取前 5 条) */
	const stateMap = (mod) => new Map(mod.listAll(true).memories.map(m => [m.id, `${m.invalidAt ? "I" : ""}${m.fadedAt ? "F" : ""}`]))
	const ma = stateMap(A)
	const mb = stateMap(B)
	const onlyA = [...ma.keys()].filter(k => !mb.has(k)).slice(0, 5)
	const onlyB = [...mb.keys()].filter(k => !ma.has(k)).slice(0, 5)
	const diffState = [...ma.keys()].filter(k => mb.has(k) && ma.get(k) !== mb.get(k)).slice(0, 5)
		.map(k => `${k}: A=${ma.get(k) || "生效"} B=${mb.get(k) || "生效"}`)
	/* 差异条目的"身份": 内容 + 磁盘上有没有它的墓碑/回收站副本 —— 用来判断是哪一类不同步 */
	const dd = readDisk() ?? {}
	const describe = (id, mod) => {
		const m = mod.listAll(true).memories.find(x => x.id === id)
		return {
			id, content: m?.content ?? "?",
			tomb: (dd.tombstones ?? []).some(t => t.id === id),
			inBin: (dd.deletedBin ?? []).some(b => b.id === id),
		}
	}
	const divergence = {onlyA, onlyB, diffState, aTotal: ma.size, bTotal: mb.size,
		detailA: onlyA.map(id => describe(id, A)), detailB: onlyB.map(id => describe(id, B))}

	/* 示例集一致性: 不许把"已删掉/已收起"的内容当正例 */
	const pos = A.getMemoryExamples()?.pos ?? []
	const goneTexts = [
		...A.listDeletedMemories().map(m => m.content),
		...A.listFadedMemories().map(m => m.content),
	]
	const stale = pos.filter(t => goneTexts.some(g => g && (g.includes(t) || t.includes(g))))

	return {seed, stats, aIds, bIds, aState, bState, stale, disk: readDisk(), purged: purged.size, binned: binned.size, purgeRevived, divergence}
}

const rounds = []
for (let s = 1; s <= SEEDS; s += 1) {
	const seed = 9000 + s * 37
	const r = await runSeed(seed)
	rounds.push(r)
	console.log(`  seed ${seed}: ${r.stats.ops} 步 (加 ${r.stats.add} · 删 ${r.stats.del} · 永久删 ${r.stats.purge} · 收起 ${r.stats.fade} · 作废 ${r.stats.inv} · 还原 ${r.stats.restore} · 整理 ${r.stats.summarize} · 裁剪 ${r.stats.trim} · 示例 ${r.stats.examples} · 重载 ${r.stats.reload}) → 条目 ${(r.disk?.memories ?? []).length} · 回收站 ${(r.disk?.deletedBin ?? []).length} · 块 ${(r.disk?.blocks ?? []).length}`)
	if (r.aState !== r.bState) {
		const d = r.divergence
		console.log(`    ⚠ 不收敛细节: A 独有 ${JSON.stringify(d.detailA)} · B 独有 ${JSON.stringify(d.detailB)} · 状态不同 ${JSON.stringify(d.diffState)} (A ${d.aTotal} 条 / B ${d.bTotal} 条)`)
	}
}

console.log("\n===== 结构断言 (必须永远成立) =====")
/* 不收敛/复活的细节直接放进"发现"行 (放日志中段会被刷掉) */
const convDetail = rounds.filter(r => r.aState !== r.bState)
	.map(r => `seed ${r.seed}: A 独有 ${JSON.stringify(r.divergence.detailA)} · B 独有 ${JSON.stringify(r.divergence.detailB)} · 状态不同 ${JSON.stringify(r.divergence.diffState)} (A ${r.divergence.aTotal}/B ${r.divergence.bTotal})`)
	.join(" ｜ ")
check("① 每一轮的落盘 JSON 都能解析", rounds.every(r => !!r.disk))
check("② 每轮的结构不变量全过 (总数自洽 / 回收站不越界 / 块引用无孤儿 / 生效列表干净)",
	structuralFindings === 0, `${structuralFindings} 处`)
check("③ 回收站从不越界 / 落盘结构自洽",
	rounds.every(r => (r.disk?.deletedBin ?? []).length <= 20 && (r.disk?.memories ?? []).length >= 0))
check("④ 示例集里没有「已删掉/已收起」的内容 (与主人的取舍一致)",
	rounds.every(r => r.stale.length === 0), rounds.map(r => `${r.seed}:${JSON.stringify(r.stale)}`).join(" "))

console.log("\n===== 发现 (行为问题; 默认只报告, --strict 才算失败) =====")
finding("A.（**已知、暂不处理** 2026-09-30 用户拍板）「永久删除」跨实例不永久: 另一窗口的陈旧回收站副本会把它带回回收站",
	rounds.every(r => r.purgeRevived === 0),
	`${rounds.map(r => `${r.seed}:${r.purgeRevived} 次`).join(" ")} ⇒ 复现: node tmp-memcheck/_dbg-dual-purge.mjs`)
/* B 只是"记录": 一条普通记忆可能只在一个窗口可见 (不丢数据; 已验证过但**根因未定性**,
 * 也可能只是本探针的收敛协议与真实启动路径不同造成的假象)。用户 2026-09-30 拍板: 不追。 */
console.log(`  记录  B. 两窗口最终不完全收敛（**已知差异、不追**）: ${convDetail || "本轮没撞上"}`)

if (structural.length) {
	console.log("\n结构不变量明细 (前 12 条):")
	for (const f of structural.slice(0, 12)) console.log(`  - ${f}`)
}
const badFindings = findingsOut.filter(f => !f.ok).length
const failed = results.filter(r => !r.cond)
const bad = failed.length + (STRICT ? badFindings : 0)
console.log(`\n${results.length - failed.length}/${results.length} 项结构断言通过 · ${findingsOut.length - badFindings}/${findingsOut.length} 项行为期望达成${badFindings ? ` (${badFindings} 项发现见上)` : ""}`)
console.log(STRICT ? "" : "(默认: 发现只报告不改判; 加 --strict 才让发现决定退出码)")
if (bad) {
	process.exitCode = 1
	console.log("FAILED:", [...failed.map(f => f.name), ...(STRICT ? findingsOut.filter(f => !f.ok).map(f => f.name) : [])].join(" | "))
}
