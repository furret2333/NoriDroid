/**
 * 千问 CosyVoice 流式语音合成 (SSE)
 *
 * 接口: POST {base}/api/v1/services/audio/tts/SpeechSynthesizer
 * 头: Authorization: Bearer <key> + X-DashScope-SSE: enable
 * 响应 SSE: data: {"output":{"audio":"<base64>","audio_event":"delta|sentence_start|sentence_end|completed|error"}}
 * 走原生桥 (WebView fetch 有 CORS), 回调与 Fish 共用 __noriTtsChunk/Done/Error.
 */
import {cleanSpeechText} from "./fishaudio"

export interface CosyConfig {
	apiKey: string
	baseUrl: string
	model: string
	voice: string
	format: string
	sampleRate: number
	rate: number
}

/** 模型清单与"音色 id → 模型"推断规则已抽到零依赖的 cosy-models.ts
 *  (settings 层也要用, 但不应因此把合成实现拖进无关 bundle); 这里再导出一次, 保持既有 import 路径不变。 */
export {COSY_MODELS, cosyModelFromVoiceId, pickVoiceModel, normalizeCloneVoices, type CosyCloneVoice} from "./cosy-models"

/** 音色留空时的统一文案 (设置页提示与合成前拦截共用, 避免两处说法不一致) */
export const COSY_NO_VOICE_ERROR = "未设置音色：本项目不使用系统音色，请先在下方「声音克隆」创建专属音色，或填入已有的克隆音色 id"

/** 音色与当前模型不匹配时的文案 (仅用于**设置页提示**)。
 *  音色名是分模型的 (v3-flash 是 longxiaochun_v3, v2 是 longxiaochun_v2, qwen-audio 系是 longanhuan_v3.1),
 *  官方明确不能跨模型混用, 混用会返回 InvalidParameter。切换模型后继续用旧克隆是最容易踩的一种。 */
export const cosyVoiceModelError = (voice: string, voiceModel: string, model: string): string =>
	`音色与模型不匹配：音色 ${voice} 是为 ${voiceModel} 克隆的，当前模型是 ${model}。音色不能跨模型使用 —— 请把模型切回 ${voiceModel}，或为 ${model} 重新克隆一个音色`

export interface CosyStreamResult {
	ok: boolean
	/** 收到的音频字节数 (供测试连接判断) */
	bytes?: number
	error?: string
}

/** 原生桥流式请求 (SSE 由 Kotlin 解析, 每个音频块以 base64 回传) */
export const streamCosyTTS = async (
	text: string,
	cfg: CosyConfig,
	onChunk: (bytes: Uint8Array) => void,
	signal?: AbortSignal,
): Promise<CosyStreamResult> => {
	if (!cfg.apiKey.trim()) return {ok: false, error: "未配置千问 API Key"}
	// 音色留空 → 本地拦下。这条是**确定**的失败: 清单里每个模型的系统音色名都各不相同
	// (longxiaochun_v3 / longxiaochun_v2 / longanhuan_v3.1...), 没有任何"通用默认音色"可兜,
	// 发出去只会换回一句 Engine error [411]。在这里报错比让服务端报更清楚。
	if (!cfg.voice.trim()) return {ok: false, error: COSY_NO_VOICE_ERROR}
	// "音色属于别的模型" **故意不在这里拦** (fail-open):
	// 归属是从 settings 记录 / 音色名前缀推出来的, 属于推断而非事实 —— 推断错了就会把
	// 本来能用的配置硬拦死, 且提示还会指错方向。所以只由设置页提示 (cosyVoiceModelError),
	// 真发出去; 若确实不匹配, 服务端会回 InvalidParameter, 用户自己看得见。
	// 代价: 多跑一次必然失败的请求。收益: 推断永不可能阻塞正常使用。
	const clean = cleanSpeechText(text)
	if (!clean) return {ok: false, error: "TTS 文本为空"}
	type Callbacks = {
		__noriTtsChunk?: (b64: string) => void
		__noriTtsDone?: (json: string) => void
		__noriTtsError?: (json: string) => void
	}
	const W = window as unknown as Callbacks
	return new Promise<CosyStreamResult>((resolve) => {
		let settled = false
		let totalBytes = 0
		const finish = (r: CosyStreamResult) => {
			if (settled) return
			settled = true
			cleanup()
			resolve(r)
		}
		const cleanup = () => {
			delete W.__noriTtsChunk
			delete W.__noriTtsDone
			delete W.__noriTtsError
			signal?.removeEventListener("abort", onAbort)
		}
		const onAbort = () => finish({ok: false, error: "已停止"})
		W.__noriTtsChunk = (b64) => {
			try {
				const bytes = base64ToBytes(b64)
				totalBytes += bytes.length
				onChunk(bytes)
			} catch { /* 跳过坏块 */ }
		}
		W.__noriTtsDone = (json) => {
			try {
				const r = JSON.parse(json) as {ok?: boolean}
				finish({ok: !!r.ok, bytes: totalBytes})
			} catch { finish({ok: true, bytes: totalBytes}) }
		}
		W.__noriTtsError = (json) => {
			try {
				const r = JSON.parse(json) as {message?: string}
				finish({ok: false, error: r.message ?? "CosyVoice 请求失败", bytes: totalBytes})
			} catch { finish({ok: false, error: "CosyVoice 请求失败", bytes: totalBytes}) }
		}
		if (signal) {
			if (signal.aborted) { onAbort(); return }
			signal.addEventListener("abort", onAbort)
		}
		try {
			const nori = (window as unknown as {
				NoriChat?: {cosyTtsStream: (...a: unknown[]) => void}
			}).NoriChat
			if (!nori || typeof nori.cosyTtsStream !== "function") {
				finish({ok: false, error: "原生桥不支持 CosyVoice (请升级应用)"})
				return
			}
			nori.cosyTtsStream(
				cfg.baseUrl.trim().replace(/\/+$/, "") || "https://dashscope.aliyuncs.com",
				cfg.apiKey.trim(),
				cfg.model || "cosyvoice-v3.5-flash",
				cfg.voice.trim(),
				cfg.format || "mp3",
				cfg.sampleRate || 24000,
				cfg.rate || 1,
				clean,
			)
		} catch (e) {
			finish({ok: false, error: `发起请求失败: ${(e as Error)?.message ?? String(e)}`})
		}
	})
}

const base64ToBytes = (b64: string): Uint8Array => {
	const bin = atob(b64)
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
	return bytes
}

/* ---------------- 声音克隆 (千问 CosyVoice) ---------------- */

export interface VoicePickedResult {
	ok: boolean
	name?: string
	mime?: string
	size?: number
	message?: string
}

/** 打开系统文件选择器选音频 (结果异步回调) */
export const pickVoiceFile = (): Promise<VoicePickedResult> =>
	new Promise((resolve) => {
		const W = window as unknown as {__noriVoicePickedRes?: (json: string) => void}
		W.__noriVoicePickedRes = (json) => {
			delete W.__noriVoicePickedRes
			try { resolve(JSON.parse(json) as VoicePickedResult) } catch { resolve({ok: false, message: "选择结果解析失败"}) }
		}
		const nori = (window as unknown as {NoriChat?: {pickVoiceFile?: () => void}}).NoriChat
		if (!nori || typeof nori.pickVoiceFile !== "function") {
			resolve({ok: false, message: "原生桥不支持文件选择 (请升级应用)"})
			return
		}
		try { nori.pickVoiceFile() } catch (e) { resolve({ok: false, message: `发起选择失败: ${String(e)}`}) }
	})

export interface CloneCreateResult {
	ok: boolean
	voice_id?: string
	message?: string
}

/** 创建克隆音色 (Kotlin 内部完成上传+创建) */
export const createCloneVoice = (apiKey: string, targetModel: string, prefix: string): Promise<CloneCreateResult> =>
	new Promise((resolve) => {
		const W = window as unknown as {__noriCloneCreateRes?: (json: string) => void}
		W.__noriCloneCreateRes = (json) => {
			delete W.__noriCloneCreateRes
			try { resolve(JSON.parse(json) as CloneCreateResult) } catch { resolve({ok: false, message: "创建结果解析失败"}) }
		}
		const nori = (window as unknown as {NoriChat?: {createCloneVoice?: (a: string, b: string, c: string) => void}}).NoriChat
		if (!nori || typeof nori.createCloneVoice !== "function") {
			resolve({ok: false, message: "原生桥不支持声音克隆 (请升级应用)"})
			return
		}
		try { nori.createCloneVoice(apiKey, targetModel, prefix) } catch (e) { resolve({ok: false, message: `发起创建失败: ${String(e)}`}) }
	})

/**
 * 一键克隆: 参考音频**联网下载**（2026-10-01 起不再打进 APK），不需要用户选文件。
 * 原生侧负责：下载（首次，之后走缓存）→ 规范成官方要求的 16-bit WAV → 与手动克隆同一套上传/建音色。
 * 回调名 `__noriClonePresetRes`（与手动流程的 `__noriCloneCreateRes` 分开）。
 * ⚠ 那个下载地址在国内可能直连不了（新手引导里已注明"下载音频与模型可能需要魔法"）。
 */
export const createPresetCloneVoice = (apiKey: string, targetModel: string, prefix: string): Promise<CloneCreateResult> =>
	new Promise((resolve) => {
		const W = window as unknown as {__noriClonePresetRes?: (json: string) => void}
		W.__noriClonePresetRes = (json) => {
			delete W.__noriClonePresetRes
			try { resolve(JSON.parse(json) as CloneCreateResult) } catch { resolve({ok: false, message: "创建结果解析失败"}) }
		}
		const nori = (window as unknown as {NoriChat?: {createPresetCloneVoice?: (a: string, b: string, c: string) => void}}).NoriChat
		if (!nori || typeof nori.createPresetCloneVoice !== "function") {
			resolve({ok: false, message: "原生桥不支持一键克隆 (请升级应用)"})
			return
		}
		try { nori.createPresetCloneVoice(apiKey, targetModel, prefix) } catch (e) { resolve({ok: false, message: `发起创建失败: ${String(e)}`}) }
	})

export interface CloneQueryResult {
	ok: boolean
	/** DEPLOYING / OK / UNDEPLOYED */
	status?: string
	target_model?: string
	message?: string
}

/** 查询克隆音色状态 */
export const queryCloneVoice = (apiKey: string, voiceId: string): Promise<CloneQueryResult> =>
	new Promise((resolve) => {
		const W = window as unknown as {__noriCloneQueryRes?: (json: string) => void}
		W.__noriCloneQueryRes = (json) => {
			delete W.__noriCloneQueryRes
			try { resolve(JSON.parse(json) as CloneQueryResult) } catch { resolve({ok: false, message: "查询结果解析失败"}) }
		}
		const nori = (window as unknown as {NoriChat?: {queryCloneVoice?: (a: string, b: string) => void}}).NoriChat
		if (!nori || typeof nori.queryCloneVoice !== "function") {
			resolve({ok: false, message: "原生桥不支持声音克隆 (请升级应用)"})
			return
		}
		try { nori.queryCloneVoice(apiKey, voiceId) } catch (e) { resolve({ok: false, message: `发起查询失败: ${String(e)}`}) }
	})
