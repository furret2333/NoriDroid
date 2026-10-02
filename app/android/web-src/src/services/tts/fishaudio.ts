/**
 * Fish Audio 流式语音合成
 *
 * 接入文档: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 * 协议: POST {baseUrl}/v1/tts, 请求头 Authorization: Bearer <key> + model, 请求体 streaming=true,
 * 响应为 HTTP 分块音频流 (每个 chunk 是一段可独立解码的音频, 拼接即为完整音频).
 */

export interface FishTTSConfig {
	enabled: boolean
	apiKey: string
	/** 默认官方 API; 可改为自建网关 */
	baseUrl: string
	/** 音色模型 id (Voice Library 里每个音色的 id, 选填, 缺省用默认音色) */
	referenceId: string
	/** s2.1-pro / s2-pro / s1 / s2.1-pro-free */
	model: string
	/** mp3 (推荐) / pcm / opus / wav */
	format: string
	/** 文本分块长度 100~500 (越小首音越快, 块数越多) */
	chunkLength: number
	/** normal (质量优先) / balanced / relaxed */
	latency: string
}

export const DEFAULT_FISH_TTS: FishTTSConfig = {
	enabled: false,
	apiKey: "",
	baseUrl: "https://api.fish.audio",
	referenceId: "",
	model: "s2.1-pro",
	format: "mp3",
	chunkLength: 120,
	latency: "balanced",
}

export const FISH_MODELS = ["s2.1-pro", "s2-pro", "s1", "s2.1-pro-free"]
export const FISH_FORMATS = ["mp3", "pcm", "opus", "wav"]
export const FISH_LATENCIES = ["normal", "balanced", "relaxed"]

export interface FishStreamResult {
	ok: boolean
	/** 收到音频字节数 (供测试连接判断) */
	bytes?: number
	error?: string
}

/**
 * 请求流式 TTS. 每个到达的音频分块都会回调 onChunk.
 */
export const streamFishTTS = async (
	text: string,
	cfg: FishTTSConfig,
	onChunk: (bytes: Uint8Array) => void,
	signal?: AbortSignal,
): Promise<FishStreamResult> => {
	if (!cfg.apiKey.trim()) return {ok: false, error: "未配置 Fish Audio API Key"}
	const clean = cleanSpeechText(text)
	if (!clean) return {ok: false, error: "TTS 文本为空"}
	// 优先走原生桥 (WebView 内 fetch 受 CORS/系统代理限制, 原生 HTTP 无此问题)
	const nori = (window as unknown as {NoriChat?: {ttsStream: (...args: unknown[]) => void}}).NoriChat
	if (nori && typeof nori.ttsStream === "function") {
		return streamViaBridge(clean, cfg, onChunk, signal)
	}
	return streamViaFetch(clean, cfg, onChunk, signal)
}

/**
 * 原生桥通道: Kotlin 端流式请求并把每个音频分块以 base64 回传
 */
const streamViaBridge = async (
	clean: string,
	cfg: FishTTSConfig,
	onChunk: (bytes: Uint8Array) => void,
	signal?: AbortSignal,
): Promise<FishStreamResult> => {
	type Callbacks = {
		__noriTtsChunk?: (b64: string) => void
		__noriTtsDone?: (json: string) => void
		__noriTtsError?: (json: string) => void
	}
	const W = window as unknown as Callbacks
	return new Promise<FishStreamResult>((resolve) => {
		let settled = false
		const finish = (r: FishStreamResult) => {
			if (settled) return
			settled = true
			cleanup()
			resolve(r)
		}
		const cleanup = () => {
			delete W.__noriTtsChunk
			delete W.__noriTtsDone
			delete W.__noriTtsError
			// 解绑 abort 监听 (与 cosyvoice 通道一致): 每句一个 controller, 不解绑会长期堆积
			signal?.removeEventListener("abort", abort)
		}
		W.__noriTtsChunk = (b64) => {
			try {
				onChunk(base64ToBytes(b64))
			} catch {
				// 解码失败的分块跳过
			}
		}
		W.__noriTtsDone = (json) => {
			try {
				const r = JSON.parse(json) as {ok?: boolean}
				finish({ok: !!r.ok})
			} catch {
				finish({ok: true})
			}
		}
		W.__noriTtsError = (json) => {
			try {
				const r = JSON.parse(json) as {message?: string}
				finish({ok: false, error: r.message ?? "TTS 请求失败"})
			} catch {
				finish({ok: false, error: "TTS 请求失败"})
			}
		}
		const abort = () => finish({ok: false, error: "已停止"})
		signal?.addEventListener("abort", abort)
		// 排队等到了起跑时才发现已被停止 (如用户按了停止朗读): 不再发起合成请求,
		// 否则会出现"按了停止还蹦出半句"的幽灵音频, 还白花一次合成
		if (signal?.aborted) {
			finish({ok: false, error: "已停止"})
			return
		}
		try {
			const nori = (window as unknown as {NoriChat?: {ttsStream: (...args: unknown[]) => void}}).NoriChat
			nori!.ttsStream(
				cfg.baseUrl.trim().replace(/\/+$/, "") || "https://api.fish.audio",
				cfg.apiKey.trim(),
				cfg.model || "s2.1-pro",
				cfg.referenceId.trim(),
				cfg.format || "mp3",
				cfg.chunkLength || 200,
				cfg.latency || "normal",
				clean,
			)
		} catch (e) {
			finish({ok: false, error: `发起请求失败: ${(e as Error)?.message ?? String(e)}`})
		}
	})
}

/**
 * base64 → Uint8Array (WebView atob 可用)
 */
const base64ToBytes = (b64: string): Uint8Array => {
	const bin = atob(b64)
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
	return bytes
}

/**
 * 浏览器直连通道 (仅 Web 预览/无原生桥时使用)
 */
const streamViaFetch = async (
	clean: string,
	cfg: FishTTSConfig,
	onChunk: (bytes: Uint8Array) => void,
	signal?: AbortSignal,
): Promise<FishStreamResult> => {
	const base = cfg.baseUrl.trim().replace(/\/+$/, "") || "https://api.fish.audio"
	let res: Response
	try {
		res = await fetch(`${base}/v1/tts`, {
			method: "POST",
			signal,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.apiKey.trim()}`,
				model: cfg.model || "s2.1-pro",
			},
			body: JSON.stringify({
				text: clean,
				...(cfg.referenceId.trim() ? {reference_id: cfg.referenceId.trim()} : {}),
				format: cfg.format || "mp3",
				streaming: true,
				chunk_length: cfg.chunkLength || 200,
				latency: cfg.latency || "normal",
			}),
		})
	} catch (e) {
		return {ok: false, error: `网络请求失败: ${(e as Error)?.message ?? String(e)}`}
	}
	if (!res.ok) {
		let detail = ""
		try {
			const json = await res.json()
			detail = (json as {message?: string; detail?: string}).message ?? (json as {detail?: string}).detail ?? ""
		} catch {
			detail = await res.text().catch(() => "")
		}
		return {ok: false, error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`}
	}
	if (!res.body) return {ok: false, error: "响应无内容"}
	const reader = res.body.getReader()
	let total = 0
	try {
		for (;;) {
			const {done, value} = await reader.read()
			if (done) break
			if (value && value.length) {
				total += value.length
				onChunk(value)
			}
		}
	} catch (e) {
		if ((e as Error)?.name === "AbortError") return {ok: false, error: "已停止"}
		return {ok: false, error: `流读取失败: ${(e as Error)?.message ?? String(e)}`}
	}
	return {ok: true, bytes: total}
}

/**
 * 连接测试: 合成一句短文本, 收到任意音频字节即视为连通
 */
export const testFishTTS = async (cfg: FishTTSConfig): Promise<FishStreamResult> => {
	let gotBytes = false
	const res = await streamFishTTS("测试", cfg, () => { gotBytes = true })
	if (res.ok && gotBytes) return {ok: true, bytes: res.bytes}
	if (res.ok && !gotBytes) return {ok: false, error: "服务连通但未返回音频"}
	return res
}

/**
 * 把带 Markdown 的文本清洗成适合朗读的纯文本
 */
export const cleanSpeechText = (raw: string): string => {
	let text = raw
	text = text.replace(/```[\s\S]*?```/g, " ")
	text = text.replace(/`([^`\n]*)`/g, "$1")
	text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
	text = text.replace(/https?:\/\/\S+/g, " ")
	text = text.replace(/^#{1,6}\s+/gm, "")
	text = text.replace(/^\s{0,3}>\s?/gm, "")
	text = text.replace(/^\s{0,3}([-*+]\s|\d{1,9}[.、]\s)/gm, "")
	text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1")
	text = text.replace(/\*([^*\n]+)\*/g, "$1")
	text = text.replace(/__([^_\n]+)__/g, "$1")
	text = text.replace(/~~([^~\n]+)~~/g, "$1")
	text = text.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
	return text.replace(/\s+/g, " ").trim()
}
