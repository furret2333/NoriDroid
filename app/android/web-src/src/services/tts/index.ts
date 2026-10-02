/**
 * Android TTS 管理器: 双提供商 (Fish Audio / 千问 CosyVoice) + 流式播放
 *
 * 对外接口:
 * - isTtsReady(s): 当前提供商是否启用且配了 Key
 * - speak(s, text): 一次性朗读 (自动打断旧的)
 * - beginSpeakSession(s) / speakAppend(s, text) / endSpeakSession(s):
 *   会话式逐句追加 —— 用于流式聊天"边说边生成"
 * - stop(): 停止一切 (含已排队的句子)
 * - test(s): 连接测试
 */
import type {Settings} from "../chat"
import {DEFAULT_FISH_TTS, cleanSpeechText, streamFishTTS, testFishTTS, type FishTTSConfig} from "./fishaudio"
import {streamCosyTTS, type CosyConfig} from "./cosyvoice"
import {pickVoiceModel} from "./cosy-models"
import {StreamPlayer} from "./player"

export type {FishTTSConfig, CosyConfig}

const player = new StreamPlayer()

let currentAbort: AbortController | null = null

/* ---------------- 会话式逐句播放状态 ---------------- */
let speakSessionActive = false
/** 会话是否被强制中止 (stop): 已排队的句子也全部放弃 */
let aborted = false
/** 句子合成串行链: 保证音频顺序 = 句子顺序 */
let speakChain: Promise<void> = Promise.resolve()
/** 已排队/进行中的合成, 停止时全部取消 */
const speakAborts = new Set<AbortController>()
/** 是否已安排收尾 (endOfStream) */
let pendingEnd = false

/**
 * 设置应用内朗读音量 (0~1): 只影响本 App 的播放, 不改系统音量.
 * 由设置面板的滑块实时调用; 朗读开始时也会按 settings.ttsVolume 自动应用.
 */
export const setTtsVolume = (v: number): void => player.setVolume(v)

/** 当前设置里的朗读音量 (容错: 缺失/非法 → 1) */
const volumeOf = (s: Settings): number => {
	const n = Number(s.ttsVolume)
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
}

/** 播放状态订阅 (用于 UI 显示"停止朗读"按钮) */
export const onSpeakingChange = (cb: (playing: boolean) => void): void => {
	player.onStateChange = cb
}

/* ---------------- 合成失败透传 ---------------- */
let ttsErrorHandler: ((msg: string) => void) | null = null

/** 注册 TTS 合成失败回调 (界面提示用) */
export const setTtsErrorHandler = (fn: ((msg: string) => void) | null): void => {
	ttsErrorHandler = fn
}

const notifyError = (msg: string): void => {
	try {
		ttsErrorHandler?.(msg)
	} catch {
		// 忽略
	}
}

/* ---------------- 提供商路由 ---------------- */
export type TtsProvider = "fish" | "cosyvoice"

/** 当前提供商 */
export const providerOf = (s: Settings): TtsProvider => (s.ttsProvider === "cosyvoice" ? "cosyvoice" : "fish")

/** 从 Settings 提取 Fish TTS 配置 */
export const fishConfigOf = (s: Settings): FishTTSConfig => ({
	enabled: s.ttsEnabled,
	apiKey: s.ttsApiKey ?? "",
	baseUrl: s.ttsBaseUrl || DEFAULT_FISH_TTS.baseUrl,
	referenceId: s.ttsReferenceId ?? "",
	model: s.ttsModel || DEFAULT_FISH_TTS.model,
	format: s.ttsFormat || "mp3",
	chunkLength: s.ttsChunkLength || 120,
	latency: s.ttsLatency || "balanced",
})

/** 查某个已选音色是为哪个模型克隆的; 空音色返回 ""。
 *  纯逻辑在 cosy-models.pickVoiceModel 里 (Node 门禁直接覆盖), 这里只是从 Settings 取字段。 */
export const cosyVoiceModelOf = (s: Settings): string => pickVoiceModel(s.cosyVoice, s.cosyCloneVoices)

/** 从 Settings 提取千问 CosyVoice 配置 */
export const cosyConfigOf = (s: Settings): CosyConfig => ({
	apiKey: s.cosyApiKey ?? "",
	baseUrl: s.cosyBaseUrl || "https://dashscope.aliyuncs.com",
	model: s.cosyModel || "cosyvoice-v3.5-flash",
	// 不使用系统音色: 留空就交给 streamCosyTTS 明确报错, 不要兜底成某个系统音色名
	voice: s.cosyVoice ?? "",
	format: "mp3",
	sampleRate: 24000,
	rate: Number(s.cosyRate) || 1,
})

/* ---------------- 外部占用闸门（语音聊天） ---------------- */

/** 是否就绪 (启用 + 当前提供商有 Key) */
export const isTtsReady = (s: Settings): boolean => {
	if (!s.ttsEnabled) return false
	return providerOf(s) === "cosyvoice"
		? !!(s.cosyApiKey ?? "").trim()
		: !!(s.ttsApiKey ?? "").trim()
}

/** 按提供商流式合成一段文本 */
const streamTTS = async (
	s: Settings,
	text: string,
	onChunk: (bytes: Uint8Array) => void,
	signal?: AbortSignal,
): Promise<{ok: boolean; error?: string}> => {
	if (providerOf(s) === "cosyvoice") {
		return streamCosyTTS(text, cosyConfigOf(s), onChunk, signal)
	}
	return streamFishTTS(text, fishConfigOf(s), onChunk, signal)
}

/**
 * 朗读文本切句 (最稳定版): 只在安全边界切, 绝不在词中间切.
 * - 优先按句末标点/换行切 (省略号 … 默认也算边界, 保证 TTS 首音快);
 * - 无边界且超长时, 只在最近的空格/逗号/顿号处切;
 * - 连弱分隔都没有 → 整段保留为一个合成单元 (不硬切, 避免 nori 被切成 N/ori).
 * @param ellipsisAsBoundary 省略号是否作为句子边界 (TTS 用 true 保证首音快;
 *                           气泡显示用 false, 避免省略号被单独切出/挤到下一行)
 */
export const splitSpeechText = (buf: string, maxLen = 40, ellipsisAsBoundary = true): {sentences: string[]; rest: string} => {
	const bounds = ellipsisAsBoundary ? "。！？!?\n…" : "。！？!?\n"
	const parts = buf.split(new RegExp(`(?<=[${bounds}])`))
	if (parts.length > 1) {
		// 最后一段可能是不完整句, 留到下一次
		return {sentences: parts.slice(0, -1), rest: parts[parts.length - 1]}
	}
	if (buf.length < maxLen) return {sentences: [], rest: buf}
	// 无标点边界: 只允许在空格/逗号/顿号等弱分隔处切
	const window = buf.slice(0, maxLen)
	const seps = window.match(/[\s,，、;；:：]+/g)
	if (seps && seps.length) {
		const last = seps[seps.length - 1]
		const idx = window.lastIndexOf(last)
		if (idx > maxLen * 0.4) {
			const cut = idx + last.length
			return {sentences: [buf.slice(0, cut)], rest: buf.slice(cut)}
		}
	}
	// 没有安全断点: 整段保留, 不切词
	return {sentences: [buf], rest: ""}
}

/**
 * 开启一次"逐句朗读会话". 自动打断上一段.
 * @returns 是否成功开启 (未启用/缺 Key 返回 false)
 */
export const beginSpeakSession = (s: Settings): boolean => {
	if (!isTtsReady(s)) return false
	// 应用内音量 (每次会话按当前设置对齐, 悬浮窗/主界面都自动生效)
	player.setVolume(volumeOf(s))
	// 打断上一段 (含未开始排队的句子)
	stop()
	player.reset()
	// 在用户手势链路里解锁音频
	player.unlock()
	aborted = false
	speakSessionActive = true
	pendingEnd = false
	return true
}

/**
 * 追加一句待朗读文本: 排到合成队列末尾, 按顺序合成并播放 (不打断当前音频).
 * 队列里的句子在会话关闭 (endSpeakSession) 后仍会正常合成; 只有 stop() 才会丢弃.
 */
export const speakAppend = (s: Settings, text: string): void => {
	const clean = cleanSpeechText(text)
	if (!speakSessionActive || !clean) return
	const abort = new AbortController()
	speakAborts.add(abort)
	speakChain = speakChain.then(async () => {
		try {
			if (aborted) return
			const fmt = providerOf(s) === "cosyvoice" ? "mp3" : (fishConfigOf(s).format === "pcm" ? "pcm" : "mp3")
			const res = await streamTTS(s, clean, (chunk) => {
				player.pushChunk(chunk, fmt)
			}, abort.signal)
			// 单句失败不打断整体, 但透传给界面提示
			if (!res.ok && res.error && res.error !== "已停止") {
				notifyError(res.error)
			}
		} finally {
			speakAborts.delete(abort)
		}
	})
}

/**
 * 结束会话: 等所有已排队的句子合成完成后通知播放器收尾 (endOfStream).
 */
export const endSpeakSession = (): void => {
	// 关闭"接受新句子", 但已排队的句子照常合成播放
	speakSessionActive = false
	if (pendingEnd) return
	pendingEnd = true
	speakChain = speakChain.then(() => {
		if (!aborted) player.endStream()
	})
}

/**
 * 一次性朗读一段文本 (自动打断上一段)
 */
export const speak = async (s: Settings, text: string): Promise<{ok: boolean; error?: string}> => {
	if (!isTtsReady(s)) return {ok: false, error: "TTS 未启用或未配置 API Key"}
	if (!beginSpeakSession(s)) return {ok: false, error: "TTS 未启用或未配置 API Key"}
	speakAppend(s, text)
	endSpeakSession()
	return {ok: true}
}

/**
 * 停止一切朗读 (含已排队的句子), 并通知原生桥取消进行中的合成
 */
export const stop = (): void => {
	speakSessionActive = false
	aborted = true
	pendingEnd = false
	for (const abort of speakAborts) abort.abort()
	speakAborts.clear()
	speakChain = Promise.resolve()
	currentAbort?.abort()
	currentAbort = null
	player.stop()
	player.reset()
	// 通知原生桥停止流式 HTTP 请求 (两个提供商都停, 无副作用)
	try {
		const nori = (window as unknown as {NoriChat?: {ttsStop?: () => void; cosyTtsStop?: () => void}}).NoriChat
		nori?.ttsStop?.()
		nori?.cosyTtsStop?.()
	} catch {
		// 忽略
	}
}

/**
 * 连接测试: 合成"测试"并试播
 */
export const test = async (s: Settings): Promise<{ok: boolean; error?: string}> => {
	stop()
	player.reset()
	player.unlock()
	if (providerOf(s) === "cosyvoice") {
		if (!(s.cosyApiKey ?? "").trim()) return {ok: false, error: "请先填写千问 API Key"}
		let gotBytes = 0
		const res = await streamCosyTTS("测试", cosyConfigOf(s), () => { gotBytes++ })
		if (!res.ok) return {ok: false, error: res.error}
		if (!gotBytes) return {ok: false, error: "连接成功但未收到音频数据"}
	} else {
		const cfg = fishConfigOf(s)
		if (!cfg.apiKey.trim()) return {ok: false, error: "请先填写 Fish Audio API Key"}
		const res = await testFishTTS(cfg)
		if (!res.ok) return {ok: false, error: res.error}
	}
	// 试播 (测试未播放, 这里重新合成一段短音并播放)
	const r2 = await speak(s, "你好,我是nori")
	return r2
}
