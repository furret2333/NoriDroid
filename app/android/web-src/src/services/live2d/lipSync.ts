/**
 * 口型驱动：优先使用 TTS 音频块的真实振幅，无法取得可靠振幅时安全闭嘴。
 *
 * PCM 块可以直接算 RMS；MP3/WAV/Opus 块则异步尝试用 OfflineAudioContext 解码。
 * 解码失败只影响振幅分析，不影响已有播放链路，嘴会保持安全闭合。
 *
 * ## 信号从哪来（都是现成的，不用改 TTS 模块）
 * `App.vue` 里已有 `speaking` ref（由播放器的 `onSpeakingChange` 驱动），仍作为安全活动信号。
 *
 * ## 为什么写在"顶点计算之前"的钩子里
 * 库每帧的流水线是 `… → lipsync → pose → this._model.update()(算顶点) → 画`；
 * `update()` 一执行顶点就定死了，所以额外参数只能在它**之前**写 —— 正好是
 * `beforeUpdate.ts` 那个调度器（`blink.ts` 用的是同一个）。多消费者互不干扰（各自 try/catch）。
 *
 * ## 安全性
 * - **不累积**：库每帧从保存值重建参数，这里每帧写一次；不说时**一个字都不写**，
 *   嘴自然回到模型自己的值（表情/动作照常管嘴）。
 * - **模型没有该参数就不启用**：靠 `window.__noriHasParam` 判（补丁暴露的），自动降级。
 * - **兜底**：连续"出声"超过 `LIP_MAX_RUN_MS` 就不再动嘴 —— 万一播放器状态卡在 true，
 *   也不至于让她张着嘴动到天荒地老。
 *
 * ## 纯函数 / IO 分离
 * `lipStep` 是纯函数（时钟与随机源可注入）⇒ 门禁能在 Node 里精确单测包络；
 * 写参数那侧才碰 window。
 */

import {registerBeforeUpdate} from "./beforeUpdate"

/** 驱动嘴的模型参数（`model3.json` 的 `Groups.LipSync` = `["ParamMouthOpenY"]`） */
export const MOUTH_PARAM = "ParamMouthOpenY"

/** 每隔多久换一个口型目标（ms）。太快像抽搐，太慢像在嚼 */
export const LIP_STEP_MS = 110
/** 每一帧向目标靠拢的比例（0~1）。越小越柔 */
export const LIP_ATTACK = 0.35
/** 开口量的取值区间。**实机试出来的**：最初 MAX = 1.0，嘴张得太大（用户反馈"幅度太大"），
 *  降到 0.45 才像正常说话。MIN 留一点底，别在 0 上贴死。
 *  **嫌大/嫌小就调这两个数字**（这是唯一控制幅度的地方）。 */
export const LIP_MIN = 0.06
export const LIP_MAX = 0.45
/** 停声后收口的比例（每帧），比张开略快 —— "说完即收" */
export const LIP_RELEASE = 0.35
/** 单次连续"出声"的动嘴上上限（兜底，见文件头） */
export const LIP_MAX_RUN_MS = 240_000

export type VoiceChunkFormat = "mp3" | "pcm" | "opus" | "wav"

export interface LipState {
	/** 当前开口量 0~1 */
	open: number
	/** 本段目标值 */
	target: number
	/** 下次换目标的时刻 */
	nextChangeAt: number
	/** 本段连续出声的起点（0 = 不在说） */
	startedAt: number
}

export const newLipState = (): LipState => ({open: 0, target: 0, nextChangeAt: 0, startedAt: 0})

/** 一帧的结果：`write=false` 时**一个字都不写** */
export interface LipFrame {
	state: LipState
	open: number
	write: boolean
}

/**
 * 推进一帧口型。**纯函数**（不修改入参）。
 *
 * @param speaking 当前是否在出声（App.vue 的 `speaking`）
 * @param rand 随机源（门禁可注入固定值）
 */
export const lipStep = (
	st: LipState,
	now: number,
	speaking: boolean,
	rand: () => number = Math.random,
	audioLevel?: number | null,
): LipFrame => {
	// 时钟异常: 什么都不写, 也不毒化状态（与 datasea/frameGate 同一套 fail-safe 习惯）
	if (!Number.isFinite(now)) return {state: st, open: st.open, write: false}

	if (!speaking) {
		// 停声: 收口并清掉本段状态。open 已经不大了就直接归零, 避免长期留一个小残值
		const open = st.open > 0.01 ? st.open * (1 - LIP_RELEASE) : 0
		return {state: {open, target: 0, nextChangeAt: 0, startedAt: 0}, open, write: st.open > 0}
	}

	const startedAt = st.startedAt || now
	// 兜底: 状态卡在"一直在说"时, 超过上限就不再动嘴
	if (now - startedAt > LIP_MAX_RUN_MS) {
		const open = st.open > 0.01 ? st.open * (1 - LIP_RELEASE) : 0
		return {state: {open, target: 0, nextChangeAt: 0, startedAt}, open, write: false}
	}

	let target = st.target
	let nextChangeAt = st.nextChangeAt
	if (now >= nextChangeAt) {
		if (Number.isFinite(audioLevel)) {
			target = amplitudeToMouthOpen(audioLevel as number)
		} else {
			/*
			 * 没有可信音频振幅时必须收口。播放器的 `speaking` 可能会跨过
			 * 句间缓冲停顿，随机兜底会把这种停顿误报成正在说话。
			 * `rand` 保留在签名里，兼容已有的纯函数门禁和调用方。
			 */
			target = 0
		}
		nextChangeAt = now + LIP_STEP_MS
	}
	const release = target <= 0 ? LIP_RELEASE : LIP_ATTACK
	const open = Math.max(0, Math.min(1, st.open + (target - st.open) * release))
	return {state: {open, target, nextChangeAt, startedAt}, open, write: true}
}

/* ---------------- IO 侧（真正写参数） ---------------- */

interface LipHooks {
	set?: (id: string, v: number) => void
	/** ⚠ **不要用 `__noriHasParam`** —— 它内部是 `this._model.getParameterIndex(id)`,
	 *  而 CubismModel 的 `getParameterIndex` 收的是**参数对象**、不是 id 字符串 ⇒ 对字符串恒返回 -1
	 *  ⇒ 恒 false。曾经就是用它做判定，把口型**永久禁掉**（`paramMissing` 一置位就不再写）。
	 *  补丁另外暴露的 `__noriParamIndexOf`（手写 getParameterCount/getParameterId 线性查找）才是可靠的。 */
	indexOf?: (id: string) => number
}

const defaultHooks = (): LipHooks => {
	if (typeof window === "undefined") return {}
	const w = window as unknown as {__noriSetParam?: LipHooks["set"]; __noriParamIndexOf?: LipHooks["indexOf"]}
	return {set: w.__noriSetParam, indexOf: w.__noriParamIndexOf}
}

const nowMs = (): number =>
	typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()

let state: LipState = newLipState()
let lastWritten = 0
let paramMissing = false   // 模型没这个参数 ⇒ 记一次就别再每帧问了
let latestAmplitude = 0
let lastAmplitudeAt = -1e9
let playbackAmplitudeSource = false
let voiceGeneration = 0

const clamp01 = (n: number): number => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0

/** RMS 到嘴部开口量的映射：压掉底噪，保留强弱变化，限制最大开口。 */
export const amplitudeToMouthOpen = (rms: number): number => {
	const n = clamp01(rms)
	// 编码底噪不能被当成发音，否则句间停顿会留下小幅张嘴。
	const floor = 0.025
	const span = 0.18
	if (n <= floor) return 0
	const shaped = Math.pow(Math.min(1, (n - floor) / span), 0.72)
	return LIP_MIN + shaped * (LIP_MAX - LIP_MIN)
}

/** 从 Fish PCM（可带 16 字节分块头）计算归一化 RMS。 */
export const pcmRms = (bytes: Uint8Array): number => {
	if (!bytes?.length) return 0
	let data = bytes
	if (bytes.length >= 16) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const pcmSize = view.getInt32(4, true)
		const sampleRate = view.getInt32(8, true)
		if (pcmSize > 0 && sampleRate >= 8000 && sampleRate <= 48000 && 16 + pcmSize <= bytes.length) {
			data = bytes.subarray(16, 16 + pcmSize)
		}
	}
	const samples = Math.floor(data.length / 2)
	if (!samples) return 0
	const view = new DataView(data.buffer, data.byteOffset, samples * 2)
	let sum = 0
	for (let i = 0; i < samples; i++) {
		const v = view.getInt16(i * 2, true) / 32768
		sum += v * v
	}
	return Math.sqrt(sum / samples)
}

/** 上一帧实际写进去的开口量（0 = 没写；诊断/E2E 用） */
export const mouthOpenNow = (): number => lastWritten

/** 每帧调用（由 `beforeUpdate` 调度器在库 `update()` **之前**调用） */
export const applyLipSync = (
	speaking: boolean,
	now: number = nowMs(),
	hooks: LipHooks = defaultHooks(),
): number => {
	const level = Number.isFinite(now) && now - lastAmplitudeAt < AMPLITUDE_TAIL_MS ? latestAmplitude : null
	const f = lipStep(state, now, speaking, Math.random, level)
	state = f.state
	if (!f.write) {
		lastWritten = 0
		return 0
	}
	const {set, indexOf} = hooks
	if (typeof set !== "function") {
		lastWritten = 0
		return 0
	}
	if (paramMissing) {
		lastWritten = 0
		return 0
	}
	/* 只有在**可靠**的 indexOf 明确说"没这个参数"时才永久禁用。
	   拿不到 indexOf 时宁可照样写 —— 写一个不存在的参数是无害的,
	   而"误判成没有"的代价是**口型永久不动**(比多写几次严重得多)。 */
	if (typeof indexOf === "function" && indexOf(MOUTH_PARAM) < 0) {
		paramMissing = true
		lastWritten = 0
		return 0
	}
	try { set(MOUTH_PARAM, f.open) } catch { /* 忽略: 写参数失败不该影响渲染 */ }
	lastWritten = f.open
	return 1
}

/* ---------------- "音频块正在到达" —— 独立于播放器状态的第二条信号 ---------------- */

/** 最后一个音频块到达之后，还继续算"在出声"多久 (ms)：句间静默/网络抖动时不至于把嘴一下闭死 */
export const VOICE_TAIL_MS = 400

/** 振幅没有及时刷新就视为静音；比块到达尾巴短，优先保证停顿闭嘴。 */
export const AMPLITUDE_TAIL_MS = 96

let lastVoiceAt = -1e9

/** 每到达一个 TTS 音频块调一次（由 `tts/index.ts` 的 streamTTS 统一转发，两条通道共用一处） */
export const notifyVoiceChunk = (now: number = nowMs()): void => {
	if (Number.isFinite(now)) lastVoiceAt = now
}

const notifyAmplitude = (rms: number, now: number, fromPlayback = false): void => {
	if (!Number.isFinite(rms) || !Number.isFinite(now)) return
	if (playbackAmplitudeSource && !fromPlayback) return
	latestAmplitude = clamp01(rms)
	lastAmplitudeAt = now
}

let encodedPending = new Uint8Array(0)
let encodedDecode: Promise<void> = Promise.resolve()

/** Feed one TTS block to the analysis path. Playback never depends on this promise. */
export const notifyVoiceAudio = (bytes: Uint8Array, format: VoiceChunkFormat, now: number = nowMs()): void => {
	const generation = voiceGeneration
	notifyVoiceChunk(now)
	if (format === "pcm") {
		notifyAmplitude(pcmRms(bytes), now)
		return
	}
	if (typeof OfflineAudioContext === "undefined" || !bytes?.length) return
	const merged = new Uint8Array(encodedPending.length + bytes.length)
	merged.set(encodedPending)
	merged.set(bytes, encodedPending.length)
	encodedPending = merged.length > 1024 * 1024 ? bytes.slice() : merged
	const pendingSnapshot = encodedPending
	const input = pendingSnapshot.slice()
	encodedDecode = encodedDecode.then(async () => {
		try {
			const ctx = new OfflineAudioContext(1, 1, 24000)
			const audio = await ctx.decodeAudioData(input.buffer.slice(0) as ArrayBuffer)
			const channels = audio.numberOfChannels
			const length = audio.length
			if (generation !== voiceGeneration) return
			if (channels && length) {
				// 编码块可能覆盖较长时间；只看末尾短窗，避免整块平均值跨过真实停顿。
				const tailSamples = Math.max(1, Math.min(length, Math.floor(audio.sampleRate * 0.048)))
				const start = length - tailSamples
				let sum = 0
				for (let c = 0; c < channels; c++) {
					const samples = audio.getChannelData(c)
					for (let i = start; i < samples.length; i++) sum += samples[i] * samples[i]
				}
				notifyAmplitude(Math.sqrt(sum / (channels * tailSamples)), nowMs())
			}
			// Do not clear chunks that arrived while decodeAudioData was pending.
			if (encodedPending === pendingSnapshot) encodedPending = new Uint8Array(0)
		} catch {
			// Arbitrary stream cuts often cannot be decoded independently; retain the fallback.
		}
	})
}

/** 播放器实际输出的 RMS；分析器可用时它会屏蔽网络块的提前振幅。 */
export const notifyPlaybackAmplitude = (rms: number, now: number = nowMs()): void => {
	notifyAmplitude(rms, now, true)
}

export const setPlaybackAmplitudeSource = (active: boolean): void => {
	playbackAmplitudeSource = active
	if (!active) {
		latestAmplitude = 0
		lastAmplitudeAt = -1e9
	}
}

/** 清理上一段语音的异步解码和振幅尾巴，避免旧 MP3 完成后顶开下一段。 */
export const resetVoiceAnalysis = (): void => {
	voiceGeneration++
	lastVoiceAt = -1e9
	latestAmplitude = 0
	lastAmplitudeAt = -1e9
	encodedPending = new Uint8Array(0)
}

/** 刚才有音频块到达吗（含 TAIL 余量）。仅供诊断，不作为口型活动闸门。 */
export const voiceActive = (now: number = nowMs()): boolean =>
	Number.isFinite(now) && now - lastVoiceAt < VOICE_TAIL_MS

/**
 * 装上（App 启动时调一次）。`isSpeaking` 是**惰性读取**的回调 ——
 * 这样模块不必知道 Vue 的 ref，且每次进来都拿最新值。
 */
export const installLipSync = (isSpeaking: () => boolean): void => {
	registerBeforeUpdate(() => { applyLipSync(isSpeaking() === true) })

	/** 当前诊断快照（纯读） */
	const snap = () => ({
		written: lastWritten,
		missing: paramMissing,
		indexOf: (window as unknown as {__noriParamIndexOf?: (id: string) => number}).__noriParamIndexOf?.(MOUTH_PARAM) ?? null,
		voiceActive: voiceActive(),
		speaking: isSpeaking() === true,
	})

	/* 只留一个内存里的只读钩子 `__noriLipDebug()`（零开销）：设置页那块"口型诊断"已按用户要求删除，
	   写 DOM 的定时器也一并去掉。留它是为了以后调幅度时还能一眼看出"有没有在写、参数下标是多少"。
	   `__noriLipForce`（App.vue 里读）同样保留 —— 没有界面按钮了，但它是我下次排查口型的后门。 */
	try { (window as unknown as {__noriLipDebug?: () => unknown}).__noriLipDebug = snap } catch { /* 忽略 */ }
}

/** 仅供测试：重置状态 */
export const __resetLipSyncForTest = (): void => {
	state = newLipState()
	lastWritten = 0
	paramMissing = false
	playbackAmplitudeSource = false
	resetVoiceAnalysis()
}
