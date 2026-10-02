/**
 * 背景音乐服务: NoriOS 官方 OST 三首.
 * 音频不入 APK —— 首次使用经原生桥 (NoriChat.bgmDownload) 从远程资源包下载并
 * 解压到应用私有目录 (filesDir/bgm, 覆盖升级保留), 再由 WebViewAssetLoader 的
 * /bgm-local/ 路径处理器 (BgmPathHandler) 从本地供流, 之后无需二次下载.
 * - random 模式随机选曲且避免连播同一首; "换一首"再随机
 * - 自动播放限制: 设置开关本身是用户手势; 启动时若已开启, 挂一次性 pointerdown 重试
 * - 音量独立于 TTS 朗读音量
 */
import type {Settings} from "./chat"

export interface BgmTrack {
	id: string
	name: string
	file: string
}

export const BGM_TRACKS: BgmTrack[] = [
	{id: "bgm_memory", name: "记忆", file: "bgm_memory.mp3"},
	{id: "bgm1", name: "数据海", file: "bgm1.m4a"},
	{id: "nori_daily_manifold", name: "日常", file: "nori_daily_manifold.mp3"},
]

export type BgmState = "missing" | "downloading" | "ready"

export const bgmNameOf = (id: string): string =>
	id === "random" ? "随机播放" : (BGM_TRACKS.find(t => t.id === id)?.name ?? id)

let audio: HTMLAudioElement | null = null
let enabled = false
let track: string = "random"
let currentId: string | null = null
let volume = 0.35
let gestureHooked = false
let state: BgmState = "missing"
let downloadPct = 0
let wantPlay = false // 已开启且应处于播放中 (含下载完成待起播)
/**
 * TTS 闪避 (ducking): Nori 开口朗读时把背景音乐压到 **60%**, 说完恢复。
 *
 * ## 2026-09-26 调整 (用户: "nori 说话的时候背景音下降的少一点")
 * 原来: 固定压到 **20%** (基准 0.35 → 0.07), 而且是 `audioEl.volume = ...` **一帧硬切**。
 *   · 20% 太狠 —— 人声清楚是以"背景乐基本消失"为代价换来的;
 *   · 硬切本身比"降多少"更刺耳: 下降/回升都是瞬间跳变, 听感像断了一下。
 * 现在: 压到 60% + **渐变** (下降 160ms / 回升 220ms)。回升略慢, 因为"突然变响"比"突然变轻"更突兀。
 * `volume` 属性不支持曲线, 渐变只能用 rAF 逐帧赋值 —— 只有几十毫秒、单个音频元素, 成本可忽略。
 */
const DUCK_FACTOR = 0.6
const DUCK_FADE_IN_MS = 160    // 开始说话: 降下去
const DUCK_FADE_OUT_MS = 220   // 说完: 升回来

let ducked = false // TTS 闪避: Nori 说话时背景音乐自动压低

let stateHandler: ((s: BgmState, pct: number) => void) | null = null
let errorHandler: ((msg: string) => void) | null = null
let busyPoller: ReturnType<typeof setInterval> | null = null

const notifyState = (): void => {
	try { stateHandler?.(state, downloadPct) } catch { /* 忽略 */ }
}

/** "err:busy" = 原生侧已有下载在跑 (如页面重载打断): 保持"下载中"并轮询本地文件,
 *  就绪后自动起播; 轮询上限 10 分钟防死循环 */
const pollBusyReady = (): void => {
	if (busyPoller) return
	let polls = 0
	busyPoller = setInterval(() => {
		polls += 1
		const ready = queryReady()
		if (ready || state !== "downloading" || polls > 200) {
			if (busyPoller) { clearInterval(busyPoller); busyPoller = null }
			if (ready) {
				state = "ready"
				downloadPct = 100
				notifyState()
				if (enabled && wantPlay) startPlayback()
			} else if (state === "downloading") {
				state = "missing"
				notifyState()
			}
		}
	}, 3000)
}

export const setBgmStateHandler = (cb: ((s: BgmState, pct: number) => void) | null): void => {
	stateHandler = cb
}

export const setBgmErrorHandler = (cb: ((msg: string) => void) | null): void => {
	errorHandler = cb
}

/** 目标音量 (闪避中 = 基准 × DUCK_FACTOR) */
const targetVolume = (): number => (ducked ? volume * DUCK_FACTOR : volume)

let duckRaf = 0
let duckFrom = -1

/**
 * 平滑地把音量推到目标值 (rAF 逐帧线性)。
 * 不用 CSS/WebAudio: 只要一个音量滑杆, 没必要为它搭 AudioContext 图。
 * 每一帧都重新读 targetVolume(): 渐变途中用户拖了音量条/又切了说话状态, 也会顺着新目标走。
 */
const fadeVolume = (): void => {
	if (!audioEl) return
	if (duckRaf) { cancelAnimationFrame(duckRaf); duckRaf = 0 }
	const from = audioEl.volume
	const dur = ducked ? DUCK_FADE_IN_MS : DUCK_FADE_OUT_MS
	if (from === targetVolume() || dur <= 0) { audioEl.volume = targetVolume(); return }
	const t0 = performance.now()
	duckFrom = from
	const step = (): void => {
		duckRaf = 0
		if (!audioEl) return
		const p = Math.min(1, (performance.now() - t0) / dur)
		audioEl.volume = Math.min(1, Math.max(0, duckFrom + (targetVolume() - duckFrom) * p))
		if (p < 1) duckRaf = requestAnimationFrame(step)
	}
	duckRaf = requestAnimationFrame(step)
}

/** 立即对齐到目标音量 (起播/切曲/拖音量条这类"不该有渐变"的场合用) */
const applyVolume = (): void => {
	if (duckRaf) { cancelAnimationFrame(duckRaf); duckRaf = 0 }
	if (audioEl) audioEl.volume = targetVolume()
}

/** TTS 闪避 (ducking): Nori 开口朗读时压低到 60%, 说完渐回 (由朗读播放状态回调驱动) */
export const setBgmDucking = (on: boolean): void => {
	if (ducked === on) return
	ducked = on
	fadeVolume()
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.35)

let audioEl: HTMLAudioElement | null = null

const ensureAudio = (): HTMLAudioElement => {
	if (!audioEl) {
		audioEl = new Audio()
		audioEl.loop = true
		audioEl.preload = "auto"
		audioEl.onerror = () => {
			if (enabled) {
				try { errorHandler?.("音频读取失败, 请尝试重新下载背景音乐资源") } catch { /* 忽略 */ }
			}
		}
	}
	return audioEl
}

interface BgmBridge {
	bgmStatus?: () => string
	bgmDownload?: () => string
}

const bridge = (): BgmBridge | null =>
	(window as unknown as {NoriChat?: BgmBridge}).NoriChat ?? null

/** 同步查询本地资源状态 (原生桥返回 JSON) */
const queryReady = (): boolean => {
	try {
		const raw = bridge()?.bgmStatus?.()
		if (!raw) return state === "ready"
		const parsed = JSON.parse(raw) as {ready?: boolean}
		return !!parsed.ready
	} catch {
		return state === "ready"
	}
}

/**
 * 与**磁盘上的真实文件**对齐一次「已下载」状态, 并把结果通知 UI。
 *
 * ## 为什么必须有这一步（2026-10-02 用户报的 bug）
 * 旧实现只在"开关已打开"那条分支里 `queryReady()` —— 开关关着时 `syncBgm` 直接 return,
 * 状态永远停在模块初始值 `missing`。于是：**资源明明已经躺在 filesDir/bgm 里, 关掉 App 再打开,
 * 设置里又显示「下载背景音乐资源」**（用户看到的正是这个）。
 *
 * 判据刻意**只认磁盘**：原生 `bgmStatus()` 每次现查三个音频文件是否存在且非空
 * （见 ChatBridge.bgmStatus），没有任何"下载完成"标记文件可失真 —— 所以这里问一次原生就够了,
 * 不看开关、不看内存里的旧值。
 *
 * @returns 磁盘上资源是否齐备
 */
export const refreshBgmReady = (): boolean => {
	if (queryReady()) {
		if (state !== "ready") {
			state = "ready"
			downloadPct = 100
			notifyState()
		}
		return true
	}
	// 资源不在了 (被清过/换机): 只有"曾以为就绪"才回退, 免得把"下载中"或"已失败"冲掉
	if (state === "ready") {
		state = "missing"
		downloadPct = 0
		notifyState()
	}
	return false
}

/** 原生下载器回调: 进度 / 完成 / 失败 */
const onDownloadResult = (json: string): void => {
	try {
		const r = JSON.parse(json) as {stage?: string; pct?: number; message?: string}
		if (r.stage === "progress") {
			state = "downloading"
			downloadPct = Math.max(0, Math.min(100, Math.round(Number(r.pct) || 0)))
			notifyState()
		} else if (r.stage === "done") {
			state = "ready"
			downloadPct = 100
			notifyState()
			if (enabled && wantPlay) startPlayback()
		} else if (r.stage === "error") {
			state = queryReady() ? "ready" : "missing"
			downloadPct = 0
			notifyState()
			try { errorHandler?.(r.message ?? "下载失败") } catch { /* 忽略 */ }
		}
	} catch { /* 忽略 */ }
}

// 原生侧只检查 window.__noriBgmRes 存在即回调 (模块加载即注册)
;(window as unknown as {__noriBgmRes?: (json: string) => void}).__noriBgmRes = onDownloadResult

const pickRandom = (avoid: string | null): string => {
	const ids = BGM_TRACKS.map(t => t.id)
	const pool = ids.filter(id => ids.length < 2 || id !== avoid)
	return pool[Math.floor(Math.random() * pool.length)]
}

const resolveId = (): string => (track === "random" ? pickRandom(currentId) : track)

/** WebView 自动播放限制兜底: 等第一次用户手势再试播 */
const hookGestureRetry = (): void => {
	if (gestureHooked) return
	gestureHooked = true
	const retry = (): void => {
		window.removeEventListener("pointerdown", retry)
		gestureHooked = false
		if (enabled && wantPlay && audioEl) void audioEl.play().catch(() => { /* 仍被拦则等下一次手势 */ })
	}
	window.addEventListener("pointerdown", retry, {once: true})
}

const startPlayback = (): void => {
	const a = ensureAudio()
	currentId = resolveId()
	const t = BGM_TRACKS.find(x => x.id === currentId) ?? BGM_TRACKS[0]
	a.src = `/bgm-local/${t.file}`
	a.volume = volume
	void a.play().catch(() => hookGestureRetry())
}

/**
 * 按 settings 同步播放状态 (挂载/保存设置时调用).
 * 资源缺失且已开启 → 自动触发下载 (原生侧解压完成后回调自动起播).
 * @returns 当前播放曲目 id (未在播返回 null)
 */
export const syncBgm = (s: Settings): string | null => {
	volume = clamp01(Number(s.bgmVolume))
	applyVolume()
	// ⚠ 必须在 `!s.bgmEnabled` **之前**: "下没下过"与开关无关 —— 见 refreshBgmReady 的说明
	const ready = refreshBgmReady()
	if (!s.bgmEnabled) {
		enabled = false
		wantPlay = false
		audioEl?.pause()
		return null
	}
	enabled = true
	wantPlay = true
	track = s.bgmTrack || "random"
	if (!ready) {
		if (state !== "missing") return null // 下载中: 完成回调里自动起播
		// 自动下载: 已开启但本地缺资源 (仅首次; 之后走本地无需再下)
		state = "downloading"
		downloadPct = 0
		notifyState()
		const r = bridge()?.bgmDownload?.()
		if (r && r !== "ok") {
			// busy = 原生已有下载在跑 (页面重载场景): 轮询等待而非报错
			if (r === "err:busy") pollBusyReady()
			else state = "missing"
			notifyState()
		}
		return null
	}
	startPlayback()
	return currentId
}

/**
 * 手动触发下载 (设置里的下载按钮; 下载中幂等忽略)。
 * @param force true = 「重新下载」: 磁盘上已有也照样从远程再拉一遍 (用户怀疑资源坏了时的出口)
 */
export const downloadBgm = (force = false): void => {
	if (state === "downloading") return
	if (!force && queryReady()) {
		state = "ready"
		notifyState()
		if (enabled && wantPlay) startPlayback()
		return
	}
	state = "downloading"
	downloadPct = 0
	notifyState()
	const r = bridge()?.bgmDownload?.()
	if (r && r !== "ok") {
		// busy = 原生已有下载在跑: 轮询等待而非报错
		if (r === "err:busy") pollBusyReady()
		else {
			state = "missing"
			notifyState()
			try { errorHandler?.("下载触发失败") } catch { /* 忽略 */ }
		}
	}
}

/** 随机换一首 (不同于当前), 并播放. @returns 新曲目 id */
export const nextBgmTrack = (): string => {
	const next = pickRandom(currentId)
	currentId = next
	const a = ensureAudio()
	const t = BGM_TRACKS.find(x => x.id === next) ?? BGM_TRACKS[0]
	a.src = `/bgm-local/${t.file}`
	a.volume = volume
	void a.play().catch(() => hookGestureRetry())
	return next
}

export const setBgmVolume = (v: number): void => {
	volume = clamp01(Number(v))
	applyVolume()
}

export const pauseBgm = (): void => {
	audioEl?.pause()
}

export const resumeBgm = (): void => {
	if (enabled && wantPlay && state === "ready" && audioEl) void audioEl.play().catch(() => hookGestureRetry())
}

export const bgmCurrentId = (): string | null => currentId
