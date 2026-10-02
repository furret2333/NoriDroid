/**
 * 流式音频播放器 (MediaSource 优先 + WebAudio 回退)
 *
 * - mp3: 首选 **MediaSource (MSE)** —— 字节流直接追加进浏览器媒体管线, 由播放器内部缓冲,
 *   无逐块解码停顿, 播放连续不卡顿 (Android WebView 的 Chromium 原生支持 audio/mpeg)。
 * - opus/wav: MSE 不支持时自动回退 WebAudio 串行解码。
 * - pcm: WebAudio 直接转 Float32 播放 (无解码, 延迟最低)。
 */

export type StreamFormat = "mp3" | "pcm" | "opus" | "wav"

/** PCM 默认采样率 (无头数据兜底) */
const PCM_FALLBACK_RATE = 44100

/** WebAudio 回退路径: 待解码缓冲上限 (防止永远解不出时内存无限增长) */
const MAX_PENDING = 8 * 1024 * 1024

/** 各格式对应的 MSE MIME (不支持时回退 WebAudio) */
const mimeFor = (format: StreamFormat): string | null => {
	switch (format) {
		case "mp3": return "audio/mpeg"
		case "wav": return "audio/wav"
		case "opus": return "audio/opus"
		default: return null
	}
}

/**
 * 从首个分块嗅探真实音频格式 (部分 TTS 服务端无视请求里的 format 参数,
 * 比如 CosyVoice 默认返回 wav / opus, 若按 mp3 塞进 MSE 会无声).
 */
const sniffFormat = (bytes: Uint8Array): StreamFormat | null => {
	if (bytes.length < 4) return null
	// RIFF....WAVE
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "wav"
	// OggS (opus)
	if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "opus"
	// ID3 头
	if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "mp3"
	// 裸 mp3 帧同步字 0xFFEx
	if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3"
	return null
}

export class StreamPlayer {
	/* ---------------- 公共状态 ---------------- */
	private stopped = false
	private playing = false
	onStateChange?: (playing: boolean) => void
	onEnded?: () => void

	/* ---------------- MediaSource 路径 ---------------- */
	private mseAttempted = false
	private mseOk = false
	private ms: MediaSource | null = null
	private sb: SourceBuffer | null = null
	private audioEl: HTMLAudioElement | null = null
	private blobUrl: string | null = null
	private sbBusy = false
	private mseQueue: ArrayBuffer[] = []
	private mseEndRequested = false
	private mseMime: string | null = null
	private mseHasData = false

	/* ---------------- WebAudio 回退路径 ---------------- */
	private ctx: AudioContext | null = null
	private nextTime = 0
	private sources: AudioBufferSourceNode[] = []
	private pending: Uint8Array = new Uint8Array(0)
	private decodeChain: Promise<void> = Promise.resolve()
	private gen = 0
	/**
	 * 应用内音量 (0~1). 只作用在本播放器的输出上, 不动系统音量:
	 * - MSE 路径 → HTMLAudioElement.volume (MDN: WebView Android 全支持);
	 * - WebAudio 回退路径 → GainNode.
	 * 注意: 不要把 audioEl 接进 createMediaElementSource, 那样元素 volume 会失效 (必须改用 gain).
	 */
	private vol = 1
	/** WebAudio 回退路径的增益节点 (音量控制), 惰性创建 */
	private gain: GainNode | null = null

	/** 设置应用内音量 (0~1), 立即对当前播放生效 */
	setVolume(v: number): void {
		const n = Number(v)
		this.vol = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
		try {
			if (this.audioEl) this.audioEl.volume = this.vol
		} catch {
			// 忽略
		}
		try {
			if (this.gain) this.gain.gain.value = this.vol
		} catch {
			// 忽略
		}
	}

	/** 当前应用内音量 (0~1) */
	get volume(): number {
		return this.vol
	}

	/** 取得 (必要时创建) 增益节点: 统一用 gain 控制 WebAudio 路径的输出音量 */
	private ensureGain(ctx: AudioContext): GainNode {
		if (!this.gain) {
			this.gain = ctx.createGain()
			this.gain.gain.value = this.vol
			this.gain.connect(ctx.destination)
		}
		return this.gain
	}

	/** 是否正在播放 */
	get isPlaying(): boolean {
		return this.playing
	}

	private setPlaying(v: boolean): void {
		if (this.playing !== v) {
			this.playing = v
			this.onStateChange?.(v)
		}
	}

	/**
	 * 解锁音频 (在用户手势链路里调用一次, 满足自动播放策略)
	 */
	unlock(): void {
		try {
			if (!this.ctx) {
				this.ctx = new AudioContext()
				this.gain = null // 新 context: 旧的 gain 节点作废, 下次用到时重建
			}
			if (this.ctx.state === "suspended") void this.ctx.resume()
		} catch {
			// WebView 不支持时静默
		}
		if (this.audioEl) {
			this.audioEl.play().catch(() => {})
		}
	}

	/**
	 * 入队一段音频
	 */
	pushChunk(bytes: Uint8Array, format: StreamFormat = "mp3"): void {
		if (this.stopped || !bytes.length) return
		if (format === "pcm") {
			this.pushPcm(bytes)
			return
		}
		// 首次分块时嗅探真实编码, 避免格式不符导致 MSE 解码失败(无声)
		if (!this.mseAttempted) {
			const sniffed = sniffFormat(bytes)
			if (sniffed) format = sniffed
		}
		// 首次分块时决定走 MSE 还是 WebAudio
		if (!this.mseAttempted) {
			this.mseAttempted = true
			const mime = mimeFor(format)
			this.mseMime = mime
			this.mseOk = !!mime
				&& typeof MediaSource !== "undefined"
				&& MediaSource.isTypeSupported(mime)
		}
		if (this.mseOk) {
			this.initMse()
			this.appendMse(bytes)
			return
		}
		this.pushEncoded(null, bytes)
	}

	/* ================= MediaSource 路径 ================= */

	private initMse(): void {
		if (this.ms || !this.mseMime) return
		try {
			// 每次会话用全新的 Audio 元素, 避免监听器跨会话累积导致状态回调重复触发
			if (this.audioEl) {
				try {
					this.audioEl.pause()
					this.audioEl.removeAttribute("src")
					this.audioEl.load()
				} catch {
					// 忽略
				}
				this.audioEl = null
			}
			this.audioEl = new Audio()
			this.audioEl.preload = "auto"
			this.audioEl.volume = this.vol // 应用内音量 (不动系统音量)
			this.ms = new MediaSource()
			this.blobUrl = URL.createObjectURL(this.ms)
			this.audioEl.src = this.blobUrl
			this.audioEl.addEventListener("playing", () => this.setPlaying(true))
			this.audioEl.addEventListener("pause", () => this.setPlaying(false))
			this.audioEl.addEventListener("ended", () => {
				this.setPlaying(false)
				this.onEnded?.()
			})
			const onOpen = () => {
				if (this.stopped || !this.ms) return
				try {
					this.sb = this.ms.addSourceBuffer(this.mseMime!)
					this.sb.mode = "sequence"
					this.sb.addEventListener("updateend", () => {
						this.sbBusy = false
						this.flushMse()
						if (this.mseEndRequested) this.finishMse()
					})
					this.flushMse()
				} catch {
					// 万一 addSourceBuffer 失败, 回退 WebAudio
					this.mseOk = false
					this.pushEncodedBytesFromQueue()
				}
			}
			if (this.ms.readyState === "open") onOpen()
			else this.ms.addEventListener("sourceopen", onOpen, {once: true})
		} catch {
			this.mseOk = false
			this.pushEncodedBytesFromQueue()
		}
	}

	/** MSE 不可用时的兜底: 把已积压的 mp3 字节交给 WebAudio 串行解码 */
	private pushEncodedBytesFromQueue(): void {
		const leftover = this.mseQueue
		this.mseQueue = []
		for (const buf of leftover) {
			this.pushEncoded(null, new Uint8Array(buf))
		}
	}

	private appendMse(bytes: Uint8Array): void {
		const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
		if (!this.sb || this.sbBusy || !this.ms || this.ms.readyState !== "open") {
			this.mseQueue.push(buf)
			this.tryPlay()
			return
		}
		this.mseHasData = true
		this.sbBusy = true
		try {
			this.sb.appendBuffer(buf)
		} catch {
			this.sbBusy = false
			this.mseQueue.push(buf)
		}
		this.tryPlay()
	}

	private flushMse(): void {
		if (this.stopped || !this.sb || this.sbBusy) return
		if (!this.ms || this.ms.readyState !== "open") return
		while (this.mseQueue.length && !this.sbBusy) {
			const buf = this.mseQueue.shift()!
			this.mseHasData = true
			this.sbBusy = true
			try {
				this.sb.appendBuffer(buf)
			} catch {
				this.sbBusy = false
				break
			}
		}
		this.tryPlay()
	}

	private tryPlay(): void {
		if (!this.audioEl || this.audioEl.paused === false) return
		this.audioEl.play().catch(() => {})
	}

	/**
	 * 流已结束: 通知 MSE endOfStream, 触发 ended 事件 (没有任何音频数据时跳过收尾)
	 */
	endStream(): void {
		if (!this.mseOk || !this.ms || !this.mseHasData) return
		this.mseEndRequested = true
		if (!this.sbBusy && this.ms.readyState === "open") this.finishMse()
	}

	private finishMse(): void {
		if (!this.ms || this.ms.readyState !== "open") return
		try {
			this.ms.endOfStream()
		} catch {
			// 已结束则忽略
		}
	}

	/* ================= WebAudio 回退路径 ================= */

	private ensureCtx(): AudioContext | null {
		this.unlock()
		if (!this.ctx) return null
		if (this.ctx.state === "suspended") void this.ctx.resume()
		return this.ctx
	}

	/** mp3/opus/wav (WebAudio 回退): 追加到累积缓冲, 串行解码 */
	private pushEncoded(ctx: AudioContext | null, bytes: Uint8Array): void {
		const c = ctx ?? this.ensureCtx()
		if (!c) return
		const merged = new Uint8Array(this.pending.length + bytes.length)
		merged.set(this.pending, 0)
		merged.set(bytes, this.pending.length)
		this.pending = merged
		// 串行化: 前一次解码完全结束后才尝试本次, 解码顺序 = 到达顺序
		this.decodeChain = this.decodeChain.then(() => this.tryDecode(c))
	}

	/** 尝试解码当前累积缓冲 (串行执行, 失败则保留缓冲等下一块) */
	private async tryDecode(ctx: AudioContext): Promise<void> {
		if (this.stopped || !this.pending.length) return
		const gen = this.gen
		const buf = this.pending.buffer.slice(0) as ArrayBuffer
		let buffer: AudioBuffer
		try {
			buffer = await ctx.decodeAudioData(buf)
		} catch {
			// 解码失败: 很可能是音频帧被网络分块切分, 保留累积等下一块
			if (this.pending.length > MAX_PENDING) this.pending = new Uint8Array(0)
			return
		}
		if (this.stopped || gen !== this.gen) return
		this.pending = new Uint8Array(0)
		this.scheduleBuffer(ctx, buffer)
	}

	/** pcm: 解析分块头并直接播放 */
	private pushPcm(bytes: Uint8Array): void {
		const ctx = this.ensureCtx()
		if (!ctx) return
		let sampleRate = PCM_FALLBACK_RATE
		let data: Uint8Array
		// Fish Audio PCM 分块头: int32 id / int32 pcmSize / int32 sampleRate / int32 pcmDurationMs
		if (bytes.length >= 16) {
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			const pcmSize = view.getInt32(4, true)
			const rate = view.getInt32(8, true)
			const headerSize = 16
			if (pcmSize > 0 && rate >= 8000 && rate <= 48000 && headerSize + pcmSize <= bytes.length) {
				sampleRate = rate
				data = bytes.subarray(headerSize, headerSize + pcmSize)
			} else {
				data = bytes
			}
		} else {
			data = bytes
		}
		const samples = Math.floor(data.length / 2)
		if (!samples) return
		const float = new Float32Array(samples)
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
		for (let i = 0; i < samples; i++) {
			float[i] = dv.getInt16(i * 2, true) / 32768
		}
		const buffer = ctx.createBuffer(1, samples, sampleRate)
		buffer.copyToChannel(float, 0)
		this.scheduleBuffer(ctx, buffer)
	}

	/** 排入播放队列 (连续衔接) */
	private scheduleBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
		if (this.stopped) return
		const source = ctx.createBufferSource()
		source.buffer = buffer
		source.connect(this.ensureGain(ctx)) // 经增益节点输出 → 应用内音量生效
		const now = ctx.currentTime
		if (this.nextTime < now + 0.05) this.nextTime = now + 0.05
		source.start(this.nextTime)
		this.nextTime += buffer.duration
		this.sources.push(source)
		this.setPlaying(true)
		source.onended = () => {
			const idx = this.sources.indexOf(source)
			if (idx >= 0) this.sources.splice(idx, 1)
			if (!this.sources.length && this.nextTime <= ctx.currentTime + 0.05) {
				this.setPlaying(false)
				this.onEnded?.()
			}
		}
	}

	/* ================= 停止 / 复位 ================= */

	/**
	 * 停止播放并清空一切缓冲
	 */
	stop(): void {
		this.stopped = true
		this.gen++
		this.decodeChain = Promise.resolve()
		// MSE 清理
		if (this.audioEl) {
			try {
				this.audioEl.pause()
				this.audioEl.removeAttribute("src")
				this.audioEl.load()
			} catch {
				// 忽略
			}
		}
		if (this.blobUrl) {
			try { URL.revokeObjectURL(this.blobUrl) } catch { /* 忽略 */ }
		}
		this.ms = null
		this.sb = null
		this.mseQueue = []
		this.sbBusy = false
		this.mseEndRequested = false
		this.mseHasData = false
		// WebAudio 清理
		for (const source of this.sources) {
			try {
				source.stop()
				source.disconnect()
			} catch {
				// 已停止的源忽略
			}
		}
		this.sources = []
		this.pending = new Uint8Array(0)
		this.nextTime = 0
		this.setPlaying(false)
	}

	/**
	 * 复位, 允许下一次播放 (新的 MediaSource / 解码链)
	 */
	reset(): void {
		this.stopped = false
		this.gen++
		this.decodeChain = Promise.resolve()
		this.nextTime = 0
		this.pending = new Uint8Array(0)
		this.mseAttempted = false
		this.mseOk = false
		this.mseMime = null
		this.blobUrl = null
	}
}
