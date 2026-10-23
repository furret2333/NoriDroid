/**
 * 在线人数（匿名心跳）单测：纯逻辑 + 调度状态机（Node 直跑，不需要 App / 浏览器）。
 *
 * 用 esbuild 把 `src/services/presence.ts` 打成内存 ESM，再用 data: URL 导入；
 * 这样不必在仓库里多留一个生成物（与 tmp-memcheck 下手工保留下来的 bundle 不同）。
 *
 * 运行: cd web-src && node tmp-memcheck/run-presence-tests.mjs
 */
import {readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((d) => d.startsWith("esbuild@"))
if (!esbuildDir) throw new Error("node_modules/.pnpm 下找不到 esbuild，请先 pnpm install")
const {build} = await import(
	pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href
)

const result = await build({
	absWorkingDir: root,
	entryPoints: [path.join(root, "src/services/presence.ts")],
	bundle: true,
	platform: "neutral",
	format: "esm",
	logLevel: "silent",
	write: false,
})
const code = result.outputFiles[0].text
const P = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)

let pass = 0
let fail = 0
const check = (name, cond, detail = "") => {
	if (cond) {
		pass += 1
		console.log(`PASS  ${name}`)
	} else {
		fail += 1
		console.log(`FAIL  ${name}  ← ${detail}`)
	}
}
const tick = () => new Promise((r) => setImmediate(r))

/* ---------------- 安装 ID ---------------- */

const uuidCrypto = {randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}
const id1 = P.generatePresenceId(uuidCrypto, () => 0.5)
check("① randomUUID 路径：去连字符后是 32 位合法 ID", P.isValidPresenceId(id1) && id1.length === 32, id1)
check("①-b randomUUID 结果符合 hex 口径", /^[a-f0-9]{32}$/.test(id1), id1)

const bytesCrypto = {
	getRandomValues: (arr) => {
		for (let i = 0; i < arr.length; i += 1) arr[i] = i * 16
		return arr
	},
}
const id2 = P.generatePresenceId(bytesCrypto, () => 0.5)
check("② getRandomValues 路径（旧 WebView）也是 32 位 hex", /^[a-f0-9]{32}$/.test(id2), id2)

const id3 = P.generatePresenceId({}, () => 0.25) // 只有 Math.random 兜底
check("③ 无 crypto 时 Math.random 兜底仍合法", P.isValidPresenceId(id3) && /^[a-f0-9]{32}$/.test(id3), id3)
check("③-b 兜底路径不是常量", P.generatePresenceId({}, () => 0.25) === id3)

{
	const store = new Map()
	const storage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, v),
	}
	const a = P.ensurePresenceId(storage, () => 0.5)
	const b = P.ensurePresenceId(storage, () => 0.5)
	check("④ ensurePresenceId 首次生成、之后复用同一个 ID", a === b && P.isValidPresenceId(a), `${a} / ${b}`)
	store.set("nori.presence.id", "坏值")
	const c = P.ensurePresenceId(storage, () => 0.5)
	check("④-b 存储里是坏值时会重新生成", c !== "坏值" && P.isValidPresenceId(c), c)
	const d = P.ensurePresenceId(null, () => 0.5)
	const e = P.ensurePresenceId(null, () => 0.5)
	check("④-c localStorage 不可用时也复用同一个内存 ID（防止在线虚增）", d === e && P.isValidPresenceId(d), `${d} / ${e}`)
}

/* ---------------- 响应解析 ---------------- */

check("⑤ 正常响应解析", JSON.stringify(P.parsePresenceResponse('{"ok":true,"online":128,"today":4567}')) === JSON.stringify({online: 128, today: 4567}))
check("⑤-b 小数会被向下取整", P.parsePresenceResponse('{"ok":true,"online":12.9,"today":3.7}').online === 12)
check("⑤-c today 缺失按 0", P.parsePresenceResponse('{"ok":true,"online":1}').today === 0)
check("⑥ ok:false 视为失败", P.parsePresenceResponse('{"ok":false,"online":99}') === null)
check("⑥-b 非法 JSON 视为失败", P.parsePresenceResponse("not json") === null)
check("⑥-c 负数 / NaN 视为失败", P.parsePresenceResponse('{"ok":true,"online":-1}') === null && P.parsePresenceResponse('{"ok":true,"online":"x"}') === null)
check("⑥-d today 负数按 0", P.parsePresenceResponse('{"ok":true,"online":5,"today":-3}').today === 0)
check("⑥-e 失败原因提取：message 字段", P.extractPresenceError('{"ok":false,"message":"HTTP 401"}') === "HTTP 401")
check("⑥-f 失败原因提取：非 JSON 原样截断", P.extractPresenceError("boom") === "boom")

/* ---------------- 文案 ---------------- */

const now0 = 1_000_000_000_000
const fresh = {ok: true, online: 128, today: 4567, at: now0 - 60_000}
check("⑦ 在线主文案", P.presenceCountText(fresh, now0) === "128 位同好", P.presenceCountText(fresh, now0))
check("⑦-b 今日副文案", P.presenceTodayText(fresh, now0) === "今日 4567 位同好来过", P.presenceTodayText(fresh, now0))
check("⑦-c 没数据时主文案是加载中", P.presenceCountText(null, now0) === "加载中…")
check("⑦-d 超过 15 分钟显示暂时连不上", P.presenceCountText(fresh, now0 + P.STALE_MS + 1) === "暂时连不上")
check("⑦-e 超过 15 分钟后 today 文案为空", P.presenceTodayText(fresh, now0 + P.STALE_MS + 1) === "")
check("⑦-f 状态点: 新鲜=live / 失败=stale / 无数据=off",
	P.presenceTone(fresh, now0) === "live" &&
		P.presenceTone({...fresh, failing: true}, now0) === "stale" &&
		P.presenceTone(null, now0) === "off")
check("⑦-g 失败状态说明不谎报在线", /连接不稳定/.test(P.presenceStatusText({...fresh, failing: true}, now0)))
check("⑦-g2 有失败原因时状态文案带原因",
	/暂时连不上.*HTTP 401/.test(P.presenceStatusText({ok: false, online: 0, today: 0, at: 0, failing: true, error: "HTTP 401"}, now0)),
	P.presenceStatusText({ok: false, online: 0, today: 0, at: 0, failing: true, error: "HTTP 401"}, now0))
check("⑦-h 未配置时状态说明", P.presenceStatusText(null, now0, false) === "未配置在线人数服务")

/* ---------------- 运行时地址 ---------------- */

{
	const saved = globalThis.window
	// PRESENCE_URL 可以是空串（功能关闭）也可以是已部署地址；这里断言两者口径一致
	check("⑧ 无 override 时使用 PRESENCE_URL 常量",
		P.runtimePresenceUrl() === P.PRESENCE_URL, JSON.stringify({url: P.PRESENCE_URL}))
	check("⑧-a 空串=未配置 / https 地址=已配置",
		P.presenceConfigured() === /^https:\/\//.test(P.PRESENCE_URL), P.PRESENCE_URL)
	globalThis.window = {__noriPresenceUrl: "https://presence.test"}
	check("⑧-b window.__noriPresenceUrl 可以覆盖（探针用）",
		P.presenceConfigured() === true && P.runtimePresenceUrl() === "https://presence.test")
	check("⑧-d 填服务根地址 → 自动补 /v1/heartbeat",
		P.heartbeatUrl() === "https://presence.test/v1/heartbeat", P.heartbeatUrl())
	globalThis.window = {__noriPresenceUrl: "https://presence.test/"}
	check("⑧-e 尾部斜杠不会产生双斜杠",
		P.heartbeatUrl() === "https://presence.test/v1/heartbeat", P.heartbeatUrl())
	globalThis.window = {__noriPresenceUrl: "https://presence.test/v1/heartbeat"}
	check("⑧-f 误填完整端点不会变成 /v1/heartbeat/v1/heartbeat",
		P.heartbeatUrl() === "https://presence.test/v1/heartbeat", P.heartbeatUrl())
	globalThis.window = {
		__noriPresenceUrl: "https://xztoatqtnlehfauywosa.supabase.co/rest/v1/rpc/presence_heartbeat",
	}
	check("⑧-g Supabase RPC 地址原样使用（不追加 /v1/heartbeat）",
		P.heartbeatUrl() ===
			"https://xztoatqtnlehfauywosa.supabase.co/rest/v1/rpc/presence_heartbeat",
		P.heartbeatUrl())
	globalThis.window = {
		__noriPresenceUrl:
			"https://noridroid-presence-d8csu101fba36.api.tcloudbasegateway.com/v1/rdb/rest/rpc/presence_heartbeat",
	}
	check("⑧-h CloudBase RPC 地址原样使用（不追加 /v1/heartbeat）",
		P.heartbeatUrl() ===
			"https://noridroid-presence-d8csu101fba36.api.tcloudbasegateway.com/v1/rdb/rest/rpc/presence_heartbeat",
		P.heartbeatUrl())

	globalThis.window = {__noriPresenceUrl: "http://insecure.test"}
	check("⑧-c 覆盖成非 https 仍视为未配置", P.presenceConfigured() === false)
	globalThis.window = saved
	if (saved === undefined) delete globalThis.window
}

/* ---------------- 调度状态机 ---------------- */

const makeHarness = (init = {}) => {
	let now = 1_000_000
	const timers = new Map()
	let seq = 0
	const sent = []
	const changes = []
	const vis = {visible: init.visible !== false}
	const deps = {
		now: () => now,
		isVisible: () => vis.visible,
		send: async (url, id, version) => {
			sent.push({url, id, version, at: now})
			const r = init.responses?.length ? init.responses.shift() : '{"ok":true,"online":1,"today":2}'
			if (r instanceof Error) throw r
			return r
		},
		onChange: (s) => changes.push(s),
		setTimer: (fn, ms) => {
			const id = ++seq
			timers.set(id, {fn, ms})
			return id
		},
		clearTimer: (id) => timers.delete(id),
		getId: () => "a".repeat(32),
		url: () => init.url ?? "https://presence.test",
	}
	const service = P.createPresenceService(deps)
	const timer = () => [...timers.values()][0]
	const fire = async () => {
		const t = timer()
		if (!t) return false
		timers.delete([...timers.keys()][0])
		t.fn()
		await tick()
		return true
	}
	return {
		service,
		sent,
		changes,
		vis,
		timer,
		fire,
		advance: (ms) => { now += ms },
		now: () => now,
	}
}

{
	const h = makeHarness()
	h.service.start("2.5.0")
	await tick()
	check("⑨ start 立即发一次心跳", h.sent.length === 1 && h.sent[0].url === "https://presence.test", JSON.stringify(h.sent))
	check("⑨-b 上报含版本号", h.sent[0].version === "2.5.0")
	check("⑨-c 状态更新为在线 1 / 今日 2", h.service.get()?.online === 1 && h.service.get()?.today === 2)
	check("⑨-d 下一次心跳 = 5 分钟", h.timer()?.ms === P.HEARTBEAT_MS, JSON.stringify(h.timer()))

	await h.fire()
	check("⑩ 定时器到点再发一次", h.sent.length === 2, `sent=${h.sent.length}`)

	h.vis.visible = false
	await h.fire()
	check("⑪ 后台时不发请求（只重新排期）", h.sent.length === 2, `sent=${h.sent.length}`)
	check("⑪-b 后台时仍保留 5 分钟排期", h.timer()?.ms === P.HEARTBEAT_MS)

	h.service.stop()
	check("⑫ stop 后清掉计时器", h.timer() === undefined)
	h.vis.visible = true
	h.service.start("2.5.0")
	await tick()
	check("⑫-b stop 后可重新 start", h.sent.length === 3, `sent=${h.sent.length}`)
}

{
	const h = makeHarness({responses: [new Error("网络失败"), '{"ok":true,"online":7,"today":9}']})
	h.service.start("2.5.0")
	await tick()
	check("⑬ 首次失败: 状态标 failing、不抛异常", h.service.get()?.failing === true && h.service.get()?.ok === false)
	check("⑬-b 首次失败后退避 60 秒", h.timer()?.ms === P.MIN_RETRY_MS, JSON.stringify(h.timer()))
	await h.fire()
	check("⑭ 第二次成功: 数值正确且清掉 failing", h.service.get()?.online === 7 && !h.service.get()?.failing)
	check("⑭-b 成功后回到 5 分钟间隔", h.timer()?.ms === P.HEARTBEAT_MS, JSON.stringify(h.timer()))

	const before = h.sent.length
	h.advance(P.MIN_GAP_MS + 1)
	h.service.onVisible("2.5.0")
	await tick()
	check("⑮ 回前台超过 60s 会补一次心跳", h.sent.length === before + 1, `sent=${h.sent.length}`)
	h.service.onVisible("2.5.0")
	await tick()
	check("⑮-b 60s 内重复 onVisible 不重复请求", h.sent.length === before + 1)
}

{
	const h = makeHarness({responses: ['{"ok":true,"online":3,"today":4}']})
	h.service.stop()
	await tick()
	h.service.refresh("2.5.0")
	await tick()
	check("⑯ 未 start 时 refresh 也能工作（探针注入地址后用）", h.sent.length === 1 && h.service.get()?.online === 3)
	h.service.stop()
}

{
	const h = makeHarness()
	h.service.start("2.5.0")
	await tick()
	const before = h.sent.length
	h.advance(P.MIN_GAP_MS + 1)
	h.service.onVisible("2.5.0")
	await tick()
	check("⑰ onVisible 在 60s 后会补一次", h.sent.length === before + 1)
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail) process.exitCode = 1
