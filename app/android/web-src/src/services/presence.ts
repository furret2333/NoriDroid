/**
 * 在线人数（2026-10-21 用户需求）
 *
 * 做什么：主界面在前台时每 5 分钟发一次**匿名心跳**，服务端按 10 分钟窗口
 * 去重计数，返回「此刻在线 / 今日来过」，显示在「关于 / 隐私」页。
 *
 * 为什么这样设计（读完项目后的约束）：
 * - WebView 只放行 appassets + pinme.dev（`WebAssets.ALLOWED_SUBRESOURCE_DOMAINS`），
 *   所以请求走**原生桥** `NoriChat.presencePing`（Kotlin 侧 HttpURLConnection），
 *   不扩大页面可访问的域、也不需要 CORS。
 * - 上报内容只有 **随机安装 ID + 应用版本号 + 平台**；不含设备标识 / 聊天 / 人设。
 * - 服务端不可用 / 未部署时**静默降级**：不弹错、不影响其它功能，最多显示「暂时连不上」。
 * - 纯逻辑（校验 / 解析 / 文案 / 调度）都放在这里，可被 Node 门禁直接测（见 tmp-memcheck）。
 *
 * 端点部署：`services/presence/`（Cloudflare Worker + Durable Object），
 * 部署后把地址填到下面的 `PRESENCE_URL`，或探针里用 `window.__noriPresenceUrl` 覆盖。
 */

/** 计数服务地址（完整端点）。留空 = 功能未启用（关于页不显示在线人数，也不发任何请求）。
 *  2026-10-23：Cloudflare（workers.dev + 自定义域名）在国内被阻断，改用 Supabase 免费版的
 *  Postgres RPC（schema 见 services/presence-supabase/schema.sql）。
 *  换服务端只改这一行。 */
export const PRESENCE_URL =
	"https://xztoatqtnlehfauywosa.supabase.co/rest/v1/rpc/presence_heartbeat"

/** Supabase 的 publishable key（公开值，会打进客户端；只用于 apikey header）。
 *  换后端/换项目时和 PRESENCE_URL 一起改。 */
export const PRESENCE_KEY = "sb_publishable_5DOhaCD0oQUeGFHK9Bcbyg_NMR7gHjj"

/** 心跳间隔：5 分钟（服务端窗口 10 分钟，留一次容错） */
export const HEARTBEAT_MS = 5 * 60_000
/** 失败后的第一次重试间隔（指数退避：15s → 30s → 1min → 2min → 5min 封顶）
 *  首试失败多半是刚启动/切网，15 秒就重试，别让用户干等一分钟。 */
export const MIN_RETRY_MS = 15_000
const MAX_RETRY_MS = 5 * 60_000
/** 超过这么久没有成功响应，就不再展示旧数字 */
export const STALE_MS = 15 * 60_000
/** 回前台补心跳的最小间隔（避免频繁切前台反复请求） */
export const MIN_GAP_MS = 60_000
/** 原生桥回调的兜底超时（原生 connect/read 各 8s，这里留到 20s） */
const BRIDGE_TIMEOUT_MS = 20_000
const ID_KEY = "nori.presence.id"

export interface PresenceState {
	/** 最近一次**成功**响应；失败时这里仍是上次的好值 */
	ok: boolean
	online: number
	today: number
	/** 客户端收到响应的本地时间（ms） */
	at: number
	/** 最近一次请求失败（旧值继续显示，但标成"不稳定"） */
	failing?: boolean
	/** 最近一次失败的原始原因（HTTP 401 / 超时 / 解析失败…），用于设置页排查 */
	error?: string
}

export type PresenceTone = "live" | "stale" | "off"

/** 运行时地址：探针/调试可用 `window.__noriPresenceUrl` 覆盖，生产用常量。 */
export const runtimePresenceUrl = (): string => {
	const w = typeof window === "undefined"
		? null
		: (window as unknown as {__noriPresenceUrl?: unknown})
	const override = w?.__noriPresenceUrl
	if (typeof override === "string" && override.trim()) return override.trim()
	return PRESENCE_URL.trim()
}

/**
 * 心跳端点：兼容三种填法 ——
 *   - Supabase RPC 完整地址 `…/rest/v1/rpc/presence_heartbeat`（当前使用）
 *   - 服务根地址 `https://xxx.workers.dev`（旧 Cloudflare 后端）
 *   - 完整端点 `https://xxx.workers.dev/v1/heartbeat`
 * Supabase RPC 地址原样返回；其余统一补成 `/v1/heartbeat`。空地址返回空串。
 */
export const heartbeatUrl = (): string => {
	const raw = runtimePresenceUrl().replace(/\/+$/, "")
	if (!raw) return ""
	if (/\/rest\/v1\/rpc\/[A-Za-z0-9_]+$/.test(raw)) return raw
	const base = raw.replace(/\/v1\/heartbeat$/, "")
	return `${base}/v1/heartbeat`
}

/** 是否配置了计数服务（未配置时整块 UI 不出现，也不发请求）。 */
export const presenceConfigured = (): boolean => /^https:\/\//.test(runtimePresenceUrl())

/* ---------------- 安装 ID ---------------- */

export const isValidPresenceId = (id: unknown): id is string =>
	typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id)

interface CryptoLike {
	randomUUID?: () => string
	getRandomValues?: (a: Uint8Array) => Uint8Array
}

const defaultCrypto = (): CryptoLike | undefined => {
	const c = (globalThis as unknown as {crypto?: CryptoLike}).crypto
	if (!c) return undefined
	return typeof c.randomUUID === "function" || typeof c.getRandomValues === "function" ? c : undefined
}

/**
 * 生成 32 位十六进制安装 ID。
 * Android 7 的 WebView 可能没有 `crypto.randomUUID`（Chrome 92+），故逐级回退：
 * randomUUID → getRandomValues → Math.random（仅作匿名标识，不用于安全用途）。
 */
export const generatePresenceId = (
	c: CryptoLike | undefined = defaultCrypto(),
	random: () => number = Math.random,
): string => {
	if (c?.randomUUID) {
		try {
			const stripped = String(c.randomUUID()).replace(/-/g, "")
			if (isValidPresenceId(stripped)) return stripped
		} catch { /* 回退 */ }
	}
	if (c?.getRandomValues) {
		try {
			const bytes = new Uint8Array(16)
			c.getRandomValues(bytes)
			return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
		} catch { /* 回退 */ }
	}
	let out = ""
	for (let i = 0; i < 32; i += 1) out += Math.floor(random() * 16).toString(16)
	return out
}

export interface PresenceStorage {
	getItem: (key: string) => string | null
	setItem: (key: string, value: string) => void
}

const defaultStorage = (): PresenceStorage | null => {
	try {
		return typeof localStorage === "undefined" ? null : localStorage
	} catch {
		return null
	}
}

/**
 * 读取/生成并持久化安装 ID（换机、清数据会换新 ID，这是预期行为）。
 *
 * 内存兜底很重要：如果 localStorage 读/写失败（隐私模式、存储配额、旧 WebView），
 * 每次心跳都重新生成 ID 会让服务端把同一台设备当成 N 个在线用户。所以生成过一次
 * 就记在模块里，哪怕没写进 storage 也复用同一个。
 */
let fallbackPresenceId = ""
export const ensurePresenceId = (
	storage: PresenceStorage | null = defaultStorage(),
	random: () => number = Math.random,
): string => {
	try {
		const saved = storage?.getItem(ID_KEY) ?? ""
		if (isValidPresenceId(saved)) {
			fallbackPresenceId = saved
			return saved
		}
	} catch { /* 读失败 → 用内存兜底 */ }
	if (fallbackPresenceId) return fallbackPresenceId
	const id = generatePresenceId(undefined, random)
	fallbackPresenceId = id
	try {
		storage?.setItem(ID_KEY, id)
	} catch { /* 忽略：内存里已经有同一个 ID */ }
	return id
}

/* ---------------- 响应解析与文案（纯函数） ---------------- */

export interface PresenceResponse {
	online: number
	today: number
}

/** 解析原生桥回传的 JSON；任何异常都返回 null（调用方按失败处理）。 */
export const parsePresenceResponse = (raw: string): PresenceResponse | null => {
	try {
		const j = JSON.parse(raw) as {ok?: unknown; online?: unknown; today?: unknown} | null
		if (!j || j.ok !== true) return null
		const online = Number(j.online)
		if (!Number.isFinite(online) || online < 0) return null
		const today = Number(j.today)
		return {
			online: Math.floor(online),
			today: Number.isFinite(today) && today >= 0 ? Math.floor(today) : 0,
		}
	} catch {
		return null
	}
}

/** 从原生桥回传里提取失败原因（用于设置页展示；没有就返回空串）。 */
export const extractPresenceError = (raw: string): string => {
	try {
		const j = JSON.parse(raw) as {message?: unknown; error?: unknown} | null
		const m = typeof j?.message === "string" ? j.message : typeof j?.error === "string" ? j.error : ""
		if (m) return m.slice(0, 120)
	} catch { /* 不是 JSON */ }
	const s = String(raw ?? "").replace(/\s+/g, " ").trim()
	return s ? s.slice(0, 120) : ""
}

const isPresenceFresh = (state: PresenceState | null, now: number): boolean =>
	!!state && state.ok && now - state.at <= STALE_MS

export const presenceTone = (state: PresenceState | null, now: number): PresenceTone => {
	if (!state || !state.ok) return "off"
	if (state.failing || !isPresenceFresh(state, now)) return "stale"
	return "live"
}

/** 「此刻在线」的主文案 */
export const presenceCountText = (state: PresenceState | null, now: number): string => {
	if (!state) return "加载中…"
	if (state.ok && isPresenceFresh(state, now)) return `${state.online} 位同好`
	return "暂时连不上"
}

/** 「今日来过」的副文案（没有数据时返回空串，调用方直接不渲染） */
export const presenceTodayText = (state: PresenceState | null, now: number): string => {
	if (!state || !state.ok || state.today <= 0 || !isPresenceFresh(state, now)) return ""
	return `今日 ${state.today} 位同好来过`
}

/** 状态说明（关于页第二行 / 设置里的解释） */
export const presenceStatusText = (
	state: PresenceState | null,
	now: number,
	configured = true,
): string => {
	if (!configured) return "未配置在线人数服务"
	if (!state) return "正在连接在线人数服务…"
	if (!state.ok) return state.error ? `暂时连不上：${state.error}` : "暂时连不上计数服务，稍后自动重试"
	if (state.failing) return state.error ? `连接不稳定：${state.error}` : "连接不稳定，显示的是上一次的在线人数"
	if (now - state.at > STALE_MS) return "计数服务已超过 15 分钟没有响应"
	return "匿名心跳：随机安装 ID + 版本号，不含设备标识与聊天内容；今日按北京时间；可在设置里关闭"
}

/* ---------------- 心跳调度（依赖注入，便于门禁单测） ---------------- */

export interface PresenceDeps {
	now: () => number
	isVisible: () => boolean
	/** 发一次心跳，返回原生桥回传的 JSON 字符串 */
	send: (url: string, id: string, version: string) => Promise<string>
	onChange: (state: PresenceState | null) => void
	setTimer: (fn: () => void, ms: number) => number
	clearTimer: (id: number) => void
	getId: () => string
	url: () => string
}

export interface PresenceService {
	/** 开始心跳（立即发一次，然后按间隔调度） */
	start: (version: string) => void
	/** 立刻刷新一次（version 可选，用于探针在 URL 注入后补一次） */
	refresh: (version?: string, force?: boolean) => void
	/** 页面重新可见时调用：距上次尝试超过 MIN_GAP_MS 才补一次 */
	onVisible: (version?: string) => void
	stop: () => void
	get: () => PresenceState | null
}

export const createPresenceService = (deps: PresenceDeps): PresenceService => {
	let state: PresenceState | null = null
	let timer = 0
	let running = false
	let inFlight = false
	let version = ""
	let lastAttempt = 0
	let failCount = 0

	const emit = (): void => deps.onChange(state)
	const clear = (): void => {
		if (timer) {
			deps.clearTimer(timer)
			timer = 0
		}
	}
	const schedule = (ms: number): void => {
		clear()
		if (running) timer = deps.setTimer(() => { void run(false) }, ms)
	}

	const run = async (force: boolean): Promise<void> => {
		if (!running || inFlight) return
		const url = deps.url()
		if (!url) return
		if (!force && !deps.isVisible()) {
			schedule(HEARTBEAT_MS)
			return
		}
		inFlight = true
		lastAttempt = deps.now()
		try {
			const raw = await deps.send(url, deps.getId(), version)
			const parsed = parsePresenceResponse(raw)
			if (!parsed) throw new Error(extractPresenceError(raw) || "在线人数响应无法解析")
			state = {ok: true, online: parsed.online, today: parsed.today, at: deps.now()}
			failCount = 0
		} catch (e) {
			failCount += 1
			const msg = e instanceof Error ? e.message : String(e)
			state = state
				? {...state, failing: true, error: msg}
				: {ok: false, online: 0, today: 0, at: 0, failing: true, error: msg}
		} finally {
			inFlight = false
		}
		emit()
		schedule(
			failCount > 0
				? Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(failCount - 1, 3))
				: HEARTBEAT_MS,
		)
	}

	return {
		start(v: string) {
			version = v
			running = true
			void run(true)
		},
		refresh(v?: string, force = true) {
			if (v) version = v
			running = true
			void run(force)
		},
		onVisible(v?: string) {
			if (v) version = v
			if (!running) return
			if (deps.now() - lastAttempt >= MIN_GAP_MS) void run(true)
		},
		stop() {
			running = false
			clear()
		},
		get() {
			return state
		},
	}
}

/* ---------------- 浏览器侧单例 + 原生桥 ---------------- */

type BridgeWindow = {
	NoriChat?: {presencePing?: (url: string, id: string, version: string, apiKey: string) => void}
	__noriPresenceRes?: (json: string) => void
}

const sendViaBridge = (url: string, id: string, version: string): Promise<string> =>
	new Promise((resolve, reject) => {
		const w = window as unknown as BridgeWindow
		const nori = w.NoriChat
		if (!nori || typeof nori.presencePing !== "function") {
			reject(new Error("NoriChat.presencePing 未注入"))
			return
		}
		let done = false
		const timer = window.setTimeout(() => {
			if (done) return
			done = true
			delete w.__noriPresenceRes
			reject(new Error("在线人数心跳超时"))
		}, BRIDGE_TIMEOUT_MS)
		w.__noriPresenceRes = (json: string) => {
			if (done) return
			done = true
			window.clearTimeout(timer)
			delete w.__noriPresenceRes
			resolve(String(json ?? ""))
		}
		try {
			// 第 4 个参数是 Supabase publishable key（其他后端可为空）
			nori.presencePing(url, id, version, PRESENCE_KEY)
		} catch (e) {
			if (done) return
			done = true
			window.clearTimeout(timer)
			delete w.__noriPresenceRes
			reject(e)
		}
	})

const listeners = new Set<(state: PresenceState | null) => void>()
let singleton: PresenceService | null = null

/* ---------------- 发送通道：优先 WebView fetch，失败再走原生桥 ----------------
 * 2026-10-23 实机反馈：原生 HttpURLConnection 请求 Supabase 时出现 "connection reset"，
 * 但同一台手机的浏览器能正常访问 Supabase（Chromium 网络栈）。所以优先用 WebView fetch
 * （需要 WebAssets 把本项目 Supabase host 放行），失败再回退原生桥。
 * 探针/调试可用 window.__noriPresenceFetch = false 强制走原生桥。
 */
const FETCH_TIMEOUT_MS = 10_000
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const sendViaFetch = async (url: string, id: string, version: string): Promise<string> => {
	const w = window as unknown as {__noriPresenceFetch?: boolean}
	if (w.__noriPresenceFetch === false) throw new Error("fetch 已禁用（探针）")
	if (typeof fetch !== "function") throw new Error("WebView 不支持 fetch")
	const ctl = typeof AbortController !== "undefined" ? new AbortController() : null
	const timer = ctl ? window.setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : 0
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				apikey: PRESENCE_KEY,
			},
			body: JSON.stringify({p_id: id, p_v: version}),
			cache: "no-store",
			signal: ctl?.signal,
		})
		const text = await res.text()
		if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
		if (!parsePresenceResponse(text)) throw new Error(text ? extractPresenceError(text) : "fetch 响应为空")
		return text
	} finally {
		if (timer) window.clearTimeout(timer)
	}
}

/** 先 fetch，失败再原生桥；两条都失败时把两边的错误都带出来。 */
const sendPresence = async (url: string, id: string, version: string): Promise<string> => {
	let fetchError = ""
	try {
		return await sendViaFetch(url, id, version)
	} catch (e) {
		fetchError = msgOf(e)
	}
	try {
		const raw = await sendViaBridge(url, id, version)
		if (parsePresenceResponse(raw)) return raw
		const nativeMsg = extractPresenceError(raw) || "响应无法解析"
		throw new Error(`fetch: ${fetchError}；native: ${nativeMsg}`)
	} catch (e) {
		const nativeMsg = msgOf(e)
		if (nativeMsg.startsWith("fetch:")) throw e
		throw new Error(`fetch: ${fetchError}；native: ${nativeMsg}`)
	}
}

const getService = (): PresenceService => {
	if (!singleton) {
		singleton = createPresenceService({
			now: () => Date.now(),
			isVisible: () => typeof document === "undefined" || !document.hidden,
			send: sendPresence,
			onChange: (s) => {
				for (const fn of listeners) {
					try {
						fn(s)
					} catch { /* 订阅方异常不影响心跳 */ }
				}
			},
			setTimer: (fn, ms) => window.setTimeout(fn, ms),
			clearTimer: (id) => window.clearTimeout(id),
			getId: () => ensurePresenceId(),
			// 注意：这里必须是**完整心跳端点**（带 /v1/heartbeat），不是服务根地址
			url: heartbeatUrl,
		})
	}
	return singleton
}

export const subscribePresence = (fn: (state: PresenceState | null) => void): (() => void) => {
	listeners.add(fn)
	fn(singleton?.get() ?? null)
	return () => {
		listeners.delete(fn)
	}
}

export const startPresence = (version: string): void => {
	if (!presenceConfigured()) return
	getService().start(version)
}

export const stopPresence = (): void => {
	singleton?.stop()
}

export const refreshPresence = (version: string): void => {
	if (!presenceConfigured()) return
	getService().refresh(version, true)
}

export const presenceOnVisible = (version: string): void => {
	if (!presenceConfigured()) return
	singleton?.onVisible(version)
}
