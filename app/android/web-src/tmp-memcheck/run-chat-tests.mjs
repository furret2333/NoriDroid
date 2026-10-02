/**
 * chat 服务行为测试 (Node 直测): 覆盖 2026-09-11/12 修复轮的 chat/index.ts 改动.
 * - FE-H1 流式串行队列: 并发两路流式不互踩, 前一路结束才发下一路
 * - FE-M10 本地 abort 通知原生 chatStop
 * - FE-M12 writeFile 只认 "ok"
 * - loadChat 过滤错误气泡 (error 标记 + 旧版 "⚠ " 前缀残留)
 *
 * 运行: cd web-src && node tmp-memcheck/run-chat-tests.mjs
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
	entryPoints: [path.join(root, "src/services/chat/index.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/chat-bundle.mjs"),
	plugins: [rawPlugin],
})

/* ---------------- 假桥 ---------------- */
const files = new Map()
let chatStreamCalls = 0
let chatStopCalls = 0
let writeCount = 0
let writeFileRawReturn = "ok"
globalThis.window = {
	NoriChat: {
		readFile: (name) => files.get(name) ?? "",
		// 真实语义: 只有返回 "ok" 才算写入成功; 返回 err/异常时**文件保持原样**。
		// (旧夹具无条件先写 files 再返回失败码, 等于"失败也写进去了", 会让失败路径的断言失真)
		writeFile: (name, content) => {
			writeCount += 1
			if (writeFileRawReturn !== "ok") return writeFileRawReturn
			files.set(name, String(content))
			return "ok"
		},
		chatStream: () => { chatStreamCalls += 1 },
		chatStop: () => { chatStopCalls += 1 },
		fetchModels: () => { /* 不回包 → 走超时路径 */ },
	},
}

const chat = await import(pathToFileURL(path.join(root, "tmp-memcheck/chat-bundle.mjs")).href)

/* ---------------- 断言小工具 ---------------- */
const results = []
const check = (name, cond, extra = "") => {
	results.push({name, ok: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `  ← ${extra}`}`)
}
const tick = async () => new Promise((r) => setTimeout(r, 0))
const mkMsg = (role, content, ts) => ({role, content, ts})

/* ============ T1 FE-H1: 两路流式串行化 ============ */
{
	const cb1 = {deltas: "", done: "", error: ""}
	const cb2 = {deltas: "", done: "", error: ""}
	chat.sendChatStream("u", "k", "m", [mkMsg("user", "第一句", 1)], {
		onDelta: (d) => { cb1.deltas += d },
		onDone: (c) => { cb1.done = c },
		onError: (m) => { cb1.error = m },
	})
	await tick() // 队列任务在微任务后才执行 (一次微任务级延迟, 可忽略)
	check("H1: 第一路立即发起 (原生 chatStream 调用 1 次)", chatStreamCalls === 1 && typeof window.__noriChatDelta === "function", `calls=${chatStreamCalls}`)
	chat.sendChatStream("u", "k", "m", [mkMsg("user", "第二句", 2)], {
		onDelta: (d) => { cb2.deltas += d },
		onDone: (c) => { cb2.done = c },
		onError: (m) => { cb2.error = m },
	})
	await tick()
	check("H1: 第二路排队, 不抢占原生流", chatStreamCalls === 1, `calls=${chatStreamCalls}`)
	window.__noriChatDelta("A")
	check("H1: 增量路由到第一路 (不串台)", cb1.deltas === "A" && cb2.deltas === "")
	window.__noriChatDone(JSON.stringify({ok: true, content: "A"}))
	check("H1: 第一路 onDone 收到全文", cb1.done === "A")
	await tick()
	check("H1: 第一路结束后第二路自动发起", chatStreamCalls === 2, `calls=${chatStreamCalls}`)
	window.__noriChatDelta("B")
	check("H1: 增量改路由到第二路", cb2.deltas === "B" && cb1.deltas === "A")
	window.__noriChatDone(JSON.stringify({ok: true, content: "B"}))
	check("H1: 第二路 onDone 收到全文", cb2.done === "B")
	check("H1: 全部结束后单例回调已清理", typeof window.__noriChatDelta !== "function")
}

/* ============ T2 FE-M10: 本地 abort 通知原生 chatStop ============ */
{
	const got = []
	const ac = new AbortController()
	chat.sendChatStream("u", "k", "m", [mkMsg("user", "三", 3)], {
		onDelta: () => {}, onDone: () => {}, onError: (m) => { got.push(m) },
	}, false, ac.signal)
	ac.abort() // 任务尚未起跑时 abort: task 开跑检测 signal.aborted → onAbort
	await tick()
	check("M10: abort 调用原生 chatStop", chatStopCalls === 1, `calls=${chatStopCalls}`)
	check("M10: abort 走 onError(已停止)", got[0] === "已停止", `got=${JSON.stringify(got)}`)
	await tick()
	check("M10: abort 后队列解锁 (下一路能发起)", chatStreamCalls === 2, `calls=${chatStreamCalls}`)
}

/* ============ T3 FE-M12: writeFile 只认 "ok" ============ */
{
	writeFileRawReturn = "ok"
	check("M12: 原生返回 ok → 成功", chat.writeFile("x.json", "{}") === true)
	writeFileRawReturn = "err:insert"
	check("M12: 原生返回 err:insert → 失败", chat.writeFile("x.json", "{}") === false)
	writeFileRawReturn = undefined
	check("M12: 桥异常 undefined → 不再误判成功", chat.writeFile("x.json", "{}") === false)
	writeFileRawReturn = "ok" // 复位: 否则后续用例都在"写盘失败"状态下跑
}

/* ============ T3b 流式空闲看门狗: 原生不回包时不得永久卡死队列 ============
 * 修复前实测: 桥存在且调用成功、但永不回包时, 那一路 Promise 永不 settle →
 *   streamQueue 永久卡住 → 之后所有消息都发不出去, 只能重启 App。
 * 修复后: 距上次 delta 超过 __noriStreamTimeoutMs 即报错并放行队列。
 * 这里把超时调小 (60ms) 以便快速断言。
 */
{
	window.__noriStreamTimeoutMs = 60
	const got1 = []
	chat.sendChatStream("u", "k", "m", [mkMsg("user", "无响应", 10)], {
		onDelta: () => {}, onDone: () => { got1.push("done") }, onError: (m) => { got1.push(m) },
	})
	// 收到一个 delta 也应重置看门狗; 但这一路我们完全不回包, 直接等超时
	await new Promise((r) => setTimeout(r, 160))
	check("T3b: 原生不回包 → 触发超时错误", got1.length === 1 && String(got1[0]).includes("超时"),
		`got=${JSON.stringify(got1)}`)

	// 队列必须已解锁: 下一路能正常发起并完成
	const callsBefore = chatStreamCalls
	const got2 = []
	chat.sendChatStream("u", "k", "m", [mkMsg("user", "第二路", 11)], {
		onDelta: () => {}, onDone: (c) => { got2.push(c) }, onError: (m) => { got2.push(m) },
	})
	await tick()
	check("T3b: 超时后队列解锁 (第二路已发起)", chatStreamCalls === callsBefore + 1,
		`before=${callsBefore} after=${chatStreamCalls}`)
	window.__noriChatDelta("好")
	window.__noriChatDone(JSON.stringify({ok: true, content: "好"}))
	check("T3b: 超时后下一路能正常完成", got2.length === 1 && got2[0] === "好", JSON.stringify(got2))

	// 心跳重置: 只要有 delta 持续到达, 就不该触发超时
	const got3 = []
	chat.sendChatStream("u", "k", "m", [mkMsg("user", "慢速", 12)], {
		onDelta: () => {}, onDone: (c) => { got3.push(c) }, onError: (m) => { got3.push(m) },
	})
	await tick()
	for (let i = 0; i < 4; i += 1) {
		await new Promise((r) => setTimeout(r, 40))   // 每次间隔 40ms < 60ms 超时
		window.__noriChatDelta("字")
	}
	check("T3b: 持续有 delta 时看门狗被重置 (未误判超时)", got3.length === 0, JSON.stringify(got3))
	window.__noriChatDone(JSON.stringify({ok: true, content: "字字字字"}))
	await tick()
	check("T3b: 慢速但持续输出的流能正常完成", got3.length === 1 && got3[0] === "字字字字", JSON.stringify(got3))

	delete window.__noriStreamTimeoutMs
}

/* ============ T4 loadChat 过滤错误气泡 ============ */
{
	files.set("chat.json", JSON.stringify([
		{role: "assistant", content: "⚠ 请求失败", ts: 1},
		{role: "user", content: "你好", ts: 2},
		{role: "assistant", content: "你好呀", ts: 3, error: true},
		{role: "user", content: "讲个笑话", ts: 4},
	]))
	const msgs = chat.loadChat()
	check("loadChat: 旧版 ⚠ 前缀残留被过滤", !msgs.some((m) => m.content.startsWith("⚠")), `n=${msgs.length}`)
	check("loadChat: error 标记气泡被过滤", !msgs.some((m) => m.error === true))
	check("loadChat: 正常消息保留 (2 条)", msgs.length === 2, `n=${msgs.length}`)
}

/* ============ T5 FE-M1: 裁剪边界持久化, 旧消息不再复活 ============ */
{
	files.set("chat.json", JSON.stringify([
		{role: "user", content: "很久以前的消息", ts: 1000},
		{role: "assistant", content: "久远的回复", ts: 2000},
		{role: "user", content: "最近的消息", ts: 9000},
	]))
	check("M1: 前置 - 旧格式可读", chat.loadChat().length === 3)
	chat.setChatTrimCutoff(5000)
	chat.persistChat([{role: "user", content: "最近的消息", ts: 9000}])
	chat.flushChatPersist()
	const saved = JSON.parse(files.get("chat.json"))
	check("M1: 新格式落盘带 cutoff 边界", saved.v === 1 && saved.cutoff === 5000 && saved.msgs.length === 1,
		JSON.stringify({v: saved.v, cutoff: saved.cutoff}))
	// 模拟另一实例用旧快照把已裁消息写回磁盘 → 本实例落盘归并时必须按边界丢弃
	files.set("chat.json", JSON.stringify([
		{role: "user", content: "很久以前的消息", ts: 1000},
		{role: "user", content: "最近的消息", ts: 9000},
	]))
	chat.persistChat([{role: "user", content: "最近的消息", ts: 9000}])
	chat.flushChatPersist()
	const after = JSON.parse(files.get("chat.json"))
	check("M1: 低于边界的旧消息不复活", after.msgs.length === 1 && after.msgs[0].ts === 9000,
		`n=${after.msgs?.length}`)
	check("M1: loadChat 采纳磁盘上更深的边界", chat.loadChat().length === 1)
}

/* ============ T6 FE-M4: 占位符重启后保留 ============ */
{
	files.set("chat.json", JSON.stringify({v: 1, cutoff: 0, msgs: [
		{role: "system", content: "（更早的对话已压缩为历史总结，可在设置→记忆系统查看）", ts: 1, placeholder: true},
		{role: "system", content: "普通系统消息不该回读", ts: 2},
		{role: "user", content: "你好", ts: 3},
	]}))
	const msgs = chat.loadChat()
	check("M4: 占位符读盘保留", msgs.some(m => m.role === "system" && m.content.includes("更早的对话已压缩")))
	check("M4: 非占位符 system 消息仍被过滤", !msgs.some(m => m.content === "普通系统消息不该回读"))
	check("M4: 旧版前缀占位符 (无标记字段) 也识别", (() => {
		files.set("chat.json", JSON.stringify([
			{role: "system", content: "（更早的对话已压缩为历史总结）", ts: 1},
			{role: "user", content: "嗨", ts: 2},
		]))
		return chat.loadChat().length === 2
	})())
}

/* ============ T7 FE-M9: persistChat 真拷贝快照 ============ */
{
	const arr = [{role: "user", content: "写入时的内容", ts: 1}]
	chat.persistChat(arr)
	arr[0].content = "防抖窗口内被改成的内容" // 快照后调用方继续改对象
	chat.flushChatPersist()
	const saved = JSON.parse(files.get("chat.json"))
	check("M9: 防抖窗口内的对象突变不穿透到写盘", saved.msgs[0].content === "写入时的内容",
		`got=${saved.msgs[0].content}`)
}

/* ============ T8 FE-M2: 桥调用超时兜底 ============ */
{
	window.__noriBridgeTimeoutMs = 30
	const r = await chat.fetchModels("https://x", "k")
	check("M2: 原生不回包 → 超时返回错误结果", r.ok === false && r.message.includes("超时"), JSON.stringify(r))
	// 回包正常时不被超时抢先
	window.__noriBridgeTimeoutMs = 10_000
	setTimeout(() => window.__noriModelsRes && window.__noriModelsRes(JSON.stringify({ok: true, models: ["a"]})) , 5)
	const r2 = await chat.fetchModels("https://x", "k")
	check("M2: 正常回包不受影响", r2.ok === true && r2.models?.[0] === "a")
	delete window.__noriBridgeTimeoutMs
}

/* ============ T9 写盘失败不丢批 (flushChatPersist 只在成功后清 pending) ============ */
{
	// 前置: 磁盘上先有一条旧消息
	files.set("chat.json", JSON.stringify({v: 1, cutoff: 0, msgs: [mkMsg("user", "旧消息", 100)]}))

	// 模拟写盘失败 (原生返回 err): 本批消息不得丢失, 且磁盘保持原样
	writeFileRawReturn = "err:disk-full"
	chat.persistChat([mkMsg("user", "旧消息", 100), mkMsg("assistant", "失败期间的新回复", 200)])
	chat.flushChatPersist()
	const afterFail = JSON.parse(files.get("chat.json"))
	check("写盘失败: 磁盘未被写入 (仍是失败前内容)",
		afterFail.msgs.length === 1 && afterFail.msgs[0].ts === 100,
		`n=${afterFail.msgs?.length}`)

	// 恢复可写后重试: 之前失败的那一批必须被补上 (不退化成"丢了")
	writeFileRawReturn = "ok"
	chat.flushChatPersist()
	const afterRetry = JSON.parse(files.get("chat.json"))
	check("写盘失败: 恢复后重试补回整批 (2 条)",
		afterRetry.msgs.length === 2 && afterRetry.msgs.some(m => m.ts === 200),
		`n=${afterRetry.msgs?.length} ts=${afterRetry.msgs?.map(m => m.ts)}`)
	check("写盘失败: 重试后不重复旧消息 (ts=100 只有一条)",
		afterRetry.msgs.filter(m => m.ts === 100).length === 1)

	// 收尾: 写成功以清空 pending, 并等过重试窗口, 避免残留定时器影响后续
	chat.persistChat([mkMsg("user", "收尾", 300)])
	chat.flushChatPersist()
	await new Promise((r) => setTimeout(r, 1200))
}

/* ============ T10 反复裁剪: 占位符不得累积 ============
 * 背景 (真 bug, 2026-09-16 发现): 每次自动裁剪都 unshift 一条新占位符 (ts 用
 * Date.now()), 而归并按 (ts, content) 判重 —— 文案相同、ts 不同 → 被当成两条不同
 * 消息都留下, 于是越积越多。实测 33 轮裁剪后磁盘累积 33 条同样的占位符, 在聊天
 * 界面里显示成一长串重复气泡, 还挤占 HISTORY_KEEP 的真实消息名额。
 * 修复: filterChatMsgs 只留第一条占位符; mergeChatLists 尾部收尾对占位符查重。
 * 注意: 只对**占位符**查重 —— 用户两次说"好的"是合法消息, 不能按内容全局去重。
 */
{
	const PH = "（更早的对话已压缩为历史总结，可在设置→记忆系统查看）"
	files.clear()
	let clock = 1_700_000_000_000
	let messages = []
	// 反复裁剪 12 轮, 每轮都新建占位符 (逐字复刻 App.vue 的动作)
	for (let round = 0; round < 12; round += 1) {
		for (let i = 0; i < 45; i += 1) {
			messages.push(mkMsg(i % 2 ? "assistant" : "user", `r${round}-m${i}`, clock++))
		}
		const kept = messages.slice(-20)
		kept.unshift({role: "system", content: PH, ts: Date.now(), placeholder: true})
		const firstReal = kept.find(m => m.role !== "system")
		if (firstReal) chat.setChatTrimCutoff(firstReal.ts)
		messages = kept
		chat.persistChat(messages)
		chat.flushChatPersist()
		messages = chat.loadChat()
	}
	const disk = JSON.parse(files.get("chat.json"))
	const phCount = disk.msgs.filter(m => m.role === "system").length
	check("T10: 反复裁剪后占位符只留一条 (原 bug 下每轮 +1)",
		phCount === 1, `placeholder=${phCount}`)
	check("T10: 磁盘消息数不随裁剪轮数增长",
		disk.msgs.length <= 21, `n=${disk.msgs.length} (12 轮裁剪)`)
	const reals = disk.msgs.filter(m => m.role !== "system")
	check("T10: 真实消息保持 20 条 (未被占位符挤占)", reals.length === 20, `n=${reals.length}`)
	const dup = {}
	for (const m of reals) dup[`${m.role}|${m.content}`] = (dup[`${m.role}|${m.content}`] || 0) + 1
	const repeated = Object.entries(dup).filter(([, n]) => n > 1)
	check("T10: 无重复的真实消息", repeated.length === 0,
		JSON.stringify(repeated.slice(0, 3)))
	// 合法重复内容不得被吞: 同一句"好的"在不同 ts 下必须都保留
	files.clear()
	chat.persistChat([
		mkMsg("user", "好的", 1000),
		mkMsg("assistant", "嗯嗯", 1001),
		mkMsg("user", "好的", 1002),
		mkMsg("assistant", "嗯嗯", 1003),
	])
	chat.flushChatPersist()
	const kept2 = JSON.parse(files.get("chat.json")).msgs
	check("T10: 合法的重复内容不被误删 (不能按内容全局去重)",
		kept2.filter(m => m.content === "好的").length === 2
		&& kept2.filter(m => m.content === "嗯嗯").length === 2,
		JSON.stringify(kept2.map(m => m.content)))
}

/* ============ T11 裁剪后归并不得重复 (App 全流程复现) ============
 * 背景 (真 bug, 2026-09-16 用户报告"发送过的消息还是会有多次显示重复"):
 * 旧 mergeChatLists 用"按 ts 交错双指针", 一边走完就把另一边**无条件追加**。
 * 裁剪后磁盘与本地的时间戳区间不再对齐 (磁盘是 [.., 24..], 本地是 [4..23, 24..26]),
 * 于是已经被收录过的条目被再追加一遍 —— 实测每轮**翻倍**:
 *   21+22 → 43 → 85 → 167 → 329 …
 * 界面上就是"发过的消息反复重复", 且磁盘文件爆炸式增长。
 *
 * 本块逐字复刻 App.vue 的时序: push user → persistChat → push assistant(liveBubble
 * 流式 mutate) → persistChat → 切后台 flush → 回前台 loadChat → 偶发裁剪。
 * 修复前该流程在第 12 轮就出现 ×2 重复并迅速翻倍。
 */
{
	files.clear()
	chat.__resetChatCutoffForTest()   // 复位裁剪边界: 前面的块留下的 cutoff 会高于本块所有 ts,
	                                  // 导致归并全部丢弃而掩盖 bug (实测踩到过)
	let clock = 1_700_000_000_000
	const now = () => (clock += 7)          // 近似 Date.now(): 每条消息独立取值
	let messages = chat.loadChat()          // onMounted: messages.value = loadChat()
	const dupsIn = (arr) => {
		const c = {}
		for (const m of arr.filter(x => x.role !== "system")) c[m.role + "|" + m.content] = (c[m.role + "|" + m.content] || 0) + 1
		return Object.entries(c).filter(([, n]) => n > 1)
	}
	let firstDup = -1
	let worst = 0
	let lastLen = 0

	for (let round = 0; round < 40; round += 1) {
		messages.push({role: "user", content: `问题${round}`, ts: now()})
		chat.persistChat(messages)
		// 助手流式回复: liveBubble 先 push, 再原地 mutate
		const live = {role: "assistant", content: "", ts: now()}
		messages.push(live)
		live.content += `回答${round}`
		chat.persistChat(messages)
		chat.flushChatPersist()            // 切后台
		messages = chat.loadChat()         // 回前台
		// 每 12 轮模拟一次"摘要成功后裁剪"
		if (round % 12 === 11 && messages.length > 20) {
			const kept = messages.slice(-20)
			kept.unshift({role: "system", content: "（更早的对话已压缩）", ts: now(), placeholder: true})
			const fr = kept.find(m => m.role !== "system")
			if (fr) chat.setChatTrimCutoff(fr.ts)
			messages = kept
			chat.persistChat(messages)
			chat.flushChatPersist()
			messages = chat.loadChat()
		}
		const d = dupsIn(messages)
		if (d.length && firstDup < 0) firstDup = round
		if (d.length > worst) worst = d.length
		// 记录最大重复倍数
		const maxTimes = Math.max(1, ...Object.values(
			messages.filter(x => x.role !== "system").reduce((a, m) => {
				const k = m.role + "|" + m.content
				a[k] = (a[k] || 0) + 1
				return a
			}, {}),
		))
		if (maxTimes > lastLen) lastLen = maxTimes
	}
	const diskMsgs = JSON.parse(files.get("chat.json")).msgs
	check("T11: 裁剪+回前台循环后内存无重复消息",
		dupsIn(messages).length === 0,
		`首次重复在第 ${firstDup} 轮, 重复种类 ${worst}`)
	check("T11: 磁盘无重复消息",
		dupsIn(diskMsgs).length === 0,
		JSON.stringify(dupsIn(diskMsgs).slice(0, 3)))
	check("T11: 无任何消息被重复 3 次以上 (原 bug 会翻倍到 2^n)",
		lastLen <= 2, `最大重复次数=${lastLen}`)
	check("T11: 消息总数不爆炸 (原 bug 下 40 轮会到数百条)",
		diskMsgs.length <= 60, `磁盘=${diskMsgs.length}`)
	// 同内容不同 ts 的合法重复必须保留
	files.clear()
	chat.persistChat([
		mkMsg("user", "好的", 5000), mkMsg("assistant", "嗯嗯", 5001),
		mkMsg("user", "好的", 6000), mkMsg("assistant", "嗯嗯", 6001),
	])
	chat.flushChatPersist()
	const keptSame = JSON.parse(files.get("chat.json")).msgs
	check("T11: 同内容不同时间的合法重复仍保留",
		keptSame.filter(m => m.content === "好的").length === 2
		&& keptSame.filter(m => m.content === "嗯嗯").length === 2,
		JSON.stringify(keptSame.map(m => m.content)))
	// 同 ts 同内容必须去重 (这是防重复的根本)
	files.clear()
	chat.persistChat([mkMsg("user", "重复", 7000), mkMsg("user", "重复", 7000)])
	chat.flushChatPersist()
	check("T11: 同 ts 同内容被去重",
		JSON.parse(files.get("chat.json")).msgs.filter(m => m.content === "重复").length === 1)
	// 同 ts 同角色不同内容 → 只留**更长**的那条 (完整回复 vs 流式部分), 不并存两条气泡。
	// 注: 这条曾写作"同 ts 不同内容都保留", 那其实**固化了 bug** —— 用户会看到两条
	// 助手气泡 (一条部分、一条完整)。代价: 同一毫秒内同角色两条真消息会被合并且留长者,
	// 概率极低 (Date.now 毫秒级) 且只影响 assistant/user 同角色撞车。
	files.clear()
	chat.persistChat([mkMsg("assistant", "部分", 8000), mkMsg("assistant", "完整回复内容", 8000)])
	chat.flushChatPersist()
	const sameTs = JSON.parse(files.get("chat.json")).msgs
	check("T11: 同 ts 同角色只留一条, 且保留更长的 (完整回复)",
		sameTs.length === 1 && sameTs[0].content === "完整回复内容",
		JSON.stringify(sameTs.map(m => m.content)))
	// 但**不同角色**在同一毫秒必须都保留 (防丢: 用户与助手各一条)
	files.clear()
	chat.persistChat([mkMsg("user", "甲", 8500), mkMsg("assistant", "乙", 8500)])
	chat.flushChatPersist()
	check("T11: 同 ts 不同角色都保留 (不丢消息)",
		JSON.parse(files.get("chat.json")).msgs.length === 2)
	files.clear()
	// 磁盘为空时走捷径, 也必须遵守同一套规则
	chat.persistChat([mkMsg("assistant", "短", 8700), mkMsg("assistant", "更长的完整回复", 8700)])
	chat.flushChatPersist()
	check("T11: 空盘捷径路径同样只留更长的那条",
		JSON.parse(files.get("chat.json")).msgs.length === 1,
		JSON.stringify(JSON.parse(files.get("chat.json")).msgs.map(m => m.content)))
}

/* ============ 汇总 ============ */
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
	process.exitCode = 1
	console.log("FAILED:", failed.map(f => f.name).join(" | "))
}
