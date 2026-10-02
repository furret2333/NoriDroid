/**
 * 记忆系统行为测试 (Node 直测, 不需要 App)
 *
 * 用 esbuild 把 services/memory/index.ts 与 core.ts 各打成单文件 bundle,
 * 用假 window.NoriChat 桥 (内存 Map 当文件系统) 在 Node 里跑断言.
 * 覆盖 2026-09-11 修复轮: H1/H2/M1/M4/M7/M8/M9/M11 + Q4 防御 + mergeMemories noChange.
 *
 * 运行: cd web-src && node tmp-memcheck/run-tests.mjs
 */
import {readFileSync, readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

// esbuild 没被提升 (pnpm 严格布局), 从 .pnpm 目录里动态解析
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild, 请先 pnpm install")
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)

/** 让 esbuild 认识 vite 的 `?raw` 导入 (chat/index.ts 引了 nori-prompt.md?raw) */
const rawPlugin = {
	name: "raw",
	setup(b) {
		b.onResolve({filter: /\?raw$/}, (args) => ({path: args.path, namespace: "raw-file"}))
		b.onLoad({filter: /./, namespace: "raw-file"}, (args) => {
			const rel = args.path.replace(/\?raw$/, "").replace(/^\.\//, "")
			const base = path.dirname(args.importer || path.join(root, "src/services/chat/index.ts"))
			return {loader: "text", contents: readFileSync(path.resolve(base, rel), "utf8")}
		})
	},
}

await build({
	entryPoints: [path.join(root, "src/services/memory/index.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/memory-bundle.mjs"),
	plugins: [rawPlugin],
})
await build({
	entryPoints: [path.join(root, "src/services/memory/core.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/core-bundle.mjs"),
})
await build({
	entryPoints: [path.join(root, "src/services/nori-diary.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/diary-bundle.mjs"),
	plugins: [rawPlugin],
	external: [],
})
await build({
	entryPoints: [path.join(root, "src/services/chat/index.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/chat-bundle-for-tests.mjs"),
	plugins: [rawPlugin],
})
await build({
	entryPoints: [path.join(root, "src/services/live2d/modelStore.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/modelstore-bundle.mjs"),
})
await build({
	entryPoints: [path.join(root, "src/services/pomo-stats.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/pomostats-bundle.mjs"),
})
// 渲染帧率上限: 与库解耦的纯逻辑, 供 test-framecap.mjs 用模拟时钟验证
await build({
	entryPoints: [path.join(root, "src/services/live2d/frameCap.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/framecap-bundle.mjs"),
})
// 一键克隆的答题门 (2026-10-01): 判卷规则是纯函数, 必须能单测"容忍标点空格但不许差不多就对"
await build({
	entryPoints: [path.join(root, "src/services/tts/clone-gate.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/clone-gate-bundle.mjs"),
})
// 背景音乐 (2026-10-02 用户报「已下载过、重启又显示下载按钮」): "已下载"必须以**磁盘状态**为准,
// 用假 NoriChat 桥 (bgmStatus/bgmDownload) 就能在 Node 里把这条判据钉死
await build({
	entryPoints: [path.join(root, "src/services/bgm.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/bgm-bundle.mjs"),
})

/* ---------------- 假桥: 内存 Map 当文件系统 ---------------- */
const files = new Map()
let writeCount = 0
/** 定向写失败开关 (用于验证"写盘失败"分支): null = 全部成功; 否则仅该文件名失败 */
let failWriteFor = null
let failWriteRaw = "err:disk-full"
/** 构造 NoriChat 假桥 (T19 会把 window 整个换成 NoriBridge, 之后必须能装回来) */
const makeNoriChatBridge = () => ({
	readFile: (name) => files.get(name) ?? "",
	writeFile: (name, content) => {
		writeCount += 1
		if (failWriteFor && name === failWriteFor) return failWriteRaw
		files.set(name, String(content))
		return "ok"
	},
})
globalThis.window = {NoriChat: makeNoriChatBridge()}
/**
 * 装回 NoriChat 假桥。
 * T19 用 `globalThis.window = {NoriBridge: ...}` 整个替换了 window, 会把假桥一起抹掉;
 * 之后任何 readFile 都静默返回 "" (readFile 内部 catch 后返回空串), 表现为
 * "测试自己写进 files 的数据, 被测代码完全读不到" —— 排查成本极高, 务必在替换后恢复。
 */
const restoreNoriChatBridge = () => { globalThis.window = {NoriChat: makeNoriChatBridge()} }

const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)
const diary = await import(pathToFileURL(path.join(root, "tmp-memcheck/diary-bundle.mjs")).href)
const chatSvc = await import(pathToFileURL(path.join(root, "tmp-memcheck/chat-bundle-for-tests.mjs")).href)

/* ---------------- 断言小工具 ---------------- */
const DAY = 24 * 3600 * 1000
const results = []
const check = (name, cond, extra = "") => {
	results.push({name, ok: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `  ← ${extra}`}`)
}
const mkMem = (id, content, over = {}) => ({
	id, content, type: "preference", importance: 0.7, confidence: 0.9,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 90, ...over,
})
const seedDisk = (memories, extra = {}) => {
	files.set("memory.json", JSON.stringify({memories, summaries: [], summarizedMsgCount: 0, tombstones: [], ...extra}))
}
const resetDisk = () => { files.clear(); mem.reloadMemory() }
const diskMemories = () => { try { return JSON.parse(files.get("memory.json") || "{}").memories ?? [] } catch { return [] } }

/* ============ T1 H1: decayDays=null 重启后保持 null; 缺字段的才回填 ============ */
{
	files.clear()
	seedDisk([
		mkMem("t1", "喜欢下雨天", {decayDays: null}),
		mkMem("t2", "我叫小明", {type: "fact", decayDays: undefined}),
	])
	mem.reloadMemory()
	const all = mem.listAll().memories
	check("H1: 固定/显式记忆 (decayDays=null) 重启后仍为 null", all.find(m => m.id === "t1")?.decayDays === null,
		`got ${JSON.stringify(all.find(m => m.id === "t1")?.decayDays)}`)
	check("H1: 真缺字段的旧数据仍回填默认值", all.find(m => m.id === "t2")?.decayDays === 365)
}

/* ============ T2 H2: "记住X" 并进旧条后保持永久 ============ */
{
	resetDisk()
	seedDisk([mkMem("t2old", "喜欢下雨天", {decayDays: 90})])
	mem.reloadMemory()
	mem.addMemoriesFromText("记住：我喜欢下雨天")
	const all = mem.listAll().memories
	const merged = all.find(m => m.content.includes("下雨天"))
	check("H2: 显式记忆合并后只剩一条", all.length === 1 && !!merged, `count=${all.length}`)
	check("H2: 合并结果 decayDays=null (不被旧条 90 天覆盖)", merged?.decayDays === null,
		`got ${JSON.stringify(merged?.decayDays)}`)
	check("H2: explicit 标签保留", (merged?.tags ?? []).includes("explicit"))
}

/* ============ T3 M1: 删除后立即重载不复活 ============ */
{
	resetDisk()
	seedDisk([mkMem("t3", "我在准备考研", {type: "project"})])
	mem.reloadMemory()
	check("M1: 前置 - 删除前可见", mem.listAll().memories.some(m => m.id === "t3"))
	check("M1: deleteMemory 返回 true", mem.deleteMemory("t3") === true)
	mem.reloadMemory() // 防抖未落盘, 磁盘还是旧副本 → 会话墓碑必须兜住
	check("M1: 删除后立即重载, 记忆不复活", !mem.listAll().memories.some(m => m.id === "t3"))
	await mem.flushMemoryPersist()
	check("M1: 落盘后磁盘上也没有了", !diskMemories().some(m => m.id === "t3"))
}

/* ============ T4 M4: prune 不删永久记忆 ============ */
{
	const now = Date.now()
	const stale = (id, over = {}) => mkMem(id, `杂事记忆${id}`, {
		type: "event", importance: 0.5, decayDays: 30,
		createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY, lastAccessedAt: now - 40 * DAY, accessCount: 0, ...over,
	})
	// 场景一: 160 条 (超 PRUNE_AFTER=150), 低频低重要 + 1 条固定
	const items1 = Array.from({length: 159}, (_, i) => stale(`p1_${i}`))
	items1.push(mkMem("pin1", "用户固定的记忆", {decayDays: null, importance: 0.4, createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY, lastAccessedAt: now - 40 * DAY}))
	const dropped1 = core.pruneMemories(items1)
	check("M4: 第一轮低频清理会删低价值旧条", dropped1.length === 159, `dropped=${dropped1.length}`)
	check("M4: 永久记忆不被低频清理删掉", !dropped1.some(d => d.id === "pin1"))
	// 场景二: 320 条, 触发第二轮"按价值丢弃"
	// 2026-09-30: 重要度从 0.7 改成 0.65 —— 0.7 起有了"免死金牌" (见 T36 与 core.ts 的
	// isProtectedFromOverflow), 而 0.65 正好是**宽松模型写一次性垃圾的那个档**:
	// ≥0.6 躲过第一轮低频清理、<0.7 仍归第二轮按价值淘汰。断言意图不变。
	const items2 = Array.from({length: 319}, (_, i) => stale(`p2_${i}`, {importance: 0.65, decayDays: 365, type: "fact"}))
	items2.push(mkMem("pin2", "用户固定的记忆2", {decayDays: null, importance: 0.9, createdAt: now - 100 * DAY, updatedAt: now - 100 * DAY, lastAccessedAt: now - 100 * DAY}))
	const dropped2 = core.pruneMemories(items2)
	check("M4: 第二轮按价值丢弃仍然生效", dropped2.length === 20, `dropped=${dropped2.length}`)
	check("M4: 第二轮也不删永久记忆", !dropped2.some(d => d.id === "pin2"))
}

/* ============ T5 M7: 重复说同样的话不弹"记住了" ============ */
{
	resetDisk()
	seedDisk([mkMem("t5", "我喜欢下雨天", {tags: ["llm"]})])
	mem.reloadMemory()
	// 假 LLM: 提取提示词 → 按输入返回事实; 决策提示词 → 对旧 id 返回 NONE
	const llmCall = async (prompt) => {
		if (prompt.includes("记忆库管理员")) {
			const idMatch = prompt.match(/^(\S+) \| /m)
			return JSON.stringify({memory: [{id: idMatch?.[1] ?? "new", text: "我喜欢下雨天", event: "NONE"}]})
		}
		const fact = prompt.includes("下雨天的傍晚") ? "我喜欢下雨天的傍晚" : "我喜欢下雨天"
		return JSON.stringify({facts: [{content: fact, type: "preference", importance: 0.7, confidence: 0.9}]})
	}
	const r1 = await mem.extractMemoriesSmart("我喜欢下雨天", llmCall)
	const r2 = await mem.extractMemoriesSmart("我喜欢下雨天", llmCall)
	/** 对照组用的假 LLM: 事实固定为一句与库里无关的新偏好 (决策不命中 → NONE 分支) */
	const llmCall2 = async (prompt) => {
		if (prompt.includes("记忆库管理员")) return JSON.stringify({memory: []})
		return JSON.stringify({facts: [{content: "我最近喜欢上喝乌龙茶", type: "preference", importance: 0.7, confidence: 0.9}]})
	}
	check("M7: 第一次重复发言不弹泡", r1.tips.length === 0, `tips=${JSON.stringify(r1.tips)}`)
	check("M7: 第二次重复发言不弹泡", r2.tips.length === 0, `tips=${JSON.stringify(r2.tips)}`)
	// 对照组: 真正的新信息仍要弹
	// 注意对照组的事实必须与已有记忆**语义无关**: 原先用的「我喜欢下雨天的傍晚」与
	// 「我喜欢下雨天」只差两字, 属于"同一件事换说法"(近重复) —— 2026-09-26 起近重复
	// 一律交给 AI 判重, 这里被判为同一件事而不新增 (见 T26), 拿它当"真新增"会误报。
	const r3 = await mem.extractMemoriesSmart("我最近喜欢上喝乌龙茶", llmCall2)
	check("M7: 对照组 - 真新增仍弹泡", r3.tips.length === 1, `tips=${JSON.stringify(r3.tips)}`)
}

/* ============ T6 M8: addGoal 撞上已有记忆, 目标不被吞 ============ */
{
	resetDisk()
	seedDisk([mkMem("t6old", "考研", {type: "project", importance: 0.6, tags: ["project"], decayDays: 60})])
	mem.reloadMemory()
	check("M8: addGoal 返回 true", mem.addGoal("准备考研") === true)
	const goals = mem.listGoals()
	check("M8: 撞旧记忆后目标列表仍有 1 条", goals.length === 1, `count=${goals.length}`)
	check("M8: 被合并的旧条被打上 goal 标签且永久", goals[0]?.content.includes("考研") && (goals[0]?.tags ?? []).includes("goal") && goals[0]?.decayDays === null)
}

/* ============ T7 M9: 决策调用的成本契约 (2026-09-26 起语义有变, 见下) ============
 * 旧契约 ("弱重叠一律不调") 只对**词面**成立; 修长期记忆重复时发现它有个致命副作用:
 * 「我叫小明」vs「我的名字是小明」这类**零字面重叠**的同义句永远进不了候选, AI 看不到 ⇒
 * 判重被静默跳过 ⇒ 同一件事并存两条。所以现在多了一条**同类兜底**: 成本闸没打开时,
 * 把同类型旧记忆一并交给 AI 判重 (类型只有 6 个枚举, 代价是一次很快的决策调用)。
 * 这里守的是新契约: ①没同类旧记忆时不调; ②强词面重叠必调; ③弱重叠/零重叠但同类 → 调 (兜底)。 */
{
	resetDisk()
	seedDisk([
		mkMem("t7a", "喜欢下雨天", {}),
		mkMem("t7b", "我不吃辣", {type: "fact", decayDays: 365, tags: ["explicit"]}),
	])
	mem.reloadMemory()
	let calls = 0
	const spy = async () => { calls += 1; return JSON.stringify({memory: []}) }
	// ① 空库: 没有任何旧记忆 → 不可能有候选, 绝不调 (省掉第一次调用的成本)
	files.clear()
	mem.reloadMemory()
	await mem.applyLlmMemoryDecision([mkMem("f0", "我喜欢吃辣条", {decayDays: 90})], spy)
	check("M9: 空库时不调决策 LLM", calls === 0, `calls=${calls}`)
	// ② 强重叠: 与"喜欢下雨天"有 4 个 bigram 重叠 → 必调
	seedDisk([mkMem("t7a", "喜欢下雨天", {})])
	mem.reloadMemory()
	await mem.applyLlmMemoryDecision([mkMem("f2", "我最喜欢下雨天了", {decayDays: 90})], spy)
	check("M9: 强重叠仍调决策 LLM", calls === 1, `calls=${calls}`)
	// ③ 弱重叠 + 同类旧记忆 → 同类兜底调一次 (正是"换说法不重复"的代价)
	seedDisk([mkMem("t7a", "喜欢下雨天", {})])
	mem.reloadMemory()
	await mem.applyLlmMemoryDecision([mkMem("f1", "我喜欢吃辣条", {decayDays: 90})], spy)
	check("M9: 弱重叠但同类 → 同类兜底调一次", calls === 2, `calls=${calls}`)
	// ④ 零词面重叠 + 同类 → 同样调 (否则「我叫小明」这种同义句永远判不了重)
	seedDisk([mkMem("t7c", "我的名字叫小明", {type: "fact", decayDays: 365})])
	mem.reloadMemory()
	await mem.applyLlmMemoryDecision([mkMem("f4", "我叫小明", {type: "fact", decayDays: 365})], spy)
	check("M9: 零字面重叠但同类 → 调决策 (同义改写可判重)", calls === 3, `calls=${calls}`)
	// ⑤ 零重叠 + 无同类 (库里只有另一种类型) → 不调
	seedDisk([mkMem("t7d", "喜欢下雨天", {})])
	mem.reloadMemory()
	await mem.applyLlmMemoryDecision([mkMem("f5", "我在准备考研", {type: "project", decayDays: 60})], spy)
	check("M9: 零重叠且无同类 → 不调决策", calls === 3, `calls=${calls}`)
}

/* ============ T8 M11: 无变化跳写 ============ */
{
	files.clear()
	mem.reloadMemory()
	await mem.summarizeIfNeeded([], async () => "") // 触发 persist (空待办分支)
	await mem.flushMemoryPersist()
	const w1 = writeCount
	check("M11: 首次落盘有写入 (主+备)", w1 >= 2, `w=${w1}`)
	await mem.summarizeIfNeeded([], async () => "")
	await mem.flushMemoryPersist()
	check("M11: 内容未变时第二次不落盘", writeCount === w1, `w1=${w1} w2=${writeCount}`)
}

/* ============ T9 Q4: 坏元素不炸召回 ============ */
{
	files.clear()
	files.set("memory.json", JSON.stringify({
		memories: [null, 42, mkMem("t9", "喜欢下雨天", {})],
		summaries: [], summarizedMsgCount: 0, tombstones: [],
	}))
	mem.reloadMemory()
	check("Q4: 坏元素被过滤, 好数据保留", mem.memoryStats().memoryCount === 1, `count=${mem.memoryStats().memoryCount}`)
	let block = ""
	let threw = false
	try { block = mem.recallForQuery("我喜欢下雨天") } catch { threw = true }
	check("Q4: 召回不抛错且能命中", !threw && block.includes("喜欢下雨天"))
}

/* ============ T10 core: mergeMemories 完全相同 → 零变化 ============ */
{
	const prev = mkMem("a", "我喜欢下雨天", {tags: ["llm"]})
	const same = mkMem("b", "我喜欢下雨天", {tags: ["llm"]})
	const r1 = core.mergeMemories([same], [prev])
	check("merge: 完全相同 → 不新增不改写", r1.added.length === 0 && r1.updated.length === 0,
		`added=${r1.added.length} updated=${r1.updated.length}`)
	const withNewTag = mkMem("c", "我喜欢下雨天", {tags: ["llm", "x"]})
	const r2 = core.mergeMemories([withNewTag], [prev])
	check("merge: 有差异 → 仍正常升级", r2.added.length === 0 && r2.updated.length === 1)
}

/* ============ T11 MEM-M3: 摘要 id 区间指纹, 双实例重复摘要可去重 ============ */
{
	files.clear()
	mem.reloadMemory()
	// 注意: 不带 ts → 走 summaryIdFor 的**下标回退**分支 (兼容旧数据)。
	// 真实产线的消息都带 ts, 那条路径由 T23 覆盖。
	const messages = Array.from({length: 45}, (_, i) => ({
		role: i % 2 ? "assistant" : "user",
		content: `对话内容第${i}句`,
	}))
	await mem.summarizeIfNeeded(messages, async () => "这是一份总结")
	await mem.flushMemoryPersist()
	const first = JSON.parse(files.get("memory.json"))
	check("M3: 无 ts 时退回下标区间指纹 (sum-0-25)", first.summaries[0]?.id === "sum-0-25",
		`id=${first.summaries[0]?.id}`)
	// 模拟双实例竞态: 另一实例对同一区间总结了内容不同的摘要 (同 id), 先写盘
	files.set("memory.json", JSON.stringify({
		memories: [],
		summaries: [{id: "sum-0-25", content: "另一实例的措辞", createdAt: Date.now() + 5, msgCount: 25, tokenCount: 1}],
		summarizedMsgCount: 25,
		tombstones: [],
	}))
	mem.reloadMemory()
	const again = await mem.summarizeIfNeeded(messages, async () => "第二份总结")
	const final = JSON.parse(files.get("memory.json"))
	check("M3: 同 id 摘要合并只留一份", final.summaries.length === 1, `n=${final.summaries.length}`)
	check("M3: 游标已到区间末尾, 不再重复总结", again === false && final.summaries[0].id === "sum-0-25")
}

/* ============ T12 tokenize 缓存: 等值且命中缓存 ============ */
{
	const a = core.tokenize("喜欢下雨天")
	check("tokenize: bigram 切分正确", JSON.stringify(a) === JSON.stringify(["喜欢", "欢下", "下雨", "雨天"]),
		JSON.stringify(a))
	check("tokenize: 同串命中缓存 (同引用)", core.tokenize("喜欢下雨天") === a)
}

/* ============ T13 改口: 方向词变体也必须消解 (不能只认 喜欢/不喜欢) ============
 * 背景: EXTRACT_RULES 会把「最喜欢X」「超喜欢X」「我讨厌X」「我不爱吃X」都提成
 * preference, 但反向消解的比较键 prefKey 只认 "喜欢"/"不喜欢" 两个字面前缀,
 * 其他方向词一律返回空 → 跳过消解 → 新旧两个方向并存, 上下文里同时注入两个说法.
 * 注意: 每个子场景用唯一 id, 因为模块级会话墓碑 (deletedIds) 不会跨块复位.
 */
{
	// 断言: 只应剩"新方向"那一条
	const expectReversal = (name, newContent, forbidden) => {
		const all = mem.listAll().memories.map(m => m.content)
		const one = all.length === 1
		check(`${name}: 只剩一条`, one, `库内=${JSON.stringify(all)}`)
		check(`${name}: 新方向保留`, all.length === 1 && all[0] === newContent, `got=${JSON.stringify(all)}`)
		check(`${name}: 旧方向已消解`, !all.some(c => c === forbidden), `库内=${JSON.stringify(all)}`)
	}

	// ① 旧侧是「最喜欢X」→ 新说「我不喜欢X了」
	resetDisk()
	seedDisk([mkMem("p1", "最喜欢下雨天")])
	mem.reloadMemory()
	mem.addMemoriesFromText("我不喜欢下雨天了")
	expectReversal("改口1 (旧:最喜欢X)", "不喜欢下雨天了", "最喜欢下雨天")

	// ② 旧侧是「我讨厌X」→ 新说「我喜欢X」
	resetDisk()
	seedDisk([mkMem("p2", "我讨厌吃辣")])
	mem.reloadMemory()
	mem.addMemoriesFromText("我喜欢吃辣")
	expectReversal("改口2 (旧:我讨厌X)", "喜欢吃辣", "我讨厌吃辣")

	// ③ 旧侧是「不爱吃X」(规则归一形态) → 新说「我爱吃X」(新内容被规则归一成"喜欢吃X")
	//    注意: 规则把"不爱吃香菜"提成 "不喜欢香菜", 不是原字面 —— 种子必须用归一后的形态
	resetDisk()
	seedDisk([mkMem("p3", "不喜欢香菜")])
	mem.reloadMemory()
	mem.addMemoriesFromText("我爱吃香菜")
	expectReversal("改口3 (旧:不喜欢X/不爱吃)", "喜欢吃香菜", "不喜欢香菜")

	// ③b 同方向、仅多一个主语的措辞差异, 绝不能被当成改口删掉 (走 merge 合并)
	resetDisk()
	seedDisk([mkMem("p3b", "喜欢下雨天", {tags: ["llm"]})])
	mem.reloadMemory()
	mem.addMemoriesFromText("我喜欢下雨天")
	const sameDir = mem.listAll().memories.map(m => m.content)
	check("改口回归: 同方向不同措辞不误删 (仍只剩一条且存活)",
		sameDir.length === 1 && sameDir[0].includes("下雨天"), `库内=${JSON.stringify(sameDir)}`)

	// ④ 旧侧是「我超爱X」→ 新说「我不喜欢X了」
	resetDisk()
	seedDisk([mkMem("p4", "我超爱下雨天")])
	mem.reloadMemory()
	mem.addMemoriesFromText("我不喜欢下雨天了")
	expectReversal("改口4 (旧:我超爱X)", "不喜欢下雨天了", "我超爱下雨天")

	// ⑤ 回归: 宾语不同的偏好绝不能被误消解
	resetDisk()
	seedDisk([mkMem("p5", "我喜欢猫")])
	mem.reloadMemory()
	mem.addMemoriesFromText("我讨厌狗")
	const both = mem.listAll().memories.map(m => m.content)
	check("改口回归: 不同宾语不误消解 (猫/狗 都在)", both.length === 2,
		`库内=${JSON.stringify(both)}`)

	// ⑥ 回归: 无方向词的普通记忆不该被当成偏好宾语
	resetDisk()
	seedDisk([mkMem("p6", "我在准备考研", {type: "project"})])
	mem.reloadMemory()
	mem.addMemoriesFromText("我讨厌下雨天")
	const after = mem.listAll().memories.map(m => m.content)
	check("改口回归: 与无关记忆不互相消解", after.length === 2, `库内=${JSON.stringify(after)}`)
}

/* ============ T14 召回语义门槛: 无关记忆不得靠 importance/新鲜度挤进结果 ============
 * 背景: scoreMemory = 语义*2.0 + importance*0.6 + confidence*0.2 + 新鲜度*0.3 + 强化*0.1,
 * 除以 0.35 的阈值时, 一条 importance/confidence 高且当天创建的记忆即使语义重叠为 0,
 * 分数也能到 ~1.0 → 对**任何**提问都会被召回并注入上下文, 挤占 topK。
 * 正确语义: 相关性是召回的**必要条件**, 静态分只用于在相关记忆之间排序。
 */
{
	// 与查询毫无字面重叠的高重要记忆 (importance 0.9 / confidence 0.95 / 当天创建)
	resetDisk()
	seedDisk([
		mkMem("irrelevant", "我在准备考研", {
			type: "fact", importance: 0.9, confidence: 0.95, decayDays: 365,
		}),
	])
	mem.reloadMemory()
	const r1 = core.recallMemories(mem.listAll().memories, "今天晚饭吃什么好呢")
	check("A2: 语义重叠为 0 的高重要记忆不被召回", r1.hits.length === 0,
		`hits=${JSON.stringify(r1.hits.map(h => h.content))}`)
	check("A2: 未被召回就不该被强化 (accessCount 不变)",
		r1.updated.every(m => m.accessCount === 0), JSON.stringify(r1.updated.map(m => m.accessCount)))

	// 对照: 有字面重叠时仍必须召回 (门槛不能把召回整体打死)
	resetDisk()
	seedDisk([
		mkMem("relevant", "我在准备考研", {
			type: "fact", importance: 0.9, confidence: 0.95, decayDays: 365,
		}),
	])
	mem.reloadMemory()
	const r2 = core.recallMemories(mem.listAll().memories, "考研准备得怎么样了")
	check("A2 对照: 有重叠的记忆仍被召回", r2.hits.length === 1 && r2.hits[0].content === "我在准备考研",
		`hits=${JSON.stringify(r2.hits.map(h => h.content))}`)

	// 对照: 混在一起时, 无关的不能挤掉相关的
	resetDisk()
	seedDisk([
		mkMem("noise", "我在准备考研", {type: "fact", importance: 0.95, confidence: 0.95, decayDays: 365}),
		mkMem("rel", "喜欢吃辣", {importance: 0.5, confidence: 0.8}),
	])
	mem.reloadMemory()
	const r3 = core.recallMemories(mem.listAll().memories, "我特别喜欢吃辣")
	check("A2: 无关记忆不挤占 topK (只留相关的那条)",
		r3.hits.length === 1 && r3.hits[0].content === "喜欢吃辣",
		`hits=${JSON.stringify(r3.hits.map(h => h.content))}`)

	// 回归: 走完整 recallForQuery 注入路径, 无关记忆不应出现在注入块里
	resetDisk()
	seedDisk([
		mkMem("n1", "我在准备考研", {type: "fact", importance: 0.9, confidence: 0.95, decayDays: 365}),
	])
	mem.reloadMemory()
	const block = mem.recallForQuery("今天天气不错啊")
	check("A2: 注入上下文里没有无关记忆", block === "" || !block.includes("考研"), `block=${JSON.stringify(block)}`)
}

/* ============ T15 A3: unpin 不得把"显式记住"从永久降级为可过期 ============
 * 背景: pinMemory 取消固定时无条件取 defaultDecayDays(type)。
 * 规则 index.ts:87 把「别忘了X / 记一下X / 帮我记下X」提成 type=fact + tag=explicit
 * + decayDays=null (永久)。unpin 后 decayDays 被改成 fact 的默认 365 天 ——
 * 用户"明确要求记住"的东西变成会过期 (expireMemories 按 365×3 天删), 而 tags 里
 * 的 explicit 在 expireMemories 里并不被豁免 (它只看 decayDays)。
 */
{
	resetDisk()
	// 模拟真实形态: fact + explicit + 永久
	seedDisk([mkMem("a3", "别忘了买牛奶", {type: "fact", tags: ["explicit"], decayDays: null})])
	mem.reloadMemory()

	check("A3: 前置 - 初始为永久", mem.listAll().memories[0]?.decayDays === null,
		`got=${JSON.stringify(mem.listAll().memories[0]?.decayDays)}`)

	check("A3: pin 返回 true", mem.pinMemory("a3", true) === true)
	check("A3: pin 后仍永久", mem.listAll().memories[0]?.decayDays === null)

	check("A3: unpin 返回 true", mem.pinMemory("a3", false) === true)
	const after = mem.listAll().memories[0]
	check("A3: unpin 后仍为永久 (explicit 不该被降级)", after?.decayDays === null,
		`got=${JSON.stringify(after?.decayDays)}`)
	check("A3: unpin 后 pinned 标签已摘掉", !(after?.tags ?? []).includes("pinned"))
	check("A3: unpin 后 explicit 标签保留", (after?.tags ?? []).includes("explicit"))

	// 对照: 一条普通(非 explicit)记忆 unpin 后应恢复类型默认衰减 —— 不能一刀切全永久
	resetDisk()
	seedDisk([mkMem("a3b", "喜欢下雨天", {type: "preference", tags: [], decayDays: null})])
	mem.reloadMemory()
	mem.pinMemory("a3b", true)
	mem.pinMemory("a3b", false)
	const plain = mem.listAll().memories[0]
	check("A3 对照: 普通记忆 unpin 后恢复类型默认衰减 (90)",
		plain?.decayDays === 90, `got=${JSON.stringify(plain?.decayDays)}`)

	// 对照: core 类 (「记住：X」) unpin 后仍永久
	resetDisk()
	seedDisk([mkMem("a3c", "记住我不吃辣", {type: "core", tags: ["explicit"], decayDays: null})])
	mem.reloadMemory()
	mem.pinMemory("a3c", true)
	mem.pinMemory("a3c", false)
	check("A3 对照: core 类 unpin 后仍永久",
		mem.listAll().memories[0]?.decayDays === null, `got=${JSON.stringify(mem.listAll().memories[0]?.decayDays)}`)
}

/* ============ T16 A4: 未被渲染的记忆不得被强化 ============
 * 背景: recallMemories 默认 topK=8, buildMemoryBlock 默认 limit=6。
 * recallForQuery 取 8 条却只渲染 6 条, 但强化对全部 8 条 accessCount+1 ——
 * 第 7、8 名从未注入上下文, 却虚涨访问次数; 而 accessCount 既参与价值评分
 * (pruneMemories 据此决定丢谁), 又是 expireMemories 的免死条件 (>=2 则不过期)。
 */
{
	const now = Date.now()
	// 9 条都含共同 bigram 以保证都能过相关性门槛; 用 importance 拉开排序
	const mk = (i) => mkMem(`a4_${i}`, `喜欢测试物${i}`, {importance: 0.9 - i * 0.02})
	resetDisk()
	seedDisk(Array.from({length: 9}, (_, i) => mk(i)))
	mem.reloadMemory()

	const before = new Map(mem.listAll().memories.map(m => [m.id, m.accessCount]))
	const block = mem.recallForQuery("喜欢测试物")
	const blockLines = block.split("\n").filter(l => l.startsWith("- ")).length
	check("A4: 前置 - 注入块只有 6 行", blockLines === 6, `lines=${blockLines}`)

	const after = mem.listAll().memories
	const injectedIds = new Set(
		after.filter(m => (before.get(m.id) ?? 0) === 0 && m.accessCount > 0 && block.includes(m.content)).map(m => m.id)
	)
	const bumpedButNotRendered = after.filter(m =>
		m.accessCount > (before.get(m.id) ?? 0) && !block.includes(m.content)
	)
	check("A4: 未被渲染的记忆不该被强化 (accessCount 不变)",
		bumpedButNotRendered.length === 0,
		`被强化但未进注入块: ${JSON.stringify(bumpedButNotRendered.map(m => m.content))}`)
	check("A4: 注入块内的记忆确实被强化了 (共 6 条)",
		injectedIds.size === 6, `n=${injectedIds.size}`)
}

/* ============ T17 写盘失败不得静默 (writeFile 返回值此前被丢弃) ============
 * 背景: nori-diary.ts / habit.ts / chat.saveSettings 都调用 writeFile 却不检查返回值,
 * 失败被外层 catch 吞掉 —— 与已修的 chat.flushChatPersist 完全同类。
 * 后果: 用户看到"今天的日记写好啦"/"设置已保存", 重启后却什么都没有。
 */
{
	const DAY = 24 * 3600 * 1000
	const now = Date.now()
	const today = (() => {
		const d = new Date(now)
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
	})()
	const llmOk = async () => "今天和主人聊了游戏。\n开心"

	// ① 对照组: 写盘正常 → 返回 ok, 且真的落盘
	failWriteFor = null
	files.clear()
	files.set("chat.json", JSON.stringify({v: 1, cutoff: 0, msgs: [
		{role: "user", content: "今天聊了游戏", ts: now - 1000},
	]}))
	const r1 = await diary.writeTodayDiary(llmOk)
	const disk1 = JSON.parse(files.get("nori-diary.json") || "{}")
	check("A6 对照: 写盘正常时返回 ok", r1 === "ok", `got=${r1}`)
	check("A6 对照: 写盘正常时日记真的在磁盘上",
		(disk1.entries ?? []).some(e => e.date === today), JSON.stringify(disk1.entries ?? []))

	// ② 主文件写失败 → 必须如实返回 failed, 且不得在磁盘上留下"已写"的假象
	diary.__resetDiaryCacheForTest?.()
	files.clear()
	files.set("chat.json", JSON.stringify({v: 1, cutoff: 0, msgs: [
		{role: "user", content: "今天聊了游戏", ts: now - 1000},
	]}))
	failWriteFor = "nori-diary.json"
	const r2 = await diary.writeTodayDiary(llmOk)
	const disk2 = JSON.parse(files.get("nori-diary.json") || "{}")
	check("A6: 主文件写失败时返回 failed (不谎报成功)", r2 === "failed", `got=${r2}`)
	check("A6: 写失败后磁盘上没有该条 (不留下已写的假象)",
		!(disk2.entries ?? []).some(e => e.date === today), JSON.stringify(disk2.entries ?? []))
	failWriteFor = null

	// ③ 设置写失败 → saveSettings 必须返回 false
	failWriteFor = "settings.json"
	const okFalse = chatSvc.saveSettings({apiKey: "k", baseUrl: "u", model: "m"})
	check("A6: 设置写失败时 saveSettings 返回 false", okFalse === false, `got=${okFalse}`)
	failWriteFor = null
	const okTrue = chatSvc.saveSettings({apiKey: "k", baseUrl: "u", model: "m"})
	check("A6 对照: 设置写成功时 saveSettings 返回 true", okTrue === true, `got=${okTrue}`)

	/* --- 时间感知 (2026-10-01) ---
	   背景: 用户报「Nori 没法看时间」—— 聊天提示词里从来没有"现在几点"。修法是在人格**之后**
	   追加一个时间块（放最前会破坏提示词缓存，见交接-P3 §15）。这里只测这个块的格式与纯度；
	   "真的进了 payload、且在人格之后"由探针 probe-time-context.mjs 在浏览器里验。 */
	{
		const t = new Date(2026, 9, 1, 9, 12)          // 2026-10-01 09:12（本地时间，星期四）
		const block = chatSvc.localTimeBlock(t)
		check("时间块: 含【当前时间】标题", block.includes("【当前时间】"), block.slice(0, 40))
		check("时间块: 含年月日", block.includes("2026-10-01"), block.slice(0, 60))
		check("时间块: 含星期（算「下周三」要用）", block.includes("星期四"), block.slice(0, 60))
		check("时间块: 含时分", block.includes("09:12"), block.slice(0, 60))
		check("时间块: 含时区偏移 UTC±hh:mm", /UTC[+-]\d{2}:\d{2}/.test(block), block.slice(0, 90))
		check("时间块: 同一时刻输出稳定（纯函数）", chatSvc.localTimeBlock(t) === block)
		check("时间块: 不同时刻输出不同（不是常量）", chatSvc.localTimeBlock(new Date(2026, 9, 1, 9, 13)) !== block)
		check("时间块: 不传参数时用「现在」（格式仍对）", /^【当前时间】\d{4}-\d{2}-\d{2} 星期./.test(chatSvc.localTimeBlock()))
		check("默认设置: timeAware 默认开", chatSvc.DEFAULT_SETTINGS.timeAware === true, String(chatSvc.DEFAULT_SETTINGS.timeAware))

	}

	// ③b saveSettingsRaw: 必须把原生给的真实原因带出来。
	// 背景: 真机上保存失败只会显示"存储不可写", 而 err:insert / err:stream / SecurityException
	// 全被压成同一句话, 完全没法定位 (2026-09-22 因此排查了很久)。
	failWriteFor = "settings.json"
	const rawFail = chatSvc.saveSettingsRaw({apiKey: "k", baseUrl: "u", model: "m"})
	check("A6: 写失败时 saveSettingsRaw 返回原生原因 (不吞掉)",
		rawFail === failWriteRaw, `got=${JSON.stringify(rawFail)} 期望 ${JSON.stringify(failWriteRaw)}`)
	failWriteFor = null
	const rawOk = chatSvc.saveSettingsRaw({apiKey: "k", baseUrl: "u", model: "m"})
	check("A6 对照: 写成功时 saveSettingsRaw 返回 ok", rawOk === "ok", `got=${JSON.stringify(rawOk)}`)
	check("A6: saveSettings 与 saveSettingsRaw 的判定一致 (前者就是后者的 === \"ok\")",
		(chatSvc.saveSettings({apiKey: "k"}) === true) === (chatSvc.saveSettingsRaw({apiKey: "k"}) === "ok"))

	// ④ 回归: 写失败后"今天没对话"的判定不能受影响 (empty 与 failed 必须可区分)
	failWriteFor = "nori-diary.json"
	files.clear()
	files.set("chat.json", JSON.stringify({v: 1, cutoff: 0, msgs: []}))
	const r4 = await diary.writeTodayDiary(llmOk)
	check("A6: 今天无对话时返回 empty (不误报 failed)", r4 === "empty", `got=${r4}`)
	failWriteFor = null
	void DAY
}

/* ============ T18 B4: 语义召回的降级路径同样受相关性门槛约束 ============
 * A2 的门槛加在 recallMemories 里, 但 recallForQuerySmart 有两条自己的分支:
 *   ① LLM 失败/异常 → 关键词完整兜底 (走 recallMemories → 自动受门槛)
 *   ② LLM 成功但返回空 → "强命中补充" 直接调 scoreMemory (曾绕过门槛, 已显式补上)
 * 这里把两条分支都钉住 —— 只测 recallForQuery 不足以覆盖真实运行时的调用点。
 */
{
	const mkSeed = (id, content, over = {}) => mkMem(id, content, over)
	const seedTwo = () => {
		resetDisk()
		seedDisk([
			// 高重要 + 当天创建 + 零字面重叠 → 修复前任何提问都会被注入
			mkSeed("noise", "我在准备考研", {type: "fact", importance: 0.95, confidence: 0.95, decayDays: 365}),
			// 低重要但真正相关
			mkSeed("rel", "喜欢吃辣", {importance: 0.5, confidence: 0.8}),
		])
		mem.reloadMemory()
	}

	// ① LLM 抛异常 → 关键词兜底: 无关的高重要记忆不得出现
	seedTwo()
	const blockThrow = await mem.recallForQuerySmart("我特别喜欢吃辣", async () => { throw new Error("llm down") })
	check("B4: LLM 失败降级时, 无关记忆不被注入",
		!blockThrow.includes("考研"), `block=${JSON.stringify(blockThrow)}`)
	check("B4: LLM 失败降级时, 相关记忆仍然被注入",
		blockThrow.includes("喜欢吃辣"), `block=${JSON.stringify(blockThrow)}`)

	// ② LLM 成功但返回空数组 → 强命中补充分支
	seedTwo()
	const blockEmpty = await mem.recallForQuerySmart("我特别喜欢吃辣", async () => "[]")
	check("B4: LLM 空结果时, 无关记忆不被补充注入",
		!blockEmpty.includes("考研"), `block=${JSON.stringify(blockEmpty)}`)

	// ③ 补充分支的**边界**断言。
	//    诚实说明: 这一条不是"反向验证能变红"的用例 —— 零字面重叠记忆的静态分上限约
	//    0.6+0.2+0.3+0.1 = 1.2 左右, 天然达不到该分支的 score>1.5 阈值, 所以那道阈值
	//    自己就挡住了它。给该分支补的 overlapCount 门槛是**契约一致性**的纵深防御
	//    (保证"scoreMemory 不被当相关性用"这条约束在所有调用点成立), 而非当前必需的修复。
	//    这里保留断言, 是为了锁住"极高重要度 + 零重叠"这一边界不被将来放宽阈值时悄悄放过。
	resetDisk()
	seedDisk([
		mkSeed("rel2", "喜欢吃辣", {importance: 0.9, confidence: 0.95}),
		mkSeed("noise2", "我在准备考研", {type: "fact", importance: 0.9, confidence: 0.95, decayDays: 365}),
	])
	mem.reloadMemory()
	const blockSup = await mem.recallForQuerySmart("我特别喜欢吃辣", async () => "[]")
	check("B4: LLM 空结果时, 零重叠的高重要记忆不进注入块",
		!blockSup.includes("考研"), `block=${JSON.stringify(blockSup)}`)
	check("B4 对照: 同分支里相关记忆仍被补充", blockSup.includes("喜欢吃辣"), `block=${JSON.stringify(blockSup)}`)
}

/* ============ T19 模型下载: 并发不得覆盖全局回调, 且必须清理 ============
 * ensureModel 用 window.__noriModelRes 这个**全局单例**接收原生回调。
 * 修复前: 并发第二次调用会覆盖第一次的回调 → 第一个 Promise 永不 settle
 *         (之后再也切不了模型, 只能重启 App), 且没有超时兜底。
 * 修复后: 已有下载在途时第二次立刻拒绝; 回调用完即删 (按引用比对, 不误删后注册的)。
 * 注: 120s 超时分支需要假定时器才能测, 这里只钉住可观测的并发与清理行为。
 */
{
	const mod = await import(pathToFileURL(path.join(root, "tmp-memcheck/modelstore-bundle.mjs")).href)
	const tick = async () => new Promise((r) => setTimeout(r, 0))
	const downloads = []
	globalThis.window = {
		NoriBridge: {
			listInstalled: () => "[]",
			download: (id) => { downloads.push(id) },
		},
	}

	// ① 正常路径: 下载 → 原生回包 → resolve, 且回调被清理
	const p1 = mod.ensureModel("m1", "模型1")
	await tick()
	check("T19: 下载已发起", downloads.length === 1 && downloads[0] === "m1", JSON.stringify(downloads))
	check("T19: 回调已注册", typeof window.__noriModelRes === "function")
	window.__noriModelRes(JSON.stringify({ok: true, entryBase: "m1"}))
	const r1 = await p1
	check("T19: 正常下载 resolve 出入口基名", r1 === "m1", `got=${r1}`)
	check("T19: resolve 后回调已清理", window.__noriModelRes === undefined,
		`got=${typeof window.__noriModelRes}`)

	// ② 并发: 第二次必须立刻被拒 (而不是覆盖回调导致第一个永久挂起)
	const p2 = mod.ensureModel("m2", "模型2")
	await tick()
	let rejected = null
	const p3 = mod.ensureModel("m3", "模型3").then(
		(v) => ({resolved: v}),
		(e) => ({rejected: e}),
	)
	const outcome = await p3
	rejected = outcome.rejected ?? null
	check("T19: 并发第二次被拒绝 (不覆盖回调)",
		!!rejected && String(rejected.message).includes("正在下载"),
		`outcome=${JSON.stringify(outcome)} pendingCallback=${typeof window.__noriModelRes}`)
	check("T19: 只有第一次真正发起下载", downloads.length === 2 && downloads[1] === "m2",
		JSON.stringify(downloads))

	// ③ 第一个仍能正常完成 (证明没被截胡)
	window.__noriModelRes(JSON.stringify({ok: true, entryBase: "m2"}))
	check("T19: 在途下载仍能正常完成", (await p2) === "m2")

	// ④ 失败回包走 reject, 且回调同样被清理 (否则下次下载会误判"已有下载在途")
	const p4 = mod.ensureModel("m4", "模型4")
	await tick()
	window.__noriModelRes(JSON.stringify({ok: false, message: "网络错误"}))
	let errMsg = ""
	await p4.catch((e) => { errMsg = e?.message ?? String(e) })
	check("T19: 失败回包 reject 出原生消息", errMsg === "网络错误", `got=${JSON.stringify(errMsg)}`)
	check("T19: 失败后回调也被清理", window.__noriModelRes === undefined,
		`got=${typeof window.__noriModelRes}`)

	// ⑤ 已安装的模型走缓存, 不触发下载
	globalThis.window = {
		NoriBridge: {
			listInstalled: () => JSON.stringify([{id: "cached", entryBase: "cached-base"}]),
			download: () => { throw new Error("不该被调用") },
		},
	}
	const r5 = await mod.ensureModel("cached", "缓存模型")
	check("T19: 已安装模型直接返回缓存 (不下载)", r5 === "cached-base", `got=${r5}`)

	// 收尾: 本块把 window 整个换成了 NoriBridge, 必须装回 NoriChat 假桥,
	// 否则后续所有依赖 readFile 的测试块都会读到空字符串 (静默失败, 极难排查)
	restoreNoriChatBridge()
}

/* ============ T20b 一键克隆答题门 (2026-10-01) ============
 * 判卷是**纯函数**且**只认全等**（先归一化掉空格/标点/全角）—— 这道题是内置音色的解锁条件，
 * 判宽了等于没锁。UI 侧（点开弹窗、答错不许克隆、答对才调桥）由 probe-clone-gate.mjs 在浏览器里验。
 */
{
	const cg = await import(pathToFileURL(path.join(root, "tmp-memcheck/clone-gate-bundle.mjs")).href)
	check("授权题: 正确答案（原样）通过", cg.checkCloneAnswer("水母是水里的月亮") === true)
	check("授权题: 带空格/句号/书名号也放行", cg.checkCloneAnswer(" 「水母是水里的月亮。」 ") === true)
	check("授权题: 换行也放行", cg.checkCloneAnswer("水母是水里的\n月亮") === true)
	check("授权题: 少字/多字一律不通过", cg.checkCloneAnswer("水母是月亮") === false && cg.checkCloneAnswer("水母是水里的月亮呀") === false)
	check("授权题: 空输入不通过", cg.checkCloneAnswer("") === false && cg.checkCloneAnswer("   ") === false)
	check("授权题: 近似答案不通过（不许模糊匹配）", cg.checkCloneAnswer("水母是海里的月亮") === false)
	check("授权题: 题面里写明 8 字", /8 字/.test(cg.CLONE_GATE_QUESTION))
	check("授权题: 答案正好 8 字（与题面对得上）", cg.normalizeCloneAnswer("水母是水里的月亮").length === 8)
}

/* ============ T20 专注统计: 汇总计算 + Nori 注入的三个闸门 ============
 * 这是本次唯一能脱离 App.vue 单测的部分 (面板模板与注入调用点测不到)。
 * 重点钉住: 闸门顺序、里程碑只庆祝一次、以及"不该提时绝不提"。
 */
{
	const ps = await import(pathToFileURL(path.join(root, "tmp-memcheck/pomostats-bundle.mjs")).href)
	const NOW = new Date("2026-09-15T14:00:00")
	const key = (offset) => ps.dayKey(new Date(NOW.getTime() - offset * 86400000))
	const day = (o = {}) => ({focusMin: 0, done: 0, abort: 0, countUpMin: 0, ...o})

	/* --- ① summarize: 完成率 / 平均每段 / 近 7 天 / 最佳 --- */
	{
		const days = {
			[key(0)]: day({focusMin: 100, done: 4, abort: 1, countUpMin: 20}),
			[key(1)]: day({focusMin: 50, done: 2, abort: 0}),
			[key(3)]: day({focusMin: 150, done: 6, abort: 0}),
			[key(9)]: day({focusMin: 999, done: 9, abort: 0}),   // 超出 7 天窗口, 不应计入
		}
		const s = ps.summarize(days, 7, NOW)
		check("T20: 今日总分钟 = focusMin + countUpMin", s.todayMin === 120, `got=${s.todayMin}`)
		check("T20: 完成率 = done/(done+abort)", Math.abs(s.todayRate - 4 / 5) < 1e-9, `got=${s.todayRate}`)
		check("T20: 平均每段 = focusMin/done (四舍五入)", s.todayAvgMin === 25, `got=${s.todayAvgMin}`)
		check("T20: 近 7 天窗口外的数据不计入", s.rangeMin === 120 + 50 + 150, `got=${s.rangeMin}`)
		check("T20: 近 7 天最佳单日", s.rangeBest === 150, `got=${s.rangeBest}`)
		check("T20: 近 7 天完成总数", s.rangeDone === 4 + 2 + 6, `got=${s.rangeDone}`)
	}

	/* --- ② 无数据时: 完成率与平均值用 -1 表示"无数据", 不谎报 0% --- */
	{
		const s = ps.summarize({}, 7, NOW)
		check("T20: 无记录时完成率为 -1 (不是 0%)", s.todayRate === -1, `got=${s.todayRate}`)
		check("T20: 无记录时平均每段为 -1", s.todayAvgMin === -1, `got=${s.todayAvgMin}`)
		check("T20: 无记录时 streak 为 0", s.streak === 0, `got=${s.streak}`)
	}

	/* --- ③ streak: 今天没记录应从昨天起算 (否则每天 0 点归零) --- */
	{
		const days = {
			[key(1)]: day({focusMin: 30, done: 1}),
			[key(2)]: day({focusMin: 30, done: 1}),
			[key(3)]: day({focusMin: 30, done: 1}),
		}
		check("T20: 今天无记录时 streak 从昨天起算", ps.computeStreak(days, NOW) === 3,
			`got=${ps.computeStreak(days, NOW)}`)
		const days2 = {...days, [key(0)]: day({focusMin: 10, done: 1})}
		check("T20: 今天有记录时 streak 含今天", ps.computeStreak(days2, NOW) === 4,
			`got=${ps.computeStreak(days2, NOW)}`)
		const gap = {[key(0)]: day({focusMin: 10}), [key(2)]: day({focusMin: 10})}
		check("T20: 中间断档则 streak 只算到断点", ps.computeStreak(gap, NOW) === 1,
			`got=${ps.computeStreak(gap, NOW)}`)
	}

	/* --- ④ 闸门 1: 话题不相关 → 绝不注入 --- */
	{
		const s = ps.summarize({[key(0)]: day({focusMin: 300, done: 10})}, 7, NOW)
		check("T20: 话题无关时不注入 (问天气)",
			ps.buildFocusHint(s, "今天天气不错啊").hint === "")
		check("T20: 话题相关时注入 (聊工作)",
			ps.buildFocusHint(s, "今天工作好累").hint !== "")
	}

	/* --- ⑤ 闸门 3: 今日不足 25 分钟不值得提 --- */
	{
		const s = ps.summarize({[key(0)]: day({focusMin: 20, done: 1})}, 7, NOW)
		check("T20: 今日专注不足 25 分钟不提", ps.buildFocusHint(s, "我在工作").hint === "")
		const s2 = ps.summarize({[key(0)]: day({focusMin: 25, done: 1})}, 7, NOW)
		check("T20: 刚好 25 分钟会提", ps.buildFocusHint(s2, "我在工作").hint !== "")
	}

	/* --- ⑥ 优先级: 里程碑 > 连续天数 > 今日时长 --- */
	{
		const days = {}
		for (let i = 0; i < 7; i++) days[key(i)] = day({focusMin: 30, done: 1})
		const s = ps.summarize(days, 7, NOW)
		const r1 = ps.buildFocusHint(s, "在写代码", {})
		check("T20: 达标里程碑时优先报里程碑",
			r1.hint.includes("连续一周") && r1.milestoneKey === "streak7", JSON.stringify(r1))
		// 已庆祝过 → 退回下一档 (连续天数)
		const r2 = ps.buildFocusHint(s, "在写代码", {streak7: 123, streak3: 123})
		check("T20: 里程碑只庆祝一次 (已庆祝则退回连续天数)",
			!r2.hint.includes("连续一周") && r2.hint.includes("连续 7 天"), JSON.stringify(r2))
		check("T20: 已庆祝的里程碑不再返回 milestoneKey", r2.milestoneKey === undefined)
	}

	/* --- ⑦ 注入文本自带克制约束 (不放宽 persona 的长度规则) --- */
	{
		const s = ps.summarize({[key(0)]: day({focusMin: 90, done: 3})}, 7, NOW)
		const h = ps.buildFocusHint(s, "今天学习效率不高").hint
		check("T20: 注入文本要求'最多提这一件事'", h.includes("最多提这一件事"), h)
		check("T20: 注入文本要求'不搭就不要提'", h.includes("不搭") || h.includes("不要罗列"), h)
	}
}

/* ============ T21 专注统计扩展: 永久保留 / 终身累计 / 热力图网格 / 月度汇总 ============ */
{
	const ps = await import(pathToFileURL(path.join(root, "tmp-memcheck/pomostats-bundle.mjs")).href)
	const NOW = new Date("2026-09-15T14:00:00")   // 2026-09-15 是周二
	const key = (offset) => ps.dayKey(new Date(NOW.getTime() - offset * 86400000))
	const day = (o = {}) => ({focusMin: 0, done: 0, abort: 0, countUpMin: 0, ...o})

	/* --- ① migrateStats: 旧文件补出 total / best --- */
	{
		const old = {v: 1, days: {
			[key(0)]: day({focusMin: 100, done: 4, countUpMin: 20}),
			[key(1)]: day({focusMin: 50, done: 2}),
		}}
		const changed = ps.migrateStats(old, NOW)
		check("T21: 旧文件迁移返回 changed=true", changed === true)
		check("T21: total.focusMin 由现存 days 累积", old.total?.focusMin === 150, `got=${old.total?.focusMin}`)
		check("T21: total.done 由现存 days 累积", old.total?.done === 6, `got=${old.total?.done}`)
		check("T21: total.countUpMin 累积正确", old.total?.countUpMin === 20, `got=${old.total?.countUpMin}`)
		check("T21: best.dayMin 取现存最大单日", old.best?.dayMin === 120, `got=${old.best?.dayMin}`)
		check("T21: best.streak 取现存最长连续", old.best?.streak === 2, `got=${old.best?.streak}`)
	}

	/* --- ② migrateStats 幂等: 已有 total/best 时不重复累加 --- */
	{
		const s = {v: 1, days: {[key(0)]: day({focusMin: 100})}, total: {focusMin: 999, done: 9, countUpMin: 9}, best: {dayMin: 999, streak: 9}}
		const changed = ps.migrateStats(s, NOW)
		check("T21: 已有 total 时不重复累加", s.total.focusMin === 999, `got=${s.total.focusMin}`)
		check("T21: 字段齐备时 changed=false", changed === false)
	}

	/* --- ③ 保留期: 永久 (不再删 30 天前), 只裁 10 年外 --- */
	{
		const keep = {v: 1, days: {
			[key(60)]: day({focusMin: 10}),      // 60 天前: 旧逻辑会删, 现在必须保留
			[key(300)]: day({focusMin: 10}),     // 300 天前
			[key(4000)]: day({focusMin: 10}),    // 超过 10 年: 防御性裁掉
		}}
		ps.migrateStats(keep, NOW)
		const ks = Object.keys(keep.days)
		check("T21: 60 天前的记录被保留 (永久保留)", ks.includes(key(60)), JSON.stringify(ks))
		check("T21: 300 天前的记录被保留", ks.includes(key(300)), JSON.stringify(ks))
		check("T21: 超过 10 年的记录被裁掉 (防御上限)", !ks.includes(key(4000)), JSON.stringify(ks))
	}

	/* --- ④ addToStore: 按增量累加 (传全量会重复累加, 这是实测踩过的坑) --- */
	{
		const s = {v: 1, days: {[key(0)]: day({focusMin: 200, done: 5, countUpMin: 30})}}
		ps.migrateStats(s, NOW)
		const before = s.total.focusMin                 // 230
		// 模拟: 又完成一个番茄 (focusMin +50, done +1)
		s.days[key(0)].focusMin += 50
		s.days[key(0)].done += 1
		ps.addToStore(s, {focusMin: 50, done: 1})
		check("T21: addToStore 按增量累加 total", s.total.focusMin === before + 50, `got=${s.total.focusMin}`)
		check("T21: addToStore 累加 done 增量", s.total.done === 6, `got=${s.total.done}`)
		// best.dayMin 是从 days 扫出来的 (dayMinutes = focusMin + countUpMin = 250 + 30)
		check("T21: addToStore 刷新 best.dayMin", s.best.dayMin === 280, `got=${s.best.dayMin}`)
		// 再累加一次同样的增量 → 继续增长 (证明是增量而非全量)
		s.days[key(0)].focusMin += 50
		ps.addToStore(s, {focusMin: 50})
		check("T21: 同日多次记录累计正确 (不重复计全量)", s.total.focusMin === before + 100,
			`got=${s.total.focusMin}`)
		check("T21: 只传部分字段时其余不丢", s.total.done === 6, `got=${s.total.done}`)
	}

	/* --- ⑤ bestStreak: 历史最长连续, 不受当前断档影响 --- */
	{
		const days = {
			[key(10)]: day({focusMin: 10}), [key(9)]: day({focusMin: 10}),
			[key(8)]: day({focusMin: 10}), [key(7)]: day({focusMin: 10}), [key(6)]: day({focusMin: 10}),
			[key(2)]: day({focusMin: 10}),
		}
		check("T21: bestStreak 取历史最长段 (5)", ps.bestStreak(days) === 5, `got=${ps.bestStreak(days)}`)
		check("T21: 空 days 的 bestStreak 为 0", ps.bestStreak({}) === 0)
	}

	/* --- ⑥ buildHeatmap: 网格尺寸与周对齐 --- */
	{
		const days = {[key(0)]: day({focusMin: 60}), [key(1)]: day({focusMin: 20})}
		const hm = ps.buildHeatmap(days, 52, NOW)
		check("T21: 热力图 cells 长度 = weeks*7", hm.cells.length === 52 * 7, `got=${hm.cells.length}`)
		check("T21: weeks 字段正确", hm.weeks === 52)
		const filled = hm.cells.filter(Boolean)
		// 起点 = 今天 - (51*7 + 本周已过天数); 从起点到今天应恰好覆盖
		const todayCell = filled.find(c => c.date === key(0))
		check("T21: 今天那格存在且有分钟数", !!todayCell && todayCell.min === 60, JSON.stringify(todayCell))
		check("T21: 昨天的格子有分钟数", filled.find(c => c.date === key(1))?.min === 20)
		check("T21: 不含未来日期", !filled.some(c => c.date > key(0)),
			JSON.stringify(filled.slice(-3)))
		// 行对齐: 每个非 null 格子的行号必须等于它的 getDay()
		let rowOk = true
		hm.cells.forEach((c, i) => {
			if (!c) return
			const row = i % 7
			const gd = new Date(`${c.date}T12:00:00`).getDay()
			if (row !== gd) rowOk = false
		})
		check("T21: 行号与星期对齐 (0=周日)", rowOk)
		check("T21: 有月份标签", hm.monthLabels.length >= 6, `n=${hm.monthLabels.length}`)
	}

	/* --- ⑦ heatLevel 分档 --- */
	{
		check("T21: heatLevel(0)=0", ps.heatLevel(0) === 0)
		check("T21: heatLevel(24)=1", ps.heatLevel(24) === 1)
		check("T21: heatLevel(25)=2", ps.heatLevel(25) === 2)
		check("T21: heatLevel(100)=4", ps.heatLevel(100) === 4)
	}

	/* --- ⑧ monthlyRollup: 按月聚合, 新→旧, 补零 --- */
	{
		const days = {
			"2026-09-01": day({focusMin: 60, done: 2}),
			"2026-09-15": day({focusMin: 40, done: 1}),
			"2026-08-10": day({focusMin: 30, done: 1}),
		}
		const roll = ps.monthlyRollup(days, 12, NOW)
		check("T21: 月度汇总返回 12 项", roll.length === 12, `got=${roll.length}`)
		check("T21: 最新月在最前", roll[0].month === "2026-09", `got=${roll[0].month}`)
		check("T21: 本月聚合为 100 分钟 / 3 完成", roll[0].min === 100 && roll[0].done === 3,
			JSON.stringify(roll[0]))
		check("T21: 上月聚合正确", roll[1].month === "2026-08" && roll[1].min === 30, JSON.stringify(roll[1]))
		check("T21: 无记录的月份补 0", roll[5].min === 0, JSON.stringify(roll[5]))
	}

	/* --- ⑨ 三档范围: summarize 支持 7 / 30 / 365 --- */
	{
		const days = {[key(0)]: day({focusMin: 10}), [key(20)]: day({focusMin: 20}), [key(200)]: day({focusMin: 30})}
		check("T21: 近 7 天不含 20 天前", ps.summarize(days, 7, NOW).rangeMin === 10)
		check("T21: 近 30 天含 20 天前", ps.summarize(days, 30, NOW).rangeMin === 30)
		check("T21: 近 365 天含 200 天前", ps.summarize(days, 365, NOW).rangeMin === 60)
	}
}

/* ============ T22 历史总结: 预算注入 / 软截断 / 归档折叠 ============ */
{
	/* --- ① softTruncate: 句末软截断 --- */
	{
		const s = "第一句话。第二句话。第三句话。"
		const r = core.softTruncate(s, 12)
		check("T22: 软截断落在句末 (无残句)", /[。！？]$/.test(r), JSON.stringify(r))
		check("T22: 软截断结果不超上限", r.length <= 12, `len=${r.length} r=${JSON.stringify(r)}`)
		check("T22: 原文未超限时原样返回", core.softTruncate("短句。", 100) === "短句。")
		const hard = core.softTruncate("一二三四五六七八九十十一十二十三", 8)
		check("T22: 无句末标点时回退硬切加省略号", hard.endsWith("…") && hard.length <= 9, JSON.stringify(hard))
		const far = core.softTruncate("短。然后一大段没有任何标点的超长内容一直写下去写到超出上限为止", 20)
		check("T22: 边界退太狠时回退硬切", far.endsWith("…"), JSON.stringify(far))
	}

	/* --- ② buildSummaryBlock: 字符预算 + 时间正序 + metas 在前 --- */
	{
		const mk = (id, content, createdAt) => ({id, content, createdAt, msgCount: 1, tokenCount: 1})
		const sums = [
			mk("s1", "A".repeat(300), 3000),
			mk("s2", "B".repeat(300), 2000),
			mk("s3", "C".repeat(300), 1000),
		]
		const metas = [mk("meta-1", "〔1/1–2/1〕更早的脉络", 500)]
		const small = core.buildSummaryBlock(sums, {budget: 400, metas: []})
		check("T22: 预算小时只注入最新一条",
			small.includes("A".repeat(10)) && !small.includes("B".repeat(10)), `len=${small.length}`)
		const big = core.buildSummaryBlock(sums, {budget: 5000, metas: []})
		check("T22: 预算够时全部注入", big.includes("A") && big.includes("B") && big.includes("C"))
		check("T22: 注入顺序为时间正序 (最旧在最前)",
			big.indexOf("CCC") < big.indexOf("BBB") && big.indexOf("BBB") < big.indexOf("AAA"),
			JSON.stringify(big.slice(0, 60)))
		const withMeta = core.buildSummaryBlock(sums, {budget: 5000, metas})
		check("T22: metas 排在逐条摘要之前",
			withMeta.indexOf("更早的脉络") < withMeta.indexOf("CCC"), JSON.stringify(withMeta.slice(0, 80)))
		check("T22: 无摘要无归档时返回空串", core.buildSummaryBlock([], {}) === "")
		const huge = [mk("h1", "X".repeat(2000), 100)]
		check("T22: 单条超预算时仍注入它 (否则功能失效)",
			core.buildSummaryBlock(huge, {budget: 100}).includes("X"))
	}

	/* --- ③ foldDroppedSummaries: 折叠归档 --- */
	{
		const mk = (id, content, createdAt) => ({id, content, createdAt, msgCount: 5, tokenCount: 1})
		const dropped = [
			mk("d2", "第二段摘要内容", 2000),
			mk("d1", "第一段摘要内容", 1000),
		]
		const meta = core.foldDroppedSummaries(dropped)
		check("T22: 折叠产出 meta", !!meta && typeof meta.content === "string")
		check("T22: meta id 为区间指纹 (可跨实例去重)", meta.id === "meta-1000-2000", `got=${meta.id}`)
		check("T22: meta.createdAt 取最早那条 (时间轴位置正确)", meta.createdAt === 1000, `got=${meta.createdAt}`)
		check("T22: meta 含日期区间标记", /〔\d+\/\d+–\d+\/\d+〕/.test(meta.content), JSON.stringify(meta.content))
		check("T22: meta 内容为时间正序 (第一段在第二段前)",
			meta.content.indexOf("第一段") < meta.content.indexOf("第二段"), JSON.stringify(meta.content))
		check("T22: meta.msgCount 为各条之和", meta.msgCount === 10, `got=${meta.msgCount}`)
		check("T22: meta 长度受上限约束", meta.content.length <= core.MAX_META_CHARS + 1, `len=${meta.content.length}`)
		check("T22: 空输入返回 null", core.foldDroppedSummaries([]) === null)
		check("T22: 相同输入折叠出相同 id (双实例去重依据)",
			core.foldDroppedSummaries(dropped).id === meta.id)
	}

	/* --- ④ 集成: 超上限时自动裁剪 → 折叠归档 → 落盘 → 注入块含归档 --- */
	{
		resetDisk()
		// 注意 id 前缀必须与其他测试块**不重复**: deletedIds(会话墓碑) 是模块级 Set,
		// 跨测试块永不复位 —— 用 `sum-N` 会撞上前面摘要测试留下的墓碑而被整批过滤。
		const many = Array.from({length: 30}, (_, i) => ({
			id: `t22s-${i}`,
			content: `第${i}段摘要内容`,
			createdAt: 1000 + i,           // 严格递增: 被裁的必然是最旧的几段
			msgCount: 25, tokenCount: 10,
		}))
		// 载入即触发存量超标收敛 (load 内的 trimSummariesToMax + flushPersist)
		seedDisk([], {summaries: many, summarizedMsgCount: 750})
		mem.reloadMemory()
		// 断言落盘结果: 载入时的存量裁剪必须真的写进磁盘 (只改内存 = 重启后复原)。
		// 这里先等 flushMemoryPersist 排空写队列 —— load 触发的落盘走串行队列, 是异步的。
		await mem.flushMemoryPersist()
		const disk = JSON.parse(files.get("memory.json") || "{}")
		const kept = disk.summaries ?? []
		const metas = disk.meta ?? []
		check("T22: 超上限的摘要被裁到上限 (24)", kept.length === 24, `n=${kept.length}`)
		check("T22: 保留的是最新的 24 段 (最旧的被裁)",
			kept.every(s => !/第[0-5]段/.test(s.content)), JSON.stringify(kept.map(s => s.content).slice(0, 3)))
		check("T22: 被裁的摘要折进了 meta 归档 (不再直接丢弃)", metas.length >= 1,
			`meta=${JSON.stringify(metas.map(m => m.id))}`)
		check("T22: 归档 meta 用区间指纹 id", !!metas[0] && String(metas[0].id).startsWith("meta-"),
			JSON.stringify(metas[0]?.id))
		check("T22: 归档内容含被裁段落的摘录", !!metas[0] && /第[0-5]段/.test(metas[0].content),
			JSON.stringify(metas[0]?.content))
		const block = mem.summaryBlock()
		check("T22: 注入块包含归档 (最久远脉络保留下来)", block.includes("〔"),
			JSON.stringify(block.slice(0, 100)))
		check("T22: 注入块总长受预算约束 (<= 4000 字符)",
			block.length <= 4000, `len=${block.length}`)
	}
}

/* ============ T23 自动裁剪下的摘要循环: 游标重算 + id 时间戳指纹 ============
 * 背景 (真 bug, 2026-09-16 发现): 自动裁剪从**前面**删消息, 而 summarizedMsgCount
 * 是"从头起已摘要的条数"这一长度语义。裁剪后:
 *   ① 游标不重算 → 停在旧值;  `pending<=0` 分支又把它硬算成 total-20, 把游标
 *      **往回缩** → 已摘要的近端消息被当待压缩内容重新总结;
 *   ② 摘要 id 用**下标** → 裁剪后下标重排, 每轮算出同一个 id 被落盘去重丢掉。
 * 两者叠加: 摘要器卡在同 20 条上无限打转, 新消息永不入库 (实测 200 轮只剩 2 条摘要)。
 * 本块用真实消息时间戳 + 真实裁剪动作复现整条链路。
 */
{
	files.clear()
	mem.reloadMemory()
	const RAW_WINDOW = 20
	const HISTORY_KEEP = 20
	let messages = []
	let clock = 1_700_000_000_000
	for (let round = 0; round < 120; round += 1) {
		messages.push({role: "user", content: `u${round}`, ts: clock++})
		messages.push({role: "assistant", content: `a${round}`, ts: clock++})
		const summarized = await mem.summarizeIfNeeded(messages, async () => "【摘要】压缩片段。")
		await mem.flushMemoryPersist()
		// 仅在摘要成功后裁剪 —— 与 App.vue `if (summarized && cfg.trimHistory && ...)` 一致;
		// P5 起裁剪量由 safeTrimDrop 给出 (只裁"已进过摘要的前缀"), 并登记被裁条数
		if (summarized && messages.length > HISTORY_KEEP) {
			const dropN = mem.safeTrimDrop(messages.length)
			if (dropN > 0) {
				messages = [
					{role: "system", content: "（更早的对话已压缩为历史总结）", ts: clock++, placeholder: true},
					...messages.slice(dropN),
				]
				mem.notifyHistoryTrimmed(dropN)
				await mem.flushMemoryPersist()
			}
		}
	}
	const disk = JSON.parse(files.get("memory.json") || "{}")
	const sums = disk.summaries ?? []
	const ids = sums.map(s => s.id)
	check("T23: 摘要 id 全部唯一 (下标指纹会让新摘要被去重丢掉)",
		new Set(ids).size === ids.length, `n=${ids.length} uniq=${new Set(ids).size}`)
	check("T23: id 用消息时间戳区间指纹 (非下标)",
		ids.every(id => /^sum-\d{10,}-\d{10,}$/.test(String(id))), JSON.stringify(ids.slice(0, 3)))
	check("T23: 摘要条数远多于 2 (原 bug 下只留 2 条)", sums.length >= 5, `n=${sums.length}`)
	// 相邻区间必须严格衔接 (无空洞/无重叠)
	let prevLast = null, breaks = 0, deltas = new Set()
	for (const id of ids) {
		const m = String(id).match(/^sum-(\d+)-(\d+)$/)
		if (!m) continue
		const first = Number(m[1]), last = Number(m[2])
		if (prevLast !== null) { if (first <= prevLast) breaks += 1; deltas.add(first - prevLast) }
		prevLast = last
	}
	check("T23: 相邻摘要区间无重叠/无倒退", breaks === 0, `breaks=${breaks}`)
	check("T23: 区间缺口恒定 (说明窗口稳定推进, 非反复重压同一段)",
		deltas.size === 1, `deltas=${[...deltas].join(",")}`)
	const covered = sums.reduce((n, s) => n + (s.msgCount || 0), 0)
	check("T23: 累计覆盖远超早期那 25 条 (原 bug 下恒为 25)",
		covered > 100, `covered=${covered}`)
	// P5: 游标不再是"保留条数"这种会被裁剪打乱的绝对值, 而是两个单调计数之差 ——
	// 当前数组里的"下一个要摘要的位置"必须小于数组长度, 且不能把没总结的消息跳过去
	// (旧实现把保留的 20 条标成已摘要 ⇒ 它们永远进不了摘要, 见 probe-trim-skip.mjs)
	const resume = (disk.summarizedMsgCount ?? 0) - (disk.trimmedMsgCount ?? 0)
	check("T23: 裁剪后游标(累计已摘要 - 累计已裁剪)落在数组内且不跳过未总结消息",
		(disk.trimmedMsgCount ?? 0) > 0 && resume >= 0 && resume <= messages.length &&
		resume >= messages.length - RAW_WINDOW - 25,
		`sum=${disk.summarizedMsgCount} trimmed=${disk.trimmedMsgCount} resume=${resume} len=${messages.length}`)
	void RAW_WINDOW
}

/* ============ T24 同段摘要去重 (双实例游标错位) ============
 * 背景 (真 bug, 2026-09-16 用户截图报告"历史总结重复总结了两条"):
 * 主界面与悬浮窗的消息列表长度可能差 1 (主界面裁剪后会插一条占位 system 消息,
 * 悬浮窗从磁盘 loadChat 读到的没有), 于是 start = min(游标, total - RAW_WINDOW)
 * 两边算出来差 1 —— 同一段对话被总结成 sum-2-26 与 sum-3-27 两条,
 * **id 不同, 按 id 去重抓不住**, 界面上就是两条几乎一样的历史总结。
 * 修复: 按**时间戳区间重叠**判定 (重叠 ≥ 较短段 50% 即同段), 写入时替换、载入时收敛。
 */
{
	// ① 区间解析
	check("T24: rangeOfSummary 解析时间戳区间", (() => {
		const r = core.rangeOfSummary("sum-1700000000000-1700000000024")
		return !!r && r.start === 1700000000000 && r.end === 1700000000024
	})())
	check("T24: 非区间指纹 (旧版 uid) 返回 null",
		core.rangeOfSummary("m3x9k2-random") === null)

	// ② 重叠判定: 用户实际遇到的那两条 (区间起点差 1)
	check("T24: 同段两条 (区间错位) 判定为重叠",
		core.summariesOverlap({start: 2000, end: 2600}, {start: 2100, end: 2700}) === true)
	// ③ 正常相邻两批必须**不**重叠, 否则会误删
	check("T24: 正常相邻两批零重叠 → 不判为同段",
		core.summariesOverlap({start: 2000, end: 2400}, {start: 2500, end: 2900}) === false)
	check("T24: 首尾相接 (end+1 = start) 不算重叠",
		core.summariesOverlap({start: 100, end: 200}, {start: 201, end: 300}) === false)
	check("T24: 一条完全包含另一条 → 重叠",
		core.summariesOverlap({start: 100, end: 400}, {start: 150, end: 200}) === true)
	check("T24: 各差 50% 的临界情况判为重叠",
		core.summariesOverlap({start: 0, end: 100}, {start: 50, end: 150}) === true)

	// ④ 集成: 载入时自动收敛历史遗留的重复摘要。
	// 注意 id 必须是真实区间指纹格式 (sum-<数字>-<数字>): rangeOfSummary 只认这个,
	// 旧版随机 uid 无法参与重叠判定 (这是有意的保守行为, 见实现注释)。
	files.clear()
	files.set("memory.json", JSON.stringify({
		memories: [],
		summaries: [
			{id: "sum-1700000001000-1700000003600", content: "用户和小捡玩数数游戏，从 2 数到 20。", createdAt: 5000, msgCount: 25, tokenCount: 10},
			{id: "sum-1700000001100-1700000003700", content: "用户让 Nori 陪自己数数，从 2 数到 20，Nori 一路接住。", createdAt: 5005, msgCount: 25, tokenCount: 10},
			// 一条正常的不同段摘要, 必须保留
			{id: "sum-1700000005000-1700000007600", content: "用户说喜欢下雨天。", createdAt: 6000, msgCount: 25, tokenCount: 10},
			// 旧版随机 uid: 无法解析区间, 按"保守不删"处理, 必须保留
			{id: "legacy-random-uid-1", content: "旧版本留下的摘要。", createdAt: 4000, msgCount: 25, tokenCount: 10},
		],
		summarizedMsgCount: 0, tombstones: [], meta: [],
	}))
	mem.reloadMemory()
	const after = mem.listAll().summaries
	check("T24: 载入时同段重复被收敛为一条 (4 → 3)",
		after.length === 3, `n=${after.length} ids=${after.map(s => s.id).join(",")}`)
	check("T24: 保留的是较新的那条 (createdAt 更大)",
		after.some(s => s.id === "sum-1700000001100-1700000003700")
		&& !after.some(s => s.id === "sum-1700000001000-1700000003600"),
		after.map(s => s.id).join(","))
	check("T24: 不同段的摘要不受影响 (不误删)",
		after.some(s => s.id === "sum-1700000005000-1700000007600"), after.map(s => s.id).join(","))
	check("T24: 旧版随机 uid 摘要不被误删 (无法解析即保守保留)",
		after.some(s => s.id === "legacy-random-uid-1"), after.map(s => s.id).join(","))
	// 收敛结果要落盘, 否则重启后又回来
	await mem.flushMemoryPersist()
	const onDisk = JSON.parse(files.get("memory.json")).summaries
	check("T24: 收敛结果已落盘 (重启后不复现)",
		onDisk.length === 3, `disk=${onDisk.length}`)

	// ⑤ 写入侧: 预置一条"同段旧摘要"(模拟另一实例已写入), 在同一游标位置再总结一次
	//    —— 新摘要必须**替换**旧摘要, 而不是并存两条。
	//    注: 不能靠"把游标设成 1 来模拟错位"——单模块里落盘合并 (adoptFromDisk 取 max
	//    游标) 会把游标抬回去, 复现不了两个**独立 cache** 的真实情形。
	files.clear()
	const conv = Array.from({length: 50}, (_, i) => ({
		role: i % 2 ? "assistant" : "user",
		content: `数数 ${i}`,
		ts: 1_700_000_000_000 + i,
	}))
	// 磁盘上先放一条覆盖 [0,24] 的摘要 (即本次将要生成的那一段)
	files.set("memory.json", JSON.stringify({
		memories: [],
		summaries: [{
			id: "sum-1700000000000-1700000000024", content: "AA 另一实例写的同段摘要",
			createdAt: 1000, msgCount: 25, tokenCount: 10,
		}],
		summarizedMsgCount: 0, tombstones: [], meta: [],
	}))
	mem.reloadMemory()
	mem.__setSummaryCursorForTest(0)
	// 这里**不** flush: 避免 adoptFromDisk 把游标改写掉
	const did = await mem.summarizeIfNeeded(conv, async () => "BB 本次新写的摘要")
	check("T24: 写入侧总结确实发生", did === true)
	const nowIds = mem.listAll().summaries
	check("T24: 写入侧同段摘要被替换而非并存 (只留 1 条)",
		nowIds.length === 1, `n=${nowIds.length} ids=${nowIds.map(s => s.id).join(",")}`)
	check("T24: 保留的是本次新写入的那条 (内容为 BB)",
		nowIds.length === 1 && nowIds[0].content.includes("BB"),
		JSON.stringify(nowIds.map(s => s.content.slice(0, 12))))
	await mem.flushMemoryPersist()
	const onDisk2 = JSON.parse(files.get("memory.json")).summaries
	check("T24: 落盘后仍只有 1 条 (不会复活)",
		onDisk2.length === 1, `disk=${onDisk2.length}`)
}

/* ============ T26 长期记忆重复 (2026-09-26 用户反馈: "长期记忆有的还是会有重复") ============
 * 实测背景 (tmp-memcheck/probe-mem-dup.mjs + probe-mem-dup-tuning2.mjs):
 *  ① 判重只有"归一化后原文包含"一道闸, 换成另一种说法就并存两条
 *     (「我是做前端的」+「我的职业是前端开发」→ 2 条);
 *  ② AI 判重的成本闸 keywordHit 在"单条候选内 early-break、不跨候选累计" ——
 *     旧「我在准备考研考试」+ 新「我准备考研」词面只重叠 2 个 bigram, 实测判为未命中
 *     → usedLlm=false, 直接走 merge 兜底 → 库里两条并存;
 *  ③ 摘要要点回流会写进长期记忆, 与已有记忆换说法时重复录入。
 * 修法: 近重复 (Dice ≥ NEAR_DUP_DICE) 只用来**召回候选**并触发 AI 判重 (不替代判重);
 *       决策漏判时, "原文包含"的兜底去重保证不新增; 载入时收敛存量重复。
 * 反向约束 (重点): 字符级相似度**不能**当合并判据 —— 实测「我喜欢猫」/「我喜欢猫毛」= 0.857、
 *       「我不喜欢下雨天」/「我喜欢下雨天」= 0.727 (方向相反) 都会误并, 故 A 组守着
 *       "近重复但不同的事"绝不能被自动合并。 */
{
	const fact26 = (content, type = "fact") => ({
		id: `m26_${Math.random().toString(36).slice(2, 8)}`, content, type,
		importance: 0.8, confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now(),
		lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365,
	})
	/* A. 载入时收敛存量重复 (只认**归一化后完全相同**), 并落盘 (下次启动不复现)
	 * ⚠ 时间戳必须**全部钉成同一毫秒**: 「我喜欢下雨天」与「我不喜欢下雨天」本来是一对改口,
	 *   载入时的"存量改口收敛"（collapseReversals）只在**判得出先后**时作废更早的那条;
	 *   用 Date.now() 逐条生成时, 机器一忙就会差 1~2ms → 那条被正当地作废 → 本块断言全崩。
	 *   (2026-09-28 实测: 差 2ms 就复现 "存量改口收敛: 作废旧说法 1 条", 7 条变 5 条。)
	 *   这里要测的是**去重**, 所以显式给它们同一个时间戳, 让改口收敛按设计"判不出先后就不动"。 */
	const T26BASE = Date.now()
	const mk26 = (id, content, over = {}) =>
		mkMem(id, content, {createdAt: T26BASE, updatedAt: T26BASE, ...over})
	files.clear()
	seedDisk([
		mk26("dup1", "我喜欢下雨天", {importance: 0.6}),
		mk26("dup2", "我喜欢下雨天。", {importance: 0.9, tags: ["explicit"], decayDays: null}),
		mk26("dup3", "我最近在准备考研", {type: "project"}),
		mk26("dup4", "在准备考研", {type: "project"}),
		mk26("keep1", "我家养了一只猫", {type: "fact", decayDays: 365}),
		mk26("keep2", "我喜欢猫毛", {type: "fact", decayDays: 365}),
		mk26("keep3", "我不喜欢下雨天", {}),
	])
	mem.reloadMemory()
	const deduped = mem.listAll().memories
	check("T26-A: 载入时\"完全相同(含仅标点差)\"的重复被合并 (7 → 6)", deduped.length === 6,
		`count=${deduped.length} ${JSON.stringify(deduped.map(m => m.content))}`)
	check("T26-A: 合并保留更完整的内容 (带句号的那条)",
		deduped.some(m => m.content === "我喜欢下雨天。"),
		JSON.stringify(deduped.map(m => m.content)))
	check("T26-A: 合并取更永久的一方 (decayDays=null 不被可衰减条吃掉)",
		deduped.find(m => (m.tags ?? []).includes("explicit"))?.decayDays === null,
		JSON.stringify(deduped.find(m => (m.tags ?? []).includes("explicit"))))
	check("T26-A: **包含**关系不算重复 —— 方向相反的近重复不被合并",
		deduped.some(m => m.content === "我不喜欢下雨天"))
	check("T26-A: **包含**关系不算重复 —— 只差一字的近重复不被合并",
		deduped.some(m => m.content === "我喜欢猫毛"))
	check("T26-A: **包含**关系不算重复 —— 子串不再吞掉短记忆",
		deduped.some(m => m.content === "在准备考研") && deduped.some(m => m.content === "我最近在准备考研"),
		JSON.stringify(deduped.map(m => m.content)))
	await mem.flushMemoryPersist()
	check("T26-A: 收敛结果已落盘 (重启后不复现)",
		(JSON.parse(files.get("memory.json")).memories ?? []).length === 6,
		`disk=${(JSON.parse(files.get("memory.json")).memories ?? []).length}`)
	mem.reloadMemory()
	check("T26-A: 重载后仍是 6 条 (不会复活)", mem.listAll().memories.length === 6)

	/* A2. 反例守卫: 短记忆**绝不能**被"包含它的长记忆"吞掉 ——
	 * 这正是"把 isSameContent 当全库收敛判据"会踩的坑 (实测 `isSameContent("猫","我家养了一只猫")=true`)。
	 * 该判据在写入合并里是对的 (用户又提了同一件事), 但用于每次载入的自动收敛会静默删数据。 */
	files.clear()
	seedDisk([
		mkMem("s1", "咖啡", {type: "preference"}),
		mkMem("s2", "每天喝咖啡", {type: "preference"}),
		mkMem("s3", "研究生", {type: "project"}),
		mkMem("s4", "我在准备考研, 想读研究生", {type: "project"}),
	])
	mem.reloadMemory()
	const shortKept = mem.listAll().memories
	check("T26-A2: 短记忆不被长记忆的子串判定吞掉 (4 条全在)", shortKept.length === 4,
		JSON.stringify(shortKept.map(m => m.content)))

	/* B. 决策漏判时的"原文包含"兜底: 不新增、也不弹"记住了" */
	files.clear()
	seedDisk([mkMem("t26b", "我在准备考研", {type: "project", importance: 0.8})])
	mem.reloadMemory()
	const dupRes = await mem.applyLlmMemoryDecision(
		[fact26("我在准备考研")],
		async () => JSON.stringify({memory: []}),   // 决策什么都没说
	)
	check("T26-B: 决策漏判时不新增", dupRes.added === 0, JSON.stringify(dupRes))
	check("T26-B: 库里仍只有 1 条", mem.listAll().memories.length === 1,
		JSON.stringify(mem.listAll().memories.map(m => m.content)))
	// 与规则通道串起来: 不弹"记住了" (没有新东西可记)
	const rDup = await mem.extractMemoriesSmart("我在准备考研", async (p) =>
		p.includes("记忆库管理员") ? JSON.stringify({memory: []}) : JSON.stringify({facts: []}))
	check("T26-B: 重复发言不弹'记住了'", rDup.tips.length === 0, `tips=${JSON.stringify(rDup.tips)}`)

	/* C. 近重复 (换说法) 走 AI 判重: UPDATE 吸收, 不并存两条 */
	files.clear()
	seedDisk([mkMem("t26c", "我在准备考研考试", {type: "project", importance: 0.8})])
	mem.reloadMemory()
	const cRes = await mem.applyLlmMemoryDecision([fact26("我准备考研")], async () =>
		JSON.stringify({memory: [{id: "t26c", text: "我在准备考研考试", event: "UPDATE"}]}))
	check("T26-C: 近重复被判重并吸收 (added=0)", cRes.added === 0 && cRes.usedLlm === true, JSON.stringify(cRes))
	check("T26-C: 库里仍只有 1 条 (换说法不再并存)", mem.listAll().memories.length === 1,
		JSON.stringify(mem.listAll().memories.map(m => m.content)))

	/* D. 反向守卫: 相似度高但**内容更短**的 UPDATE 不改写旧条 (避免信息退化) */
	files.clear()
	seedDisk([mkMem("t26d", "我的名字叫小明，是个前端工程师", {type: "fact", decayDays: 365})])
	mem.reloadMemory()
	await mem.applyLlmMemoryDecision([fact26("我叫小明")], async () =>
		JSON.stringify({memory: [{id: "t26d", text: "我叫小明", event: "UPDATE"}]}))
	const dList = mem.listAll().memories
	check("T26-D: 更短的 UPDATE 不覆盖更完整的旧条",
		dList.length === 1 && dList[0].content === "我的名字叫小明，是个前端工程师",
		JSON.stringify(dList.map(m => m.content)))

	/* E. 决策 NONE (库里已有同一件事) 也必须吸收, 否则又并存两条;
	 *    **只吸收被点名的那个事实**, 同批里真正的新事实照常入库 */
	files.clear()
	seedDisk([mkMem("t26e", "我在准备考研考试", {type: "project", importance: 0.8})])
	mem.reloadMemory()
	const eRes = await mem.applyLlmMemoryDecision(
		[fact26("我准备考研", "project"), fact26("我周末想去打羽毛球", "event")],
		async () => JSON.stringify({memory: [{id: "t26e", event: "NONE"}]}),
	)
	const eList = mem.listAll().memories
	check("T26-E: 决策 NONE 时近重复事实被吸收 (added=1, 只加了真正的新事实)",
		eRes.added === 1, JSON.stringify(eRes))
	check("T26-E: 库内 = 旧条 + 新事实 (没有变成 3 条)",
		eList.length === 2, JSON.stringify(eList.map(m => m.content)))
	check("T26-E: 近重复说法没有并存",
		!eList.some(m => m.content === "我准备考研"), JSON.stringify(eList.map(m => m.content)))
}

/* ============ T27 句尾语气词导致的"同一件事两条" (2026-09-26 用户实测反馈) ============
 * 用户原话: 「比如我的名字是小明哦 会出现『我的名字是小明』和『是小明哦』两条记忆」。
 * 实测根因 (tmp-memcheck/probe-mem-name-dup.mjs):
 *   规则通道把「我的名字是小明哦」抽成「小明哦」("我的名字是"被当主语剥掉, 句尾"哦"留在内容里),
 *   而 AI 通道给出的可能是「我的名字是小明哦」/「是小明哦」; 归一化后两两互不包含 ⇒ 并存两条。
 * 修法两条:
 *   ① 写入侧判重统一用 normalizeForCompare (在归一化之上剥句尾语气词) —— 新数据不再产生;
 *   ② 存量收敛放行"少主语前缀"那一档 (collapseSameContent) —— 旧数据自动收。
 * 反向约束: 剥句尾语气词**不能**把方向相反的句子归一成同一串 ("不喜欢下雨天" vs "喜欢下雨天"
 * 的"不"在句首, 不受影响), 也不能让短记忆被长记忆吞掉 —— 下面 A/B 两组守着。 */
{
	files.clear()
	seedDisk([])
	mem.reloadMemory()
	// ① 规则通道: 只说这一句, 只该有一条
	mem.addMemoriesFromText("我的名字是小明哦")
	const one = mem.listAll().memories
	check("T27: 单句「我的名字是小明哦」只落一条", one.length === 1, JSON.stringify(one.map(m => m.content)))
	// ② 换说法再说一遍 (带/不带语气词) 不该变两条
	mem.addMemoriesFromText("我的名字是小明")
	mem.addMemoriesFromText("我叫小明")
	const after = mem.listAll().memories
	check("T27: 换个说法说同一件事仍是 1 条", after.length === 1,
		JSON.stringify(after.map(m => m.content)))

	// ③ 存量收敛: 旧数据里已经并存的两条要被收掉 (含"少了主语"的形态)
	files.clear()
	seedDisk([
		mkMem("n1", "我的名字是小明", {type: "fact", decayDays: 365}),
		mkMem("n2", "是小明哦", {type: "fact", decayDays: 365}),
	])
	mem.reloadMemory()
	const collapsed = mem.listAll().memories
	check("T27: 存量「我的名字是小明」+「是小明哦」收敛为 1 条", collapsed.length === 1,
		JSON.stringify(collapsed.map(m => m.content)))

	// ④ 带主语前缀的形态同样收 (「小明哦」+「我的名字是小明」)
	files.clear()
	seedDisk([
		mkMem("n3", "小明哦", {type: "fact", decayDays: 365}),
		mkMem("n4", "我的名字是小明", {type: "fact", decayDays: 365}),
	])
	mem.reloadMemory()
	check("T27: 存量「小明哦」+「我的名字是小明」收敛为 1 条",
		mem.listAll().memories.length === 1,
		JSON.stringify(mem.listAll().memories.map(m => m.content)))

	// ⑤ 反向守卫 A: 方向相反的句子不能被语气词归一化**合并成一条**
	//    (2026-09-27 起: 它们会走「改口消解」→ 后说的留生效列表, 先说的进「已作废」可还原。
	//     守卫的要点是「不能把两条揉成一条混合内容」, 不是「必须两条都留着」。)
	files.clear()
	{
		const t0 = Date.now()
		seedDisk([
			mkMem("g1", "我不喜欢下雨天", {createdAt: t0, updatedAt: t0}),
			mkMem("g2", "我喜欢下雨天", {createdAt: t0 + 60000, updatedAt: t0 + 60000}),
		])
	}
	mem.reloadMemory()
	const revKept = mem.listAll().memories.map(m => m.content)
	const revInv = mem.listInvalidMemories().map(m => m.content)
	check("T27: 反向守卫 — 方向相反的两条不会被「合并」成一条混合内容",
		revKept.length === 1 && revKept[0] === "我喜欢下雨天" && revInv.length === 1 && revInv[0] === "我不喜欢下雨天",
		`生效=${JSON.stringify(revKept)} 已作废=${JSON.stringify(revInv)}`)

	// ⑥ 反向守卫 B: 带语气词的短记忆也不被长记忆吞掉
	files.clear()
	seedDisk([
		mkMem("g3", "咖啡", {type: "preference"}),
		mkMem("g4", "每天喝咖啡", {type: "preference"}),
	])
	mem.reloadMemory()
	check("T27: 反向守卫 — 「咖啡」不被「每天喝咖啡」吞掉",
		mem.listAll().memories.length === 2,
		JSON.stringify(mem.listAll().memories.map(m => m.content)))
}

/* ============ T28 目标收尾判定 (2026-09-27 用户要求: 回答完后 LLM 自己判断何时删掉目标) ============
 * 这个动作会**删用户数据**, 所以门禁守的是"宁可漏判, 绝不误删":
 *   ① 明确说完成/放弃 → 删;
 *   ② 只是提到进度/含糊 → 不删;
 *   ③ 没有目标时不调 LLM (零调用);
 *   ④ LLM 编造 id / 返回垃圾 / 抛错 / 超时 → 什么都不删;
 *   ⑤ 解析容错与"只认清单内 id";
 *   ⑥ 删掉的目标要真的从库和「陪着你的事」列表消失 (经 removeGoal, 有墓碑防复活)。 */
{
	const goal = (id, content) => mkMem(id, content, {type: "project", importance: 0.85, tags: ["goal"], decayDays: null})
	const rawDone = (ids) => JSON.stringify({done: ids.map(id => ({id, reason: "主人说做完了"}))})

	/* ① 明确完成 → 删 */
	resetDisk()
	seedDisk([goal("g1", "考雅思 7 分"), mkMem("m1", "我喜欢下雨天", {})])
	mem.reloadMemory()
	let calls = 0
	const del = await mem.pruneDoneGoals("我雅思考完了，7 分！", async () => { calls += 1; return rawDone(["g1"]) })
	check("T28: 明确完成 → 目标被删", del.length === 1 && del[0] === "考雅思 7 分", JSON.stringify(del))
	check("T28: 只删目标, 普通记忆不受影响",
		mem.listGoals().length === 0 && mem.listAll().memories.some(m => m.content === "我喜欢下雨天"),
		JSON.stringify(mem.listAll().memories.map(m => m.content)))
	check("T28: 删目标时确实调了 LLM (1 次)", calls === 1, `calls=${calls}`)
	await mem.flushMemoryPersist()
	check("T28: 落盘后也不在 (不会复活)",
		!(JSON.parse(files.get("memory.json")).memories ?? []).some(m => m.id === "g1"),
		JSON.stringify((JSON.parse(files.get("memory.json")).memories ?? []).map(m => m.id)))

	/* ② 只是提到进度 → 不删 */
	resetDisk()
	seedDisk([goal("g2", "坚持跑步")])
	mem.reloadMemory()
	const keep = await mem.pruneDoneGoals("最近有点忙，跑步还在坚持", async () => JSON.stringify({done: []}))
	check("T28: 只是提到进度 → 不删", keep.length === 0 && mem.listGoals().length === 1,
		`removed=${JSON.stringify(keep)} goals=${mem.listGoals().length}`)

	/* ③ 没有目标 → 零调用 (既省钱也防误删) */
	resetDisk()
	seedDisk([mkMem("n1", "我喜欢下雨天", {})])
	mem.reloadMemory()
	let calls2 = 0
	const none = await mem.pruneDoneGoals("我雅思考完了", async () => { calls2 += 1; return rawDone(["n1"]) })
	check("T28: 库里没有目标时**不调** LLM", calls2 === 0, `calls=${calls2}`)
	check("T28: 且什么都没删", none.length === 0 && mem.listAll().memories.length === 1, JSON.stringify(none))

	/* ④ 编造 id / 垃圾输出 / 抛错 / 超时 → 什么都不删 */
	resetDisk()
	seedDisk([goal("g3", "考雅思 7 分")])
	mem.reloadMemory()
	const fake = await mem.pruneDoneGoals("考完了", async () => JSON.stringify({done: [{id: "不存在的id"}]}))
	check("T28: LLM 编造 id → 忽略, 不删", fake.length === 0 && mem.listGoals().length === 1, JSON.stringify(fake))
	const junk = await mem.pruneDoneGoals("考完了", async () => "我觉得应该删掉吧（不是 JSON）")
	check("T28: 非 JSON 输出 → 不删", junk.length === 0 && mem.listGoals().length === 1, JSON.stringify(junk))
	const boom = await mem.pruneDoneGoals("考完了", async () => { throw new Error("网络挂了") })
	check("T28: LLM 抛错 → 不删", boom.length === 0 && mem.listGoals().length === 1, JSON.stringify(boom))
	const slow = await mem.pruneDoneGoals("考完了", () => new Promise(r => setTimeout(() => r(rawDone(["g3"])), 6000)))
	check("T28: LLM 超时 (4s) → 不删", slow.length === 0 && mem.listGoals().length === 1, JSON.stringify(slow))

	/* ⑤ 解析容错: 围栏 / 纯数组 / 纯 id 字符串 / 去重 / 丢弃清单外 id
	 * 注意: parseLlmGoalDone 由 index.ts 导出 (memory bundle), 不在 core bundle 里 */
	const valid = new Set(["a", "b"])
	check("T28: 解析容忍 ```json 围栏",
		mem.parseLlmGoalDone('```json\n{"done":[{"id":"a"}]}\n```', valid).length === 1)
	check("T28: 解析容忍纯数组 [{id}]",
		mem.parseLlmGoalDone('[{"id":"a"},{"id":"b"}]', valid).length === 2)
	check("T28: 解析容忍纯 id 字符串数组",
		mem.parseLlmGoalDone('["a"]', valid).length === 1)
	check("T28: 解析会去重",
		mem.parseLlmGoalDone('{"done":[{"id":"a"},{"id":"a"}]}', valid).length === 1)
	check("T28: 解析会丢掉不在清单里的 id",
		mem.parseLlmGoalDone('{"done":[{"id":"a"},{"id":"zzz"}]}', valid).length === 1)
	const prompt = mem.buildLlmGoalDonePrompt([{id: "x1", content: "考雅思"}], "考完了", [])
	check("T28: 提示词带上了目标 id 与内容", prompt.includes("x1 | 考雅思"))
	check("T28: 提示词明确写了\"不确定就不要删\"", prompt.includes("不要删"))
}

/* ============ T25 openingMemoryBlock: 语音开场记忆注入 ============
 * 背景（2026-09-26 实机核查）：语音会话以前**只发人设**，记忆全靠 `recall_memory` 工具，
 * 而两份报告的 `toolCalls` 都是 0 ⇒ 语音里她**零记忆**（不知道你叫什么）。
 * 这里守两件事：① 没有当前提问时也能给出"身份/核心"记忆块；② 开场注入**不动 accessCount**。 */
{
	files.clear()
	seedDisk([
		mkMem("o1", "主人最喜欢的食物是拉面", {type: "fact", importance: 0.95, tags: ["explicit"], decayDays: null}),
		mkMem("o2", "主人的名字叫小明", {type: "fact", importance: 0.9, tags: ["identity"], decayDays: null}),
		mkMem("o3", "随口提过一句天气", {type: "preference", importance: 0.3, tags: [], decayDays: 90}),
	])
	mem.reloadMemory()
	const block = mem.openingMemoryBlock("")
	check("T25: 空查询也能给出开场记忆块（关键词召回在空查询下必然为空）", block.includes("【长期记忆】"), block.slice(0, 80))
	check("T25: 身份/核心记忆被选进来", block.includes("拉面") && block.includes("小明"), block)
	check("T25: 低权重的闲聊不会被塞进来", !block.includes("天气"), block)
	check("T25: 开场注入**不涨 accessCount**（否则高分记忆会永远霸榜）",
		JSON.parse(files.get("memory.json")).memories.every(m => m.accessCount === 0),
		JSON.stringify(JSON.parse(files.get("memory.json")).memories.map(m => [m.id, m.accessCount])))
	/* 有当前话题时：按话题召回（词面重叠），与身份记忆合并 */
	const withQ = mem.openingMemoryBlock("拉面好吃吗")
	check("T25: 有查询词时按话题召回", withQ.includes("拉面"), withQ)
	const emptyStore = (() => { files.clear(); seedDisk([]); mem.reloadMemory(); return mem.openingMemoryBlock("") })()
	check("T25: 没有任何记忆时返回空串（不注入空标题）", emptyStore === "", JSON.stringify(emptyStore))
}

/* ============ T29 记忆作废/还原 (B1 记忆纠正, 2026-09-27) ============
 * 背景: 决策 DELETE 以前真的删旧记忆, 而且有一道"importance ≥ 0.85 不许删"的保护闸 ——
 * 而名字/身份这类最需要纠正的记忆重要度恰恰是 0.9, 实测**恰好纠正不了**
 * (tmp-memcheck/probe-mem-correction.mjs 第 ④⑤ 组: 改口后新旧并存)。
 * 改成"作废 (invalidAt) 可还原"后那道闸不再必要 (判错的代价从"永久丢"降到"点一下还原")。
 *
 * 这一组守六件事:
 *  A. 作废生效: 决策 DELETE → 旧条不再注入/召回/展示, 但**文件里还在** (可还原);
 *  B. 还原生效: restoreMemory 后又能注入, 且落盘不会被打回;
 *  C. 回流不复活: 摘要要点从旧对话里再提取旧说法时, 不会把它变回一条活记忆;
 *  D. 不误伤: 只作废被点名的 id, 同批/同库的其它记忆不受影响;
 *  E. 作废条不"吃"新事实: 新事实与作废条字面完全相同时走新增, 而不是被并进死条目;
 *  F. 双实例一致性: 落盘合并时"已作废"这份赢过磁盘上那份没作废的旧副本。 */
{
	const t29fact = (content, type = "fact") => ({
		id: `m29_${Math.random().toString(36).slice(2, 8)}`, content, type,
		importance: 0.9, confidence: 0.95, createdAt: Date.now(), updatedAt: Date.now(),
		lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 365,
	})

	/* A. 名字改口: 「我叫小明」→「我叫小刚」 (importance 0.9, 正是旧保护闸挡住的场景) */
	files.clear()
	seedDisk([
		mkMem("nm1", "我叫小明", {type: "fact", importance: 0.9, tags: ["identity"], decayDays: null}),
		mkMem("keep29", "我喜欢下雨天", {importance: 0.6}),
	])
	mem.reloadMemory()
	check("T29-A: 前置 — 纠正前旧说法确实会被注入", mem.openingMemoryBlock("").includes("小明"),
		mem.openingMemoryBlock(""))
	const aRes = await mem.applyLlmMemoryDecision(
		[t29fact("我叫小刚")],
		async () => JSON.stringify({memory: [{id: "nm1", text: "我叫小明", event: "DELETE"}]}),
	)
	check("T29-A: 决策 DELETE 被计为 invalidated (不是 deleted)",
		aRes.invalidated === 1 && aRes.deleted === 0, JSON.stringify(aRes))
	const aAll = mem.listAll().memories
	check("T29-A: 高重要的名字记忆**也能被纠正**了 (旧说法不再展示)",
		!aAll.some(m => m.id === "nm1"), JSON.stringify(aAll.map(m => m.content)))
	check("T29-A: 新说法已入库", aAll.some(m => m.content.includes("小刚")),
		JSON.stringify(aAll.map(m => m.content)))
	check("T29-A: 被作废的旧条**还在文件里** (没被抹掉)",
		diskMemories().some(m => m.id === "nm1"), JSON.stringify(diskMemories().map(m => m.id)))
	await mem.flushMemoryPersist()
	check("T29-A: 落盘后作废标记仍在 (重启不复活)",
		typeof diskMemories().find(m => m.id === "nm1")?.invalidAt === "number",
		JSON.stringify(diskMemories().find(m => m.id === "nm1")))
	check("T29-A: 无关记忆不受影响 (只作废被点名的 id)",
		aAll.some(m => m.content === "我喜欢下雨天"), JSON.stringify(aAll.map(m => m.content)))
	check("T29-A: 作废后不再注入 (开场块)", !mem.openingMemoryBlock("").includes("小明"),
		mem.openingMemoryBlock(""))
	check("T29-A: 作废后不再注入 (关键词召回)", !mem.recallForQuery("我叫什么").includes("小明"),
		mem.recallForQuery("我叫什么"))
	const aiPromptSeen = []
	const aiBlock = await mem.recallForQuerySmart("我叫什么", async (p) => {
		aiPromptSeen.push(p)
		return JSON.stringify([{id: "nm1", reason: "用户在问名字"}])
	})
	check("T29-A: LLM 召回的**候选清单里就没有**作废条 (不靠模型自觉)",
		!aiPromptSeen.join("\n").includes("小明"), aiPromptSeen.join(" ").slice(0, 200))
	check("T29-A: 作废条不会出现在 LLM 召回结果里 (新说法照常注入)",
		!aiBlock.includes("小明"), aiBlock)
	check("T29-A: listInvalidMemories 能取到它 (供记忆库历史展示)",
		mem.listInvalidMemories().length === 1 && mem.listInvalidMemories()[0].id === "nm1",
		JSON.stringify(mem.listInvalidMemories().map(m => m.id)))
	check("T29-A: listAll(true) 含作废条, listAll() 不含",
		mem.listAll(true).memories.some(m => m.id === "nm1") && !mem.listAll().memories.some(m => m.id === "nm1"))

	/* B. 还原 (用户点「还原」) */
	await mem.flushMemoryPersist()
	mem.reloadMemory()
	check("T29-B: 落盘重载后仍是「作废」状态 (标记没被丢)",
		!mem.listAll().memories.some(m => m.id === "nm1") && mem.listInvalidMemories().length === 1,
		JSON.stringify(mem.listInvalidMemories().map(m => m.id)))
	check("T29-B: 还原返回 true", mem.restoreMemory("nm1") === true)
	check("T29-B: 还原后回到有效列表", mem.listAll().memories.some(m => m.id === "nm1"),
		JSON.stringify(mem.listAll().memories.map(m => m.content)))
	check("T29-B: 还原后历史里没有了", mem.listInvalidMemories().length === 0,
		JSON.stringify(mem.listInvalidMemories().map(m => m.id)))
	check("T29-B: 还原后又能注入了", mem.openingMemoryBlock("").includes("小明"),
		mem.openingMemoryBlock(""))
	await mem.flushMemoryPersist()
	mem.reloadMemory()
	check("T29-B: 落盘重载后仍是有效的 (还原没被静默回滚)",
		mem.listAll().memories.some(m => m.id === "nm1") && !diskMemories().find(m => m.id === "nm1")?.invalidAt,
		JSON.stringify(diskMemories().find(m => m.id === "nm1")))
	check("T29-B: 还原一条没作废的记忆 → false (幂等, 不乱改时间)",
		mem.restoreMemory("keep29") === false)
	check("T29-B: 作废一条不存在的 id → false", mem.invalidateMemory("nope_zzz") === false)
	check("T29-B: 手动 invalidateMemory 也能作废 (UI/其它路径用)",
		mem.invalidateMemory("keep29") === true && !mem.listAll().memories.some(m => m.id === "keep29"))

	/* C. 回流不复活: 摘要要点里还留着旧说法「我叫小明」, 不能把它变回活记忆 */
	files.clear()
	seedDisk([
		mkMem("nm2", "我叫小明", {type: "fact", importance: 0.9, tags: ["identity"], decayDays: null}),
	])
	mem.reloadMemory()
	mem.invalidateMemory("nm2")
	check("T29-C: 前置 — nm2 已作废 (标了 invalidAt)",
		mem.listInvalidMemories().some(m => m.id === "nm2"),
		JSON.stringify(mem.listAll(true).memories.map(m => [m.id, !!m.invalidAt])))
	// 60 条 > RAW_WINDOW(20) + SUMMARIZE_THRESHOLD(25), 否则摘要根本不会触发
	const msgCount = 60
	const history = Array.from({length: msgCount}, (_, i) => ({role: i % 2 ? "assistant" : "user", content: `第${i}句闲聊`, ts: Date.now() + i}))
	const reflow = await mem.summarizeIfNeeded(history, async () => "这段时间聊了些家常。\n**记忆要点**：我叫小明\n")
	check("T29-C: 摘要生成成功 (前置)", reflow === true)
	await mem.flushMemoryPersist()
	const cActive = mem.listAll().memories
	check("T29-C: 旧说法**没有**从摘要回流成活记忆",
		!cActive.some(m => m.content.includes("小明")),
		JSON.stringify(mem.listAll(true).memories.map(m => [m.id, m.content, !!m.invalidAt])))
	check("T29-C: 信息没丢 —— 要点仍留在摘要正文里",
		mem.listAll().summaries.some(s => s.content.includes("小明")),
		JSON.stringify(mem.listAll().summaries.map(s => s.content)))
	/* 反例守卫: 与作废条无关的要点照常回流 (别把回流整个堵死) */
	files.clear()
	seedDisk([mkMem("nm3", "我叫小明", {type: "fact", importance: 0.9, tags: ["identity"], decayDays: null})])
	mem.reloadMemory()
	mem.invalidateMemory("nm3")
	await mem.summarizeIfNeeded(history, async () => "这段时间聊了些家常。\n**记忆要点**：记住：我周末要去看电影\n")
	await mem.flushMemoryPersist()
	check("T29-C: 反例 — 与作废条无关的要点照常回流",
		mem.listAll().memories.some(m => m.content.includes("看电影")),
		JSON.stringify(mem.listAll().memories.map(m => m.content)))

	/* D. 不误伤: 决策点名作废一条时, 同批其它事实照常入库, 其它旧记忆不动 */
	files.clear()
	seedDisk([
		mkMem("d29a", "我讨厌下雨天", {importance: 0.7}),
		mkMem("d29b", "我在准备考研", {type: "project", importance: 0.8, decayDays: 60}),
	])
	mem.reloadMemory()
	const dRes = await mem.applyLlmMemoryDecision(
		[t29fact("我喜欢下雨天", "preference"), t29fact("我周末去爬山", "event")],
		async () => JSON.stringify({memory: [{id: "d29a", text: "我喜欢下雨天", event: "DELETE"}]}),
	)
	const dAll = mem.listAll().memories
	check("T29-D: 只作废被点名的那一条", dRes.invalidated === 1 && dRes.deleted === 0, JSON.stringify(dRes))
	check("T29-D: 同批新事实照常入库 (没被连坐)",
		dAll.some(m => m.content.includes("爬山")) && dAll.some(m => m.content.includes("喜欢下雨天")),
		JSON.stringify(dAll.map(m => m.content)))
	check("T29-D: 同库无关记忆完好", dAll.some(m => m.id === "d29b"), JSON.stringify(dAll.map(m => m.content)))
	check("T29-D: 编造的 id 不会被作废 (只认库内真实 id)",
		(await mem.applyLlmMemoryDecision([t29fact("随口一句", "event")],
			async () => JSON.stringify({memory: [{id: "编造的id", text: "x", event: "DELETE"}]}))).invalidated === 0)

	/* E. 作废条不"吃"新事实: 新事实与作废条字面完全相同时应当**新增**一条活的,
	 *    而不是被并进那条不注入的死条目 (mergeMemories 的池子已剔除 invalidAt) */
	files.clear()
	seedDisk([mkMem("e29", "我每天早上跑步", {importance: 0.7})])
	mem.reloadMemory()
	mem.invalidateMemory("e29")
	const eRes = await mem.applyLlmMemoryDecision([t29fact("我每天早上跑步", "preference")],
		async () => JSON.stringify({memory: []}))   // 决策漏判 → 走 merge 兜底
	const eActive = mem.listAll().memories
	check("T29-E: 与作废条重复的新事实仍然入库 (不被静默吞掉)",
		eRes.added === 1 && eActive.some(m => m.content.includes("跑步")),
		`${JSON.stringify(eRes)} active=${JSON.stringify(eActive.map(m => m.content))}`)
	check("T29-E: 入库的是新条目, 作废条保持作废状态",
		eActive.find(m => m.content.includes("跑步"))?.id !== "e29" && mem.listInvalidMemories().some(m => m.id === "e29"),
		JSON.stringify(eActive.map(m => m.id)))
	check("T29-E: 存量收敛也不会把活记忆并进作废条",
		(() => {
			files.clear()
			seedDisk([
				mkMem("e29b", "我的名字是小明", {type: "fact", importance: 0.9, invalidAt: Date.now(), updatedAt: Date.now(), tags: ["identity"], decayDays: null}),
				mkMem("e29c", "我叫小明", {type: "fact", importance: 0.9, tags: ["identity"], decayDays: null}),
			])
			mem.reloadMemory()
			const kept = mem.listAll().memories
			return kept.length === 1 && kept[0].id === "e29c"
		})(), JSON.stringify(mem.listAll().memories.map(m => [m.id, m.content])))

	/* F. 双实例落盘合并: "已作废"这份必须赢过磁盘上那份还没作废的旧副本 (core.newerMemory) */
	const older = mkMem("f29", "我不喜欢吃香菜", {importance: 0.7})
	const invalidCopy = {...older, invalidAt: Date.now() + 1000, updatedAt: Date.now() + 1000}
	const mergedF = core.mergeStores(
		{memories: [invalidCopy], summaries: [], summarizedMsgCount: 0, tombstones: []},
		{memories: [older], summaries: [], summarizedMsgCount: 0, tombstones: []},
	)
	check("T29-F: 合并时作废标记不会被旧副本吃掉",
		typeof mergedF.memories.find(m => m.id === "f29")?.invalidAt === "number",
		JSON.stringify(mergedF.memories))
	const restoredCopy = {...older, updatedAt: Date.now() + 2000}
	const mergedF2 = core.mergeStores(
		{memories: [restoredCopy], summaries: [], summarizedMsgCount: 0, tombstones: []},
		{memories: [invalidCopy], summaries: [], summarizedMsgCount: 0, tombstones: []},
	)
	check("T29-F: 反向 — 还原 (更新的 updatedAt) 能盖过作废标记",
		mergedF2.memories.find(m => m.id === "f29")?.invalidAt === undefined,
		JSON.stringify(mergedF2.memories))
	/* F2. **同毫秒平局** (实测踩到的真 bug): 刚写入的记忆马上被改口纠正时, Date.now() 与旧
	 *     updatedAt 可以是同一毫秒 —— 旧副本凭平局规则把作废标记吃掉了 (T29-C 现场: 内存里有
	 *     invalidAt, 落盘合并后没了)。守卫: 平局一律偏袒"已作废"的那一份。 */
	const tieBase = {...mkMem("f29b", "我叫小明", {type: "fact", importance: 0.9, tags: ["identity"], decayDays: null}), updatedAt: 1700000000000}
	const tieInv = {...tieBase, invalidAt: 1700000000000}
	const mergedTie = core.mergeStores(
		{memories: [tieInv], summaries: [], summarizedMsgCount: 0, tombstones: []},
		{memories: [tieBase], summaries: [], summarizedMsgCount: 0, tombstones: []},
	)
	check("T29-F2: 同毫秒平局时作废标记不被旧副本吃掉",
		typeof mergedTie.memories.find(m => m.id === "f29b")?.invalidAt === "number",
		JSON.stringify(mergedTie.memories))
	const mergedTie2 = core.mergeStores(
		{memories: [tieBase], summaries: [], summarizedMsgCount: 0, tombstones: []},
		{memories: [tieInv], summaries: [], summarizedMsgCount: 0, tombstones: []},
	)
	check("T29-F2: 参数顺序反过来也偏袒作废 (合并顺序不该影响结果)",
		typeof mergedTie2.memories.find(m => m.id === "f29b")?.invalidAt === "number",
		JSON.stringify(mergedTie2.memories))

	/* H. 决策提示词: DELETE 的语义要说清楚 (作废≠抹掉), 且要求"矛盾才删" ——
	 *    这条改动把 DELETE 的作用范围放到了**高重要记忆**上 (名字/身份), 提示词必须同步收紧 */
	const dPrompt = core.buildLlmMemoryDecisionPrompt(
		[{content: "我叫小刚", type: "fact"}],
		[{id: "x1", content: "我叫小明", type: "fact"}],
	)
	check("T29-H: 决策提示词说明 DELETE = 作废 (可进历史/可还原)",
		dPrompt.includes("作废") && dPrompt.includes("还原"), dPrompt.slice(0, 300))
	check("T29-H: 决策提示词收紧门槛 (矛盾才 DELETE, 拿不准 NONE)",
		dPrompt.includes("信息矛盾") && dPrompt.includes("拿不准就选 NONE"), dPrompt.slice(0, 400))

	/* G. 目标: 作废的目标不再被"隔几天关心一次"打扰 */
	files.clear()
	seedDisk([mkMem("g29", "考雅思 7 分", {
		type: "project", importance: 0.85, tags: ["goal"], decayDays: null,
		createdAt: Date.now() - 30 * DAY, updatedAt: Date.now() - 30 * DAY,
	})])
	mem.reloadMemory()
	check("T29-G: 前置 — 到期目标会被关心", mem.goalCarePrompt().includes("考雅思"))
	files.clear()
	seedDisk([mkMem("g29", "考雅思 7 分", {
		type: "project", importance: 0.85, tags: ["goal"], decayDays: null,
		createdAt: Date.now() - 30 * DAY, updatedAt: Date.now() - 30 * DAY,
	})])
	mem.reloadMemory()
	mem.invalidateMemory("g29")
	check("T29-G: 作废的目标不在目标列表里", mem.listGoals().length === 0)
	check("T29-G: 作废的目标不再触发关心", mem.goalCarePrompt() === "", mem.goalCarePrompt())
}

/* ============ T30 确定性改口消解 (2026-09-27 实机反馈: 「我想养猫」→「我不想养猫了」两条并存) ============
 * 实机现场 (tmp-memcheck/probe-cross-type-reversal.mjs 复现):
 *   ① 这两句**规则通道都没接住** ⇒ 两条都是模型提取的, 模型给前者标 project、后者标 preference;
 *   ② 判重决策**调了**、旧条**也在候选清单里**, 但模型**只答了 ADD** ⇒ 没有 DELETE ⇒ 没有作废;
 *   ③ 旧判据 `isPrefReversal` 只认"喜欢/不爱"那一族词, 且要求新旧**都是 preference** ⇒ 双重漏掉。
 * 修法: 新增**不看模型**的意愿族判据 (否定词 + 情态词 → 宾语), 跨类型生效, 命中即**作废**(可还原);
 *       并加一条**载入时**的存量收敛, 让库里已经并存的改口对也自动清掉。
 * ⚠ 这组测试里**反例比正例重要**: 误作废 = 用户看到记忆莫名进历史。 */
{
	const t30fact = (content, type = "fact") => ({
		id: `m30_${Math.random().toString(36).slice(2, 8)}`, content, type,
		importance: 0.6, confidence: 0.8, createdAt: Date.now(), updatedAt: Date.now(),
		lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 60,
	})
	/* A. 判据本体: 正例 + 反例 (一张表钉死) */
	const posCases = [
		["我想养猫", "我不想养猫了", "实机那例 (跨类型 project→preference)"],
		["我想养猫", "我不打算养猫了", "换说法"],
		["我要去北京", "我不去北京了", "否定词通用性 (第一版就漏了这个)"],
		["我想学日语", "我不想学日语了", "想学"],
		["我不想养猫了", "我又想养猫了", "反向回摆"],
		["喜欢下雨天", "我不喜欢下雨天了", "偏好族 (原有能力)"],
		["我喜欢猫", "我讨厌猫", "偏好族"],
	]
	const negCases = [
		["我想养猫", "我想养猫了", "同方向 → 交给 merge 合并, 绝不作废"],
		["我想养猫", "我不想养狗", "宾语不同"],
		["我想买手机", "我不想买手机壳了", "★ 包含关系不算同一件事 (手机 ⊂ 手机壳)"],
		["我想养猫", "我不喜欢养猫了", "偏好反向 ≠ 意愿反向"],
		["我喜欢猫", "我想养猫", "都是正向"],
		["我要", "我不要", "宾语不足 2 字"],
		["我最近在准备考研", "我不想养猫了", "完全无关"],
		["我今天去上班", "我不想上班了", "宾语不同 (去上班 / 上班)"],
		["我没去北京", "我想去北京", "★ 没去=过去没发生, 不是对计划的否定"],
		["我不在家", "我要在家", "★ 宾语是状态 (在家) 而非要做的事"],
	]
	let wrong = 0
	for (const [a, b] of posCases) if (!mem.__isReversalForTest(a, b)) wrong += 1
	for (const [a, b] of negCases) if (mem.__isReversalForTest(a, b)) wrong += 1
	check(`T30-A: 改口判据 ${posCases.length} 正例全命中 / ${negCases.length} 反例全不动`,
		wrong === 0, `不符 ${wrong} 项: ${JSON.stringify([...posCases, ...negCases].filter(([a, b], i) =>
			i < posCases.length ? !mem.__isReversalForTest(a, b) : mem.__isReversalForTest(a, b)).map(([a, b]) => `${a}→${b}`))}`)

	/* B. 行为: 模型只答 ADD 也必须作废 (这就是实机那个 bug 的正面回归) */
	files.clear()
	seedDisk([mkMem("cat1", "我想养猫", {type: "project", importance: 0.6, decayDays: 60})])
	mem.reloadMemory()
	const bRes = await mem.applyLlmMemoryDecision(
		[t30fact("我不想养猫了", "preference")],
		async () => JSON.stringify({memory: [{id: "new", text: "我不想养猫了", event: "ADD"}]}),
	)
	await mem.flushMemoryPersist()
	const bActive = mem.listAll().memories.map(m => m.content)
	const bInv = mem.listInvalidMemories().map(m => m.content)
	check("T30-B: 模型只答 ADD 时, 旧说法照样被作废 (不再依赖模型自觉)",
		bRes.invalidated === 1 && bActive.length === 1 && bActive[0] === "我不想养猫了" && bInv[0] === "我想养猫",
		`res=${JSON.stringify(bRes)} 生效=${JSON.stringify(bActive)} 已作废=${JSON.stringify(bInv)}`)
	check("T30-B: 旧说法留在文件里 (不是删除, 可还原)",
		diskMemories().some(m => m.id === "cat1" && typeof m.invalidAt === "number"),
		JSON.stringify(diskMemories().find(m => m.id === "cat1")))
	check("T30-B: 还原按钮能救回来",
		mem.restoreMemory("cat1") === true && mem.listAll().memories.some(m => m.content === "我想养猫"),
		JSON.stringify(mem.listAll().memories.map(m => m.content)))

	/* C. 载入时存量收敛: 库里早就并存的改口对 (就是实机现状) 会自动清干净 */
	files.clear()
	{
		const t0 = Date.now() - 60000
		seedDisk([
			mkMem("oldCat", "我想养猫", {type: "project", createdAt: t0, updatedAt: t0, decayDays: 60}),
			mkMem("newCat", "我不想养猫了", {type: "preference", createdAt: t0 + 60000, updatedAt: t0 + 60000}),
		])
	}
	mem.reloadMemory()
	await mem.flushMemoryPersist()
	check("T30-C: 载入时自动作废更早的那条 (存量改口收敛)",
		mem.listAll().memories.length === 1 && mem.listInvalidMemories().length === 1 &&
		mem.listInvalidMemories()[0].id === "oldCat",
		`生效=${JSON.stringify(mem.listAll().memories.map(m => m.id))} 已作废=${JSON.stringify(mem.listInvalidMemories().map(m => m.id))}`)
	mem.reloadMemory()
	check("T30-C: 收敛结果已落盘 (重载不复活)", mem.listAll().memories.length === 1 && mem.listInvalidMemories().length === 1,
		JSON.stringify(mem.listAll().memories.map(m => m.id)))

	/* D. 安全阀: 同一毫秒的并列判不出先后 → 载入时**不动** (宁可少收, 不可误收) */
	files.clear()
	{
		const t0 = Date.now()
		seedDisk([
			mkMem("tie1", "我想养猫", {type: "project", createdAt: t0, updatedAt: t0, decayDays: 60}),
			mkMem("tie2", "我不想养猫了", {type: "preference", createdAt: t0, updatedAt: t0}),
		])
	}
	mem.reloadMemory()
	check("T30-D: 同毫秒并列 → 载入时不擅自作废 (判不出先后就不动)",
		mem.listAll().memories.length === 2 && mem.listInvalidMemories().length === 0,
		`生效=${JSON.stringify(mem.listAll().memories.map(m => m.id))}`)

	/* E. 反例的行为面: 只是"包含关系"的两条绝不能被自动作废 */
	files.clear()
	{
		const t0 = Date.now() - 60000
		seedDisk([
			mkMem("ph1", "我想买手机", {type: "project", createdAt: t0, updatedAt: t0, decayDays: 60}),
			mkMem("ph2", "我不想买手机壳了", {type: "preference", createdAt: t0 + 60000, updatedAt: t0 + 60000}),
		])
	}
	mem.reloadMemory()
	check("T30-E: 反例守卫 — 手机 / 手机壳 不被当成改口 (两条都留着)",
		mem.listAll().memories.length === 2 && mem.listInvalidMemories().length === 0,
		`生效=${JSON.stringify(mem.listAll().memories.map(m => m.content))} 已作废=${JSON.stringify(mem.listInvalidMemories().map(m => m.content))}`)

	/* F. 规则通道 (不经过模型) 也要能消解改口。
	 * ⚠ 注意用**规则能提取的句子**来测 (喜欢/不喜欢 这一族): 规则通道只认关键词,
	 * 「我不想学钢琴了」这种它压根提取不出来 ⇒ 没有新事实 ⇒ 也就无从消解
	 * (这是"关掉 AI 提取后记忆本来就记得很少"的固有边界, 不是 bug)。 */
	files.clear()
	{
		const t0 = Date.now() - 60000
		seedDisk([mkMem("rule1", "我喜欢钢琴", {type: "preference", createdAt: t0, updatedAt: t0, decayDays: 90})])
	}
	mem.reloadMemory()
	const fAdded = mem.addMemoriesFromText("我不喜欢钢琴了")
	await mem.flushMemoryPersist()
	check("T30-F: 规则通道写入时也走改口消解 (关掉 AI 也有用)",
		fAdded >= 1 && !mem.listAll().memories.some(m => m.content === "我喜欢钢琴") &&
		mem.listInvalidMemories().some(m => m.content === "我喜欢钢琴"),
		`added=${fAdded} 生效=${JSON.stringify(mem.listAll().memories.map(m => m.content))} 已作废=${JSON.stringify(mem.listInvalidMemories().map(m => m.content))}`)
}

/* ============ T31 记忆分块 (P1: 数据结构 + 迁移, 行为不变) ============ */
{
	/* A. v1 库载入 → 建「早期记忆」块: 条目一个不改, 全部挂进块里 */
	files.clear()
	const t0 = Date.now() - 3600000
	seedDisk([
		mkMem("b1", "我叫小明", {type: "fact", importance: 0.9, createdAt: t0, updatedAt: t0, decayDays: null}),
		mkMem("b2", "我喜欢钢琴", {type: "preference", createdAt: t0 + 1000, updatedAt: t0 + 1000}),
		mkMem("b3", "我想养猫", {type: "project", createdAt: t0 + 2000, updatedAt: t0 + 2000, invalidAt: t0 + 3000}),
	])
	const beforeRaw = files.get("memory.json")
	mem.reloadMemory()
	await mem.flushMemoryPersist()
	const disk1 = JSON.parse(files.get("memory.json"))
	check("T31-A1: v1 库载入后自动建出「早期记忆」块",
		Array.isArray(disk1.blocks) && disk1.blocks.length === 1 &&
		disk1.blocks[0].id === "blk-legacy" && disk1.blocks[0].topic === "早期记忆",
		JSON.stringify(disk1.blocks))
	check("T31-A2: 块里挂上全部条目 id (含已作废那条)",
		Array.isArray(disk1.blocks?.[0]?.itemIds) && disk1.blocks[0].itemIds.length === 3 &&
		["b1", "b2", "b3"].every(id => disk1.blocks[0].itemIds.includes(id)),
		JSON.stringify(disk1.blocks?.[0]?.itemIds))
	check("T31-A3: 迁移不改内容/类型/重要度 (与迁移前原文逐条一致)",
		(() => {
			const before = JSON.parse(beforeRaw).memories.map(m => `${m.id}:${m.content}:${m.type}:${m.importance}`).sort()
			const after = mem.listAll(true).memories.map(m => `${m.id}:${m.content}:${m.type}:${m.importance}`).sort()
			return JSON.stringify(before) === JSON.stringify(after)
		})(),
		`迁移前=${beforeRaw.slice(0, 60)}`)
	check("T31-A4: schemaVersion 写成 2", disk1.schemaVersion === 2, String(disk1.schemaVersion))
	const snap0 = files.get("memory.v1-backup.json")
	let snapParsed = null
	try { snapParsed = JSON.parse(snap0) } catch { /* 解析失败即断言失败 */ }
	check("T31-A5: 迁移前写了 v1 快照 (内容 = 迁移前原文, 没有 blocks 字段)",
		!!snapParsed && snapParsed.blocks === undefined && snapParsed.schemaVersion === undefined &&
		(snapParsed.memories ?? []).length === 3,
		String(snap0).slice(0, 120))

	/* B. 幂等: 再载入两次, 仍然只有一个块 (不会重复造块/重复迁移) */
	mem.reloadMemory()
	mem.reloadMemory()
	await mem.flushMemoryPersist()
	const disk2 = JSON.parse(files.get("memory.json"))
	check("T31-B1: 迁移幂等 (反复载入不重复造块)",
		Array.isArray(disk2.blocks) && disk2.blocks.length === 1,
		JSON.stringify((disk2.blocks ?? []).map(b => b.id)))
	check("T31-B2: 幂等载入不会重复写 v1 快照", files.get("memory.v1-backup.json") === snap0)

	/* C. v1 快照只写一次: 迁移后又写过库, 快照仍是最早那份 (不被迁移后的内容覆盖) */
	mem.addMemoriesFromText("我喜欢下雨天")
	await mem.flushMemoryPersist()
	mem.reloadMemory()
	await mem.flushMemoryPersist()
	check("T31-C1: v1 快照不被迁移后的内容覆盖 (仍是那份 v1)",
		files.get("memory.v1-backup.json") === snap0,
		String(files.get("memory.v1-backup.json")).slice(0, 80))

	/* D. 空库: 标版本但不造空块 */
	files.clear()
	files.set("memory.json", JSON.stringify({memories: [], summaries: [], summarizedMsgCount: 0, tombstones: []}))
	mem.reloadMemory()
	await mem.flushMemoryPersist()
	const disk3 = JSON.parse(files.get("memory.json"))
	check("T31-D1: 空库迁移只标版本, 不造空块",
		disk3.schemaVersion === 2 && Array.isArray(disk3.blocks) && disk3.blocks.length === 0,
		`schemaVersion=${disk3.schemaVersion} blocks=${JSON.stringify(disk3.blocks)}`)

	/* E. 坏块数据防御: 坏元素被过滤, 不抛错 (块视图仍能渲染) */
	files.clear()
	seedDisk([mkMem("e1", "我喜欢猫")], {
		schemaVersion: 2,
		blocks: [null, {id: ""}, {id: "blk-ok", itemIds: ["e1", 123, null]}, "junk"],
	})
	mem.reloadMemory()
	await mem.flushMemoryPersist()
	const views = mem.listBlocks()
	check("T31-E1: 坏块被过滤, 正常块保留 (不抛错)",
		views.length === 1 && views[0].block.id === "blk-ok" && views[0].items.length === 1 &&
		views[0].items[0].id === "e1",
		JSON.stringify(views.map(v => ({id: v.block.id, n: v.items.length}))))

	/* F. 删除条目 → 块里的悬空引用被清掉, 块本身保留 (时间线不塌) */
	files.clear()
	seedDisk([mkMem("f1", "我喜欢猫"), mkMem("f2", "我喜欢狗")], {
		schemaVersion: 2,
		blocks: [{id: "blk-x", fromTs: 1, toTs: 2, msgCount: 2, topic: "猫狗", summary: "聊了猫和狗", createdAt: 1, itemIds: ["f1", "f2"]}],
	})
	mem.reloadMemory()
	check("T31-F0: 删除前块里有两条引用", mem.listBlocks()[0].items.length === 2)
	mem.deleteMemory("f2")
	await mem.flushMemoryPersist()
	const disk4 = JSON.parse(files.get("memory.json"))
	check("T31-F1: 删除条目后块里的悬空引用被清 (块保留, 摘要还在)",
		disk4.blocks.length === 1 && JSON.stringify(disk4.blocks[0].itemIds) === JSON.stringify(["f1"]) &&
		disk4.blocks[0].summary === "聊了猫和狗",
		JSON.stringify(disk4.blocks))
	/* F2. 低频清理同样清悬空引用 */
	files.clear()
	{
		const old = Date.now() - 400 * DAY
		seedDisk([
			mkMem("f3", "我喜欢旧东西", {importance: 0.2, createdAt: old, updatedAt: old, lastAccessedAt: old, accessCount: 0}),
			mkMem("f4", "我喜欢新东西", {importance: 0.9}),
		], {
			schemaVersion: 2,
			blocks: [{id: "blk-z", fromTs: 1, toTs: 2, msgCount: 2, topic: "东西", summary: "", createdAt: 1, itemIds: ["f3", "f4"]}],
		})
	}
	mem.reloadMemory()
	const prunedN = mem.pruneStaleMemories(30, 0.6)
	await mem.flushMemoryPersist()
	const disk4b = JSON.parse(files.get("memory.json"))
	check("T31-F2: 低频清理后块里只剩仍在库的 id",
		prunedN === 1 && JSON.stringify(disk4b.blocks[0].itemIds) === JSON.stringify(["f4"]),
		`pruned=${prunedN} itemIds=${JSON.stringify(disk4b.blocks[0].itemIds)}`)

	/* G. 未归类桶: 没挂进任何块的条目必须能被列出来 (否则"在库里但界面看不到") */
	files.clear()
	seedDisk([mkMem("g1", "我喜欢猫"), mkMem("g2", "我喜欢狗")], {
		schemaVersion: 2,
		blocks: [{id: "blk-y", fromTs: 1, toTs: 2, msgCount: 2, topic: "猫", summary: "", createdAt: 1, itemIds: ["g1"]}],
	})
	mem.reloadMemory()
	const un = mem.listUnblockedMemories()
	check("T31-G1: 没挂进块的条目进「未归类」桶",
		un.length === 1 && un[0].id === "g2",
		JSON.stringify(un.map(m => m.id)))

	/* H. 双实例: 同 id 块的成员取并集 (两边各自提取的条目都不能丢) */
	const blkBase = {fromTs: 100, toTs: 200, msgCount: 5, topic: "同一段", summary: "s", createdAt: 100}
	const storeA = {
		memories: [mkMem("h1", "甲")], summaries: [], summarizedMsgCount: 5,
		tombstones: [], meta: [], schemaVersion: 2,
		blocks: [{...blkBase, id: "blk-100-200", itemIds: ["h1"]}],
	}
	const storeB = {
		memories: [mkMem("h2", "乙")], summaries: [], summarizedMsgCount: 5,
		tombstones: [], meta: [], schemaVersion: 2,
		blocks: [{...blkBase, id: "blk-100-200", itemIds: ["h2"], createdAt: 200, topic: "同一段(乙)"}],
	}
	const mb = core.mergeStores(storeA, storeB).blocks.find(b => b.id === "blk-100-200")
	check("T31-H1: 双实例同 id 块 → 成员并集 + 主题取较新",
		!!mb && mb.itemIds.length === 2 && mb.itemIds.includes("h1") && mb.itemIds.includes("h2") &&
		mb.topic === "同一段(乙)",
		JSON.stringify(mb))
	check("T31-H2: 并集后块按区间正序 (时间线顺序稳定)",
		(() => {
			const m2 = core.mergeStores(
				{a: 0, ...storeA, blocks: [{...blkBase, id: "blk-200-300", itemIds: ["h1"]}]},
				{b: 0, ...storeB, blocks: [{...blkBase, id: "blk-100-200", itemIds: ["h2"]}]},
			)
			return m2.blocks.map(b => b.id).join(",") === "blk-100-200,blk-200-300"
		})())

	/* I. 行为不变的抽样回归: 召回 / 作废 / 还原 / 导出视图 照旧 */
	files.clear()
	seedDisk([mkMem("i1", "我喜欢钢琴", {createdAt: t0, updatedAt: t0})])
	mem.reloadMemory()
	await mem.flushMemoryPersist()
	check("T31-I1: 迁移后召回照旧可用", mem.recallForQuery("钢琴").includes("钢琴"), mem.recallForQuery("钢琴"))
	check("T31-I2: 迁移后作废/还原照旧可用",
		mem.invalidateMemory("i1") && mem.listInvalidMemories().length === 1 &&
		mem.restoreMemory("i1") && mem.listInvalidMemories().length === 0)
	check("T31-I3: 迁移后 listAll 视图条数不变",
		(() => { const a = mem.listAll(); return a.memories.length === 1 && a.summaries.length === 0 })())

	/* J. 清空: 块一起清空, 且不会被另一实例的旧 cache 带回 (墓碑) */
	files.clear()
	seedDisk([mkMem("j1", "我喜欢猫")])
	mem.reloadMemory()
	mem.clearMemory()
	await mem.flushMemoryPersist()
	const disk5 = JSON.parse(files.get("memory.json"))
	check("T31-J1: 清空记忆后块也清空",
		(disk5.blocks ?? []).length === 0 && disk5.memories.length === 0,
		`blocks=${JSON.stringify(disk5.blocks)} mem=${disk5.memories.length}`)
	check("T31-J2: 清空后块 id 进墓碑 (防另一实例带回来)",
		(disk5.tombstones ?? []).some(t => t.id === "blk-legacy"),
		JSON.stringify((disk5.tombstones ?? []).map(t => t.id)))

	/* K. 撤销清空: 恢复"重构前存的备份"(v1, 没有 blocks 字段) 也要补上块结构 */
	files.clear()
	seedDisk([mkMem("k1", "我喜欢猫")])
	mem.reloadMemory()
	await mem.flushMemoryPersist()
	const snapBeforeK = files.get("memory.v1-backup.json")
	files.set("memory.before-clear.json", JSON.stringify({
		memories: [mkMem("k1", "我喜欢猫")], summaries: [], summarizedMsgCount: 0, tombstones: [],
	}))
	const okK = mem.restoreMemoryBackup()
	await mem.flushMemoryPersist()
	const diskK = JSON.parse(files.get("memory.json"))
	check("T31-K1: 恢复重构前的备份 (v1) 也补上块结构, 内容照旧",
		okK && diskK.schemaVersion === 2 && (diskK.blocks ?? []).length === 1 &&
		diskK.blocks[0].id === "blk-legacy" && diskK.memories.length === 1,
		`schemaVersion=${diskK.schemaVersion} blocks=${JSON.stringify(diskK.blocks)}`)
	check("T31-K2: 块视图能看到恢复的条目",
		mem.listBlocks().length === 1 && mem.listBlocks()[0].items.length === 1,
		JSON.stringify(mem.listBlocks().map(v => ({id: v.block.id, n: v.items.length}))))
	check("T31-K3: 恢复备份不会顶替 v1 快照 (那份只对应 memory.json 的迁移)",
		files.get("memory.v1-backup.json") === snapBeforeK,
		String(files.get("memory.v1-backup.json")).slice(0, 80))
}

/* ============ T31-② 摘要通道产出记忆块 (P2: 双写, 主生产通道) ============ */
{
	/** 造 n 条带 ts 的历史 (需 ≥ RAW_WINDOW(20)+SUMMARIZE_THRESHOLD(25) = 45 条才触发总结) */
	const mkMsgs = (n, baseTs = 1_800_000_000_000) => Array.from({length: n}, (_, i) => ({
		role: i % 2 ? "assistant" : "user", content: `第${i}句`, ts: baseTs + i * 1000,
	}))
	/** 模拟模型的"摘要 + ===MEM=== + JSON"两段式输出 */
	const memOut = (obj) => `这是摘要正文。\n===MEM===\n${JSON.stringify(obj)}`

	/* A. 主通道: 哨兵 + JSON → 条目入库 + 建块 */
	resetDisk()
	const callA = async () => memOut({topic: "养猫与冰激凌", items: [
		{content: "我叫小明", type: "fact", importance: 0.9},
		{content: "我不喜欢下雨天", type: "preference", importance: 0.6},
		{content: "记住我的生日是 3 月 2 号", type: "core", importance: 0.95},
	]})
	const didA = await mem.summarizeIfNeeded(mkMsgs(45), callA)
	await mem.flushMemoryPersist()
	const stA = JSON.parse(files.get("memory.json"))
	check("T31-②A1: 摘要通道产出条目 (3 条入库)",
		didA === true && stA.memories.length === 3,
		`did=${didA} n=${stA.memories.length}`)
	check("T31-②A2: 同时建出一个记忆块 (topic/区间/成员/条数齐全)",
		(stA.blocks ?? []).length === 1 && stA.blocks[0].topic === "养猫与冰激凌" &&
		stA.blocks[0].itemIds.length === 3 && stA.blocks[0].msgCount === 25 &&
		stA.blocks[0].fromTs > 0 && stA.blocks[0].toTs > stA.blocks[0].fromTs,
		JSON.stringify(stA.blocks))
	check("T31-②A3: 块 id 是区间指纹 (blk-<首ts>-<末ts>)",
		/^blk-\d+-\d+$/.test(stA.blocks[0].id), stA.blocks[0].id)
	check("T31-②A4: 摘要正文与 JSON 分离 (摘要里不含 ===MEM===)",
		stA.summaries.length === 1 && !stA.summaries[0].content.includes("===MEM===") &&
		stA.summaries[0].content.includes("这是摘要正文"),
		String(stA.summaries[0]?.content).slice(0, 60))
	check("T31-②A5: type=core → decayDays=null (显式记住永不衰减)",
		stA.memories.some(m => m.content.includes("生日") && m.decayDays === null),
		JSON.stringify(stA.memories.map(m => [m.content, m.decayDays])))
	check("T31-②A6: 块视图能解析出这 3 条", mem.listBlocks()[0].items.length === 3)

	/* B. 重复条目跨块不重复入库 (第二次总结说出同样的话)。
	 * ⚠ 不能靠"把游标拨回去"造第二次总结: 载入/总结前的双实例游标同步会把游标抬回 max
	 *   (见 T22 第 ⑤ 条的注释)。正解是给足 70 条 —— 游标 25 时 pending 恰好 25, 自然触发。 */
	const callB = async () => memOut({topic: "又说了一遍", items: [
		{content: "我叫小明", type: "fact", importance: 0.9},
		{content: "我最近在准备考研", type: "project", importance: 0.7},
	]})
	const didB = await mem.summarizeIfNeeded(mkMsgs(70, 1_800_100_000_000), callB)
	await mem.flushMemoryPersist()
	const stB = JSON.parse(files.get("memory.json"))
	check("T31-②B1: 跨块重复条目不再入库 (总量 3 → 4, 不是 5)",
		didB === true && stB.memories.length === 4,
		`did=${didB} n=${stB.memories.length} 内容=${JSON.stringify(stB.memories.map(m => m.content))}`)
	check("T31-②B2: 两个块都在 (时间线两条)",
		(stB.blocks ?? []).length === 2 && stB.blocks[0].fromTs < stB.blocks[1].fromTs,
		JSON.stringify((stB.blocks ?? []).map(b => [b.id, b.topic, b.itemIds.length])))
	const b2items = ((stB.blocks ?? [])[1]?.itemIds ?? []).map(id => (stB.memories.find(m => m.id === id) ?? {}).content)
	check("T31-②B3: 重复的那条不会被挂进第二个块 (一条记忆只属于最初的时间段)",
		(stB.blocks ?? []).length === 2 && !b2items.includes("我叫小明"),
		JSON.stringify(b2items))

	/* C. 段内改口: 模型没听话、同一批里既给旧说法又给最终说法 → 只留最终状态生效 */
	resetDisk()
	const callC = async () => memOut({topic: "买冰激凌", items: [
		{content: "我想买冰激凌", type: "project", importance: 0.6},
		{content: "我不买冰激凌了", type: "preference", importance: 0.6},
	]})
	await mem.summarizeIfNeeded(mkMsgs(45), callC)
	await mem.flushMemoryPersist()
	const activeC = mem.listAll().memories.map(m => m.content)
	const invalidC = mem.listInvalidMemories().map(m => m.content)
	check("T31-②C1: 段内改口只留最终说法生效 (旧说法不在生效列表)",
		activeC.length === 1 && activeC[0] === "我不买冰激凌了",
		`生效=${JSON.stringify(activeC)}`)
	check("T31-②C2: 被推翻的那条留在「已作废」(可还原, 不是删除)",
		invalidC.length === 1 && invalidC[0] === "我想买冰激凌",
		`已作废=${JSON.stringify(invalidC)}`)
	check("T31-②C3: 两条都挂在块里 (时间线仍完整)", mem.listBlocks()[0].items.length === 2)

	/* D. 跨块改口: 后一块推翻前一块 → 旧条作废且可还原 */
	resetDisk()
	const callD1 = async () => memOut({topic: "想养猫", items: [{content: "我想养猫", type: "project", importance: 0.6}]})
	await mem.summarizeIfNeeded(mkMsgs(45), callD1)
	await mem.flushMemoryPersist()
	const oldIdD = mem.listAll().memories.find(m => m.content === "我想养猫").id
	const callD2 = async () => memOut({topic: "不养了", items: [{content: "我不想养猫了", type: "preference", importance: 0.6}]})
	await mem.summarizeIfNeeded(mkMsgs(70, 1_800_200_000_000), callD2)
	await mem.flushMemoryPersist()
	check("T31-②D1: 跨块改口把旧条作废 (生效列表只剩新说法)",
		mem.listAll().memories.length === 1 && mem.listAll().memories[0].content === "我不想养猫了",
		JSON.stringify(mem.listAll().memories.map(m => m.content)))
	check("T31-②D2: 旧条在「已作废」里",
		mem.listInvalidMemories().some(m => m.content === "我想养猫"))
	check("T31-②D3: 还原按钮能救回来",
		mem.restoreMemory(oldIdD) && mem.listInvalidMemories().length === 0)

	/* E. 降级三态: ① 没哨兵 ② 哨兵后 JSON 坏 ③ 哨兵后没有条目 */
	resetDisk()
	const callE1 = async () => "只有一段老式摘要, 没有哨兵。"
	await mem.summarizeIfNeeded(mkMsgs(45), callE1)
	await mem.flushMemoryPersist()
	const stE1 = JSON.parse(files.get("memory.json"))
	check("T31-②E1: 没有哨兵 → 整段当摘要, 不建块 (不写半块)",
		stE1.summaries.length === 1 && stE1.summaries[0].content.includes("没有哨兵") &&
		(stE1.blocks ?? []).length === 0 && stE1.memories.length === 0,
		`blocks=${(stE1.blocks ?? []).length} mem=${stE1.memories.length}`)

	resetDisk()
	const callE2 = async () => "摘要还在。\n===MEM===\n{\"topic\":\"坏 JSON\", items: [oops"
	await mem.summarizeIfNeeded(mkMsgs(45), callE2)
	await mem.flushMemoryPersist()
	const stE2 = JSON.parse(files.get("memory.json"))
	check("T31-②E2: JSON 坏 → 摘要照留, 不建块, 不抛错",
		stE2.summaries.length === 1 && stE2.summaries[0].content.includes("摘要还在") &&
		(stE2.blocks ?? []).length === 0,
		String(stE2.summaries[0]?.content).slice(0, 60))

	resetDisk()
	const callE3 = async () => memOut({topic: "", items: []})
	await mem.summarizeIfNeeded(mkMsgs(45), callE3)
	await mem.flushMemoryPersist()
	const stE3 = JSON.parse(files.get("memory.json"))
	check("T31-②E3: 空条目也有摘要, 但**不建空块** (空块只会给时间线添噪)",
		stE3.summaries.length === 1 && (stE3.blocks ?? []).length === 0 &&
		stE3.memories.length === 0,
		`blocks=${JSON.stringify(stE3.blocks)} mem=${stE3.memories.length}`)

	/* F. 降级通道仍可用: 老式「记忆要点」文本 → 规则提取回流 (兼容旧格式) */
	resetDisk()
	const callF = async () => "老式摘要正文。\n记忆要点：\n- 我叫小明\n- 我喜欢钢琴"
	await mem.summarizeIfNeeded(mkMsgs(45), callF)
	await mem.flushMemoryPersist()
	const stF = JSON.parse(files.get("memory.json"))
	check("T31-②F1: 「记忆要点」文本通道仍能把条目回流进库 (降级路径未丢)",
		stF.memories.length >= 1 && stF.memories.some(m => m.content.includes("小明")),
		JSON.stringify(stF.memories.map(m => m.content)))
	check("T31-②F2: 文本通道写出的条目没有块 (块只由 JSON 主通道产生)",
		(stF.blocks ?? []).length === 0 || stF.blocks.every(b => b.itemIds.length === 0),
		JSON.stringify(stF.blocks))

	/* G. 已作废的旧说法不会被旧对话回流成活记忆 (护栏对块通道同样有效) */
	resetDisk()
	seedDisk([mkMem("inv1", "我叫小明", {type: "fact", invalidAt: Date.now(), updatedAt: Date.now()})])
	mem.reloadMemory()
	const callG = async () => memOut({topic: "旧对话", items: [{content: "我叫小明", type: "fact", importance: 0.9}]})
	await mem.summarizeIfNeeded(mkMsgs(45), callG)
	await mem.flushMemoryPersist()
	check("T31-②G1: 已作废的旧说法不从块通道回流成活记忆",
		mem.listAll().memories.length === 0 && mem.listInvalidMemories().length === 1,
		`生效=${mem.listAll().memories.length} 作废=${mem.listInvalidMemories().length}`)

	/* H. 提示词契约: 必须含"只记最终说法 / 补全省略宾语 / 显式记住给 core"三条 */
	const promptH = core.buildSummaryPrompt([{role: "user", content: "你好"}])
	check("T31-②H1: 提示词含哨兵 ===MEM=== 与 JSON 结构",
		promptH.includes("===MEM===") && promptH.includes("\"items\""))
	check("T31-②H2: 提示词含「只记最终说法」与「补全省略宾语」两条规则",
		promptH.includes("只记最终说法") && promptH.includes("补全"))
	check("T31-②H3: 提示词要求显式记住用 core",
		promptH.includes("core") && promptH.includes("记住："))
}

/* ============ T31-③ 实时通道开关 + 调用次数 (P3) ============ */
{
	/* A. 设置默认值: 实时(逐句)通道默认**关** (重构 P3) */
	check("T31-③A1: Settings 默认 memoryRealtimeExtract=false",
		chatSvc.DEFAULT_SETTINGS.memoryRealtimeExtract === false,
		String(chatSvc.DEFAULT_SETTINGS.memoryRealtimeExtract))
	check("T31-③A2: Settings 仍保留 memoryLlmExtract=true (AI 整理记忆默认开)",
		chatSvc.DEFAULT_SETTINGS.memoryLlmExtract === true)

	/* B. 提示词两态: 开 = 记忆块 JSON; 关 = 旧的「记忆要点」文本式 */
	const pKeys = core.buildSummaryPrompt([{role: "user", content: "你好"}], false)
	check("T31-③B1: 关掉 AI 整理 → 提示词退回「记忆要点」文本式 (没有哨兵)",
		pKeys.includes("记忆要点") && !pKeys.includes("===MEM==="))
	check("T31-③B2: 打开 AI 整理 → 提示词含哨兵与 JSON 结构",
		core.buildSummaryPrompt([{role: "user", content: "你好"}], true).includes("===MEM==="))

	/* C. 端到端: 关掉 AI 整理时, 条目仍由**免费的关键词规则**提取入库 (老契约不变) */
	resetDisk()
	const msgsC = Array.from({length: 45}, (_, i) => ({
		role: i % 2 ? "assistant" : "user", content: `第${i}句`, ts: 1_800_300_000_000 + i * 1000,
	}))
	const didC = await mem.summarizeIfNeeded(msgsC, async () => "摘要正文。\n记忆要点：\n- 我叫小明\n- 我喜欢钢琴", false)
	await mem.flushMemoryPersist()
	const stC = JSON.parse(files.get("memory.json"))
	check("T31-③C1: 关掉 AI 整理 → 条目仍由关键词规则提取入库 (不再逐句跑)",
		didC === true && stC.memories.some(m => m.content.includes("小明")),
		JSON.stringify(stC.memories.map(m => m.content)))
	check("T31-③C2: 关掉 AI 整理 → 不产出块 (块只属于 AI 主通道)",
		(stC.blocks ?? []).length === 0,
		JSON.stringify(stC.blocks))

	/* D. 调用次数: 45 条消息 = **1 次**总结调用 (实时通道零调用) */
	resetDisk()
	let calls = 0
	const counting = async () => {
		calls += 1
		return `摘要正文。\n===MEM===\n${JSON.stringify({topic: "数次数", items: [{content: "我喜欢数数", type: "preference", importance: 0.5}]})}`
	}
	await mem.summarizeIfNeeded(msgsC, counting)
	await mem.flushMemoryPersist()
	check("T31-③D1: 45 条消息只花 1 次调用 (摘要+记忆块同一次)",
		calls === 1, `calls=${calls}`)
	check("T31-③D2: 这一次调用同时产出了摘要与记忆",
		JSON.parse(files.get("memory.json")).summaries.length === 1 &&
		mem.listBlocks().length === 1)
}

/* ============ T31-④ 「立即整理」(force) + 待整理进度 (P4) ============ */
{
	const mkMsgsN = (n, baseTs = 1_800_400_000_000) => Array.from({length: n}, (_, i) => ({
		role: i % 2 ? "assistant" : "user", content: `第${i}句`, ts: baseTs + i * 1000,
	}))
	const outN = (topic, content) =>
		`摘要正文。\n===MEM===\n${JSON.stringify({topic, items: [{content, type: "preference", importance: 0.5}]})}`

	/* A. 25 条消息 = 5 条待整理 (不足阈值 25) → 自动整理不动手, 「立即整理」动手 */
	resetDisk()
	const msgs25 = mkMsgsN(25)
	check("T31-④A1: 待整理口径 = 滑出近端窗口且未总结的条数 (25 条 → 5)",
		mem.organizeProgress(msgs25).pending === 5 && mem.organizeProgress(msgs25).threshold === 25,
		JSON.stringify(mem.organizeProgress(msgs25)))
	check("T31-④A2: 近端窗口内的消息不算待整理 (20 条 → 0)",
		mem.organizeProgress(mkMsgsN(20)).pending === 0, JSON.stringify(mem.organizeProgress(mkMsgsN(20))))
	check("T31-④A2b: 开头的占位 system 条不占批次名额 (21 条含占位 = 20 条真消息 → 0)",
		mem.organizeProgress([{role: "system", content: "占位"}, ...mkMsgsN(20)]).pending === 0,
		JSON.stringify(mem.organizeProgress([{role: "system", content: "占位"}, ...mkMsgsN(20)])))

	let callsAuto = 0
	const didAuto = await mem.summarizeIfNeeded(mkMsgsN(25), async () => { callsAuto += 1; return outN("自动", "我喜欢自动整理") })
	check("T31-④A3: 不满阈值时**自动**整理不动手 (零调用)",
		didAuto === false && callsAuto === 0, `did=${didAuto} calls=${callsAuto}`)

	let callsForce = 0
	const didForce = await mem.summarizeIfNeeded(mkMsgsN(25), async () => {
		callsForce += 1
		return outN("随手整理", "我喜欢随手整理")
	}, true, true)
	await mem.flushMemoryPersist()
	const stN = JSON.parse(files.get("memory.json"))
	check("T31-④A4: force=true (立即整理) 不满阈值也整理, 且只花 1 次调用",
		didForce === true && callsForce === 1, `did=${didForce} calls=${callsForce}`)
	check("T31-④A3: 整理出了块 + 条目 (与自动整理同一条链路)",
		(stN.blocks ?? []).length === 1 && stN.blocks[0].topic === "随手整理" &&
		stN.memories.some(m => m.content === "我喜欢随手整理"),
		JSON.stringify({blocks: stN.blocks.map(b => b.topic), mem: stN.memories.map(m => m.content)}))
	check("T31-④A4: 整理后待整理清零 (游标已推进)", mem.organizeProgress(msgs25).pending === 0,
		JSON.stringify(mem.organizeProgress(msgs25)))
}

/* ============ T31-⑤ 裁剪口径 + 空窗清零 (P5) ============ */
{
	/** 与 App.vue 同规则跑 6 轮 25 条: 每轮总结一次 + 安全裁剪一次 */
	const runRounds = async (rounds, perRound) => {
		files.clear()
		mem.reloadMemory()
		let arr = []
		let ts = Date.now() - (rounds * perRound + 10) * 1000
		const push = (n) => {
			for (let i = 0; i < n; i += 1) {
				const real = arr.filter(m => m.role !== "system").length
				arr.push({role: real % 2 ? "assistant" : "user", content: `第${ts}句`, ts})
				ts += 1000
			}
		}
		const call = async (prompt) => {
			const tss = [...prompt.matchAll(/第(\d+)句/g)].map(m => Number(m[1]))
			return `摘要正文。\n===MEM===\n${JSON.stringify({topic: "段",
				items: [{content: `覆盖 ${Math.min(...tss)}-${Math.max(...tss)}`, type: "fact", importance: 0.5}]})}`
		}
		for (let r = 0; r < rounds; r += 1) {
			push(perRound)
			await mem.summarizeIfNeeded(arr, call)
			await mem.flushMemoryPersist()
			const dropN = mem.safeTrimDrop(arr.length)
			if (dropN > 0) {
				arr = [{role: "system", content: "（更早的对话已压缩为历史总结）", ts: Date.now(), placeholder: true}, ...arr.slice(dropN)]
				mem.notifyHistoryTrimmed(dropN)
				await mem.flushMemoryPersist()
			}
		}
		await mem.flushMemoryPersist()
		const disk = JSON.parse(files.get("memory.json") || "{}")
		const ranges = (disk.blocks ?? []).map(b => [b.fromTs, b.toTs]).sort((x, y) => x[0] - y[0])
		const allTs = []
		for (let t = ts - rounds * perRound * 1000; t < ts; t += 1000) allTs.push(t)
		const rawStart = arr.length > 20 ? arr[arr.length - 20].ts : (arr[0]?.ts ?? 0)
		const shape = allTs.filter(t => t < rawStart)
			.map(t => (ranges.some(([lo, hi]) => t >= lo && t <= hi) ? "C" : "."))
			.join("")
		return {disk, ranges, shape, arr}
	}

	const R = await runRounds(6, 25)
	check("T31-⑤A1: 裁剪不再让消息被跳过 (覆盖形态 = 连续C前缀 + 连续.尾巴)",
		/^C*\.*$/.test(R.shape), `形态=${R.shape}`)
	check("T31-⑤A2: 覆盖区间逐段相接 (没有 20 条的空洞)",
		R.ranges.length >= 4 && R.ranges.every((r, i) => i === 0 || r[0] > R.ranges[i - 1][1]),
		JSON.stringify(R.ranges.length))
	check("T31-⑤A3: 每个批次的区间两端都是真消息 (没被占位符 ts 污染)",
		R.ranges.every(([lo, hi]) => hi > lo), JSON.stringify(R.ranges.slice(0, 2)))
	check("T31-⑤A4: 两个计数都落盘且单调 (summarized / trimmed)",
		(R.disk.summarizedMsgCount ?? 0) > 0 && (R.disk.trimmedMsgCount ?? 0) > 0 &&
		R.disk.summarizedMsgCount >= R.disk.trimmedMsgCount,
		`sum=${R.disk.summarizedMsgCount} trimmed=${R.disk.trimmedMsgCount}`)

	/* B. safeTrimDrop 只肯裁"已摘要的前缀": 摘要没成功过就一条都不许裁 */
	files.clear()
	mem.reloadMemory()
	check("T31-⑤B1: 从没摘要过 → 安全裁剪量为 0 (不许删没进记忆的消息)",
		mem.safeTrimDrop(60) === 0, String(mem.safeTrimDrop(60)))
	await mem.summarizeIfNeeded(Array.from({length: 45}, (_, i) => ({role: "user", content: `第${i}句`, ts: 1_900_000_000_000 + i})),
		async () => "摘要。\n===MEM===\n{}")
	check("T31-⑤B2: 摘要过 25 条 → 最多裁那 25 条 (不碰近端窗口)",
		mem.safeTrimDrop(45) === 25 && mem.safeTrimDrop(30) === 10 && mem.safeTrimDrop(20) === 0,
		`45→${mem.safeTrimDrop(45)} 30→${mem.safeTrimDrop(30)} 20→${mem.safeTrimDrop(20)}`)

	/* C. 双实例落盘合并: 两个计数取 max (都只增不减, 倒退会让消息被重复总结) */
	const mergedC = core.mergeStores(
		{memories: [], summaries: [], summarizedMsgCount: 90, trimmedMsgCount: 50, tombstones: [], meta: []},
		{memories: [], summaries: [], summarizedMsgCount: 75, trimmedMsgCount: 60, tombstones: [], meta: []},
	)
	check("T31-⑤C1: 合并后 summarized/trimmed 各自取 max",
		mergedC.summarizedMsgCount === 90 && mergedC.trimmedMsgCount === 60,
		`sum=${mergedC.summarizedMsgCount} trimmed=${mergedC.trimmedMsgCount}`)

	/* D. 上下文原文窗口: 近端 20 + 一整个待总结批次 (45), 空窗归零 */
	files.clear()
	mem.reloadMemory()
	const longMsgs = Array.from({length: 60}, (_, i) => ({role: "user", content: `第${i}句`, ts: 1_910_000_000_000 + i}))
	const ctx = mem.contextHistory(longMsgs)
	check("T31-⑤D1: 上下文窗口 = 45 条 (近端 20 + 一个待总结批次), 不再是 20",
		ctx.length === 45 && ctx[0].content === "第15句",
		`n=${ctx.length} 首条=${ctx[0]?.content}`)
	check("T31-⑤D2: 上下文不含 error 消息",
		mem.contextHistory([...longMsgs, {role: "assistant", content: "⚠ 出错", error: true, ts: 1}]).length === 45)
	check("T31-⑤D3: 消息不足 45 条时原样返回",
		mem.contextHistory(longMsgs.slice(0, 10)).length === 10)

	/* E. 近况注入: 最近 1~2 个块的主题 (摘要不重复注入) */
	check("T31-⑤E1: 没有块时不注入", mem.recentTopicsBlock() === "", JSON.stringify(mem.recentTopicsBlock()))
	resetDisk()
	seedDisk([mkMem("t1", "我喜欢猫")], {
		schemaVersion: 2,
		blocks: [
			{id: "blk-1", fromTs: 1, toTs: 2, msgCount: 25, topic: "养猫", summary: "s1", createdAt: 1, itemIds: ["t1"]},
			{id: "blk-2", fromTs: 3, toTs: 4, msgCount: 25, topic: "考研", summary: "s2", createdAt: 2, itemIds: []},
			{id: "blk-3", fromTs: 5, toTs: 6, msgCount: 25, topic: "冰激凌", summary: "s3", createdAt: 3, itemIds: []},
		],
	})
	mem.reloadMemory()
	const topics = mem.recentTopicsBlock()
	check("T31-⑤E2: 只取最近 2 个块的主题, 新的在前",
		topics === "【最近聊过】冰激凌 · 考研", topics)
	check("T31-⑤E3: 不重复注入摘要正文 (summaryBlock 已经给了)",
		!topics.includes("s1") && !topics.includes("s2") && !topics.includes("s3"), topics)
}

/* ============ T31-⑥ 记忆去重: 提示词硬约束 + 喂「已经记住的内容」(2026-09-28) ============ */
{
	const mkMsgsK = (n, baseTs = 1_800_500_000_000) => Array.from({length: n}, (_, i) => ({
		role: i % 2 ? "assistant" : "user", content: `第${i}句`, ts: baseTs + i * 1000,
	}))
	const outK = (items) => `摘要正文。\n===MEM===\n${JSON.stringify({topic: "去重", items})}`

	/* A. 提示词契约 (②): 硬约束 + 用户实机那对反例 */
	const pA = core.buildSummaryPrompt([{role: "user", content: "你好"}], true)
	check("T31-⑥A1: 提示词明写「同一件事只写一条」", pA.includes("同一件事只写一条"))
	check("T31-⑥A2: 提示词带用户实机那对反例 (我（小桧）想买鸡蛋 / 我想买鸡蛋)",
		pA.includes("我（小桧）想买鸡蛋") && pA.includes("我想买鸡蛋"))
	check("T31-⑥A3: 提示词要求不要加括号注释 (实机重复条里就带括号)",
		pA.includes("不要加括号注释"))
	check("T31-⑥A4: 提示词要求已记住的不要再写一遍", pA.includes("不要再写一遍"))
	check("T31-⑥A5: 但**改口例外**写清楚了 (改变/补充了就必须按最终状态写, 不因「已经记过」而漏改口)",
		pA.includes("改变或补充") && pA.includes("必须") && pA.includes("已经记过"))

	/* B. 不喂清单时不出现该段落 (保持精简; 关掉 AI 整理那条路径逐字不变)。
	 * ⚠ 判据必须用**段落标题**而不是「已经记住的内容」这几个字 —— 规则第 6 条正文里也提到了它 */
	const KNOWN_HEADER = "已经记住的内容（仅供避免重复"
	check("T31-⑥B1: 没有已记住内容时不加该段落",
		!pA.includes(KNOWN_HEADER) && !core.buildSummaryPrompt([], true, []).includes(KNOWN_HEADER))
	const pB = core.buildSummaryPrompt([{role: "user", content: "你好"}], true, ["我叫小桧", "我最近在准备考研"])
	check("T31-⑥B2: 喂了清单就出现该段落, 且带「不是这段对话的一部分」的防误用声明",
		pB.includes("已经记住的内容") && pB.includes("- 我叫小桧") && pB.includes("- 我最近在准备考研") &&
		pB.includes("不是**下面这段对话的一部分"))
	check("T31-⑥B3: 清单排在对话历史之前 (模型先看已记住、再看新对话)",
		pB.indexOf("已经记住的内容") < pB.indexOf("---对话历史---"))
	check("T31-⑥B4: 关掉 AI 整理 (withMemoryBlock=false) 时不加清单 (旧契约逐字不变)",
		!core.buildSummaryPrompt([{role: "user", content: "你好"}], false, ["我叫小桧"]).includes(KNOWN_HEADER))

	/* C. 端到端: summarizeIfNeeded 真的把库里已有记忆喂进提示词, 且不喂作废条 */
	resetDisk()
	seedDisk([
		mkMem("k1", "我叫小桧", {type: "fact", importance: 0.9}),
		mkMem("k2", "我前几天想养猫", {type: "project", importance: 0.5, invalidAt: Date.now()}),
	])
	mem.reloadMemory()
	let promptC = ""
	await mem.summarizeIfNeeded(mkMsgsK(45), async (prompt) => { promptC = prompt; return outK([]) })
	check("T31-⑥C1: 摘要调用真的带上了「已经记住的内容」段落", promptC.includes("已经记住的内容"))
	check("T31-⑥C2: 清单里含生效中的记忆 (我叫小桧)", promptC.includes("- 我叫小桧"))
	check("T31-⑥C3: 清单里不含已作废的记忆 (作废条不该被「避免重复」)",
		!promptC.includes("我前几天想养猫"))

	/* D. 上限: 100 条记忆喂进去要被截断 (条数 ≤40, 总字数 ≤900) */
	resetDisk()
	seedDisk(Array.from({length: 100}, (_, i) => mkMem(`m${i}`, `这是第${i}条比较长的记忆内容占位文字`, {importance: 0.5 + (i % 10) / 100})))
	mem.reloadMemory()
	let promptD = ""
	await mem.summarizeIfNeeded(mkMsgsK(45), async (prompt) => { promptD = prompt; return outK([]) })
	const knownPart = promptD.slice(promptD.indexOf("已经记住的内容"), promptD.indexOf("---对话历史---"))
	const knownLines = knownPart.split("\n").filter(l => l.startsWith("- "))
	const knownChars = knownLines.reduce((n, l) => n + l.length - 2, 0)
	check("T31-⑥D1: 清单条数被截到 ≤40", knownLines.length > 0 && knownLines.length <= 40, `n=${knownLines.length}`)
	check("T31-⑥D2: 清单总字数 ≤900 (提示词不膨胀)", knownChars <= 900, `chars=${knownChars}`)

	/* E. 行为不回退: 段内改口 / 跨块改口 仍然正确 (喂清单不能把改口判据搞坏) */
	resetDisk()
	await mem.summarizeIfNeeded(mkMsgsK(45), async () => outK([
		{content: "我想买冰激凌", type: "project", importance: 0.6},
		{content: "我不买冰激凌了", type: "preference", importance: 0.6},
	]))
	check("T31-⑥E1: 段内改口仍只留最终说法 (喂清单后不回退)",
		mem.listAll().memories.length === 1 && mem.listAll().memories[0].content === "我不买冰激凌了",
		JSON.stringify(mem.listAll().memories.map(m => m.content)))
	resetDisk()
	await mem.summarizeIfNeeded(mkMsgsK(45), async () => outK([{content: "我想养猫", type: "project", importance: 0.6}]))
	const oldIdK = mem.listAll().memories[0].id
	let secondPrompt = ""
	await mem.summarizeIfNeeded(mkMsgsK(70, 1_800_600_000_000), async (prompt) => {
		secondPrompt = prompt
		return outK([{content: "我不想养猫了", type: "preference", importance: 0.6}])
	})
	check("T31-⑥E2: 第二次总结的提示词带上了上一次记住的内容",
		secondPrompt.includes("- 我想养猫"), secondPrompt.slice(0, 100))
	check("T31-⑥E3: 跨块改口仍把旧条作废、可还原",
		mem.listAll().memories.length === 1 && mem.listAll().memories[0].content === "我不想养猫了" &&
		mem.listInvalidMemories().some(m => m.content === "我想养猫") && mem.restoreMemory(oldIdK),
		JSON.stringify(mem.listAll().memories.map(m => m.content)))
}

/* ============ T32 收起(fadedAt) + 回收站(deletedBin) —— 自动路径永不真删 (2026-09-28) ============ */
{
	const DAY32 = 24 * 3600 * 1000

	/* A. 到期 → **收起**, 不是删除; 文件里仍在; 生效列表里没有了 */
	resetDisk()
	seedDisk([
		mkMem("ex1", "我随口说过喜欢某部动画", {type: "event", importance: 0.4, decayDays: 30,
			createdAt: Date.now() - 200 * DAY32, updatedAt: Date.now() - 200 * DAY32, lastAccessedAt: 0, accessCount: 0}),
	])
	mem.reloadMemory()
	check("T32-A0: 前置 - 到期条目前还在生效列表", mem.listAll().memories.some(m => m.id === "ex1"))
	mem.addMemoriesFromText("我喜欢钢琴")   // 任意一次写库都会触发惰性到期处理
	await mem.flushMemoryPersist()
	const diskA = JSON.parse(files.get("memory.json"))
	const exA = diskA.memories.find(m => m.id === "ex1")
	check("T32-A1: 到期条**仍在文件里** (自动路径不真删)", !!exA && !!exA.fadedAt,
		JSON.stringify(exA && {fadedAt: exA.fadedAt, reason: exA.fadedReason}))
	check("T32-A2: 到期原因记为 expired", exA?.fadedReason === "expired", String(exA?.fadedReason))
	check("T32-A3: 生效列表里不再出现它", !mem.listAll().memories.some(m => m.id === "ex1"))
	check("T32-A4: 出现在「已收起」列表里", mem.listFadedMemories().some(m => m.id === "ex1"))
	check("T32-A5: 它没有墓碑 (自动路径不该产生不可逆结果)",
		!(diskA.tombstones ?? []).some(t => t.id === "ex1"), JSON.stringify(diskA.tombstones))

	/* B. 保护名单: decayDays=null (显式记住/固定/目标) 永不收起 */
	resetDisk()
	seedDisk([
		mkMem("keep1", "记住：我的生日是 3 月 2 号", {type: "core", importance: 0.95, decayDays: null,
			tags: ["explicit"], createdAt: Date.now() - 900 * DAY32, updatedAt: Date.now() - 900 * DAY32, lastAccessedAt: 0, accessCount: 0}),
	])
	mem.reloadMemory()
	mem.addMemoriesFromText("我喜欢钢琴")
	await mem.flushMemoryPersist()
	check("T32-B1: 永久条 (decayDays=null) 不会被自动收起",
		mem.listAll().memories.some(m => m.id === "keep1") && mem.listFadedMemories().length === 0,
		JSON.stringify(mem.listFadedMemories().map(m => m.content)))

	/* C. 再次被提到 = 自动复活 (用户担心的"误收起之后一点都不记了"由这条兜住) */
	resetDisk()
	seedDisk([mkMem("rv1", "我不喜欢下雨天", {type: "preference", importance: 0.7, decayDays: 90,
		createdAt: Date.now() - 400 * DAY32, updatedAt: Date.now() - 400 * DAY32, lastAccessedAt: 0, accessCount: 0})])
	mem.reloadMemory()
	mem.addMemoriesFromText("我今天心情不错")     // 触发到期 → 收起
	check("T32-C0: 前置 - 已收起", mem.listFadedMemories().some(m => m.id === "rv1"))
	mem.addMemoriesFromText("我不喜欢下雨天")     // 又说了一次同样的事
	await mem.flushMemoryPersist()
	check("T32-C1: 再说一次 → 自动放回生效",
		mem.listAll().memories.some(m => m.id === "rv1") && !mem.listFadedMemories().some(m => m.id === "rv1"),
		JSON.stringify(mem.listAll().memories.map(m => m.content)))
	const diskC = JSON.parse(files.get("memory.json"))
	check("T32-C2: 复活状态已落盘 (fadedAt 被清掉)", diskC.memories.find(m => m.id === "rv1")?.fadedAt === undefined)

	/* D. 「留下」按钮 + 重启保持 */
	resetDisk()
	seedDisk([mkMem("rf1", "我喜欢雨天", {type: "preference", importance: 0.6, decayDays: 90,
		createdAt: Date.now() - 400 * DAY32, updatedAt: Date.now() - 400 * DAY32, lastAccessedAt: 0, accessCount: 0})])
	mem.reloadMemory()
	mem.addMemoriesFromText("我喜欢钢琴")
	check("T32-D0: 前置 - 已收起", mem.listFadedMemories().some(m => m.id === "rf1"))
	check("T32-D1: 「留下」返回 true 并回到生效", mem.restoreFadedMemory("rf1") && mem.listAll().memories.some(m => m.id === "rf1"))
	mem.reloadMemory()   // 重启
	await mem.flushMemoryPersist()
	check("T32-D2: 重启后仍在生效 (没被磁盘旧副本按回收起)",
		mem.listAll().memories.some(m => m.id === "rf1") && mem.listFadedMemories().length === 0,
		JSON.stringify({active: mem.listAll().memories.map(m => m.content), faded: mem.listFadedMemories().length}))

	/* E. 手删 → 回收站 (内容还在, 能还原) */
	resetDisk()
	seedDisk([mkMem("del1", "我养了一只猫叫年年")])
	mem.reloadMemory()
	check("T32-E1: deleteMemory 返回 true", mem.deleteMemory("del1") === true)
	await mem.flushMemoryPersist()
	const diskE = JSON.parse(files.get("memory.json"))
	check("T32-E2: 生效列表里没有了", !mem.listAll().memories.some(m => m.id === "del1"))
	check("T32-E3: 回收站里**带着内容**留着", mem.listDeletedMemories().some(m => m.id === "del1" && m.content.includes("年年")),
		JSON.stringify(mem.listDeletedMemories().map(m => m.content)))
	check("T32-E4: 磁盘上 memories 里没有、deletedBin 里有",
		!(diskE.memories ?? []).some(m => m.id === "del1") && (diskE.deletedBin ?? []).some(m => m.id === "del1"))
	check("T32-E5: 墓碑仍在 (防磁盘旧副本把它带回生效列表)",
		(diskE.tombstones ?? []).some(t => t.id === "del1"))
	mem.reloadMemory()
	check("T32-E6: 重启后不会自己复活", !mem.listAll().memories.some(m => m.id === "del1"))

	/* F. 还原已删除 → 回生效, 且墓碑被清掉 (否则下次合并又被自己墓碑过滤) */
	check("T32-F1: 还原返回 true", mem.restoreDeletedMemory("del1") === true)
	await mem.flushMemoryPersist()
	const diskF = JSON.parse(files.get("memory.json"))
	check("T32-F2: 回到生效列表、回收站里没有了",
		mem.listAll().memories.some(m => m.id === "del1") && !mem.listDeletedMemories().some(m => m.id === "del1"))
	check("T32-F3: 墓碑已清除", !(diskF.tombstones ?? []).some(t => t.id === "del1"),
		JSON.stringify(diskF.tombstones))
	mem.reloadMemory()
	await mem.flushMemoryPersist()
	check("T32-F4: 重启后仍在生效 (不被自己的墓碑吃掉)",
		mem.listAll().memories.some(m => m.id === "del1"),
		JSON.stringify(mem.listAll().memories.map(m => m.content)))

	/* G. 永久删除 → 回收站里也没了 */
	check("T32-G1: 再删一次进回收站", mem.deleteMemory("del1") && mem.listDeletedMemories().some(m => m.id === "del1"))
	check("T32-G2: 永久删除返回 true", mem.deleteMemoryForever("del1") === true)
	mem.reloadMemory()
	check("T32-G3: 重启后回收站里也没有了", !mem.listDeletedMemories().some(m => m.id === "del1"))

	/* H. 回收站上限 20: 删 25 条只留最近 20 */
	resetDisk()
	seedDisk(Array.from({length: 25}, (_, i) => mkMem(`bin${i}`, `第${i}条要被删的记忆`)))
	mem.reloadMemory()
	for (let i = 0; i < 25; i += 1) mem.deleteMemory(`bin${i}`)
	await mem.flushMemoryPersist()
	const binH = mem.listDeletedMemories()
	check("T32-H1: 回收站最多留 20 条", binH.length === 20, `n=${binH.length}`)
	check("T32-H2: 留的是最近删的 (最早删的 bin0..bin4 被挤出)",
		binH.some(m => m.id === "bin24") && !binH.some(m => m.id === "bin0"),
		JSON.stringify(binH.map(m => m.id).slice(0, 3)))

	/* I. 双实例落盘合并: 收起标记不被"还没收起"的副本赢回去; 回收站并集 */
	const mI = core.mergeStores(
		{memories: [{...mkMem("f1", "内容"), fadedAt: 1000, updatedAt: 1000}], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], deletedBin: []},
		{memories: [{...mkMem("f1", "内容"), updatedAt: 1000}], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], deletedBin: []},
	)
	check("T32-I1: updatedAt 平局时偏袒「已收起」的那份 (收起不会被静默撤销)",
		!!mI.memories.find(m => m.id === "f1")?.fadedAt, JSON.stringify(mI.memories.find(m => m.id === "f1")))
	const mI2 = core.mergeStores(
		{memories: [], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], deletedBin: [{...mkMem("d1", "甲的删除"), deletedAt: 100}]},
		{memories: [], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], deletedBin: [{...mkMem("d2", "乙的删除"), deletedAt: 200}]},
	)
	check("T32-I2: 回收站按 id 并集 (两个实例删的都留着)",
		(mI2.deletedBin ?? []).length === 2 && mI2.deletedBin.some(m => m.id === "d1") && mI2.deletedBin.some(m => m.id === "d2"),
		JSON.stringify((mI2.deletedBin ?? []).map(m => m.id)))
	const mI3 = core.mergeStores(
		{memories: [], summaries: [], summarizedMsgCount: 0, tombstones: [{id: "x", at: 1}], meta: [], deletedBin: [{...mkMem("x", "被删的"), deletedAt: 5}]},
		{memories: [], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], deletedBin: []},
	)
	check("T32-I3: 回收站**不按墓碑过滤** (否则删了就没法还原)",
		(mI3.deletedBin ?? []).some(m => m.id === "x"), JSON.stringify((mI3.deletedBin ?? []).map(m => m.id)))

	/* J. 作废与收起互不干扰: 作废条不会因"再次提到"复活 */
	resetDisk()
	seedDisk([mkMem("iv1", "我想养猫", {type: "project", invalidAt: Date.now(), updatedAt: Date.now()})])
	mem.reloadMemory()
	mem.addMemoriesFromText("我想养猫")
	await mem.flushMemoryPersist()
	check("T32-J1: 作废条不会被「再次提到」复活 (只有收起才复活)",
		!mem.listAll().memories.some(m => m.id === "iv1") && mem.listInvalidMemories().some(m => m.id === "iv1"),
		JSON.stringify({active: mem.listAll().memories.map(m => m.content), invalid: mem.listInvalidMemories().map(m => m.content)}))

	/* L. 低频自动收起 (门槛 2026-09-29 由 150 降到 60): 超门槛才启动, 且只收起不删 */
	{
		resetDisk()
		const old = Date.now() - 90 * DAY32
		const stale61 = Array.from({length: 61}, (_, i) => mkMem(`st${i}`, `很久以前随口说过第${i}件事`, {
			type: "preference", importance: 0.4, decayDays: 90, accessCount: 0,
			createdAt: old, updatedAt: old, lastAccessedAt: 0,
		}))
		seedDisk(stale61.concat([mkMem("keepP", "记住：我的生日是 3 月 2 号", {type: "core", importance: 0.95, decayDays: null, tags: ["explicit"]})]))
		mem.reloadMemory()
		mem.addMemoriesFromText("我喜欢钢琴")   // 任意一次写库触发惰性低频收起
		await mem.flushMemoryPersist()
		const diskL = JSON.parse(files.get("memory.json"))
		const fadedL = mem.listFadedMemories()
		check("T32-L1: 超过 60 条后, 低价值久未提的条目被**收起**(不是删除)",
			fadedL.length > 0 && fadedL.every(m => m.fadedReason === "lowvalue") &&
			(diskL.memories ?? []).filter(m => m.id.startsWith("st")).every(m => !!m.fadedAt),
			`faded=${fadedL.length} 原因=${JSON.stringify([...new Set(fadedL.map(m => m.fadedReason))])}`)
		check("T32-L2: 永久条目 (decayDays=null) 不受低频收起影响",
			mem.listAll().memories.some(m => m.id === "keepP"))
		check("T32-L3: 被收起的条目文件里仍在、且没有墓碑 (可「留下」还原)",
			!(diskL.tombstones ?? []).some(t => t.id.startsWith("st")),
			JSON.stringify((diskL.tombstones ?? []).slice(0, 3)))
		check("T32-L4: 门槛常量已降到 60 (用户拍板)", core.PRUNE_AFTER === 60, String(core.PRUNE_AFTER))
	}

	/* K. 统计计数 */
	resetDisk()
	seedDisk([
		mkMem("s1", "生效的"),
		mkMem("s2", "作废的", {invalidAt: Date.now()}),
		mkMem("s3", "收起的", {fadedAt: Date.now(), fadedReason: "expired"}),
	])
	mem.reloadMemory()
	const st = mem.memoryStats()
	check("T32-K1: 统计能分别给出 已收起/已删除 计数",
		st.fadedCount === 1 && st.deletedCount === 0 && st.memoryCount === 3,
		JSON.stringify(st))
}

/* ============ T33 写入门槛 (S2, 2026-09-28): 只留值得长期记住的 ============ */
{
	const mkMsgs33 = (n, baseTs = 1_800_700_000_000) => Array.from({length: n}, (_, i) => ({
		role: i % 2 ? "assistant" : "user", content: `第${i}句`, ts: baseTs + i * 1000,
	}))
	/* A. 判据本体 (确定性兜底) */
	check("T33-A1: event 低重要度 (0.4) 不值得记", core.isWorthRemembering({type: "event", importance: 0.4}) === false)
	check("T33-A2: event 高重要度 (0.6) 值得记", core.isWorthRemembering({type: "event", importance: 0.6}) === true)
	check("T33-A3: 偏好 0.3 不值得记 / 0.5 值得记",
		core.isWorthRemembering({type: "preference", importance: 0.3}) === false &&
		core.isWorthRemembering({type: "preference", importance: 0.5}) === true)
	check("T33-A4: core 永远豁免 (明确要求记住的不受门槛管)",
		core.isWorthRemembering({type: "core", importance: 0.1}) === true)
	check("T33-A5: explicit / identity / pinned / goal 标签也豁免",
		core.isWorthRemembering({type: "event", importance: 0.1, tags: ["explicit"]}) === true &&
		core.isWorthRemembering({type: "event", importance: 0.1, tags: ["identity"]}) === true &&
		core.isWorthRemembering({type: "event", importance: 0.1, tags: ["pinned"]}) === true &&
		core.isWorthRemembering({type: "event", importance: 0.1, tags: ["goal"]}) === true)
	check("T33-A6: 缺 importance 时按 0.5 处理 (不过度拦截)",
		core.isWorthRemembering({type: "fact"}) === true && core.isWorthRemembering({type: "event"}) === true)

	/* B. 提示词契约: 判据 / 正反清单 / 示例 / 宁可 0 条 都在 */
	const p33 = core.buildSummaryPrompt([{role: "user", content: "你好"}], true)
	check("T33-B1: 提示词给出唯一判据 (三个月后还成立 + 以后还会被问起)",
		p33.includes("三个月后它还成立") && p33.includes("我还需要它吗"))
	check("T33-B2: 提示词有「该写/不该写」两张清单",
		p33.includes("该写的就这几类") && p33.includes("不该写的"))
	check("T33-B3: 提示词给出「一次性的不写、一贯的才写」的判别窍门与例子",
		p33.includes("一次性的不写") && p33.includes("我今天加班到十点") && p33.includes("我最近一直在加班"))
	check("T33-B4: 提示词带正反示例 (含用户实机那条「我有点困」)",
		p33.includes("我有点困，准备去睡觉") && p33.includes("我叫小桧") && p33.includes("我不喜欢下雨天"))
	check("T33-B5: 提示词写明 importance<0.5 直接别写 + 宁可 0 条",
		p33.includes("低于 0.5 的直接别写") && p33.includes("宁可 0 条"))
	check("T33-B6: 老规则没被覆盖 (只记最终说法 / 补全省略宾语 / 同一件事只写一条)",
		p33.includes("只记最终说法") && p33.includes("省略宾语的句子要结合上下文补全") &&
		p33.includes("同一件事只写一条"))

	/* C. 端到端: 混着垃圾的一批 → 只有值得的进库 */
	resetDisk()
	const out33 = (items) => `摘要正文。\n===MEM===\n${JSON.stringify({topic: "混批", items})}`
	await mem.summarizeIfNeeded(mkMsgs33(45), async () => out33([
		{content: "我有点困，准备去睡觉", type: "event", importance: 0.3},      // 垃圾 → 挡下
		{content: "今天下雨了", type: "event", importance: 0.4},                // 垃圾 → 挡下
		{content: "我叫小桧", type: "fact", importance: 0.9},                   // 值得 → 进库
		{content: "我最近在准备考研", type: "project", importance: 0.7},        // 值得 → 进库
	]))
	await mem.flushMemoryPersist()
	const disk33 = JSON.parse(files.get("memory.json"))
	const landed = (disk33.memories ?? []).map(m => m.content)
	check("T33-C1: 只有值得记的进了长期记忆 (垃圾两条被挡下)",
		landed.includes("我叫小桧") && landed.includes("我最近在准备考研") &&
		!landed.includes("我有点困，准备去睡觉") && !landed.includes("今天下雨了"),
		JSON.stringify(landed))
	check("T33-C2: 摘要照旧写上 (被挡下的内容不会连叙事一起丢)",
		(disk33.summaries ?? []).length === 1 && String(disk33.summaries[0].content).includes("摘要正文"))
	check("T33-C3: 块里只挂真正进库的两条", (disk33.blocks ?? [])[0]?.itemIds.length === 2,
		JSON.stringify((disk33.blocks ?? [])[0]?.itemIds?.length))

	/* D. 全是被挡下的垃圾 → 不建块、不写条目, 但摘要还在 */
	resetDisk()
	await mem.summarizeIfNeeded(mkMsgs33(45), async () => out33([
		{content: "我有点困，准备去睡觉", type: "event", importance: 0.2},
		{content: "我还没吃饭", type: "event", importance: 0.1},
	]))
	await mem.flushMemoryPersist()
	const disk33d = JSON.parse(files.get("memory.json"))
	check("T33-D1: 全是垃圾 → 一条都不进库、也不建空块",
		(disk33d.memories ?? []).length === 0 && (disk33d.blocks ?? []).length === 0,
		JSON.stringify({mem: (disk33d.memories ?? []).length, blocks: (disk33d.blocks ?? []).length}))
	check("T33-D2: 但摘要仍然写着 (叙事不丢)",
		(disk33d.summaries ?? []).length === 1, JSON.stringify((disk33d.summaries ?? []).map(s => s.content.slice(0, 20))))

	/* E. 门槛不误伤: 明确要求记住的低重要度条目照样进 (走 core) */
	resetDisk()
	await mem.summarizeIfNeeded(mkMsgs33(45), async () => out33([
		{content: "记住：我不吃香菜", type: "core", importance: 0.9},
	]))
	await mem.flushMemoryPersist()
	const disk33e = JSON.parse(files.get("memory.json"))
	check("T33-E1: core / 明确记住的不受门槛影响, 且 decayDays=null",
		(disk33e.memories ?? []).length === 1 && disk33e.memories[0].decayDays === null,
		JSON.stringify((disk33e.memories ?? []).map(m => [m.content, m.decayDays])))
}

/* ============ T34 整理优化: 记忆口味自学习 (示例集, 2026-09-28) ============ */
{
	const mkMsgs34 = (n, baseTs = 1_800_800_000_000) => Array.from({length: n}, (_, i) => ({
		role: i % 2 ? "assistant" : "user", content: `第${i}句`, ts: baseTs + i * 1000,
	}))
	/** 再攒 25 条自然触发下一次总结 (不能靠拨回游标: 双实例同步会把它抬回来, 回调根本不会被调用 ⇒ 断言空转假绿) */
	const msgs34b = (n, baseTs = 1_800_900_000_000) => Array.from({length: n}, (_, i) => ({
		role: i % 2 ? "assistant" : "user", content: `第${i}句`, ts: baseTs + i * 1000,
	}))
	const DAY34 = 24 * 3600 * 1000
	const seed34 = (n, extra = []) => {
		resetDisk()
		seedDisk([
			...Array.from({length: n}, (_, i) => mkMem(`p${i}`, `我喜欢第${i}种小东西`, {type: "preference", importance: 0.5 + (i % 5) / 10, accessCount: i % 4})),
			...extra,
		], {schemaVersion: 2})
		mem.reloadMemory()
	}

	/* A. 冷启动: 记忆太少不生成 */
	seed34(5)
	check("T34-A1: 生效记忆 <12 条时不生成示例 (样本太小没意义)",
		mem.rebuildMemoryExamples() === false && mem.getMemoryExamples() === null)
	check("T34-A2: 太少时 shouldRebuild 也是 false", mem.shouldRebuildMemoryExamples() === false)

	/* B. 正常生成: 正例/反例分开, 条数与体积有上限 */
	seed34(14, [
		mkMem("ev1", "我有点困，准备去睡觉", {type: "event", importance: 0.4}),   // event 低重要度 → 不进正例
		mkMem("goal1", "考雅思 7 分", {type: "project", importance: 0.9, tags: ["goal"]}),  // 目标 → 不进正例
	])
	mem.deleteMemory("p0")   // 进回收站 → 反例来源
	mem.deleteMemory("p1")
	check("T34-B1: 达到阈值后能生成示例", mem.rebuildMemoryExamples() === true)
	const ex34 = mem.getMemoryExamples()
	check("T34-B2: 正例 ≤8 条、反例 ≤4 条", (ex34?.pos.length ?? 0) > 0 && ex34.pos.length <= 8 && (ex34?.neg.length ?? 0) <= 4,
		JSON.stringify({pos: ex34?.pos.length, neg: ex34?.neg.length}))
	check("T34-B3: 反例来自**回收站里被删掉的**内容",
		(ex34?.neg ?? []).some(t => /我喜欢第[01]种小东西/.test(t)), JSON.stringify(ex34?.neg))
	check("T34-B4: event 低重要度不进正例", !(ex34?.pos ?? []).some(t => t.includes("准备去睡觉")), JSON.stringify(ex34?.pos))
	check("T34-B5: 目标不进正例 (它有自己的「陪着你的事」小节)", !(ex34?.pos ?? []).some(t => t.includes("雅思")),
		JSON.stringify(ex34?.pos))
	check("T34-B6: 单条 ≤24 字 + 总字数 ≤400",
		(ex34?.pos ?? []).every(t => t.length <= 25) && (ex34?.neg ?? []).every(t => t.length <= 25) &&
		[...(ex34?.pos ?? []), ...(ex34?.neg ?? [])].reduce((n, t) => n + t.length, 0) <= 400,
		JSON.stringify([...(ex34?.pos ?? []), ...(ex34?.neg ?? [])].map(t => t.length)))
	check("T34-B7: 记下了 builtAt / basedOn (用于刷新判定与双实例取新)",
		typeof ex34?.builtAt === "number" && ex34.basedOn >= 12, JSON.stringify({builtAt: !!ex34?.builtAt, basedOn: ex34?.basedOn}))

	/* C. 刷新判定: 刚生成过 → 不重建; 新增 20 条 → 重建 */
	check("T34-C1: 刚生成过 → shouldRebuild=false", mem.shouldRebuildMemoryExamples() === false)
	{
		const store34 = JSON.parse(files.get("memory.json"))
		for (let i = 0; i < 20; i += 1) store34.memories.push(mkMem(`new${i}`, `我又说了第${i}件事`, {type: "fact", importance: 0.7}))
		files.set("memory.json", JSON.stringify(store34))
		mem.reloadMemory()
	}
	check("T34-C2: 生效条数比上次多 ≥20 → shouldRebuild=true", mem.shouldRebuildMemoryExamples() === true)

	/* D. 提示词: 示例段的位置与"只是示例"的声明 */
	const p34 = core.buildSummaryPrompt([{role: "user", content: "你好"}], true, [], ex34)
	check("T34-D1: 提示词含正例段 (该记：…)", p34.includes("主人认可的记法") && p34.includes("该记："))
	check("T34-D2: 提示词含反例段 (不该记：…)", p34.includes("主人删掉过的") && p34.includes("不该记："))
	check("T34-D3: 明确声明「只是风格示例，不是这段对话的内容」", p34.includes("风格示例") && p34.includes("不是这段对话的内容"))
	check("T34-D4: 示例段排在【已经记住的内容】与对话历史之前 (模型先学风格再看材料)",
		p34.indexOf("主人认可的记法") < p34.indexOf("---对话历史---"))
	check("T34-D5: 没有示例时不出现该段",
		!core.buildSummaryPrompt([{role: "user", content: "你好"}], true, [], null).includes("主人认可的记法") &&
		!core.buildSummaryPrompt([{role: "user", content: "你好"}], true).includes("主人认可的记法"))
	check("T34-D6: 关掉 AI 整理 (withMemoryBlock=false) 时不加示例 (旧契约不变)",
		!core.buildSummaryPrompt([{role: "user", content: "你好"}], false, [], ex34).includes("主人认可的记法"))

	/* E. 端到端: summarizeIfNeeded 真的把示例喂进提示词 */
	seed34(14)
	mem.rebuildMemoryExamples()
	let prompt34 = ""
	await mem.summarizeIfNeeded(mkMsgs34(45), async (prompt) => { prompt34 = prompt; return "摘要。\n===MEM===\n{}" })
	check("T34-E1: 整理调用里带上了示例段", prompt34.includes("主人认可的记法") && prompt34.includes("该记："))

	/* F. 清除示例 */
	check("T34-F1: 清除前有示例", mem.getMemoryExamples() !== null)
	mem.clearMemoryExamples()
	await mem.flushMemoryPersist()
	check("T34-F2: 清除后没有了, 且已落盘",
		mem.getMemoryExamples() === null && JSON.parse(files.get("memory.json")).exampleSet === undefined)

	/* M. 示例集「跟着你的取舍走」+ 清除示例连反例一起清 (2026-09-29 用户要求) */
	{
		const seedEx = (ex) => {
			resetDisk()
			seedDisk([
				mkMem("m1", "我喜欢第0种点心"),
				mkMem("m2", "我喜欢第1种点心"),
			], {schemaVersion: 2,
				deletedBin: [mkMem("bin1", "我有点困，准备去睡觉", {deletedAt: Date.now()})],
				exampleSet: ex,
			})
			mem.reloadMemory()
		}
		seedEx({builtAt: 1, basedOn: 2,
			pos: ["我喜欢第0种点心", "我喜欢第1种点心", "我有点困，准备去睡觉"],
			neg: ["我有点困，准备去睡觉"]})
		check("T34-M0: 前置 - 示例集里有正例 3 条 / 反例 1 条",
			mem.getMemoryExamples()?.pos.length === 3 && mem.getMemoryExamples()?.neg.length === 1)

		mem.deleteMemory("m1")
		check("T34-M1: 删除一条 → 它从正例里被摘掉 (不再当你「保留的」例子)",
			!mem.getMemoryExamples().pos.includes("我喜欢第0种点心"),
			JSON.stringify(mem.getMemoryExamples()?.pos))

		mem.deleteMemoryForever("bin1")
		const exM2 = mem.getMemoryExamples()
		check("T34-M2: 永久删除 → 正例与反例里都不再有它的文字",
			!!exM2 && !exM2.pos.includes("我有点困，准备去睡觉") && !exM2.neg.includes("我有点困，准备去睡觉"),
			JSON.stringify(exM2))

		mem.fadeMemoryManually("m2")
		check("T34-M3: 手动收起 → 从正例摘掉; 两边都空了就整个清掉",
			mem.getMemoryExamples() === null && mem.listFadedMemories().some(m => m.id === "m2" && m.fadedReason === "manual"),
			JSON.stringify({ex: mem.getMemoryExamples(), faded: mem.listFadedMemories().map(m => [m.id, m.fadedReason])}))

		/* 自动收起**不动**示例集 (那是例行整理, 不是你的取舍) */
		resetDisk()
		seedDisk([
			mkMem("auto1", "我随口说过的一句话", {type: "event", importance: 0.4, decayDays: 30,
				createdAt: Date.now() - 200 * DAY34, updatedAt: Date.now() - 200 * DAY34, lastAccessedAt: 0, accessCount: 0}),
		], {schemaVersion: 2, exampleSet: {builtAt: 1, basedOn: 1, pos: ["我随口说过的一句话"], neg: []}})
		mem.reloadMemory()
		mem.addMemoriesFromText("我喜欢钢琴")
		check("T34-M4: 自动收起不动示例集 (只清你取舍的那两个动作)",
			mem.listFadedMemories().some(m => m.id === "auto1") &&
			(mem.getMemoryExamples()?.pos ?? []).includes("我随口说过的一句话"),
			JSON.stringify({faded: mem.listFadedMemories().length, pos: mem.getMemoryExamples()?.pos}))

		/* 「清除示例」必须**连反例一起清** —— 用提示词实证, 不只看字段 */
		seedEx({builtAt: 1, basedOn: 2, pos: ["我喜欢第0种点心"], neg: ["我有点困，准备去睡觉"]})
		let promptBefore = ""
		await mem.summarizeIfNeeded(mkMsgs34(45), async (p) => { promptBefore = p; return "摘要。\n===MEM===\n{}" })
		check("T34-M5: 清除前提示词里 该记/不该记 都在",
			promptBefore.includes("该记：") && promptBefore.includes("不该记："),
			JSON.stringify({n: promptBefore.length}))
		mem.clearMemoryExamples()
		await mem.flushMemoryPersist()
		let promptAfter = ""
		await mem.summarizeIfNeeded(msgs34b(70), async (p) => { promptAfter = p; return "摘要。\n===MEM===\n{}" })
		check("T34-M6: 「清除示例」连反例一起清 (提示词里 该记/不该记 都不再出现)",
			promptAfter.length > 100 && !promptAfter.includes("该记：") && !promptAfter.includes("不该记："),
			JSON.stringify({captured: promptAfter.length, hasPos: promptAfter.includes("该记："), hasNeg: promptAfter.includes("不该记：")}))
		check("T34-M7: 清除后落盘里也没有 exampleSet 了",
			JSON.parse(files.get("memory.json")).exampleSet === undefined)
	}

	/* G. 双实例合并: 取 builtAt 较新的那份 */
	const mA = core.mergeStores(
		{memories: [], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], deletedBin: [],
			exampleSet: {builtAt: 100, basedOn: 12, pos: ["甲"], neg: []}},
		{memories: [], summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], deletedBin: [],
			exampleSet: {builtAt: 200, basedOn: 30, pos: ["乙"], neg: ["丙"]}},
	)
	check("T34-G1: 示例集取 builtAt 较新的 (谁最后优化谁说了算)",
		mA.exampleSet?.pos?.[0] === "乙" && mA.exampleSet?.builtAt === 200, JSON.stringify(mA.exampleSet))
}

/* ============ T35 pruneMemories 的计数口径 (P3 长期推演查出的真 bug, 2026-09-30) ============
 * 症状: 门槛与溢出量都拿「传入数组的总长度」去比, 而 store.memories 里**含已收起/已作废**的条目,
 *   且自动路径只标记、不移出 ⇒ 总条数只增不减。一旦越过 MAX_MEMORIES, 溢出量被已收起的条数抬高
 *   ⇒ 每写一条普通记忆下一拍就被自动收起 (推演最坏情况: 生效只剩 2 条永久记忆, 已收起 2402 条)。
 * 期望: 两处都只数**生效**条目。最小复现脚本: tmp-memcheck/_dbg-p3-prune.mjs
 */
{
	const OLD35 = Date.now() - 40 * DAY
	const fad35 = (i) => mkMem(`f${i}`, `收起很久的旧记忆${i}`, {fadedAt: OLD35, fadedReason: "lowvalue"})
	const inv35 = (i) => mkMem(`v${i}`, `早就被推翻的说法${i}`, {invalidAt: OLD35})
	const act35 = (i, over = {}) => mkMem(`a${i}`, `还活着的记忆${i}`, over)

	/* A. 纯逻辑: 已收起 / 已作废 不该占名额 */
	const pA1 = core.pruneMemories([...Array.from({length: 300}, (_, i) => fad35(i)), act35(1), act35(2)])
	check("T35-A1: 300 条已收起 + 2 条新记忆 ⇒ 一条都不该判清理 (修复前会判掉这 2 条)",
		pA1.length === 0, JSON.stringify(pA1.map(m => m.id)))
	const pA2 = core.pruneMemories([...Array.from({length: 300}, (_, i) => inv35(i)), act35(1), act35(2)])
	check("T35-A2: 300 条已作废 + 2 条新记忆 ⇒ 同样一条都不判", pA2.length === 0, JSON.stringify(pA2.map(m => m.id)))
	const pA3 = core.pruneMemories([...Array.from({length: 50}, (_, i) => fad35(i)), act35(1)])
	check("T35-A3: 50 条已收起 (未越上限) ⇒ 不动 (回归保护)", pA3.length === 0, JSON.stringify(pA3.map(m => m.id)))

	/* B. 原有的两轮清理不能被改坏 */
	const stale35 = Array.from({length: 61}, (_, i) => mkMem(`s${i}`, `很久没提的低价值${i}`,
		{importance: 0.4, createdAt: OLD35, updatedAt: OLD35, lastAccessedAt: 0, accessCount: 0}))
	const pB1 = core.pruneMemories(stale35)
	check("T35-B1: 生效 61 条全是「30 天没提 + 低重要」⇒ 第一轮低频清理照旧触发 (61 条全判)",
		pB1.length === 61, `判了 ${pB1.length} 条`)
	const pB2 = core.pruneMemories([
		...Array.from({length: 320}, (_, i) => act35(i, {importance: 0.65, accessCount: 5, lastAccessedAt: Date.now()})),
		...Array.from({length: 300}, (_, i) => fad35(i)),
	])
	check("T35-B2: 320 条生效 + 300 条已收起 ⇒ 第二轮只丢 20 条 (修复前会把 320 条全丢光)",
		pB2.length === 20, `丢了 ${pB2.length} 条`)
	check("T35-B3: 丢的全是生效条目, 已收起/已作废一条不动",
		pB2.every(m => !m.fadedAt && !m.invalidAt), JSON.stringify(pB2.slice(0, 3).map(m => m.id)))

	/* C. 走真实写入路径: 库里有 300 条已收起时, 新写入的记忆必须活下来 */
	resetDisk()
	seedDisk([...Array.from({length: 300}, (_, i) => fad35(i)), act35(1)], {schemaVersion: 2})
	mem.reloadMemory()
	mem.addMemoriesFromText("我喜欢钢琴")
	await mem.flushMemoryPersist()
	const activeC = mem.listAll(false).memories.map(m => m.content)
	check("T35-C1: 库里有 300 条已收起时, 新写入的记忆仍然生效 (修复前当场被收起)",
		activeC.some(t => t.includes("钢琴")), JSON.stringify(activeC.slice(0, 4)))
	check("T35-C2: 已收起条数没被「二次收起」污染 (仍该是 300)",
		mem.listFadedMemories().length === 300, `已收起 ${mem.listFadedMemories().length}`)
	const piano35 = diskMemories().filter(m => (m.content || "").includes("钢琴"))
	check("T35-C3: 落盘里新增的那条没有 fadedAt",
		piano35.length > 0 && piano35.every(m => !m.fadedAt),
		JSON.stringify(piano35.map(m => ({c: m.content, f: m.fadedAt ?? null}))))
	resetDisk()
}

/* ============ T36 第二轮淘汰的免死金牌 (P3 发现 8.2 的 a 方案, 2026-09-30) ============
 * 症状: 库被一次性垃圾顶到 MAX_MEMORIES 后, 价值分里的"新鲜度×类型衰减"让**新鲜垃圾**压过
 *   **很久没提的项目/偏好** ⇒ 该记的被收起、垃圾留着 (推演最坏情况: 该记的 11 件事被收起)。
 * 期望: 重要度 ≥ 0.7 / core / explicit·pinned·goal·identity 不参与第二轮淘汰。
 */
{
	const now36 = Date.now()
	/** 新鲜 + 高召回 ⇒ 第一轮「30 天没提 + 低重要」不会碰它, 把第二轮单独隔离出来 */
	const act36 = (i, over = {}) => mkMem(`k${i}`, `还活着的记忆${i}`,
		{importance: 0.5, accessCount: 5, lastAccessedAt: now36, ...over})

	/* A. 320 条生效: 300 条低重要 + 20 条高重要 ⇒ 只丢低重要的 20 条 */
	const A36 = core.pruneMemories([
		...Array.from({length: 300}, (_, i) => act36(`lo${i}`, {importance: 0.5})),
		...Array.from({length: 20}, (_, i) => act36(`hi${i}`, {importance: 0.9})),
	])
	check("T36-A1: 320 条生效 (其中 20 条高重要) ⇒ 只丢 20 条低重要的, 正好回到上限",
		A36.length === 20, `丢了 ${A36.length} 条`)
	check("T36-A2: 丢的全是低重要的 (高重要拿到免死金牌)",
		A36.every(m => m.importance < 0.7), JSON.stringify(A36.map(m => `${m.id}:${m.importance}`).slice(0, 5)))

	/* B. 全是高重要 ⇒ 一条都不丢 (有意让生效数超过上限: 宁可多留, 也不丢主人交代过的事) */
	const B36 = core.pruneMemories(Array.from({length: 320}, (_, i) => act36(`p${i}`, {importance: 0.8})))
	check("T36-B1: 320 条全是 0.8 ⇒ 一条都不丢 (免死金牌够多时有意突破上限)",
		B36.length === 0, `丢了 ${B36.length} 条`)

	/* C. 标签/类型豁免: 重要度很低但带 goal/pinned/explicit/identity 或 core 也要保住 */
	const C36 = core.pruneMemories([
		...Array.from({length: 305}, (_, i) => act36(`t${i}`, {importance: 0.5})),
		act36("tag1", {importance: 0.2, tags: ["goal"]}),
		act36("tag2", {importance: 0.2, tags: ["pinned"]}),
		act36("tag3", {importance: 0.2, tags: ["explicit"]}),
		act36("tag4", {importance: 0.2, tags: ["identity"]}),
		act36("tag5", {importance: 0.2, type: "core"}),
	])
	const Cids36 = C36.map(m => m.id)
	check("T36-C1: goal/pinned/explicit/identity 标签与 core 类型全部保住",
		!["tag1", "tag2", "tag3", "tag4", "tag5"].some(id => Cids36.includes(id)), JSON.stringify(Cids36.slice(0, 6)))
	check("T36-C2: 该丢的普通低重要条目照旧丢 (310 条 → 只丢 10 条、净剩 300)",
		C36.length === 10, `丢了 ${C36.length} 条`)

	/* D. 阈值边界: 0.7 保、0.69 不保 */
	const D36 = core.pruneMemories([
		...Array.from({length: 300}, (_, i) => act36(`d${i}`, {importance: 0.5})),
		act36("keep70", {importance: 0.7}),
		act36("drop69", {importance: 0.69}),
	])
	const Dids36 = D36.map(m => m.id)
	check("T36-D1: 重要度刚好 0.7 保住 (不在丢弃名单里), 溢出量仍按生效条数算",
		!Dids36.includes("keep70") && D36.length === 2, JSON.stringify(Dids36))
}

/* ============ T37 记忆诊断日志 (P1「观测闭环」, 2026-09-30) ============
 * 目标: 把"模型到底听不听话"从推测变成可查的证据 —— 每次整理留一条记录:
 *       提示词 / 模型原始输出 / 解析结果 / **门槛挡下的条目** / 写库结果 / 库状态。
 * 关键约定: 默认关(零开销) · 只留内存(重启清空) · 环形上限 · 导出才是 JSONL。
 */
{
	/* A. 默认关: 不记录 */
	resetDisk()
	seedDisk([mkMem("d37a", "我喜欢下雨天")])
	mem.reloadMemory()
	check("T37-A1: 默认关着, 不产生任何记录", mem.diagEnabled() === false && mem.diagCount() === 0)

	/* B. 打开后走一次真实整理: 记录字段完整 */
	mem.setDiagEnabled(true)
	mem.clearDiag()
	const msgs37 = (n, base = 1_810_000_000_000) => Array.from({length: n}, (_, i) => ({
		role: i % 2 ? "assistant" : "user", content: `第${i}句`, ts: base + i * 1000,
	}))
	const llm37 = async () => "主人聊了准备考试的事。\n===MEM===\n" + JSON.stringify({
		topic: "备考",
		items: [
			{content: "我在准备考试", type: "project", importance: 0.8},       // 该记
			{content: "我有点困，准备去睡觉", type: "event", importance: 0.4},  // 门槛该挡下
		],
	})
	const did37 = await mem.summarizeIfNeeded(msgs37(45), llm37, true, false)
	const rec = mem.lastDiagRecord()
	check("T37-A2: 整理发生了 (待整理 25 条触发)", did37 === true && mem.diagCount() === 1, JSON.stringify({did: did37, n: mem.diagCount()}))
	check("T37-A3: 记下了提示词与模型原始输出 (含哨兵)",
		(rec?.promptChars ?? 0) > 200 && (rec?.raw ?? "").includes("===MEM==="),
		JSON.stringify({promptChars: rec?.promptChars, rawChars: rec?.rawChars}))
	check("T37-A4: 记下了解析结果与**被门槛挡下的那条**",
		(rec?.items ?? []).some(i => i.c.includes("准备考试")) && (rec?.gated ?? []).some(g => g.c.includes("准备去睡觉")),
		JSON.stringify({items: rec?.items, gated: rec?.gated}))
	check("T37-A5: 记下了写库结果与库状态 (能看出距 300 上限多远)",
		(rec?.write.added ?? 0) >= 1 && (rec?.lib.total ?? 0) >= 2 && (rec?.lib.active ?? 0) >= 2,
		JSON.stringify({write: rec?.write, lib: rec?.lib}))
	check("T37-A6: 记下了块 id 与摘要字数", !!rec?.blockId && (rec?.summaryChars ?? 0) > 0,
		JSON.stringify({blockId: rec?.blockId, summaryChars: rec?.summaryChars}))

	/* C. 导出格式: 第一行是环境头, 每行都是合法 JSON */
	const jsonl = mem.buildDiagJsonl({model: "test-model"})
	const rows = jsonl.trim().split("\n")
	let allOk = true
	for (const line of rows) { try { JSON.parse(line) } catch { allOk = false } }
	const head = JSON.parse(rows[0])
	check("T37-B1: 导出是 JSONL (首行环境头 + 每条一行, 全部可解析)",
		rows.length === 2 && allOk && head.kind === "header" && head.records === 1 && head.model === "test-model",
		JSON.stringify({lines: rows.length, allOk, head}))

	/* D. 环形上限: 超出丢最旧 */
	mem.clearDiag()
	for (let i = 0; i < mem.MAX_DIAG_RECORDS + 5; i += 1) {
		mem.recordOrganize({msgs: i, startIndex: 0, promptChars: 0, prompt: "", rawChars: 0, raw: "",
			topic: "", items: [], gated: [], deadLink: [], write: {added: 0, updated: 0, invalidated: 0, intra: 0, expired: 0, lowvalue: 0, revived: 0},
			summaryChars: 0, blockId: null, lib: {active: 0, faded: 0, invalid: 0, total: 0, blocks: 0}, note: `n${i}`})
	}
	const ringRows = mem.buildDiagJsonl().trim().split("\n").slice(1).map(l => JSON.parse(l))
	check(`T37-C1: 环形上限 ${mem.MAX_DIAG_RECORDS} 条 (超出丢最旧)`,
		mem.diagCount() === mem.MAX_DIAG_RECORDS && ringRows.length === mem.MAX_DIAG_RECORDS &&
		ringRows[0].note === "n5" && ringRows[ringRows.length - 1].note === `n${mem.MAX_DIAG_RECORDS + 4}`,
		JSON.stringify({n: mem.diagCount(), first: ringRows[0]?.note, last: ringRows[ringRows.length - 1]?.note}))

	/* E. 关掉后不再记 (已记录的不清 —— 用户可能正要导出) */
	mem.setDiagEnabled(false)
	const before37 = mem.diagCount()
	mem.recordOrganize({msgs: 999, startIndex: 0, promptChars: 0, prompt: "", rawChars: 0, raw: "",
		topic: "", items: [], gated: [], deadLink: [], write: {added: 0, updated: 0, invalidated: 0, intra: 0, expired: 0, lowvalue: 0, revived: 0},
		summaryChars: 0, blockId: null, lib: {active: 0, faded: 0, invalid: 0, total: 0, blocks: 0}, note: "不该出现"})
	check("T37-D1: 关掉开关后不再记录, 且已有记录保留", mem.diagCount() === before37, `${before37} → ${mem.diagCount()}`)
	mem.clearDiag()
	check("T37-D2: 清空记录", mem.diagCount() === 0)
	resetDisk()
}

/* ============ T38 三个 bug 的回归断言 (2026-10-02) ============
 * A 思考模式默认值与开关口径 / B 渲染暂停 / C 背景音乐「已下载」按磁盘算。
 * 这一组全部是纯逻辑 + 假桥, 不需要浏览器 —— 真机上那几条 UI 断言在
 * probe-thinking-default.mjs / probe-bgm-state.mjs / probe-main-fps.mjs 里。 */
{
	/* ---- A. DeepSeek 思考模式: 开关是唯一口径, 两个方向都要显式传 ---- */
	const rt = chatSvc.resolveThinking
	const dsOn = rt("https://api.deepseek.com/v1", true)
	const dsOff = rt("https://api.deepseek.com/v1", false)
	check("T38-A1: DeepSeek 端点 + 开关开 ⇒ 显式 \"enabled\"", dsOn === "enabled", String(dsOn))
	check("T38-A2: DeepSeek 端点 + 开关关 ⇒ 显式 \"disabled\" (不传 = 服务端按默认「开」跑)",
		dsOff === "disabled", String(dsOff))
	check("T38-A3: 非 DeepSeek 端点 ⇒ 空串 (这个字段是 DeepSeek 专有扩展, 绝不外传)",
		rt("https://api.openai.com/v1", true) === "" && rt("https://api.openai.com/v1", false) === "",
		`${rt("https://api.openai.com/v1", true)} / ${rt("https://api.openai.com/v1", false)}`)
	check("T38-A4: 三态必须是**字符串** (布尔是旧实现的语义: false = 不写字段 = 关不掉)",
		typeof dsOn === "string" && typeof dsOff === "string")
	check("T38-A5: 默认设置里思考模式是**开**的 (用户 2026-10-02 指定)",
		chatSvc.DEFAULT_SETTINGS.deepseekThinking === true, String(chatSvc.DEFAULT_SETTINGS.deepseekThinking))

	/* ---- B. 渲染暂停: 暂停期间一帧都不画, 恢复后继续画 ---- */
	const fc = await import(pathToFileURL(path.join(root, "tmp-memcheck/framecap-bundle.mjs")).href)
	const host = {}
	let clock = 1000
	fc.installFrameCap(host, 60, () => (clock += 20))   // 假时钟每帧 +20ms ⇒ 60fps 档每帧都该画
	let up = 0
	let md = 0
	const updater = {updateTime: () => { up += 1 }}
	const model = {update: () => { md += 1 }}
	for (let i = 0; i < 5; i += 1) host.__noriL2dTick(updater, model)
	check("T38-B1: 未暂停时渲染循环真的画 (updateTime 与 update 都被调)", up === 5 && md === 5, `up=${up} md=${md}`)
	const drawsRunning = host.__noriL2dDraws || 0
	check("T38-B2: 真画帧数计到 __noriL2dDraws (探针/诊断的判据)", drawsRunning === 5, String(drawsRunning))
	fc.setRenderPaused(host, true)
	up = 0
	md = 0
	for (let i = 0; i < 10; i += 1) host.__noriL2dTick(updater, model)
	check("T38-B3: **暂停期间一帧都不画** (updater/model 一次都没被调)", up === 0 && md === 0, `up=${up} md=${md}`)
	check("T38-B4: 暂停期间 __noriL2dDraws 不涨", (host.__noriL2dDraws || 0) === drawsRunning,
		`${drawsRunning} → ${host.__noriL2dDraws}`)
	fc.setRenderPaused(host, false)
	up = 0
	md = 0
	for (let i = 0; i < 5; i += 1) host.__noriL2dTick(updater, model)
	check("T38-B5: 恢复后立刻继续画 (暂停是双向的, 且不用重建模型)", up === 5 && md === 5, `up=${up} md=${md}`)

	/* ---- C. 背景音乐「已下载」以磁盘上的真实文件为准 ---- */
	// 页面里 Audio 是浏览器内建; Node 里给个最小替身, 让"开关打开要起播"这条也能跑到
	globalThis.Audio = globalThis.Audio || class {
		constructor() { this.volume = 1; this.src = ""; this.loop = false; this.preload = "" }
		play() { return Promise.resolve() }
		pause() { /* 空 */ }
	}
	const bgm = await import(pathToFileURL(path.join(root, "tmp-memcheck/bgm-bundle.mjs")).href)
	let seen = null
	bgm.setBgmStateHandler((s, p) => { seen = {s, p} })
	const disk = {ready: false}
	let dlCalls = 0
	globalThis.window.NoriChat = {
		bgmStatus: () => JSON.stringify({ready: disk.ready, missing: disk.ready ? [] : ["bgm_memory.mp3", "bgm1.m4a", "nori_daily_manifold.mp3"]}),
		bgmDownload: () => { dlCalls += 1; return "ok" },
	}
	const settings = (over = {}) => ({bgmEnabled: false, bgmTrack: "random", bgmVolume: 0.35, ...over})

	// C1: 用户报的那条 —— 磁盘上有文件, 但开关是关的 ⇒ 状态必须是「已就绪」
	disk.ready = true
	seen = null
	bgm.syncBgm(settings())
	check("T38-C1: 开关关着也要按**磁盘**报「已就绪」(旧实现这里停在 missing ⇒ 重启后又显示下载按钮)",
		seen && seen.s === "ready", JSON.stringify(seen))

	// C2: 磁盘上没有文件 ⇒ 显示未下载, 且关着开关**不该**自动下载
	disk.ready = false
	seen = null
	dlCalls = 0
	bgm.syncBgm(settings())
	check("T38-C2: 磁盘上没有资源时状态是 missing (该显示「下载背景音乐资源」)",
		!seen || seen.s === "missing", JSON.stringify(seen))
	check("T38-C3: 开关关着不会偷偷下载", dlCalls === 0, `dlCalls=${dlCalls}`)

	// C4: 手动下载: 磁盘上已有 ⇒ 不重复下载（幂等）; force=true 才真的再下一次
	disk.ready = true
	seen = null
	dlCalls = 0
	bgm.downloadBgm()
	check("T38-C4: 已有资源时普通下载是幂等的 (不调原生下载)", dlCalls === 0 && seen && seen.s === "ready",
		`dlCalls=${dlCalls} seen=${JSON.stringify(seen)}`)
	bgm.downloadBgm(true)
	check("T38-C5: 「重新下载」(force) 会真的调原生下载一次", dlCalls === 1, `dlCalls=${dlCalls}`)

	// C6: 资源从磁盘上消失 (被清过) ⇒ 状态要如实回退, 不能一直假装就绪
	//     先回到"就绪"这个已知状态 (C5 触发过下载, 模块此刻停在 downloading)
	disk.ready = true
	bgm.syncBgm(settings())
	seen = null
	disk.ready = false
	bgm.syncBgm(settings())
	check("T38-C6: 资源真的没了 ⇒ 状态回退成 missing", seen && seen.s === "missing", JSON.stringify(seen))

	// C7: 开关打开 + 资源就绪 ⇒ 起播本地 /bgm-local/ (没被这次修法弄坏)
	disk.ready = true
	const played = []
	globalThis.Audio = class {
		constructor() { this.volume = 1; this.src = ""; this.loop = false; this.preload = "" }
		play() { played.push(this.src); return Promise.resolve() }
		pause() { /* 空 */ }
	}
	bgm.syncBgm(settings({bgmEnabled: true}))
	check("T38-C7: 开关打开且资源就绪 ⇒ 播 /bgm-local/ 下的曲目",
		played.length === 1 && /^\/bgm-local\//.test(played[0]), JSON.stringify(played))
	bgm.setBgmStateHandler(null)
	restoreNoriChatBridge()
}

/* ============ 汇总 ============ */
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
	process.exitCode = 1
	console.log("FAILED:", failed.map(f => f.name).join(" | "))
}
